/* Altyazı Şefi Web: Canlı çeviri (sekme / pencere / ekran paylaşımı) → AS.modes.live
 *
 * Kullanıcı diziyi/filmi başka bir sekmede açar, o sekmeyi buraya paylaşır; Türkçe altyazı hem buradaki
 * önizlemede hem de her zaman üstte duran altyazı penceresinde (AS.subs.openPip) görünür.
 *   - Ekrandaki yazı (OCR): bölge (ocrRegion) her ocrInterval ms'de okunur → AS.Assembler → çeviri → 'subtitle' {kind:'ocr'}
 *   - Konuşma: sekme sesi → AS.audio.tap → Segmenter → AS.asr.transcribe → çeviri → 'subtitle' {kind:'speech'}
 *   - Otomatik: ikisi birlikte; ekranda son 4 sn altyazı görülmediyse konuşma gösterilir (Android ile aynı).
 *
 * Arka plan sekmesi: kullanıcı videonun sekmesine geçince BU sekme gizlenir; tarayıcı ana iş parçacığındaki
 * zamanlayıcıları kısar (≥1 sn, 5 dk sonra dakikada bir) ve gizli sekmedeki <video> kare çizmeyi bırakabilir. Bu yüzden:
 *   - OCR döngüsü js/ticker-worker.js (ayrılmış worker; zamanlayıcısı kısılmaz) iletileriyle, yedek olarak da ses
 *     işleyicisinden gelen ~100 ms'lik parçalarla sürülür; ana iş parçacığı zamanlayıcısı yalnızca son çaredir.
 *   - Kareler <video>'dan değil doğrudan MediaStreamTrack'ten alınır (MediaStreamTrackProcessor, yoksa ImageCapture);
 *     ikisi de yoksa önizleme <video>'su kullanılır ve kullanıcıya bu sekme gizliyken okumanın durabileceği söylenir.
 *
 * Güvenlik: tüm DOM AS.util.el / textContent ile; sekme adı, OCR metni, çeviri ve konuşma metni güvenilmez veri.
 * API: {id, title, icon, mount(panelEl), unmount(), startWithStream(stream), stop(), stats()} */
(function (root) {
  'use strict';
  var AS = root.AS;
  if (!AS || !AS.util) throw new Error('ns.js önce yüklenmeli');
  var U = AS.util;
  var el = U.el;
  var doc = root.document;
  var SVGNS = 'http://www.w3.org/2000/svg';

  /* ------------------------------------------------------------------ */
  /* sabitler                                                            */
  /* ------------------------------------------------------------------ */
  var AUTO_QUIET_MS = 4000;       // otomatik: son 4 sn ekranda altyazı yoksa konuşma gösterilir
  var STATIC_TEXT_MS = 9000;      // bölgede bundan uzun kımıldamayan yazı (logo, tabela) konuşmayı susturmaz
  var OCR_CLEAR_MS = 1500;        // kaynak altyazı kaybolduktan bu kadar sonra Türkçe satır da silinir
  var MAX_MERGE_MS = 24000;       // geride kalınca bekleyen konuşma bölütleri tek çağrıda en çok bu kadar birleşir
  var MAX_BACKLOG_MS = 18000;     // bekleyen ses bundan fazlaysa en eskiler atılır…
  var KEEP_BACKLOG_MS = 9000;     // …ve en yeni bu kadarı tutulur
  var LAG_WARN_MS = 6000;         // konuşmanın ekrana gelmesi bundan uzun sürüyorsa uyar
  var SPEECH_CARRY_MAX = 240;     // bölünmüş konuşmada birleştirilen cümlenin en fazla uzunluğu
  var GRAB_TIMEOUT_MS = 2500;
  var BLACK_CHECK_MS = 2000;
  var BLACK_WARN_MS = 8000;
  var MIN_RW = 0.08, MIN_RH = 0.05; // bölge kutusunun en küçük boyu (kesir)
  var MODEL_SIZE = { tiny: 'yaklaşık 40 MB', base: 'yaklaşık 80–130 MB', small: 'yaklaşık 250–450 MB' };
  var MODEL_NAME = { tiny: 'Hızlı (tiny)', base: 'Dengeli (base)', small: 'En doğru (small)' };
  var MSG_REPLACED = 'Konuşma modeli değiştirildi.';
  var MSG_DISPOSED = 'Konuşma tanıma durduruldu.';
  var MSG_OCR_CLOSED = 'OCR kapatıldı.';

  var SCRIPT_SRC = (doc && doc.currentScript && doc.currentScript.src) || null;
  function tickerUrl() {
    try { if (SCRIPT_SRC) return new URL('ticker-worker.js', SCRIPT_SRC).href; } catch (e) { /* aşağıda */ }
    return new URL('js/ticker-worker.js', doc.baseURI).href;
  }
  // Dosya yüklenemezse (ör. çevrimdışı ve henüz önbellekte değil) aynı saat blob: worker olarak kurulur (CSP worker-src blob:).
  var TICKER_SRC = "'use strict';var t=null,iv=400,n=0;function c(v){v=Number(v);return isFinite(v)?Math.max(50,Math.min(10000,Math.round(v))):400}" +
    "function a(){if(t!==null)clearInterval(t);t=setInterval(function(){n++;self.postMessage({type:'tick',n:n,t:Date.now()})},iv)}" +
    "self.onmessage=function(e){var d=e&&e.data;if(!d||typeof d!=='object')return;if(d.type==='start'){iv=c(d.interval);a()}" +
    "else if(d.type==='interval'){iv=c(d.interval);if(t!==null)a()}else if(d.type==='stop'){if(t!==null)clearInterval(t);t=null}};";

  /* ------------------------------------------------------------------ */
  /* simgeler (app.js ile aynı çizim dili)                               */
  /* ------------------------------------------------------------------ */
  var ICONS = {
    live: [['rect', { x: 2, y: 3.5, width: 20, height: 13.5, rx: 2.5 }], ['path', { d: 'M8 21h8M12 17v4' }], ['path', { d: 'M7 13h10M9.5 10h5' }]],
    share: [['rect', { x: 2, y: 3.5, width: 20, height: 13.5, rx: 2.5 }], ['path', { d: 'M8 21h8M12 17v4' }], ['path', { d: 'M12 13.5V7.5M9.3 10.2L12 7.5l2.7 2.7' }]],
    stop: [['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2.2 }]],
    swap: [['path', { d: 'M20 12a8 8 0 1 1-2.34-5.66' }], ['path', { d: 'M20 4v5h-5' }]],
    pip: [['rect', { x: 2.5, y: 4, width: 19, height: 15, rx: 2.5 }], ['rect', { x: 11.5, y: 11, width: 7.5, height: 5.5, rx: 1.2, fill: 'currentColor', stroke: 'none' }]],
    info: [['circle', { cx: 12, cy: 12, r: 9.5 }], ['path', { d: 'M12 11v5.5' }], ['path', { d: 'M12 7.7h.01', 'stroke-width': 2.8 }]],
    check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
    reset: [['path', { d: 'M4 12a8 8 0 1 0 2.34-5.66' }], ['path', { d: 'M4 4v5h5' }]],
    warn: [['path', { d: 'M10.3 4.2L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z' }], ['path', { d: 'M12 9.5v4.2' }], ['path', { d: 'M12 17.3h.01', 'stroke-width': 2.8 }]],
    error: [['circle', { cx: 12, cy: 12, r: 9.5 }], ['path', { d: 'M12 7.5v5.5' }], ['path', { d: 'M12 16.4h.01', 'stroke-width': 2.8 }]],
    ok: [['circle', { cx: 12, cy: 12, r: 9.5 }], ['path', { d: 'M8 12.3l2.7 2.7L16.2 9.5' }]],
    fullscreen: [['path', { d: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' }]],
    eye: [['path', { d: 'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z' }], ['circle', { cx: 12, cy: 12, r: 2.8 }]],
    eyeOff: [['path', { d: 'M2.5 12s3.5-6.5 9.5-6.5c1.6 0 3 .4 4.2 1M21.5 12s-3.5 6.5-9.5 6.5c-1.6 0-3-.4-4.2-1' }], ['path', { d: 'M4 20L20 4' }]],
    type: [['path', { d: 'M4 7.5V5h16v2.5M12 5v14M9 19h6' }]],
    pulse: [['path', { d: 'M3 12h4l2.5-6 5 12 2.5-6h4' }]]
  };

  function icon(name, size) {
    var spec = ICONS[name] || ICONS.info;
    var s = doc.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    if (size) { s.setAttribute('width', String(size)); s.setAttribute('height', String(size)); }
    for (var i = 0; i < spec.length; i++) {
      var c = doc.createElementNS(SVGNS, spec[i][0]);
      var a = spec[i][1];
      for (var k in a) if (Object.prototype.hasOwnProperty.call(a, k)) c.setAttribute(k, String(a[k]));
      s.appendChild(c);
    }
    return s;
  }

  /* ------------------------------------------------------------------ */
  /* küçük yardımcılar                                                   */
  /* ------------------------------------------------------------------ */
  function errMsg(e) {
    var m = (e && (e.message || e.name)) || String(e || 'bilinmeyen hata');
    m = String(m).replace(/\s+/g, ' ').trim();
    return m.length > 160 ? m.slice(0, 157) + '…' : m;
  }
  function status(text, level) { AS.bus.emit('status', { mode: 'live', text: text, level: level || 'info' }); }
  var onceAt = {};
  function statusOnce(key, text, level, everyMs) {
    var now = U.now();
    if (onceAt[key] && now - onceAt[key] < (everyMs || 10000)) return;
    onceAt[key] = now;
    status(text, level);
  }
  function fmt1(n) { return Number(n).toLocaleString('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
  function setText(node, text) { text = String(text); if (node.textContent !== text) node.textContent = text; }
  function setChip(chip, text, kind, title) {
    setText(chip, text);
    var cls = 'as-chip' + (kind ? ' as-chip--' + kind : '');
    if (chip.className !== cls) chip.className = cls;
    chip.title = title || '';
  }
  function shorten(s, n) {
    s = String(s || '').replace(/[\u0000-\u001f\u007f\u200b\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  /** Paylaşılan yüzeyin adı (iz etiketi insan okunur değil: "web-contents-media-stream://…"). */
  function surfaceName(track) {
    var ds = '';
    try { ds = (track && typeof track.getSettings === 'function' && track.getSettings().displaySurface) || ''; } catch (e) { ds = ''; }
    return ds === 'browser' ? 'sekme' : ds === 'window' ? 'pencere' : ds === 'monitor' ? 'tüm ekran' : '';
  }
  function liveTrack(list) {
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].readyState === 'live') return list[i];
    return null;
  }
  function stopTracks(stream) {
    try { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* zaten durmuş */ } }); } catch (e) { /* yok */ }
  }

  /* ---------- ayarlar (doğrulanmış) ---------- */
  function liveMode() { var m = AS.settings.get('liveMode'); return (m === 'ocr' || m === 'speech') ? m : 'auto'; }
  function asrLang() {
    var l = AS.settings.get('asrLang');
    return (typeof l === 'string' && (l === 'auto' || /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(l))) ? l : 'auto';
  }
  function asrModel() { var m = AS.settings.get('asrModel'); return (m === 'tiny' || m === 'small') ? m : 'base'; }
  function ocrInterval() { var v = Number(AS.settings.get('ocrInterval')); return U.clamp(isFinite(v) ? v : 400, 150, 3000); }
  function normRegion(r) {
    var d = AS.settings.defaults().ocrRegion;
    r = (r && typeof r === 'object') ? r : d;
    var num = function (v, def) { v = Number(v); return isFinite(v) ? v : def; };
    var x = U.clamp(num(r.x, d.x), 0, 1 - MIN_RW), y = U.clamp(num(r.y, d.y), 0, 1 - MIN_RH);
    var w = U.clamp(num(r.w, d.w), MIN_RW, 1 - x), h = U.clamp(num(r.h, d.h), MIN_RH, 1 - y);
    return { x: x, y: y, w: w, h: h };
  }
  function region() { return normRegion(AS.settings.get('ocrRegion')); }
  function round4(r) {
    var q = function (v) { return Math.round(v * 10000) / 10000; };
    return { x: q(r.x), y: q(r.y), w: q(r.w), h: q(r.h) };
  }

  /* ---------- yetenekler (özellik algılama) ---------- */
  function caps() {
    var nav = root.navigator || {};
    var md = nav.mediaDevices;
    var gdm = !!(md && typeof md.getDisplayMedia === 'function');
    var sc = {};
    try { sc = (md && typeof md.getSupportedConstraints === 'function') ? md.getSupportedConstraints() : {}; } catch (e) { sc = {}; }
    return {
      gdm: gdm,
      secure: root.isSecureContext !== false,
      tabAudio: gdm && !!sc.suppressLocalAudioPlayback,
      ocr: !!(AS.ocr && typeof AS.ocr.supported === 'function' && AS.ocr.supported()),
      speech: !!(AS.asr && AS.audio && typeof root.Worker === 'function' && (root.AudioContext || root.webkitAudioContext)),
      directFrames: typeof root.MediaStreamTrackProcessor === 'function' || typeof root.ImageCapture === 'function',
      docPip: 'documentPictureInPicture' in root
    };
  }

  /* ------------------------------------------------------------------ */
  /* Saat: arka planda kısılmayan tik kaynağı                            */
  /* ------------------------------------------------------------------ */
  function Clock(interval, onTick) {
    this.interval = interval;
    this.onTick = onTick;
    this.kind = null;       // 'worker' | 'blob' | 'timer'
    this.worker = null;
    this.blobUrl = null;
    this.timer = null;
    this.lastAt = 0;
    this.dead = false;
  }
  Clock.prototype.start = function () {
    // Test kancası (yalnızca yerel ?test=1): yedek yolları zorla
    var tp = U.testParams();
    if (tp && tp.liveClock === 'blob') { this._blobOrTimer(); return; }
    if (tp && tp.liveClock === 'timer') { this._timer(); return; }
    var w = null;
    if (typeof root.Worker === 'function') {
      try { w = new root.Worker(tickerUrl(), { name: 'as-live-ticker' }); } catch (e) { w = null; }
    }
    if (w) this._use(w, 'worker'); else this._blobOrTimer();
  };
  Clock.prototype._blobOrTimer = function () {
    if (this.dead) return;
    var w = null;
    if (typeof root.Worker === 'function' && typeof root.Blob === 'function' && root.URL && URL.createObjectURL) {
      try {
        this.blobUrl = URL.createObjectURL(new Blob([TICKER_SRC], { type: 'text/javascript' }));
        w = new root.Worker(this.blobUrl, { name: 'as-live-ticker' });
      } catch (e) { w = null; this._revoke(); }
    }
    if (w) this._use(w, 'blob');
    else this._timer();
  };
  Clock.prototype._revoke = function () {
    if (this.blobUrl) { try { URL.revokeObjectURL(this.blobUrl); } catch (e) { /* yok */ } this.blobUrl = null; }
  };
  Clock.prototype._use = function (w, kind) {
    var self = this;
    this.worker = w;
    this.kind = kind;
    w.onmessage = function (e) {
      if (self.dead || self.worker !== w) return;
      self._revoke();
      if (e.data && e.data.type === 'tick') self.fire(kind);
    };
    w.onerror = function (ev) {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      try { w.terminate(); } catch (x) { /* yok */ }
      if (self.dead || self.worker !== w) return;
      self.worker = null;
      self._revoke();
      if (kind === 'worker') self._blobOrTimer(); else self._timer();
    };
    w.postMessage({ type: 'start', interval: this.interval });
  };
  Clock.prototype._timer = function () {
    var self = this;
    this.kind = 'timer';
    var loop = function () {
      if (self.dead) return;
      self.fire('timer');
      self.timer = setTimeout(loop, self.interval);
    };
    this.timer = setTimeout(loop, this.interval);
  };
  /** Tik: ana kaynak aralığın %80'inden önce tekrar tetiklemez; yardımcı kaynak (ses) yalnızca ana kaynak geciktiyse tetikler. */
  Clock.prototype.fire = function (src) {
    if (this.dead) return;
    var now = U.now();
    var primary = src === this.kind;
    if (now - this.lastAt < this.interval * (primary ? 0.8 : 1.6)) return;
    this.lastAt = now;
    try { this.onTick(now, src); } catch (e) { if (root.console) console.error('[AS.live] tik', e); }
  };
  Clock.prototype.nudge = function () { this.fire('audio'); };
  Clock.prototype.setInterval = function (ms) {
    this.interval = ms;
    if (this.worker) { try { this.worker.postMessage({ type: 'interval', interval: ms }); } catch (e) { /* yok */ } }
  };
  Clock.prototype.alive = function () { return !this.dead && !!(this.worker || this.timer); };
  Clock.prototype.stop = function () {
    this.dead = true;
    if (this.worker) {
      try { this.worker.postMessage({ type: 'stop' }); } catch (e) { /* yok */ }
      try { this.worker.terminate(); } catch (e) { /* yok */ }
      this.worker = null;
    }
    this._revoke();
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  };

  /* ------------------------------------------------------------------ */
  /* Kare kaynağı: görüntü izinden doğrudan (gizli sekmede de taze kare) */
  /* ------------------------------------------------------------------ */
  function FrameSource(track, video) {
    this.track = track;
    this.video = video;
    this.kind = null;     // 'processor' | 'imagecapture' | 'video'
    this.closed = false;
    this.latest = null;   // processor: en son VideoFrame
    this.frames = 0;      // izden gelen kare sayısı
    this.reader = null;
    this.ic = null;
    this.grabbing = false;
    this.fails = 0;
    this.out = [];        // verilip henüz bırakılmamış kareler (stop() hepsini kapatır)
  }
  FrameSource.prototype.start = function () {
    var tp = U.testParams();   // test kancası (yalnızca yerel ?test=1): yedek yolları zorla
    if (tp && tp.liveFrames === 'video') { this.kind = 'video'; return; }
    if (tp && tp.liveFrames === 'imagecapture') { this._startImageCapture(); return; }
    if (typeof root.MediaStreamTrackProcessor === 'function') {
      try { this._startProcessor(); return; } catch (e) { if (root.console) console.warn('[AS.live] MediaStreamTrackProcessor kullanılamadı:', e && e.message); }
    }
    this._startImageCapture();
  };
  FrameSource.prototype._startProcessor = function () {
    var self = this;
    var proc = new root.MediaStreamTrackProcessor({ track: this.track, maxBufferSize: 2 });
    var reader = proc.readable.getReader();
    this.reader = reader;
    this.kind = 'processor';
    var pump = function () {
      reader.read().then(function (r) {
        if (r.done) { if (self.reader === reader) self.reader = null; self._processorEnded(); return; }
        var f = r.value;
        if (self.closed || self.reader !== reader) {
          try { f.close(); } catch (e) { /* yok */ }
          // Durdurulduysa akış bitene kadar boşalt (bkz. stop): her kare kapatılır
          if (self.reader === reader) pump();
          return;
        }
        if (self.latest) { try { self.latest.close(); } catch (e) { /* yok */ } }
        self.latest = f;
        self.frames++;
        pump();
      }, function (e) { if (self.reader === reader) self.reader = null; self._processorEnded(e); });
    };
    pump();
  };
  FrameSource.prototype._processorEnded = function (e) {
    if (this.closed) return;
    if (this.latest) { try { this.latest.close(); } catch (x) { /* yok */ } this.latest = null; }
    if (this.track.readyState === 'live') {
      if (root.console) console.warn('[AS.live] kare akışı kesildi, ImageCapture deneniyor', e && e.message);
      this._startImageCapture();
    }
  };
  FrameSource.prototype._startImageCapture = function () {
    if (typeof root.ImageCapture === 'function') {
      try { this.ic = new root.ImageCapture(this.track); this.kind = 'imagecapture'; return; } catch (e) { this.ic = null; }
    }
    this.kind = 'video';
  };
  /** → Promise<{src, release()} | null>. src: VideoFrame | ImageBitmap | HTMLVideoElement */
  FrameSource.prototype.acquire = function () {
    var self = this;
    if (this.closed) return Promise.resolve(null);
    if (this.kind === 'processor') {
      if (!this.latest) return Promise.resolve(null);
      var f;
      try { f = this.latest.clone(); } catch (e) { return Promise.resolve(null); }
      return Promise.resolve(this._lend(f));
    }
    if (this.kind === 'imagecapture' && this.ic) {
      if (this.grabbing) return Promise.resolve(null);
      this.grabbing = true;
      return new Promise(function (resolve) {
        var done = false;
        var timer = setTimeout(function () { if (!done) { done = true; self.grabbing = false; resolve(null); } }, GRAB_TIMEOUT_MS);
        self.ic.grabFrame().then(function (bmp) {
          if (done || self.closed) { try { bmp.close(); } catch (e) { /* yok */ } if (!done) { done = true; resolve(null); } self.grabbing = false; return; }
          done = true; clearTimeout(timer); self.grabbing = false; self.fails = 0; self.frames++;
          resolve(self._lend(bmp));
        }, function () {
          self.grabbing = false;
          if (done) return;
          done = true; clearTimeout(timer);
          // Art arda başarısızsa (ör. iz susturuldu) önizleme videosuna geç
          if (++self.fails >= 6 && self.track.readyState === 'live') { self.ic = null; self.kind = 'video'; }
          resolve(null);
        });
      });
    }
    var v = this.video;
    if (v && v.readyState >= 2 && v.videoWidth > 0) return Promise.resolve({ src: v, release: function () {} });
    return Promise.resolve(null);
  };
  /** Kareyi (VideoFrame/ImageBitmap) ödünç ver: release() ya da en geç stop() kapatır. Böylece okuma hiç
   *  bitmese bile (ör. OCR motoru okurken kapatıldı) kare çöp toplayıcıya kapatılmadan kalmaz. */
  FrameSource.prototype._lend = function (f) {
    var out = this.out;
    out.push(f);
    return { src: f, release: function () {
      var i = out.indexOf(f);
      if (i >= 0) out.splice(i, 1);
      try { f.close(); } catch (e) { /* yok */ }
    } };
  };
  FrameSource.prototype.stop = function () {
    if (this.closed) return;
    this.closed = true;
    this.out.splice(0).forEach(function (f) { try { f.close(); } catch (e) { /* yok */ } });
    var reader = this.reader, self = this;
    if (reader) {
      // İz durdurulunca (endSession hemen ardından durdurur) akış kuyruktaki kareleri verip kendiliğinden biter;
      // pump bunları kapatarak boşaltır. cancel() kuyruktaki kareleri kapatmadan atar; yalnızca yedek.
      setTimeout(function () {
        if (self.reader !== reader) return;
        self.reader = null;
        try { reader.cancel().catch(function () {}); } catch (e) { /* yok */ }
      }, 1000);
    }
    if (this.latest) { try { this.latest.close(); } catch (e) { /* yok */ } this.latest = null; }
    this.ic = null;
  };

  /* ------------------------------------------------------------------ */
  /* durum                                                               */
  /* ------------------------------------------------------------------ */
  var M = null;       // bağlıyken arayüz ve oturum durumu
  var sessSeq = 0;
  var lastStats = null;

  function newStats() {
    return {
      startedAt: U.now(), ticks: 0, ticksHidden: 0, tickSrc: {}, lastTickAt: 0, reads: 0, readsHidden: 0,
      ocrRuns: 0, emptyFrames: 0, noFrame: 0, busySkips: 0, sentences: 0, echo: 0, staleDropped: 0,
      shown: { ocr: 0, speech: 0 }, segments: 0, transcribed: 0, speechSkipped: 0, speechSuppressed: 0,
      speechDropped: 0, speechMerged: 0, audioChunks: 0, translated: 0, translateErrors: 0, ocrErrors: 0,
      cleared: 0, lastShown: null, lines: []
    };
  }

  function alive(s) { return !!(s && !s.ended && M && M.sess === s); }

  /* ------------------------------------------------------------------ */
  /* OCR motoru (oturumlar arasında saklanır, unmount'ta kapatılır)      */
  /* ------------------------------------------------------------------ */
  function ensureReader() {
    var m = M;
    if (!m) return Promise.reject(new Error(MSG_OCR_CLOSED));
    if (m.reader) return Promise.resolve(m.reader);
    if (m.readerP) return m.readerP;
    if (!caps().ocr) { m.ocrState = 'error'; m.ocrErr = 'Ekran okuma bu tarayıcıda çalışmıyor.'; scheduleRender(); return Promise.reject(new Error(m.ocrErr)); }
    m.ocrState = 'loading';
    m.ocrProg = 0;
    m.ocrErr = '';
    scheduleRender();
    var p = AS.ocr.Reader.create({
      onProgress: function (pr) {
        if (M !== m || m.readerP !== p) return;
        var v = Number(pr && pr.progress);
        if (isFinite(v)) m.ocrProg = U.clamp(v, 0, 1);
        scheduleRender();
      }
    }).then(function (reader) {
      if (M !== m || m.readerP !== p) { reader.terminate().catch(function () {}); throw new Error(MSG_OCR_CLOSED); }
      m.reader = reader;
      m.readerP = null;
      m.ocrState = 'ready';
      scheduleRender();
      return reader;
    }, function (e) {
      if (M === m && m.readerP === p) {
        m.readerP = null;
        m.ocrState = 'error';
        m.ocrErr = errMsg(e);
        status('Ekran okuma başlatılamadı: ' + m.ocrErr, 'error');
        scheduleRender();
      }
      throw e;
    });
    m.readerP = p;
    p.catch(function () { /* durum yukarıda işlendi */ });
    return p;
  }

  /* ------------------------------------------------------------------ */
  /* çeviri ve gösterim                                                  */
  /* ------------------------------------------------------------------ */
  /** Çeviri hatası için tek, tekrarsız Türkçe durum metni (translate.js iletisi zaten "Çeviri yapılamadı" ile başlayabilir). */
  function failMsg(e) {
    var m = errMsg(e).replace(/[\s.;:]+$/, '');
    if (!m || /^çeviri yapılamadı$/i.test(m)) return 'Çeviri yapılamadı; orijinal metin gösteriliyor.';
    if (/^çeviri yapılamadı/i.test(m)) return m + '. Şimdilik orijinal metin gösteriliyor.';
    return 'Çeviri yapılamadı (' + m + '); orijinal metin gösteriliyor.';
  }

  function translateFor(s, src, from) {
    var T = AS.translate;
    if (!T || typeof T.text !== 'function') return Promise.resolve(src);
    var f = (!from || from === 'auto') ? 'auto' : from;
    return Promise.resolve().then(function () {
      return T.text(src, { from: f, priority: 'high', signal: s.ctrl.signal });
    }).then(function (tr) {
      tr = String(tr === null || tr === undefined ? '' : tr).trim();
      if (!tr) return src;
      s.stats.translated++;
      return tr;
    }, function (e) {
      if (s.ended || (e && e.name === 'AbortError')) return null;
      s.stats.translateErrors++;
      var code = e && e.code;
      var msg = code === 'disabled'
        ? 'Çeviri yapılamıyor: cihaz içi çeviri yok ve çevrim içi çeviri kapalı (Ayarlar). Şimdilik orijinal metin gösteriliyor.'
        : code === 'offline'
          ? 'İnternet bağlantısı yok; çevrilemeyen satırlar orijinal haliyle gösteriliyor.'
          : code === 'busy'
            ? 'Çeviri servisleri şu an yoğun; birazdan yeniden denenecek. Şimdilik orijinal metin gösteriliyor.'
            : failMsg(e);
      statusOnce('tr-' + (code || 'x'), msg, 'warn', 15000);
      return src;
    });
  }

  function emit(s, p, chain) {
    if (!alive(s)) return;
    var now = U.now();
    s.lastEmit = { kind: p.kind, chain: chain, at: now };
    if (p.tr !== p.src) {
      s.recent.push({ tr: p.tr, src: p.src });
      if (s.recent.length > 8) s.recent.shift();
    }
    s.stats.shown[p.kind]++;
    s.stats.lastShown = { kind: p.kind, tr: p.tr, src: p.src, cont: !!p.cont };
    s.stats.lines.push({ kind: p.kind, tr: p.tr, src: p.src, cont: !!p.cont, at: Math.round(now - s.stats.startedAt), hidden: !!doc.hidden });
    if (s.stats.lines.length > 60) s.stats.lines.shift();
    AS.bus.emit('subtitle', p);
  }

  /** Ekran paylaşımına bizim altyazı penceremiz de girerse kendi Türkçe satırımızı tekrar okumayalım. */
  function isEcho(s, sentence) {
    var sim = AS.Assembler && AS.Assembler.similarity;
    if (!sim) return false;
    for (var i = s.recent.length - 1; i >= 0; i--) {
      var r = s.recent[i];
      if (sim(sentence, r.tr) >= 0.8 && sim(sentence, r.src) < 0.8) return true;
    }
    return false;
  }

  function setLast(s, text, kind) {
    s.lastOriginal = { text: shorten(text, 300), kind: kind };
    scheduleRender();
  }

  /** Otomatik yöntemde: ekranda yakın zamanda altyazı var mı? */
  function ocrFresh(s, now) {
    if (!s.ocr) return false;
    if (now - s.lastOcrShownAt < AUTO_QUIET_MS) return true;
    var o = s.ocr;
    return o.onScreenSince > 0 && now - o.textSeenAt < 1500 && now - o.onScreenSince < STATIC_TEXT_MS && o.shownSeq > 0;
  }

  /* ------------------------------------------------------------------ */
  /* OCR hattı                                                           */
  /* ------------------------------------------------------------------ */
  function startOcr(s) {
    if (s.ocr || !s.frames) return;
    s.ocr = {
      asm: new AS.Assembler(), seq: 0, shownSeq: 0, chain: 0, shownChain: -1, inFlight: false,
      textSeenAt: 0, onScreenSince: 0, cleared: true, readTimes: [], lastBlackAt: 0
    };
    ensureReader().catch(function () { /* durum gösterildi */ });
  }
  function stopOcr(s) { s.ocr = null; }

  function onTick(s, now, src) {
    if (!alive(s)) return;
    var st = s.stats;
    st.ticks++;
    st.lastTickAt = now;
    st.tickSrc[src] = (st.tickSrc[src] || 0) + 1;
    if (doc.hidden) st.ticksHidden++;
    if (s.ocr) ocrTick(s, s.ocr, now);
    scheduleRender();
  }

  function ocrTick(s, o, now) {
    var m = M;
    if (!m.reader) { if (!m.readerP && m.ocrState !== 'error') ensureReader().catch(function () {}); return; }
    if (o.inFlight) { s.stats.busySkips++; return; }
    o.inFlight = true;
    var reader = m.reader;
    s.frames.acquire().then(function (fr) {
      if (!fr) { s.stats.noFrame++; o.inFlight = false; return; }
      if (!alive(s) || s.ocr !== o || M.reader !== reader) { fr.release(); o.inFlight = false; return; }
      var hidden = !!doc.hidden;
      var p;
      try {
        checkBlack(s, o, fr.src, now);
        p = reader.read(fr.src, region());
      } catch (e) { p = Promise.reject(e); }
      return Promise.resolve(p).then(function (r) {
        fr.release();
        o.inFlight = false;
        if (hidden) s.stats.readsHidden++;
        onOcrResult(s, o, r);
      }, function (e) {
        fr.release();
        o.inFlight = false;
        onOcrError(s, e);
      });
    }).catch(function (e) {
      o.inFlight = false;
      onOcrError(s, e);
    });
  }

  function onOcrError(s, e) {
    var msg = errMsg(e);
    if (!alive(s) || msg === MSG_OCR_CLOSED) return;
    s.stats.ocrErrors++;
    statusOnce('ocr-err', msg, 'warn', 8000);
  }

  function onOcrResult(s, o, r) {
    if (!alive(s) || s.ocr !== o || !r) return;
    var now = U.now();
    var st = s.stats;
    st.reads++;
    o.readTimes.push(now);
    while (o.readTimes.length && now - o.readTimes[0] > 5000) o.readTimes.shift();
    if (r.empty) { st.emptyFrames++; return; }
    if (!r.same) st.ocrRuns++;
    var text = String(r.text || '').trim();
    if (text) {
      if (!o.onScreenSince) o.onScreenSince = now;
      o.textSeenAt = now;
    } else {
      o.onScreenSince = 0;
    }
    if (r.same) {
      if (!text) maybeClear(s, o, now);
      return;
    }
    var res = o.asm.onText(text, now, typeof r.conf === 'number' ? r.conf : 100);
    if (!text) { maybeClear(s, o, now); return; }
    if (!res || !res.sentence) return;
    if (isEcho(s, res.sentence)) { st.echo++; return; }
    var chain = res.continuation ? o.chain : ++o.chain;
    var my = ++o.seq;
    var sentence = res.sentence;
    st.sentences++;
    setLast(s, sentence, 'ocr');
    translateFor(s, sentence, asrLang() === 'auto' ? 'auto' : asrLang()).then(function (tr) {
      if (tr === null || !alive(s) || s.ocr !== o) return;
      if (my < o.shownSeq) { st.staleDropped++; return; }   // daha yeni bir satır zaten gösterildi
      var cont = !!res.continuation && o.shownChain === chain && !!s.lastEmit && s.lastEmit.kind === 'ocr';
      o.shownSeq = my;
      o.shownChain = chain;
      o.cleared = false;
      s.lastOcrShownAt = U.now();
      emit(s, { tr: tr, src: sentence, cont: cont, kind: 'ocr' }, chain);
    });
  }

  /** Kaynak altyazı ekrandan gidince (biraz gecikmeyle) bizim satırımızı da kaldır. */
  function maybeClear(s, o, now) {
    if (o.cleared || o.shownSeq === 0) return;
    if (now - o.textSeenAt < OCR_CLEAR_MS) return;
    o.cleared = true;
    if (!AS.subs || typeof AS.subs.current !== 'function') return;
    for (var i = 0; i < 2; i++) {
      var cur = AS.subs.current();
      var last = cur[cur.length - 1];
      if (!last || last.kind !== 'ocr') break;
      AS.bus.emit('subtitle', { tr: '', cont: true, kind: 'ocr' });
      s.stats.cleared++;
    }
  }

  /** Korumalı (DRM) videolar paylaşımda siyah görünür: uzun süre tamamen siyahsa kullanıcıya söyle. */
  function checkBlack(s, o, src, now) {
    if (now - o.lastBlackAt < BLACK_CHECK_MS) return;
    o.lastBlackAt = now;
    var lum = maxLuma(src);
    if (lum === null) return;
    if (lum < 24) { if (!s.blackSince) s.blackSince = now; } else s.blackSince = 0;
    var black = !!s.blackSince && now - s.blackSince > BLACK_WARN_MS;
    if (black !== s.black) { s.black = black; scheduleRender(); }
  }
  function maxLuma(src) {
    try {
      var m = M;
      if (!m.luma) {
        var c = null;
        if (typeof root.OffscreenCanvas === 'function') { try { c = new root.OffscreenCanvas(32, 18); } catch (e) { c = null; } }
        if (!c) { c = doc.createElement('canvas'); c.width = 32; c.height = 18; }
        m.luma = { c: c, ctx: c.getContext('2d', { willReadFrequently: true, alpha: false }) };
      }
      var ctx = m.luma.ctx;
      if (!ctx) return null;
      ctx.drawImage(src, 0, 0, 32, 18);
      var d = ctx.getImageData(0, 0, 32, 18).data;
      var mx = 0;
      for (var i = 0; i < d.length; i += 4) {
        var y = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        if (y > mx) mx = y;
      }
      return mx;
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------ */
  /* Konuşma hattı                                                       */
  /* ------------------------------------------------------------------ */
  function startSpeech(s) {
    if (s.speech || !s.atrack || s.atrack.readyState !== 'live') return;
    var sp = {
      seg: null, tap: null, tapError: '', queue: [], busy: false, ctrl: new AbortController(),
      seq: 0, shownSeq: 0, chain: 0, carry: null, lastSegEnd: -1, lastSegFinal: true,
      modelState: 'loading', modelErr: '', prog: null, device: null, firstDownload: false,
      lagEma: 0, lagging: false, fastRuns: 0, lastMs: 0
    };
    s.speech = sp;
    sp.seg = new AS.audio.Segmenter({ onSegment: function (pcm, info) { onSegment(s, sp, pcm, info); } });
    loadModel(s, sp);
    var p;
    try {
      p = AS.audio.tap(s.stream, function (chunk) {
        if (s.speech !== sp || !alive(s)) return;
        s.stats.audioChunks++;
        sp.seg.push(chunk);
        if (s.clock) s.clock.nudge();   // ses parçaları da kısılmayan bir saat: OCR'yi yedek olarak sürer
      }, { mode: 'live' });
    } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(function (t) {
      if (s.speech !== sp || !alive(s)) { t.stop(); return; }
      sp.tap = t;
      scheduleRender();
    }, function (e) {
      if (s.speech !== sp || !alive(s)) return;
      sp.tapError = errMsg(e);
      status(sp.tapError, 'warn');
      scheduleRender();
    });
    scheduleRender();
  }

  function stopSpeech(s) {
    var sp = s.speech;
    if (!sp) return;
    s.speech = null;
    try { if (sp.tap) sp.tap.stop(); } catch (e) { /* yok */ }
    sp.tap = null;
    try { sp.ctrl.abort(); } catch (e) { /* yok */ }
    sp.queue = [];
  }

  function modelCached(model) {
    if (!root.caches || typeof root.caches.has !== 'function') return Promise.resolve(false);
    var needle = 'whisper-' + model + '/';
    return root.caches.has('transformers-cache').then(function (has) {
      if (!has) return false;
      return root.caches.open('transformers-cache').then(function (c) { return c.keys(); }).then(function (keys) {
        return keys.some(function (r) { return r.url.indexOf(needle) >= 0; });
      });
    }).catch(function () { return false; });
  }

  function loadModel(s, sp) {
    var model = asrModel();
    sp.modelState = 'loading';
    sp.modelErr = '';
    sp.prog = null;
    sp.model = model;
    var test = !!(U.testParams() && U.testParams().asrModelPath);
    if (!(AS.asr.isLoaded() && AS.asr.model() === model) && !test) {
      modelCached(model).then(function (yes) {
        if (s.speech !== sp || sp.modelState !== 'loading') return;
        sp.firstDownload = !yes;
        if (!yes) status('Konuşma modeli ilk kez indiriliyor (' + MODEL_NAME[model] + ', ' + MODEL_SIZE[model] + '). Bir kez iner, sonra bu bilgisayarda saklanır.', 'busy');
        scheduleRender();
      });
    }
    var p;
    try {
      p = AS.asr.load({ model: model, onProgress: function (pr) { if (s.speech === sp && sp.model === model) { sp.prog = pr; scheduleRender(); } } });
    } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(function (info) {
      if (s.speech !== sp || sp.model !== model) return;
      sp.modelState = 'ready';
      sp.device = info && info.device;
      sp.prog = null;
      scheduleRender();
      pump(s, sp);
    }, function (e) {
      if (s.speech !== sp || sp.model !== model) return;
      var msg = errMsg(e);
      if (msg === MSG_REPLACED || msg === MSG_DISPOSED) return;
      sp.modelState = 'error';
      sp.modelErr = msg;
      sp.queue = [];
      scheduleRender();
    });
  }

  function durMs(it) { return it.pcm.length / 16; }

  function onSegment(s, sp, pcm, info) {
    if (s.speech !== sp || !alive(s)) return;
    var st = s.stats;
    st.segments++;
    var now = U.now();
    var joins = sp.lastSegEnd === info.startMs && sp.lastSegFinal === false;
    sp.lastSegEnd = info.endMs;
    sp.lastSegFinal = !!info.final;
    if (liveMode() === 'auto' && ocrFresh(s, now)) {
      // Ekranda altyazı okunuyor: konuşmayı yazıya dökmeye gerek yok (işlemciyi boşa yormayalım)
      st.speechSkipped++;
      sp.carry = null;
      return;
    }
    if (sp.modelState === 'error') return;
    sp.queue.push({ pcm: pcm, startMs: info.startMs, endMs: info.endMs, final: !!info.final, joins: joins, at: now, n: 1 });
    compact(s, sp);
    pump(s, sp);
  }

  function concatItems(a, b) {
    var gap = a.endMs === b.startMs ? 0 : 2400; // bitişik değilse araya 150 ms sessizlik
    var out = new Float32Array(a.pcm.length + gap + b.pcm.length);
    out.set(a.pcm, 0);
    out.set(b.pcm, a.pcm.length + gap);
    return { pcm: out, startMs: a.startMs, endMs: b.endMs, final: b.final, joins: a.joins, at: b.at, n: a.n + b.n };
  }

  /** Geride kalınca: bekleyenleri birleştir (Whisper 30 sn'lik pencereyi zaten tek seferde işler), çok birikirse eskileri at. */
  function compact(s, sp) {
    var q = sp.queue;
    if (q.length < 2) return;
    var total = 0;
    for (var i = 0; i < q.length; i++) total += durMs(q[i]);
    if (total > MAX_BACKLOG_MS) {
      while (q.length > 1 && total > KEEP_BACKLOG_MS) {
        total -= durMs(q.shift());
        s.stats.speechDropped++;
      }
      q[0].joins = false;
      sp.carry = null;
      if (sp.modelState === 'ready') { sp.lagging = true; sp.fastRuns = 0; scheduleRender(); }
    }
    var merged = [];
    var cur = q[0];
    for (var j = 1; j < q.length; j++) {
      if (durMs(cur) + durMs(q[j]) <= MAX_MERGE_MS) { cur = concatItems(cur, q[j]); s.stats.speechMerged++; }
      else { merged.push(cur); cur = q[j]; }
    }
    merged.push(cur);
    sp.queue = merged;
  }

  function pump(s, sp) {
    if (s.speech !== sp || !alive(s) || sp.busy || !sp.queue.length || sp.modelState !== 'ready') return;
    var item = sp.queue.shift();
    sp.busy = true;
    var my = ++sp.seq;
    var t0 = U.now();
    var lang = asrLang();
    var p;
    try { p = AS.asr.transcribe(item.pcm, { language: lang, signal: sp.ctrl.signal }); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(function (r) {
      if (s.speech !== sp || !alive(s)) return;
      var end = U.now();
      var lag = end - item.at;
      sp.lastMs = end - t0;
      sp.lagEma = sp.lagEma ? sp.lagEma * 0.6 + lag * 0.4 : lag;
      if (sp.lagEma > LAG_WARN_MS) { if (!sp.lagging) { sp.lagging = true; sp.fastRuns = 0; } }
      else if (sp.lagging && lag < LAG_WARN_MS / 2 && ++sp.fastRuns >= 4) sp.lagging = false;
      s.stats.transcribed++;
      onSpeechText(s, sp, item, r || {}, my, lang);
    }, function (e) {
      if (s.speech !== sp || !alive(s) || (e && e.name === 'AbortError')) return;
      var msg = errMsg(e);
      sp.carry = null;
      if (msg === MSG_REPLACED || msg === MSG_DISPOSED) return;
      statusOnce('asr-run', msg, 'warn', 8000);
    }).then(function () {
      sp.busy = false;
      scheduleRender();
      if (s.speech === sp) { compact(s, sp); pump(s, sp); }
    });
  }

  function onSpeechText(s, sp, item, r, my, lang) {
    var text = String(r.text || '').replace(/\s+/g, ' ').trim();
    if (!text) { if (item.final) sp.carry = null; return; }
    var from = r.language || (lang !== 'auto' ? lang : 'auto');
    var sentence = text;
    var cont = false;
    var chain;
    var ends = AS.Assembler && AS.Assembler.endsSentence ? AS.Assembler.endsSentence : function () { return true; };
    if (item.joins && sp.carry && !ends(sp.carry.text) && sp.carry.text.length + text.length + 1 <= SPEECH_CARRY_MAX) {
      sentence = sp.carry.text + ' ' + text;
      cont = true;
      chain = sp.carry.chain;
    } else {
      chain = ++sp.chain;
    }
    sp.carry = item.final ? null : { text: sentence, chain: chain };
    setLast(s, sentence, 'speech');
    translateFor(s, sentence, from).then(function (tr) {
      if (tr === null || s.speech !== sp || !alive(s)) return;
      if (my < sp.shownSeq) { s.stats.staleDropped++; return; }
      if (liveMode() === 'auto' && ocrFresh(s, U.now())) { s.stats.speechSuppressed++; return; }
      sp.shownSeq = my;
      var c = cont && !!s.lastEmit && s.lastEmit.kind === 'speech' && s.lastEmit.chain === chain;
      emit(s, { tr: tr, src: sentence, cont: c, kind: 'speech' }, chain);
    });
  }

  /* ------------------------------------------------------------------ */
  /* oturum                                                              */
  /* ------------------------------------------------------------------ */
  function applyMode(s) {
    if (!alive(s)) return;
    var mode = liveMode();
    var c = caps();
    var wantO = mode !== 'speech' && !!s.vtrack && s.vtrack.readyState === 'live' && c.ocr;
    var wantS = mode !== 'ocr' && !!s.atrack && s.atrack.readyState === 'live' && c.speech;
    if (wantO && !s.ocr) startOcr(s);
    if (!wantO && s.ocr) stopOcr(s);
    if (wantS && !s.speech) startSpeech(s);
    if (!wantS && s.speech) stopSpeech(s);
    scheduleRender();
  }

  function startWithStream(stream) {
    if (!M) return Promise.reject(new Error('Canlı çeviri bölümü açık değil.'));
    if (!stream || typeof stream.getTracks !== 'function' || typeof stream.getVideoTracks !== 'function') {
      return Promise.reject(new TypeError('Geçerli bir medya akışı gerekli.'));
    }
    var vt = liveTrack(stream.getVideoTracks());
    var at = liveTrack(stream.getAudioTracks());
    if (!vt && !at) return Promise.reject(new Error('Paylaşılan kaynakta görüntü de ses de yok.'));
    if (M.sess) endSession(M.sess, 'replace');
    var m = M;
    var s = {
      id: ++sessSeq, stream: stream, vtrack: vt, atrack: at, ended: false, ctrl: new AbortController(),
      frames: null, clock: null, ocr: null, speech: null, stats: newStats(), recent: [], lastEmit: null,
      lastOcrShownAt: -1e9, lastOriginal: null, black: false, blackSince: 0, listeners: [],
      label: surfaceName(vt)
    };
    lastStats = s.stats;
    m.sess = s;
    var on = function (target, ev, fn) { target.addEventListener(ev, fn); s.listeners.push([target, ev, fn]); };
    var watchVideo = function (t) {
      on(t, 'ended', function () {
        if (!alive(s) || s.vtrack !== t) return;
        endSession(s, 'ended');
        status('Paylaşım durduruldu. Yeniden başlatmak için “Sekme / pencere seç” düğmesine tıklayın.', 'info');
      });
    };
    var watchAudio = function (t) {
      on(t, 'ended', function () {
        if (!alive(s) || s.atrack !== t) return;
        if (!s.vtrack || s.vtrack.readyState !== 'live') { endSession(s, 'ended'); return; }
        s.atrack = null;
        stopSpeech(s);
        status('Sekme sesi artık gelmiyor; yalnızca ekrandaki altyazı okunuyor.', 'warn');
        scheduleRender();
      });
    };
    if (vt) watchVideo(vt);
    if (at) watchAudio(at);
    // Bazı akışlarda (ör. captureStream) izler sonradan eklenir
    if (typeof stream.addEventListener === 'function') {
      on(stream, 'addtrack', function (ev) {
        var t = ev && ev.track;
        if (!alive(s) || !t || t.readyState !== 'live') return;
        if (t.kind === 'audio' && !s.atrack) { s.atrack = t; watchAudio(t); applyMode(s); }
        else if (t.kind === 'video' && !s.vtrack) {
          s.vtrack = t;
          s.label = surfaceName(t);
          watchVideo(t);
          s.frames = new FrameSource(t, m.video);
          s.frames.start();
          m.video.hidden = false;
          m.empty.hidden = true;
          applyMode(s);
          layoutRegion();
        }
      });
    }
    // Önizleme (sessiz: sesi zaten videonun kendi sekmesi çalıyor)
    var v = m.video;
    v.muted = true;
    v.srcObject = stream;
    v.hidden = !vt;
    m.empty.hidden = !!vt;
    var pp = v.play();
    if (pp && typeof pp.catch === 'function') pp.catch(function () { /* sessiz video; otomatik oynatma engellenmez */ });
    if (vt) {
      s.frames = new FrameSource(vt, v);
      s.frames.start();
    }
    s.clock = new Clock(ocrInterval(), function (now, src) { onTick(s, now, src); });
    s.clock.start();
    applyMode(s);
    var mode = liveMode();
    var parts = [];
    if (s.ocr) parts.push('ekrandaki altyazı okunuyor');
    if (s.speech) parts.push('konuşma dinleniyor');
    status('Paylaşım başladı: ' + (parts.join(', ') || 'bekleniyor') + '. Altyazı penceresini açıp videonun sekmesine geçebilirsiniz.', 'ok');
    if (!at && mode !== 'ocr') {
      status(mode === 'speech'
        ? 'Ses paylaşılmadı: Konuşma yöntemi için sekme sesi gerekli. Yeniden paylaşıp “Sekme sesini de paylaş” kutusunu işaretleyin.'
        : 'Ses paylaşılmadı: yalnızca ekrandaki altyazı okunacak.', 'warn');
    }
    layoutRegion();
    scheduleRender();
    return Promise.resolve({
      id: s.id, video: !!vt, audio: !!at, ocr: !!s.ocr, speech: !!s.speech,
      frames: s.frames ? s.frames.kind : null, clock: s.clock.kind
    });
  }

  function endSession(s, reason) {
    if (!s || s.ended) return;
    s.ended = true;
    try { s.ctrl.abort(); } catch (e) { /* yok */ }
    stopOcr(s);
    stopSpeech(s);
    if (s.clock) s.clock.stop();
    if (s.frames) s.frames.stop();
    s.listeners.forEach(function (l) { try { l[0].removeEventListener(l[1], l[2]); } catch (e) { /* yok */ } });
    s.listeners = [];
    stopTracks(s.stream);
    s.stats.endedAt = U.now();
    s.stats.endReason = reason;
    if (M && M.sess === s) {
      M.sess = null;
      var v = M.video;
      try { v.pause(); } catch (e) { /* yok */ }
      v.srcObject = null;
      v.hidden = true;
      M.empty.hidden = false;
      if (reason !== 'replace' && AS.subs && typeof AS.subs.clear === 'function') AS.subs.clear();
      layoutRegion();
      render(); // durunca arayüz hemen başa dönsün (uyarılar, düğmeler)
    }
  }

  function stop() {
    if (!M || !M.sess) return;
    endSession(M.sess, 'user');
    status('Canlı çeviri durduruldu.', 'info');
  }

  /* ------------------------------------------------------------------ */
  /* paylaşım başlatma (getDisplayMedia)                                 */
  /* ------------------------------------------------------------------ */
  function pick() {
    var m = M;
    if (!m || m.picking) return;
    var md = root.navigator && root.navigator.mediaDevices;
    if (!md || typeof md.getDisplayMedia !== 'function') {
      status('Bu tarayıcı sekme veya ekran paylaşımını desteklemiyor.', 'error');
      return;
    }
    var c = caps();
    var constraints = {
      video: { frameRate: 10, displaySurface: 'browser' },
      audio: c.tabAudio ? { suppressLocalAudioPlayback: false } : false,
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include'
    };
    var controller = null;
    if (typeof root.CaptureController === 'function') {
      try { controller = new root.CaptureController(); constraints.controller = controller; } catch (e) { controller = null; }
    }
    var t0 = U.now();
    var p;
    // Kullanıcı hareketi kaybolmasın diye tıklamayla aynı adımda (await'ten önce) çağrılır.
    try { p = md.getDisplayMedia(constraints); } catch (e) { p = Promise.reject(e); }
    m.picking = true;
    scheduleRender();
    Promise.resolve(p).then(function (stream) {
      // Seçimden sonra bu sekmede kalınsın: kullanıcı bölgeyi ayarlayıp altyazı penceresini açabilsin.
      if (controller && typeof controller.setFocusBehavior === 'function') {
        try { controller.setFocusBehavior('no-focus-change'); } catch (e) { /* desteklenmiyor / geç kalındı */ }
      }
      if (M !== m) { stopTracks(stream); return; }
      m.picking = false;
      return startWithStream(stream).catch(function (e) {
        stopTracks(stream);
        status(errMsg(e), 'error');
      });
    }, function (e) {
      if (M === m) { m.picking = false; scheduleRender(); }
      pickError(e, U.now() - t0);
    });
  }

  function pickError(e, ms) {
    var name = e && e.name;
    var mac = /Mac/i.test((root.navigator && root.navigator.platform) || '') || U.browser().mac;
    if (name === 'NotAllowedError' || name === 'AbortError' || name === 'SecurityError') {
      // Chrome, işletim sistemi izni yoksa (macOS) seçimden sonra "Permission denied by system" ile reddeder.
      if ((ms < 500 && name !== 'AbortError') || /by system/i.test(String(e && e.message))) {
        status('Ekran paylaşımına izin verilmedi.' + (mac
          ? ' Mac\'te: Sistem Ayarları › Gizlilik ve Güvenlik › Ekran ve Sistem Ses Kaydı bölümünden tarayıcınıza izin verip tarayıcıyı yeniden başlatın.'
          : ' Adres çubuğundaki simgeden bu siteye ekran paylaşımı izni verin.'), 'warn');
      } else {
        status('Paylaşım iptal edildi. Tekrar denemek için “Sekme / pencere seç” düğmesine tıklayın.', 'info');
      }
      return;
    }
    if (name === 'NotReadableError') { status('Seçilen sekme veya pencere okunamadı. Başka birini seçip tekrar deneyin.', 'error'); return; }
    if (name === 'NotFoundError') { status('Paylaşılabilecek bir sekme, pencere veya ekran bulunamadı.', 'error'); return; }
    if (name === 'InvalidStateError') { status('Paylaşımı başlatmak için düğmeye tıklayın.', 'warn'); return; }
    status('Ekran paylaşımı başlatılamadı: ' + errMsg(e), 'error');
  }

  /* ------------------------------------------------------------------ */
  /* arayüz                                                              */
  /* ------------------------------------------------------------------ */
  var infoSeq = 0;
  /** app.js ayar satırlarıyla aynı yapı: etiket + ⓘ düğmesi + açılır açıklama kutusu. */
  function settingRow(label, info, control, labelFor) {
    var id = 'as-live-info-' + (++infoSeq);
    var box = el('div', { class: 'as-set__info', id: id, hidden: true }, info);
    var btn = el('button', {
      class: 'as-info-btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': id,
      title: 'Bu seçenek ne işe yarar?', 'aria-label': label + ': açıklamayı göster',
      on: { click: function () { var open = box.hidden; box.hidden = !open; btn.setAttribute('aria-expanded', open ? 'true' : 'false'); } }
    }, icon('info'));
    var labelEl = labelFor ? el('label', { for: labelFor }, label) : el('span', null, label);
    return el('div', { class: 'as-set' },
      el('div', { class: 'as-set__row', style: { flexWrap: 'wrap', gap: '8px' } },
        el('div', { class: 'as-set__label' }, labelEl, btn),
        el('div', { class: 'as-set__ctrl', style: { flex: '1 1 100%', marginLeft: '0', justifyContent: 'stretch' } }, control)),
      box);
  }

  function statusRow(name, extra) {
    var chip = el('span', { class: 'as-chip' }, '—');
    var row = el('div', { class: 'as-status-item' }, el('span', { class: 'as-status-item__name' }, name), chip);
    if (extra) row.appendChild(extra);
    return { row: row, chip: chip };
  }

  function stepCard(n, title, text) {
    var badge = el('div', { class: 'as-card__icon', 'aria-hidden': 'true', style: { fontWeight: '800', fontSize: '16px' } }, String(n));
    var sub = el('div', { class: 'as-card__sub', style: { marginTop: '3px' } }, text);
    var body = el('div', { class: 'as-row', style: { paddingTop: '11px', gap: '8px' } });
    var card = el('section', { class: 'as-card', 'aria-label': n + '. adım: ' + title, 'data-step': String(n),
      style: { display: 'flex', flexDirection: 'column', padding: '14px 16px', transition: 'border-color .2s ease, opacity .2s ease' } },
    el('div', { class: 'as-card__head', style: { marginBottom: '0', alignItems: 'flex-start' } },
      badge, el('div', { class: 'as-grow' }, el('h3', { class: 'as-card__title' }, title), sub)),
    body);
    return { card: card, badge: badge, sub: sub, body: body, n: n, state: '', text: text };
  }

  /** Adım açıklaması duruma göre değişir; boş metin açıklamayı gizler (biten adım kısalır). */
  function setStepText(step, text) {
    var t = text === undefined ? step.text : text;
    step.sub.hidden = !t;
    setText(step.sub, t || '');
  }

  function setStep(step, state) {
    if (step.state === state) return;
    step.state = state;
    U.clear(step.badge);
    if (state === 'done') step.badge.appendChild(icon('check'));
    else step.badge.appendChild(doc.createTextNode(String(step.n)));
    step.badge.style.background = state === 'done' ? 'var(--ok-soft)' : '';
    step.badge.style.color = state === 'done' ? 'var(--ok)' : '';
    step.card.style.borderColor = state === 'active' ? 'var(--accent-line)' : '';
    step.card.style.boxShadow = state === 'active' ? '0 0 0 1px var(--accent-line), var(--shadow-sm)' : '';
    step.card.style.opacity = state === 'todo' ? '0.78' : '';
  }

  function btn(label, iconName, cls, onClick, attrs) {
    var a = { class: 'as-btn' + (cls ? ' ' + cls : ''), type: 'button', on: { click: onClick } };
    if (attrs) for (var k in attrs) a[k] = attrs[k];
    var lab = el('span', { class: 'as-btn__label' }, label);
    var b = el('button', a, iconName ? icon(iconName) : null, lab);
    b._label = lab;
    return b;
  }

  function mount(panelEl) {
    if (!panelEl || panelEl.nodeType !== 1) throw new TypeError('AS.modes.live.mount: panel öğesi gerekli');
    if (M) unmount();
    var c = caps();
    var m = M = {
      panel: panelEl, sess: null, picking: false, reader: null, readerP: null, ocrState: 'idle', ocrProg: 0, ocrErr: '',
      regionVisible: true, drag: null, dragRegion: null, keyTimer: null, renderQueued: false, notes: {}, busFns: [],
      ro: null, luma: null
    };

    /* ---- uyarılar ---- */
    m.notesBox = el('div', { class: 'as-col', role: 'region', 'aria-label': 'Canlı çeviri uyarıları', style: { gap: '10px', marginBottom: '16px' } });
    m.notesBox.hidden = true;

    /* ---- 3 adım ---- */
    var s1 = stepCard(1, 'Sekme / pencere seç',
      'Videonun açık olduğu sekmeyi seçin; “Sekme sesini de paylaş” kutusu işaretli kalsın.');
    var s2 = stepCard(2, 'Altyazı bölgesini ayarla',
      'Turuncu kutuyu videodaki altyazının üstüne sürükleyin; köşelerinden boyutlandırın.');
    var s3 = stepCard(3, 'Altyazı penceresini aç',
      'Türkçe altyazı her zaman üstte duran küçük bir pencerede görünür. Onu videonun altına taşıyıp video sekmesine geçin.' +
      (c.docPip ? '' : ' (Bu tarayıcıda normal bir açılır pencere açılır.)'));
    m.steps = [s1, s2, s3];

    m.pickBtn = btn('Sekme / pencere seç', 'share', 'as-btn--primary', pick, { 'data-act': 'pick' });
    m.shareChip = el('span', { class: 'as-chip as-chip--ok', hidden: true, style: { maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } });
    m.repickBtn = btn('Değiştir', 'swap', 'as-btn--sm', pick, { hidden: true, title: 'Başka bir sekme veya pencere seçer', 'data-act': 'repick' });
    m.stopBtn = btn('Durdur', 'stop', 'as-btn--danger as-btn--sm', function () { stop(); }, { hidden: true, 'data-act': 'stop', title: 'Paylaşımı ve çeviriyi durdurur' });
    s1.body.appendChild(m.pickBtn);
    s1.body.appendChild(m.shareChip);
    s1.body.appendChild(m.repickBtn);
    s1.body.appendChild(m.stopBtn);

    m.regionResetBtn = btn('Varsayılana döndür', 'reset', 'as-btn--sm as-btn--ghost', function () {
      AS.settings.set('ocrRegion', AS.settings.defaults().ocrRegion);
      status('Altyazı bölgesi varsayılana (ekranın alt kısmı) döndürüldü.', 'info');
    }, { 'data-act': 'region-reset', title: 'Bölgeyi ekranın alt üçte birine döndürür' });
    s2.body.appendChild(m.regionResetBtn);

    m.pipBtn = btn('Altyazı penceresini aç', 'pip', '', onPip, { 'data-act': 'pip' });
    s3.body.appendChild(m.pipBtn);

    var stepsCol = el('div', { class: 'as-col as-live-steps', role: 'list', 'aria-label': 'Üç adımda canlı çeviri', style: { gap: '12px' } },
      s1.card, s2.card, s3.card);
    [s1, s2, s3].forEach(function (st) { st.card.setAttribute('role', 'listitem'); });

    /* ---- sahne ---- */
    var v = el('video', { class: 'as-stage__media', muted: true, autoplay: true, playsinline: true,
      disablepictureinpicture: true, 'aria-label': 'Paylaşılan sekmenin önizlemesi', hidden: true });
    v.muted = true;
    v.playsInline = true;
    m.video = v;
    m.emptyPick = btn('Sekme / pencere seç', 'share', 'as-btn--primary as-btn--lg', pick, { 'data-act': 'pick-stage' });
    m.empty = el('div', { class: 'as-stage__empty' },
      icon('share'),
      el('div', { style: { fontSize: '19px', fontWeight: '700', color: 'var(--text)' } }, 'Önizleme burada görünecek'),
      el('p', { style: { maxWidth: '470px', margin: '0' } },
        'Videonun açık olduğu sekmeyi seçince görüntüsü burada belirir. Videoyu kendi sekmesinde izlemeye devam edersiniz; bu önizleme yalnızca ayar içindir.'),
      m.emptyPick);
    var handles = ['nw', 'ne', 'sw', 'se'].map(function (h) { return el('span', { class: 'as-region__handle', 'data-h': h, 'aria-hidden': 'true' }); });
    m.regionLabel = el('span', { class: 'as-region__label' }, 'Altyazı bölgesi');
    m.regionEl = el('div', {
      class: 'as-region is-hidden', tabindex: '0', role: 'group',
      'aria-label': 'Altyazı bölgesi. Taşımak için sürükleyin veya ok tuşlarını kullanın; Shift ile ok tuşları boyutlandırır.',
      title: 'Sürükleyin: taşı · Köşeler: boyutlandır · Ok tuşları: taşı · Shift + ok: boyutlandır'
    }, m.regionLabel, handles);
    m.regionToggle = el('button', { class: 'as-icon-btn', type: 'button', title: 'Bölge kutusunu gizle', 'aria-label': 'Bölge kutusunu gizle', 'aria-pressed': 'true',
      on: { click: function () { m.regionVisible = !m.regionVisible; layoutRegion(); scheduleRender(); } } }, icon('eye'));
    m.fsBtn = el('button', { class: 'as-icon-btn', type: 'button', title: 'Tam ekran', 'aria-label': 'Önizlemeyi tam ekran yap',
      on: { click: function () { if (AS.subs && AS.subs.fullscreen) AS.subs.fullscreen(m.stage); } } }, icon('fullscreen'));
    m.stage = el('div', { class: 'as-stage', 'data-live-stage': '' }, v, m.empty, m.regionEl,
      el('div', { class: 'as-stage__controls' }, m.regionToggle, m.fsBtn));
    if (AS.subs && typeof AS.subs.attach === 'function') m.overlay = AS.subs.attach(m.stage) || null;

    /* ---- yan panel: yöntem ve dil ---- */
    m.segBtns = {};
    var seg = el('div', { class: 'as-seg', role: 'group', 'aria-label': 'Çeviri yöntemi', style: { display: 'flex', width: '100%' } },
      [['auto', 'Otomatik'], ['ocr', 'Ekrandaki yazı'], ['speech', 'Konuşma']].map(function (o) {
        var b = el('button', { type: 'button', 'aria-pressed': 'false', 'data-value': o[0], style: { flex: '1 1 auto', padding: '7px 8px' },
          on: { click: function () { try { AS.settings.set('liveMode', o[0]); } catch (e) { status(errMsg(e), 'error'); } } } }, o[1]);
        m.segBtns[o[0]] = b;
        return b;
      }));
    m.langSel = el('select', { class: 'as-select', id: 'as-live-lang', style: { maxWidth: 'none' },
      on: { change: function () { try { AS.settings.set('asrLang', String(m.langSel.value)); } catch (e) { status(errMsg(e), 'error'); } } } },
    U.LANGS.map(function (o) { return el('option', { value: o[0] }, o[1]); }));
    var methodCard = el('section', { class: 'as-card' },
      el('div', { class: 'as-card__head' }, el('div', { class: 'as-card__icon' }, icon('type')),
        el('div', null, el('h3', { class: 'as-card__title' }, 'Çeviri yöntemi'), el('div', { class: 'as-card__sub' }, 'Değişiklikler hemen uygulanır'))),
      settingRow('Yöntem',
        'Otomatik: ekranda altyazı varsa onu okur; 4 saniye altyazı görmezse konuşmayı dinleyip çevirir (önerilen). ' +
        'Ekrandaki yazı: yalnızca videonun ya da sitenin gösterdiği altyazıyı okur; az işlemci kullanır. ' +
        'Konuşma: yalnızca sesi yazıya döküp çevirir; altyazısız videolar içindir ve sekme sesinin paylaşılması gerekir.', seg, null),
      settingRow('Videonun dili',
        'Videodaki konuşmanın ve altyazının dili. Biliyorsanız seçin: otomatik algılamadan daha doğru ve hızlıdır. Ekrandan okuma şimdilik Latin harfli dillerde en iyi sonucu verir.',
        m.langSel, 'as-live-lang'));

    /* ---- yan panel: canlı durum ---- */
    m.rShare = statusRow('Paylaşım');
    m.rAudio = statusRow('Sekme sesi');
    m.rOcr = statusRow('Ekrandan okuma');
    m.rFrames = statusRow('Görüntü alma');
    m.rSpeech = statusRow('Konuşma tanıma');
    m.progBar = el('div', { class: 'as-progress__bar' });
    m.prog = el('div', { class: 'as-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Konuşma modeli indirme' }, m.progBar);
    m.progLabel = el('div', { class: 'as-hint', style: { marginBottom: '6px' } });
    m.progHint = el('div', { class: 'as-hint', style: { marginTop: '6px' } });
    m.progBox = el('div', { hidden: true, style: { margin: '2px 0 4px' } }, m.progLabel, m.prog, m.progHint);
    m.lastKind = el('span', { class: 'as-chip', style: { marginRight: '8px' } }, '');
    m.lastText = el('span', { translate: 'no', 'data-live-last': '' }, '');
    m.lastBox = el('div', { style: {
      padding: '9px 12px', borderRadius: '9px', background: 'var(--bg-2)', border: '1px solid var(--border)',
      fontSize: '14px', color: 'var(--text-2)', minHeight: '42px', overflowWrap: 'anywhere', lineHeight: '1.45'
    } }, m.lastKind, m.lastText);
    var stateCard = el('section', { class: 'as-card' },
      el('div', { class: 'as-card__head' }, el('div', { class: 'as-card__icon' }, icon('pulse')),
        el('div', null, el('h3', { class: 'as-card__title' }, 'Canlı durum'), el('div', { class: 'as-card__sub' }, 'Neyin çalıştığını buradan izleyin'))),
      el('div', { class: 'as-status-list' }, m.rShare.row, m.rAudio.row, m.rOcr.row, m.rFrames.row, m.rSpeech.row),
      m.progBox,
      el('div', { class: 'as-label', style: { margin: '10px 0 6px', fontSize: '13px', color: 'var(--muted)', fontWeight: '600' } }, 'Son okunan (orijinal)'),
      m.lastBox);

    var cards = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))', gap: '18px', alignItems: 'start' } },
      methodCard, stateCard);
    var split = el('div', { class: 'as-split' },
      el('div', { class: 'as-col', style: { gap: '18px', minWidth: '0' } }, m.stage, cards),
      stepsCol);

    m.root = el('div', { class: 'as-live', 'data-mode-root': 'live' }, m.notesBox, split);
    panelEl.appendChild(m.root);

    /* ---- olaylar ---- */
    bindRegion(m);
    v.addEventListener('loadedmetadata', function () { layoutRegion(); scheduleRender(); });
    v.addEventListener('resize', function () { layoutRegion(); scheduleRender(); });
    if (typeof root.ResizeObserver === 'function') {
      m.ro = new root.ResizeObserver(function () { layoutRegion(); });
      m.ro.observe(m.stage);
    } else {
      m.onWinResize = function () { layoutRegion(); };
      root.addEventListener('resize', m.onWinResize);
    }
    var onSettings = function (ev) { onSetting(ev && ev.key, ev && ev.value); };
    var onPipEv = function () { scheduleRender(); };
    AS.bus.on('settings', onSettings);
    AS.bus.on('pip', onPipEv);
    m.busFns = [['settings', onSettings], ['pip', onPipEv]];
    m.onVis = function () { if (!doc.hidden && M === m) render(); };
    doc.addEventListener('visibilitychange', m.onVis);

    render();
  }

  function unmount() {
    var m = M;
    if (!m) return;
    if (m.sess) endSession(m.sess, 'unmount');
    M = null;
    m.busFns.forEach(function (b) { AS.bus.off(b[0], b[1]); });
    if (m.ro) { try { m.ro.disconnect(); } catch (e) { /* yok */ } }
    if (m.onWinResize) root.removeEventListener('resize', m.onWinResize);
    doc.removeEventListener('visibilitychange', m.onVis);
    if (m.keyTimer) clearTimeout(m.keyTimer);
    if (m.reader) { var r = m.reader; m.reader = null; r.terminate().catch(function () {}); }
    m.readerP = null; // bekleyen oluşturma bitince kendini kapatır (M !== m)
    if (AS.subs && typeof AS.subs.detach === 'function') AS.subs.detach(m.stage);
    if (m.root && m.root.parentNode) m.root.parentNode.removeChild(m.root);
  }

  function onPip() {
    var S = AS.subs;
    if (!S || typeof S.openPip !== 'function') { status('Altyazı penceresi kullanılamıyor.', 'error'); return; }
    if (S.isPipOpen()) { S.closePip(); scheduleRender(); return; }
    S.openPip().then(function (ok) {
      if (ok) status('Altyazı penceresi açıldı. Pencereyi videonun altına taşıyın ve videonun sekmesine geçin; altyazı penceresi üstte kalır.', 'ok');
      scheduleRender();
    }, function (e) { status('Altyazı penceresi açılamadı: ' + errMsg(e), 'error'); });
  }

  function onSetting(key, value) {
    if (!M) return;
    var s = M.sess;
    if (key === 'liveMode') { if (s) applyMode(s); layoutRegion(); }
    else if (key === 'asrLang') { if (s && s.speech) s.speech.carry = null; }
    else if (key === 'asrModel') { if (s && s.speech) { s.speech.queue = []; s.speech.carry = null; loadModel(s, s.speech); } }
    else if (key === 'ocrInterval') { if (s && s.clock) s.clock.setInterval(ocrInterval()); }
    else if (key === 'ocrRegion') { if (!M.drag) layoutRegion(); if (s && s.ocr) s.ocr.asm.reset(); }
    else if (key === 'translateOnline') { /* sonraki çeviride kullanılır */ }
    void value;
    scheduleRender();
  }

  /* ---------- bölge kutusu (videonun gerçek görüntü alanına göre) ---------- */
  function contentRect() {
    var m = M;
    if (!m) return null;
    var sw = m.stage.clientWidth, sh = m.stage.clientHeight;
    var vw = m.video.videoWidth, vh = m.video.videoHeight;
    if (!(sw > 0 && sh > 0 && vw > 0 && vh > 0)) return null;
    var sc = Math.min(sw / vw, sh / vh);   // object-fit: contain → kenarlarda siyah bant olabilir
    var w = vw * sc, h = vh * sc;
    return { x: (sw - w) / 2, y: (sh - h) / 2, w: w, h: h };
  }

  function wantRegion() { return liveMode() !== 'speech'; }

  function layoutRegion() {
    var m = M;
    if (!m) return;
    var R = m.regionEl;
    var cr = m.sess && m.sess.vtrack ? contentRect() : null;
    var show = !!(cr && wantRegion() && m.regionVisible);
    R.classList.toggle('is-hidden', !show);
    placeOverlay(m, cr && wantRegion() ? (m.dragRegion || region()) : null);
    if (!show) return;
    var r = m.dragRegion || region();
    R.style.left = (cr.x + r.x * cr.w).toFixed(1) + 'px';
    R.style.top = (cr.y + r.y * cr.h).toFixed(1) + 'px';
    R.style.width = (r.w * cr.w).toFixed(1) + 'px';
    R.style.height = (r.h * cr.h).toFixed(1) + 'px';
    // Kutu en üstteyse etiketi içeri al (sahnenin dışında kesilmesin)
    m.regionLabel.style.top = (cr.y + r.y * cr.h < 30) ? '6px' : '';
  }

  /** Önizlemede Türkçe satır, okunan bölgenin üstüne binmesin: bölge alt yarıdaysa satır üste, değilse alta.
   *  (Yalnızca bu sahnenin katmanı; genel "altyazı konumu" ayarı ve altyazı penceresi etkilenmez.) */
  function placeOverlay(m, r) {
    var o = m.overlay;
    if (!o || !o.style) return;
    if (!r) { o.style.justifyContent = ''; o.style.padding = ''; return; }
    var lower = r.y + r.h / 2 >= 0.5;
    o.style.justifyContent = lower ? 'flex-start' : 'flex-end';
    // Üstteyken sahnenin sağ üstteki düğmelerinin (göz, tam ekran) altında kalmasın
    o.style.padding = lower ? 'max(4.5%, 54px) 4% 0' : '0 4% 5.5%';
  }

  function bindRegion(m) {
    var R = m.regionEl;
    R.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || M !== m) return;
      var cr = contentRect();
      if (!cr) return;
      var h = (e.target && e.target.getAttribute && e.target.getAttribute('data-h')) || 'move';
      m.drag = { id: e.pointerId, h: h, sx: e.clientX, sy: e.clientY, start: region(), cr: cr };
      try { R.setPointerCapture(e.pointerId); } catch (x) { /* yok */ }
      e.preventDefault();
      R.focus({ preventScroll: true });
    });
    R.addEventListener('pointermove', function (e) {
      var d = m.drag;
      if (!d || e.pointerId !== d.id) return;
      var dx = (e.clientX - d.sx) / d.cr.w, dy = (e.clientY - d.sy) / d.cr.h;
      m.dragRegion = moveRegion(d.start, d.h, dx, dy);
      layoutRegion();
    });
    var end = function (e) {
      var d = m.drag;
      if (!d || e.pointerId !== d.id) return;
      m.drag = null;
      try { R.releasePointerCapture(e.pointerId); } catch (x) { /* yok */ }
      var r = m.dragRegion;
      m.dragRegion = null;
      if (r) saveRegion(r);
      layoutRegion();
    };
    R.addEventListener('pointerup', end);
    R.addEventListener('pointercancel', end);
    R.addEventListener('keydown', function (e) {
      var dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      var dd = dirs[e.key];
      if (!dd || M !== m) return;
      e.preventDefault();
      var step = e.altKey ? 0.002 : 0.01;
      var base = m.dragRegion || region();
      m.dragRegion = e.shiftKey ? moveRegion(base, 'se', dd[0] * step, dd[1] * step) : moveRegion(base, 'move', dd[0] * step, dd[1] * step);
      layoutRegion();
      if (m.keyTimer) clearTimeout(m.keyTimer);
      m.keyTimer = setTimeout(function () {
        m.keyTimer = null;
        if (m.dragRegion) { var r = m.dragRegion; m.dragRegion = null; saveRegion(r); }
      }, 350);
    });
  }

  function moveRegion(s, h, dx, dy) {
    var x = s.x, y = s.y, w = s.w, hh = s.h;
    if (h === 'move') {
      x = U.clamp(s.x + dx, 0, 1 - s.w);
      y = U.clamp(s.y + dy, 0, 1 - s.h);
    } else {
      if (h.indexOf('w') >= 0) { var nx = U.clamp(s.x + dx, 0, s.x + s.w - MIN_RW); w = s.x + s.w - nx; x = nx; }
      if (h.indexOf('e') >= 0) { w = U.clamp(s.w + dx, MIN_RW, 1 - s.x); }
      if (h.indexOf('n') >= 0) { var ny = U.clamp(s.y + dy, 0, s.y + s.h - MIN_RH); hh = s.y + s.h - ny; y = ny; }
      if (h.indexOf('s') >= 0) { hh = U.clamp(s.h + dy, MIN_RH, 1 - s.y); }
    }
    return { x: x, y: y, w: w, h: hh };
  }

  function saveRegion(r) {
    try { AS.settings.set('ocrRegion', round4(normRegion(r))); } catch (e) { status('Bölge kaydedilemedi: ' + errMsg(e), 'error'); }
  }

  /* ---------- uyarı notları ---------- */
  function setNote(id, level, text, action) {
    var m = M;
    var cur = m.notes[id];
    if (!text) {
      if (cur) { if (cur.node.parentNode) cur.node.parentNode.removeChild(cur.node); delete m.notes[id]; }
      m.notesBox.hidden = !Object.keys(m.notes).length;
      return;
    }
    var key = level + '|' + text + '|' + (action ? action.label : '');
    if (cur && cur.key === key) return;
    var ic = icon(level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'ok' ? 'ok' : 'info', 18);
    ic.style.flex = 'none';
    ic.style.marginTop = '2px';
    var node = el('div', { class: 'as-note as-note--' + level, role: level === 'error' ? 'alert' : 'status', 'data-note': id },
      ic, el('div', { class: 'as-grow' }, text),
      action ? el('button', { class: 'as-btn as-btn--sm', type: 'button', style: { flex: 'none', marginTop: '-3px' }, on: { click: action.fn } }, action.label) : null);
    if (cur && cur.node.parentNode) cur.node.parentNode.replaceChild(node, cur.node);
    else m.notesBox.appendChild(node);
    m.notes[id] = { node: node, key: key };
    m.notesBox.hidden = false;
  }

  function renderNotes(c) {
    var m = M, s = m.sess, mode = liveMode();
    if (!c.gdm) {
      setNote('gdm', 'error', !c.secure
        ? 'Sayfa güvenli (https) bağlantıyla açılmadığı için sekme paylaşımı kapalı. Adresi https:// ile açın.'
        : 'Bu tarayıcı sekme veya ekran paylaşımını desteklemiyor (telefon, tablet ve eski Safari sürümlerinde bu özellik yoktur). Bilgisayarda güncel Chrome veya Edge kullanın; ya da “Video dosyası” ve “YouTube” bölümlerini deneyin.');
    } else setNote('gdm');
    setNote('noaudio-browser', c.gdm && !c.tabAudio ? 'warn' : '', c.gdm && !c.tabAudio
      ? 'Bu tarayıcı başka sekmelerin sesini paylaşamaz: yalnızca ekrandaki altyazı okunur, konuşma çevrilemez. Konuşma çevirisi için Chrome veya Edge kullanın.' : '');
    setNote('noocr', !c.ocr ? 'warn' : '', !c.ocr ? 'Ekrandaki yazıyı okuma bu tarayıcıda çalışmıyor (WebAssembly veya Web Worker yok).' : '');
    setNote('frames', s && s.frames && s.frames.kind === 'video' ? 'info' : '', s && s.frames && s.frames.kind === 'video'
      ? 'Bu tarayıcı görüntüyü doğrudan alamıyor: bu sekme arka plandayken ekran okuma durabilir. Altyazı Şefi\'ni ayrı bir pencerede, videonun yanında açık tutun.' : '');
    // Paylaşımda ses yok
    if (s && !s.atrack && mode !== 'ocr' && c.tabAudio) {
      setNote('noaudio', mode === 'speech' ? 'error' : 'warn', mode === 'speech'
        ? 'Ses paylaşılmadı: Konuşma yöntemi için sekme sesi gerekli. Yeniden paylaşıp “Sekme sesini de paylaş” kutusunu işaretleyin (pencere paylaşımında ses yoktur, sekme seçin).'
        : 'Ses paylaşılmadı: yalnızca ekrandaki altyazı okunuyor. Konuşmayı da çevirmek için yeniden paylaşıp “Sekme sesini de paylaş” kutusunu işaretleyin.',
      { label: 'Sesle yeniden paylaş', fn: pick });
    } else setNote('noaudio');
    setNote('nospeech-ocr', s && mode === 'speech' && !c.speech ? 'error' : '', s && mode === 'speech' && !c.speech
      ? 'Konuşma tanıma bu tarayıcıda çalışmıyor. “Ekrandaki yazı” yöntemini seçin.' : '');
    setNote('black', s && s.black && s.ocr ? 'info' : '', s && s.black && s.ocr
      ? 'Paylaşılan görüntü siyah görünüyor. Netflix gibi korumalı sitelerde video görüntüsü paylaşılamaz; sitenin kendi altyazısı açıksa yine okunur. Altyazı yoksa “Konuşma” yöntemini deneyin.' : '');
    var sp = s && s.speech;
    if (sp && sp.lagging) {
      var tiny = asrModel() === 'tiny';
      setNote('lag', 'warn', 'Konuşma tanıma bu bilgisayara ağır geliyor; geride kalmamak için eski bölümler atlanıyor.' +
        (tiny ? ' Diğer programları ve sekmeleri kapatmayı deneyin.' : ' Ayarlar\'dan “Hızlı (tiny)” modeli seçmeniz önerilir.'),
      tiny ? null : { label: 'Hızlı modele geç', fn: function () { AS.settings.set('asrModel', 'tiny'); } });
    } else setNote('lag');
    if (sp && sp.modelState === 'error') {
      setNote('model', 'error', 'Konuşma modeli yüklenemedi: ' + sp.modelErr, { label: 'Tekrar dene', fn: function () { if (M && M.sess && M.sess.speech) loadModel(M.sess, M.sess.speech); } });
    } else setNote('model');
    if (s && s.ocr && m.ocrState === 'error') {
      setNote('ocr', 'error', 'Ekran okuma başlatılamadı: ' + m.ocrErr, { label: 'Tekrar dene', fn: function () { ensureReader().catch(function () {}); } });
    } else setNote('ocr');
  }

  /* ---------- çizim ---------- */
  function scheduleRender() {
    var m = M;
    if (!m || m.renderQueued) return;
    m.renderQueued = true;
    var run = function () { if (M === m) { m.renderQueued = false; render(); } };
    // Gizli sekmede rAF çalışmaz; görünür olunca (visibilitychange) yeniden çizilir.
    if (!doc.hidden && root.requestAnimationFrame) root.requestAnimationFrame(run);
    else setTimeout(run, 400);
  }

  function render() {
    var m = M;
    if (!m) return;
    m.renderQueued = false;
    var c = caps();
    var s = m.sess;
    var mode = liveMode();
    var running = !!s;
    var pipOpen = !!(AS.subs && AS.subs.isPipOpen && AS.subs.isPipOpen());

    renderNotes(c);

    // Adım 1
    m.pickBtn.hidden = running;
    m.pickBtn.disabled = !c.gdm || m.picking;
    m.pickBtn.classList.toggle('is-busy', m.picking);
    m.emptyPick.disabled = !c.gdm || m.picking;
    m.emptyPick.classList.toggle('is-busy', m.picking);
    m.shareChip.hidden = !running;
    m.repickBtn.hidden = !running || !c.gdm;
    m.stopBtn.hidden = !running;
    if (running) {
      setText(m.shareChip, s.label ? 'Paylaşılıyor: ' + s.label : 'Paylaşılıyor');
    }
    setStep(m.steps[0], running ? 'done' : 'active');
    setStepText(m.steps[0], running ? '' : undefined);
    // Adım 2
    var regionOn = wantRegion();
    m.regionResetBtn.hidden = !regionOn || !running;
    m.steps[1].body.hidden = m.regionResetBtn.hidden;
    setStep(m.steps[1], !running ? 'todo' : (regionOn ? 'active' : 'done'));
    setStepText(m.steps[1], regionOn ? undefined : 'Konuşma yönteminde bölge gerekmez; yalnızca ses dinlenir.');
    // Adım 3
    m.pipBtn._label.textContent = pipOpen ? 'Altyazı penceresini kapat' : 'Altyazı penceresini aç';
    m.pipBtn.classList.toggle('as-btn--primary', running && !pipOpen);
    m.pipBtn.classList.toggle('is-active', pipOpen);
    m.pipBtn.setAttribute('aria-pressed', pipOpen ? 'true' : 'false');
    setStep(m.steps[2], pipOpen ? 'done' : running ? 'active' : 'todo');
    setStepText(m.steps[2], pipOpen ? 'Pencere açık. Şimdi videonun sekmesine geçin; Türkçe altyazı bu pencerede, her şeyin üstünde görünür.' : undefined);

    // Yöntem ve dil
    for (var k in m.segBtns) m.segBtns[k].setAttribute('aria-pressed', k === mode ? 'true' : 'false');
    var lang = asrLang();
    if (m.langSel.value !== lang) m.langSel.value = lang;

    // Sahne düğmeleri
    m.regionToggle.hidden = !running || !regionOn;
    var rv = m.regionVisible;
    if (m.regionToggle._vis !== rv) {
      m.regionToggle._vis = rv;
      U.clear(m.regionToggle);
      m.regionToggle.appendChild(icon(rv ? 'eye' : 'eyeOff'));
      m.regionToggle.title = rv ? 'Bölge kutusunu gizle' : 'Bölge kutusunu göster';
      m.regionToggle.setAttribute('aria-label', m.regionToggle.title);
      m.regionToggle.setAttribute('aria-pressed', rv ? 'true' : 'false');
    }
    m.fsBtn.hidden = !running;

    // Canlı durum
    if (!running) setChip(m.rShare.chip, m.picking ? 'Seçiliyor…' : 'Bekleniyor', m.picking ? 'accent' : null);
    else setChip(m.rShare.chip, s.label ? 'Açık · ' + s.label : 'Açık', 'ok');
    if (!running) setChip(m.rAudio.chip, '—', null);
    else if (s.atrack) setChip(m.rAudio.chip, 'Paylaşıldı', 'ok');
    else setChip(m.rAudio.chip, 'Paylaşılmadı', mode === 'ocr' ? null : 'warn', 'Paylaşırken “Sekme sesini de paylaş” kutusunu işaretleyin.');
    renderOcrChip(m, s, mode, c);
    if (!running || !s.frames) { setChip(m.rFrames.chip, '—', null); }
    else if (s.frames.kind === 'video') setChip(m.rFrames.chip, 'Önizlemeden', 'warn', 'Bu sekme arka plandayken ekran okuma durabilir.');
    else setChip(m.rFrames.chip, 'Doğrudan', 'ok', 'Kareler paylaşımdan doğrudan alınır; bu sekme arka plandayken de okuma sürer.');
    renderSpeech(m, s, mode, c);

    var last = s && s.lastOriginal;
    m.lastKind.hidden = !last;
    if (last) {
      setChip(m.lastKind, last.kind === 'ocr' ? 'Ekrandan' : 'Konuşmadan', last.kind === 'ocr' ? 'accent' : null);
      setText(m.lastText, last.text);
      m.lastText.style.color = 'var(--text)';
    } else {
      setText(m.lastText, running ? 'Henüz bir şey okunmadı.' : 'Paylaşım başlayınca burada görünür.');
      m.lastText.style.color = '';
    }
  }

  function renderOcrChip(m, s, mode, c) {
    var chip = m.rOcr.chip;
    if (!c.ocr) { setChip(chip, 'Desteklenmiyor', 'warn'); return; }
    if (mode === 'speech') { setChip(chip, 'Kapalı', null, 'Yöntem: Konuşma'); return; }
    if (m.ocrState === 'loading') { setChip(chip, 'Hazırlanıyor %' + Math.round((m.ocrProg || 0) * 100), 'accent', 'Ekran okuma motoru yükleniyor (ilk seferde yaklaşık 7 MB).'); return; }
    if (m.ocrState === 'error') { setChip(chip, 'Çalışmıyor', 'error', m.ocrErr); return; }
    if (!s) { setChip(chip, m.reader ? 'Hazır' : '—', m.reader ? 'ok' : null); return; }
    if (!s.ocr) { setChip(chip, s.vtrack ? 'Kapalı' : 'Görüntü yok', null); return; }
    var o = s.ocr, now = U.now();
    var n = 0;
    for (var i = 0; i < o.readTimes.length; i++) if (now - o.readTimes[i] <= 5000) n++;
    var span = Math.min(5000, Math.max(1000, now - s.stats.startedAt));
    var rate = n / (span / 1000);
    setChip(chip, fmt1(rate) + ' okuma/sn', rate > 0 ? 'ok' : null,
      'Son 5 saniyede ' + n + ' okuma · ayar: her ' + fmt1(ocrInterval() / 1000) + ' sn · toplam ' + s.stats.sentences + ' satır');
  }

  function renderSpeech(m, s, mode, c) {
    var chip = m.rSpeech.chip;
    var sp = s && s.speech;
    var showProg = false;
    if (!c.speech) setChip(chip, 'Desteklenmiyor', 'warn');
    else if (mode === 'ocr') setChip(chip, 'Kapalı', null, 'Yöntem: Ekrandaki yazı');
    else if (!s) setChip(chip, AS.asr && AS.asr.isLoaded && AS.asr.isLoaded() ? 'Model hazır' : '—', AS.asr && AS.asr.isLoaded && AS.asr.isLoaded() ? 'ok' : null);
    else if (!s.atrack) setChip(chip, 'Ses yok', 'warn', 'Ses paylaşılmadı');
    else if (!sp) setChip(chip, '—', null);
    else if (sp.tapError) setChip(chip, 'Ses alınamadı', 'error', sp.tapError);
    else if (sp.modelState === 'error') setChip(chip, 'Model yüklenemedi', 'error', sp.modelErr);
    else if (sp.modelState === 'loading') {
      var pr = sp.prog;
      var pct = pr && pr.total > 0 ? Math.round(U.clamp(pr.loaded / pr.total, 0, 1) * 100) : -1;
      setChip(chip, pct >= 0 ? 'Model iniyor %' + pct : 'Model yükleniyor…', 'accent');
      showProg = true;
      m.prog.classList.toggle('is-indeterminate', pct < 0);
      m.progBar.style.width = pct >= 0 ? pct + '%' : '';
      if (pct >= 0) m.prog.setAttribute('aria-valuenow', String(pct)); else m.prog.removeAttribute('aria-valuenow');
      setText(m.progLabel, (MODEL_NAME[sp.model] ? 'Konuşma modeli: ' + MODEL_NAME[sp.model] : 'Konuşma modeli') +
        (pr && pr.total > 100000 ? ' · ' + U.fmtBytes(pr.loaded) + ' / ' + U.fmtBytes(pr.total) : ''));
      setText(m.progHint, 'İlk kullanımda bir kez indirilir (' + (MODEL_SIZE[sp.model] || 'onlarca MB') +
        '); sonra bu bilgisayarda saklanır ve hızlı açılır. Bu sırada ' + (mode === 'auto' ? 'ekrandaki altyazı okunmaya devam eder.' : 'lütfen bekleyin.'));
    } else {
      var lagTxt = sp.lagEma ? ' · ' + fmt1(sp.lagEma / 1000) + ' sn gecikme' : '';
      var busy = sp.busy || sp.queue.length;
      setChip(chip, (busy ? 'Yazıya döküyor' : 'Dinliyor') + lagTxt, sp.lagging ? 'warn' : 'ok',
        'Model: ' + (MODEL_NAME[sp.model] || sp.model) + ' (' + (sp.device === 'webgpu' ? 'WebGPU' : 'WebAssembly') + ') · ' +
        s.stats.transcribed + ' bölüm yazıya döküldü' + (s.stats.speechDropped ? ' · ' + s.stats.speechDropped + ' bölüm atlandı' : ''));
    }
    m.progBox.hidden = !showProg;
  }

  /* ------------------------------------------------------------------ */
  /* dışa açılan API                                                     */
  /* ------------------------------------------------------------------ */
  /** Test ve tanılama için anlık sayaçlar (salt okunur kopya). */
  function stats() {
    var s = M && M.sess;
    var st = s ? s.stats : lastStats;
    var out = st ? JSON.parse(JSON.stringify(st)) : null;
    if (!out) return { running: false };
    out.running = !!s;
    out.mode = liveMode();
    out.visibility = doc.visibilityState;
    if (s) {
      out.clock = s.clock ? s.clock.kind : null;
      out.clockAlive = !!(s.clock && s.clock.alive());
      out.frames = s.frames ? s.frames.kind : null;
      out.framesIn = s.frames ? s.frames.frames : 0;
      out.ocr = !!s.ocr;
      out.ocrState = M.ocrState;
      out.speech = !!s.speech;
      out.speechState = s.speech ? s.speech.modelState : null;
      out.speechBusy = !!(s.speech && s.speech.busy);
      out.speechQueue = s.speech ? s.speech.queue.length : 0;
      out.lagMs = s.speech ? Math.round(s.speech.lagEma) : 0;
      out.lastOriginal = s.lastOriginal;
      out.audio = !!s.atrack;
    }
    return out;
  }

  AS.modes.live = {
    id: 'live',
    title: 'Canlı çeviri',
    icon: 'live',
    mount: mount,
    unmount: unmount,
    startWithStream: startWithStream,
    stop: stop,
    stats: stats,
    isRunning: function () { return !!(M && M.sess); }
  };
})(typeof window !== 'undefined' ? window : globalThis);

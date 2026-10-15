/* Altyazı Şefi Web: "YouTube" bölümü → AS.modes.youtube
 *
 * Bağlantı yapıştır → sıkı video kimliği çıkarımı ([A-Za-z0-9_-]{11}; yalnızca bilinen YouTube adresleri) →
 * YouTube IFrame API (https://www.youtube.com/iframe_api, bir kez yüklenir) → oynatıcı youtube-nocookie.com
 * üzerinden bizim .as-stage kutumuzda; Türkçe altyazı katmanı (AS.subs) ve kendi tam ekran düğmemiz.
 * Altyazı kaynakları:
 *   (a) .srt/.vtt dosyası → PreTranslator; oynatıcı zamanı (getCurrentTime) oynarken 200 ms'de bir okunur;
 *       "Senkron kaydır" ve "Türkçe SRT indir".
 *   (b) "Videonun sesinden altyazı" → getDisplayMedia (bu sekme, ses açık) → görüntü izi hemen kapatılır →
 *       AS.audio.tap → Segmenter → AS.asr.transcribe → çeviri → bus 'subtitle' (kind 'speech').
 * Saf yardımcılar (Node testlerinde de çalışır): parseLink, parseTime, watchUrl, errorInfo.
 * Ortak arayüz parçaları AS.subkit'ten (js/filemode.js) gelir. */
(function (root) {
  'use strict';
  var AS = root.AS = root.AS || {};
  AS.modes = AS.modes || {};

  var MODE = 'youtube';
  var ID_RE = /^[A-Za-z0-9_-]{11}$/;
  var API_URL = 'https://www.youtube.com/iframe_api';
  var EMBED_HOST = 'https://www.youtube-nocookie.com';
  var HOSTS = {
    'youtube.com': 1, 'www.youtube.com': 1, 'm.youtube.com': 1, 'music.youtube.com': 1,
    'youtu.be': 2, 'www.youtu.be': 2,
    'youtube-nocookie.com': 1, 'www.youtube-nocookie.com': 1
  };
  var BAD_LINK = 'Bu bir YouTube video bağlantısı değil. Örnek: https://www.youtube.com/watch?v=… ya da https://youtu.be/…';

  /* ================================================================== */
  /* Saf yardımcılar                                                     */
  /* ================================================================== */
  /** Sorgu dizesinden ham (kodu çözülmemiş) ilk değer; yoksa null. */
  function rawParam(search, name) {
    var q = String(search || '').replace(/^\?/, '');
    if (!q) return null;
    var parts = q.split('&');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var eq = p.indexOf('=');
      var k = eq < 0 ? p : p.slice(0, eq);
      if (k === name) return eq < 0 ? '' : p.slice(eq + 1);
    }
    return null;
  }

  /** YouTube başlangıç zamanı: "90", "90s", "1m30s", "1h2m3s", "1:30", "1:02:03" → saniye (tamsayı). Geçersizse 0. */
  function parseTime(v) {
    if (v === null || v === undefined) return 0;
    var s = String(v).trim().toLowerCase();
    if (!s || s.length > 20) return 0;
    var sec = NaN, m;
    if ((m = /^(\d{1,7})(?:\.\d{1,3})?s?$/.exec(s))) sec = parseInt(m[1], 10);
    else if ((m = /^(?:(\d{1,3})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s)?$/.exec(s)) && (m[1] || m[2] || m[3])) {
      sec = (parseInt(m[1] || '0', 10) * 3600) + (parseInt(m[2] || '0', 10) * 60) + parseInt(m[3] || '0', 10);
    } else if ((m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})$/.exec(s)) && parseInt(m[3], 10) < 60 && (!m[1] || parseInt(m[2], 10) < 60)) {
      sec = (parseInt(m[1] || '0', 10) * 3600) + (parseInt(m[2], 10) * 60) + parseInt(m[3], 10);
    }
    if (!isFinite(sec) || sec < 0 || sec > 360000) return 0;   // 100 saatten uzun: geçersiz say
    return sec;
  }

  /** Bağlantı ya da 11 karakterlik kimlik → {ok:true, id, start} | {ok:false, reason, message}. */
  function parseLink(input) {
    function bad(reason, message) { return { ok: false, reason: reason || 'invalid', message: message || BAD_LINK }; }
    if (typeof input !== 'string') return bad('empty', 'Bir YouTube bağlantısı yapıştırın.');
    var s = input.trim();
    if (!s) return bad('empty', 'Bir YouTube bağlantısı yapıştırın.');
    if (s.length > 2048) return bad('long');
    // İçeride boşluk, denetim ya da görünmez/yön karakteri yok
    if (/[\s\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/.test(s)) return bad();
    if (ID_RE.test(s)) return { ok: true, id: s, start: 0 };
    var str = s;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(str)) {
      // Şemasız: yalnızca bilinen bir YouTube alan adıyla başlıyorsa
      if (/^(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)(?:[/?#]|$)/i.test(str)) str = 'https://' + str;
      else return bad();
    }
    var u;
    try { u = new URL(str); } catch (e) { return bad(); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return bad('scheme');
    if (u.username || u.password || u.port) return bad();
    var host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!Object.prototype.hasOwnProperty.call(HOSTS, host)) return bad('host');
    var path = u.pathname;
    var id = null, m;
    if (HOSTS[host] === 2) {
      if ((m = /^\/([^/]+)\/?$/.exec(path))) id = m[1];
    } else if (/^\/watch\/?$/.test(path)) {
      id = rawParam(u.search, 'v');
      if (id === null && rawParam(u.search, 'list') !== null) {
        return bad('playlist', 'Bu bir oynatma listesi bağlantısı. Listeden bir videoyu açıp onun bağlantısını yapıştırın.');
      }
    } else if ((m = /^\/(?:shorts|embed|live|v|e)\/([^/]+)\/?$/.exec(path))) {
      id = m[1];
    } else if (/^\/playlist\/?$/.test(path)) {
      return bad('playlist', 'Bu bir oynatma listesi bağlantısı. Listeden bir videoyu açıp onun bağlantısını yapıştırın.');
    }
    if (!id || !ID_RE.test(id) || id === 'videoseries') return bad();
    var t = rawParam(u.search, 't');
    if (t === null) t = rawParam(u.search, 'start');
    if (t === null && u.hash) t = rawParam(u.hash.replace(/^#/, ''), 't');
    return { ok: true, id: id, start: parseTime(t) };
  }

  /** YouTube'da açma adresi (yalnızca doğrulanmış kimlikle). */
  function watchUrl(id, start) {
    if (!ID_RE.test(String(id || ''))) return null;
    var t = Math.max(0, Math.floor(Number(start) || 0));
    return 'https://www.youtube.com/watch?v=' + id + (t ? '&t=' + t + 's' : '');
  }

  /** IFrame API hata kodu → Türkçe ileti; external: YouTube'da açma ve Canlı çeviri önerilsin mi. */
  var YT_ERRORS = {
    2: 'Video kimliği geçersiz. Bağlantıyı kontrol edip yeniden yapıştırın.',
    5: 'Bu video tarayıcının oynatıcısında açılamadı (HTML5 oynatıcı hatası).',
    100: 'Video bulunamadı: kaldırılmış ya da gizli olabilir.',
    101: 'Video sahibi bu videonun başka sitelerde oynatılmasına izin vermiyor.',
    150: 'Video sahibi bu videonun başka sitelerde oynatılmasına izin vermiyor.',
    153: 'YouTube bu sayfadaki oynatıcıyı doğrulayamadı (oynatıcı yapılandırma hatası); video burada açılamıyor.'
  };
  function errorInfo(code) {
    var c = Number(code);
    var msg = YT_ERRORS[c] || ('Video oynatılamadı (YouTube hata kodu ' + (isFinite(c) ? c : '?') + ').');
    return { code: c, message: msg, external: c !== 2 };
  }

  /* ================================================================== */
  /* IFrame API yükleyici (bir kez)                                      */
  /* ================================================================== */
  var apiPromise = null;
  function loadApi() {
    var YT = root.YT;
    if (YT && typeof YT.Player === 'function') return Promise.resolve(YT);
    if (apiPromise) return apiPromise;
    apiPromise = new Promise(function (resolve, reject) {
      var doc = root.document;
      var done = false;
      var prev = root.onYouTubeIframeAPIReady;
      var script = doc.createElement('script');
      var timer = setTimeout(function () { fail(); }, 20000);
      function fail() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        apiPromise = null;
        if (script.parentNode) script.parentNode.removeChild(script);
        reject(new Error('YouTube oynatıcısı yüklenemedi. İnternet bağlantınızı kontrol edin; bir reklam ya da izleme engelleyici YouTube\'u engelliyor olabilir.'));
      }
      root.onYouTubeIframeAPIReady = function () {
        if (typeof prev === 'function') { try { prev(); } catch (e) { /* başkasının işleyicisi */ } }
        if (done) return;
        if (root.YT && typeof root.YT.Player === 'function') {
          done = true;
          clearTimeout(timer);
          resolve(root.YT);
        } else fail();
      };
      script.src = API_URL;
      script.async = true;
      script.onerror = fail;
      (doc.head || doc.documentElement).appendChild(script);
    });
    return apiPromise;
  }

  /* ================================================================== */
  /* Mod                                                                 */
  /* ================================================================== */
  var S = null;

  function K() { return AS.subkit; }
  function el() { return AS.util.el.apply(null, arguments); }
  function st(text, level) { AS.bus.emit('status', { mode: MODE, text: text, level: level || 'info' }); }
  function alive(gen) { return !!S && S.gen === gen; }

  function mount(panel) {
    if (!AS.subkit) throw new Error('Ortak bileşenler yüklenemedi (js/filemode.js).');
    if (S) unmount();
    var s = S = {
      gen: 1, panel: panel, cleanups: [], cardCleanups: [], view: new AS.subkit.CueView(),
      player: null, ready: false, state: -1, videoId: null, start: 0, poll: 0, pollN: 0,
      rawT: NaN, rawAt: 0, lastMs: NaN, lastAt: 0,
      track: null, sub: null, subFirst: false, subFrom: 'auto', listen: null, listenGen: 0, panel2: null
    };
    buildUi(s);
    panel.appendChild(s.root);
    AS.subs.attach(s.stage);
    s.cleanups.push(function () { AS.subs.detach(s.stage); });
    renderSource();
  }

  function unmount() {
    var s = S;
    if (!s) return;
    S = null;
    stopListening(s, null);
    if (s.track) { s.track.stop(); s.track = null; }
    destroyPlayer(s);
    s.view.reset();
    if (AS.subs) AS.subs.clear();
    s.cardCleanups.concat(s.cleanups).forEach(function (fn) { try { fn(); } catch (e) { /* */ } });
    s.cleanups = [];
    s.cardCleanups = [];
    if (AS.subkit) AS.subkit.revokeDownloads();
    if (s.root && s.root.parentNode) s.root.parentNode.removeChild(s.root);
  }

  /* ---------- arayüz ---------- */
  function buildUi(s) {
    var k = K();
    var U = AS.util;
    s.input = el('input', {
      class: 'as-input', type: 'url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', maxlength: '2048',
      placeholder: 'https://www.youtube.com/watch?v=…  ya da  https://youtu.be/…', 'aria-label': 'YouTube bağlantısı',
      'data-role': 'yt-link',
      on: {
        keydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); openFromInput(); } },
        input: function () { s.input.removeAttribute('aria-invalid'); U.clear(s.linkErr); },
        paste: function () {
          // Geçerli bir bağlantı yapıştırılınca hemen aç
          setTimeout(function () { if (S === s && parseLink(s.input.value).ok) openFromInput(); }, 0);
        }
      }
    });
    s.openBtn = k.button('Aç', { cls: 'as-btn--primary', iconName: 'play', role: 'yt-open', onClick: openFromInput,
      title: 'Videoyu bu sayfada açar' });
    s.linkErr = el('div', { 'data-role': 'yt-link-error', 'aria-live': 'polite' });
    var linkRow = el('div', { class: 'as-row' }, el('div', { class: 'as-grow' }, s.input), s.openBtn);
    linkRow.style.flexWrap = 'nowrap';
    var linkCard = k.card('youtube', 'YouTube bağlantısı', 'Bağlantıyı YouTube\'daki "Paylaş" düğmesinden kopyalayabilirsiniz.');
    linkCard.body.appendChild(linkRow);
    linkCard.body.appendChild(s.linkErr);
    linkCard.body.appendChild(el('p', { class: 'as-hint' },
      'youtube.com, youtu.be, Shorts ve canlı yayın bağlantıları ile 11 karakterlik video kimliği kabul edilir. Bağlantıdaki başlangıç zamanı (t=) da kullanılır.'));

    // Sahne
    s.emptyTitle = el('div', { class: 'as-card__title' }, 'YouTube videosu burada oynar');
    s.emptyText = el('div', { class: 'as-hint' }, 'Yukarıya bir YouTube bağlantısı yapıştırıp "Aç"a basın.');
    s.empty = el('div', { class: 'as-stage__empty', 'data-role': 'yt-empty' }, k.icon('youtube'), s.emptyTitle, s.emptyText);
    s.controls = el('div', { class: 'as-stage__controls' });
    s.controls.hidden = true;
    s.stage = el('div', { class: 'as-stage', 'data-role': 'stage' }, s.empty, s.controls);
    s.fsBtn = k.fullscreenButton(s.stage);
    s.controls.appendChild(s.fsBtn);
    s.cleanups.push(s.fsBtn.dispose);

    s.idChip = el('span', { class: 'as-chip', 'data-role': 'yt-id' });
    s.startChip = el('span', { class: 'as-chip' });
    s.startChip.hidden = true;
    s.extLink = el('a', { class: 'as-btn as-btn--sm as-btn--ghost', href: 'https://www.youtube.com/', target: '_blank', rel: 'noopener noreferrer',
      'data-role': 'yt-external', title: 'Videoyu YouTube\'da yeni sekmede açar' }, k.icon('external'), el('span', null, 'YouTube\'da aç'));
    var fs2 = k.button('Tam ekran', { cls: 'as-btn--sm', iconName: 'fullscreen', title: 'Videoyu Türkçe altyazıyla tam ekran izleyin (Esc ile çıkılır).',
      onClick: function () { AS.subs.fullscreen(s.stage); } });
    s.toolbar = el('div', { class: 'as-row' }, s.idChip, s.startChip, el('span', { class: 'as-spacer' }), fs2, s.extLink);
    s.toolbar.hidden = true;
    s.ytErr = el('div', { 'data-role': 'yt-error' });
    var left = el('div', { class: 'as-col' }, s.stage, s.toolbar, s.ytErr);
    left.style.gap = '12px';
    left.style.minWidth = '0';

    s.srcCard = k.card('subtitle', 'Türkçe altyazı', '');
    s.srcCard.node.setAttribute('data-role', 'source-card');
    var notes = k.card('info', 'Bilmeniz gerekenler');
    notes.body.appendChild(el('ul', { class: 'as-hint', style: { margin: '0', paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '6px' } },
      el('li', null, 'YouTube oynatıcısının içindeki reklamlar bir web sitesi tarafından kaldırılamaz.'),
      el('li', null, 'Tam ekran için oynatıcının kendi düğmesini değil, videonun altındaki "Tam ekran" düğmesini kullanın; Türkçe altyazı ancak böyle görünür.'),
      el('li', null, 'Bazı video sahipleri başka sitelerde oynatmayı kapatır. O zaman videoyu YouTube\'da açıp "Canlı çeviri" bölümünde o sekmeyi paylaşın.'),
      el('li', null, 'YouTube\'un kendi altyazılarını çevirmek için de videoyu YouTube\'da açıp "Canlı çeviri" bölümünü kullanabilirsiniz.')));
    var right = el('div', { class: 'as-col' }, s.srcCard.node, notes.node);
    right.style.gap = '16px';
    right.style.minWidth = '0';

    s.root = el('div', { class: 'as-col', 'data-mode-root': 'youtube' }, linkCard.node, el('div', { class: 'as-split' }, left, right));
    s.root.style.gap = '16px';
  }

  function showLinkError(s, msg) {
    AS.util.clear(s.linkErr);
    s.linkErr.appendChild(K().note('error', msg));
    s.input.setAttribute('aria-invalid', 'true');
  }

  function openFromInput() {
    var s = S;
    if (!s) return;
    var r = parseLink(s.input.value);
    if (!r.ok) {
      showLinkError(s, r.message);
      st(r.message, 'error');
      try { s.input.focus(); } catch (e) { /* */ }
      return;
    }
    AS.util.clear(s.linkErr);
    s.input.removeAttribute('aria-invalid');
    s.input.value = watchUrl(r.id, r.start);
    openVideo(r.id, r.start);
  }

  /* ---------- oynatıcı ---------- */
  function openVideo(id, start) {
    var s = S;
    if (!s || !ID_RE.test(id)) return;
    var k = K();
    if (s.track && !s.subFirst) removeSubtitle(true);
    s.subFirst = false;
    destroyPlayer(s);
    s.gen++;
    var gen = s.gen;
    s.videoId = id;
    s.start = start || 0;
    s.idChip.textContent = 'Video: ' + id;
    s.startChip.textContent = 'Başlangıç: ' + k.fmtClock(s.start);
    s.startChip.hidden = !s.start;
    s.extLink.setAttribute('href', watchUrl(id, s.start));
    s.toolbar.hidden = false;
    s.controls.hidden = false;
    AS.util.clear(s.ytErr);
    s.empty.hidden = false;
    s.emptyTitle.textContent = 'YouTube oynatıcısı yükleniyor…';
    s.emptyText.textContent = '';
    s.view.reset();
    if (s.track) s.track.seek(s.start * 1000);
    renderSource();
    st('YouTube oynatıcısı yükleniyor…', 'busy');
    loadApi().then(function (YT) {
      if (!alive(gen)) return;
      var host = el('div', { id: 'as-yt-player-' + gen + '-' + Math.floor(Math.random() * 1e9) });
      s.stage.insertBefore(host, s.stage.firstChild);
      var vars = { fs: 0, playsinline: 1, rel: 0, start: s.start, enablejsapi: 1, iv_load_policy: 3, hl: 'tr' };
      var origin = root.location && root.location.origin;
      if (origin && origin !== 'null') vars.origin = origin;
      try {
        s.player = new YT.Player(host, {
          host: EMBED_HOST,
          videoId: id,
          width: '100%',
          height: '100%',
          playerVars: vars,
          events: {
            onReady: function () { if (alive(gen)) onReady(s); },
            onStateChange: function (e) { if (alive(gen)) onState(s, e && e.data); },
            onError: function (e) { if (alive(gen)) onYtError(s, e && e.data); }
          }
        });
      } catch (e) {
        showApiError(s, e);
        return;
      }
      s.empty.hidden = true;
    }, function (e) {
      if (alive(gen)) showApiError(s, e);
    });
  }

  function showApiError(s, e) {
    var k = K();
    var msg = k.errText(e);
    s.empty.hidden = false;
    s.emptyTitle.textContent = 'YouTube oynatıcısı açılamadı';
    s.emptyText.textContent = msg;
    AS.util.clear(s.ytErr);
    s.ytErr.appendChild(k.note('error', msg + ' ', el('span', { class: 'as-row', style: { marginTop: '8px' } },
      k.button('Tekrar dene', { cls: 'as-btn--sm', iconName: 'reset', onClick: function () { if (S === s && s.videoId) openVideo(s.videoId, s.start); } }))));
    st(msg, 'error');
  }

  function destroyPlayer(s) {
    if (s.poll) { clearInterval(s.poll); s.poll = 0; }
    var p = s.player;
    s.player = null;
    s.ready = false;
    s.state = -1;
    s.rawT = NaN;
    s.lastMs = NaN;
    if (p && typeof p.destroy === 'function') { try { p.destroy(); } catch (e) { /* */ } }
    // Oynatıcının bıraktığı her şeyi (iframe/yer tutucu) sahneden temizle
    var kids = Array.prototype.slice.call(s.stage.children);
    kids.forEach(function (n) {
      if (n === s.empty || n === s.controls || (n.classList && n.classList.contains('as-sub'))) return;
      s.stage.removeChild(n);
    });
  }

  function onReady(s) {
    s.ready = true;
    s.empty.hidden = true;
    if (!s.poll) s.poll = setInterval(function () { pollTick(s); }, 200);
    pollTick(s, true);
    st('Video hazır. Türkçe altyazı için sağdan bir kaynak seçin.', 'ok');
  }

  function onState(s, code) {
    s.state = Number(code);
    s.rawT = NaN;   // zaman tahminini yeniden başlat
    pollTick(s, true);
  }

  function onYtError(s, code) {
    var k = K();
    var info = errorInfo(code);
    AS.util.clear(s.ytErr);
    var actions = null;
    if (info.external && s.videoId) {
      actions = el('div', { class: 'as-row', style: { marginTop: '8px' } },
        el('a', { class: 'as-btn as-btn--sm', href: watchUrl(s.videoId, s.start), target: '_blank', rel: 'noopener noreferrer', 'data-role': 'yt-error-open' },
          k.icon('external'), el('span', null, 'YouTube\'da aç')),
        k.button('Canlı çeviriye geç', { cls: 'as-btn--sm', iconName: 'live', role: 'yt-error-live',
          onClick: function () { if (AS.app && AS.app.select) AS.app.select('live'); } }));
    }
    var extra = info.external
      ? el('div', null, el('div', { style: { marginTop: '4px' } }, 'Videoyu YouTube\'da açıp "Canlı çeviri" bölümünde o sekmeyi paylaşırsanız Türkçe altyazıyı yine alabilirsiniz.'), actions)
      : null;
    s.ytErr.appendChild(k.note('error', info.message, extra));
    s.ytErr.firstChild.setAttribute('data-code', String(info.code));
    st(info.message, 'error');
  }

  /** Oynatıcı zamanı (ms): getCurrentTime seyrek güncellenir; oynarken aradaki süre eklenir. */
  function playerMs(s) {
    var p = s.player;
    if (!p || !s.ready || typeof p.getCurrentTime !== 'function') return NaN;
    var t;
    try { t = Number(p.getCurrentTime()); } catch (e) { return NaN; }
    if (!isFinite(t) || t < 0) return NaN;
    var now = AS.util.now();
    if (t !== s.rawT) { s.rawT = t; s.rawAt = now; }
    var ms = t * 1000;
    if (s.state === 1) {
      var rate = 1;
      try { rate = Number(p.getPlaybackRate()) || 1; } catch (e) { rate = 1; }
      ms += Math.min(1000, Math.max(0, now - s.rawAt) * rate);
    }
    return ms;
  }

  function pollTick(s, force) {
    if (S !== s || !s.ready) return;
    var playing = s.state === 1 || s.state === 3;
    s.pollN++;
    if (!playing && !force && s.pollN % 3) return;     // duraklatılmışken 600 ms'de bir yeter
    var ms = playerMs(s);
    if (!isFinite(ms)) return;
    var now = AS.util.now();
    if (isFinite(s.lastMs)) {
      var expect = s.lastMs + (s.state === 1 ? now - s.lastAt : 0);
      if (Math.abs(ms - expect) > 1500 && s.track) s.track.seek(ms);   // atlama
    }
    s.lastMs = ms;
    s.lastAt = now;
    if (s.track) s.view.update(ms);
  }

  function curMs() {
    var s = S;
    if (!s) return 0;
    var ms = playerMs(s);
    return isFinite(ms) ? ms : (s.start || 0) * 1000;
  }

  /* ---------- altyazı dosyası ---------- */
  function loadSubtitle(file) {
    var s = S;
    if (!s) return;
    var k = K();
    var gen = s.gen;
    k.readSubtitleFile(file).then(function (cues) {
      if (!alive(gen)) return;
      if (s.listen) { stopListening(s, 'Dinleme durduruldu; altyazı dosyası kullanılıyor.'); }
      removeSubtitle(true);
      s.sub = file;
      s.subFirst = !s.videoId;
      s.view.offsetMs = 0;
      s.track = new k.SrtTrack({ cues: cues, view: s.view, from: s.subFrom || 'auto', onProgress: function (d, t) {
        if (S === s && s.panel2) s.panel2.progress(d, t);
        if (d >= t && t && !s.trDoneSaid) { s.trDoneSaid = true; st('Altyazının tamamı Türkçeye çevrildi (' + t + ' satır).', 'ok'); }
      } });
      renderSource();
      s.track.start(curMs());
      s.lastMs = NaN;
      pollTick(s, true);
      st('Altyazı dosyası yüklendi: ' + cues.length + ' satır. Oynatma noktasından başlayarak çevriliyor…', 'busy');
    }, function (e) {
      if (!alive(gen)) return;
      var msg = k.errText(e);
      st(msg, 'error');
      if (s.panel0Err) { AS.util.clear(s.panel0Err); s.panel0Err.appendChild(k.note('error', msg)); }
    });
  }

  function removeSubtitle(silent) {
    var s = S;
    if (!s) return;
    if (s.track) { s.track.stop(); s.track = null; }
    s.sub = null;
    s.subFirst = false;
    s.trDoneSaid = false;
    s.view.reset();
    s.view.setCues([]);
    if (!silent) { renderSource(); st('Altyazı dosyası kaldırıldı.', 'info'); }
  }

  function outBase(s) {
    var k = K();
    if (s.sub) return k.safeFileName(k.stripLang(k.baseName(s.sub.name)), 'altyazi');
    return s.videoId ? 'youtube-' + s.videoId : 'altyazi';
  }

  /* ---------- videonun sesinden altyazı ---------- */
  function listenAlive(sp) { return !!S && S.listen === sp && !sp.stopped; }

  function startListening() {
    var s = S;
    if (!s || s.listen) return;
    var k = K();
    var md = root.navigator && root.navigator.mediaDevices;
    if (!md || typeof md.getDisplayMedia !== 'function') {
      st('Bu tarayıcı sekme sesini paylaşamıyor. Altyazı dosyası kullanın ya da Chrome/Edge ile açın.', 'error');
      return;
    }
    // getDisplayMedia kullanıcı tıklamasının hemen ardından çağrılmalı (bekleme yok).
    var p;
    try {
      p = md.getDisplayMedia({
        video: true, audio: true, preferCurrentTab: true, selfBrowserSurface: 'include',
        systemAudio: 'exclude', surfaceSwitching: 'exclude'
      });
    } catch (e) { p = Promise.reject(e); }
    if (s.track) { removeSubtitle(true); }
    var sp = s.listen = { id: ++s.listenGen, phase: 'asking', count: 0, dropped: 0, err: null, model: null, warn: null,
      stream: null, speech: null, chain: Promise.resolve(), abort: new AbortController(), stopped: false };
    renderSource();
    st('Açılan pencerede "Bu sekme"yi seçin ve "Sekme sesini de paylaş" açık kalsın.', 'info');
    Promise.resolve(p).then(function (stream) {
      if (!listenAlive(sp)) { stopStream(stream); return; }
      // Görüntüye gerek yok: hemen kapat (yalnızca ses)
      stream.getVideoTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* */ } });
      if (!stream.getAudioTracks().length) {
        stopStream(stream);
        listenFail(sp, 'Ses paylaşılmadı. Tekrar deneyin: açılan pencerede "Bu sekme"yi seçin ve "Sekme sesini de paylaş" seçeneğini açık bırakın.');
        return;
      }
      sp.stream = stream;
      sp.phase = 'model';
      updListen(sp, true);
      AS.asr.load({ model: AS.settings.get('asrModel'), onProgress: function (pr) { if (listenAlive(sp)) { sp.model = pr; updListen(sp); } } })
        .then(function () {
          if (!listenAlive(sp)) return;
          sp.phase = 'listening';
          updListen(sp, true);
          st('Videonun sesi dinleniyor. Konuşma Türkçe altyazıya dönüşecek.', 'ok');
        }, function (e) { if (listenAlive(sp)) listenFail(sp, k.errText(e)); });
      sp.speech = new k.LiveSpeech({
        stream: stream, mode: MODE, maxBacklog: 3,
        language: function () { return AS.settings.get('asrLang'); },
        onText: function (r) { onSpeechText(sp, r); },
        onError: function (e) { if (listenAlive(sp)) { sp.warn = k.errText(e); updListen(sp, true); } },
        onDrop: function (n) { if (listenAlive(sp)) { sp.dropped = n; updListen(sp, true); } },
        onEnded: function () {
          if (!listenAlive(sp)) return;
          // Kullanıcı "Paylaşmayı durdur"a bastı: son cümleler gelsin, sonra kapat
          sp.ended = true;
          var tries = 0;
          var finish = function () {
            if (!S || S.listen !== sp) return;
            if (sp.speech && sp.speech.pending.length && tries++ < 60) { setTimeout(finish, 300); return; }
            sp.chain.then(function () { if (S && S.listen === sp) stopListening(S, 'Sekme paylaşımı durduruldu; dinleme bitti.'); });
          };
          finish();
        }
      });
      return sp.speech.start();
    }).catch(function (e) {
      if (!listenAlive(sp)) return;
      if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
        stopListening(s, 'Paylaşım iptal edildi. Tekrar denemek için "Videonun sesinden altyazı" düğmesine basın.', 'warn');
      } else if (e && e.name === 'NotSupportedError') {
        listenFail(sp, 'Bu tarayıcı sekme sesini paylaşamıyor. Chrome ya da Edge kullanın.');
      } else listenFail(sp, k.errText(e));
    });
  }

  function onSpeechText(sp, r) {
    if (!listenAlive(sp) && !sp.ended) return;
    var src = r.text;
    var tp = AS.translate.text(src, { from: r.language || 'auto', priority: 'high', signal: sp.abort.signal })
      .then(null, function (e) {
        if (e && e.name === 'AbortError') return null;
        sp.trErr = e;
        return null;
      });
    // Sırayı koru: çeviriler bitme sırasına göre değil, konuşma sırasına göre gösterilir.
    sp.chain = sp.chain.then(function () { return tp; }).then(function (tr) {
      if (!S || S.listen !== sp) return;
      if (tr) {
        sp.count++;
        sp.trErr = null;
        AS.bus.emit('subtitle', { tr: tr, src: src, cont: false, kind: 'speech' });
      }
      updListen(sp, !!sp.trErr || sp.count === 1);
    });
  }

  function listenFail(sp, msg) {
    sp.phase = 'error';
    sp.err = msg;
    if (sp.speech) sp.speech.stop();
    stopStream(sp.stream);
    sp.stream = null;
    updListen(sp, true);
    st(msg, 'error');
  }

  function stopStream(stream) {
    if (!stream) return;
    try { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* */ } }); } catch (e) { /* */ }
  }

  /** Dinlemeyi bitirir; msg verilirse durum çubuğuna yazar. */
  function stopListening(s, msg, level) {
    var sp = s && s.listen;
    if (!sp) return;
    sp.stopped = true;
    s.listen = null;
    try { sp.abort.abort(); } catch (e) { /* */ }
    if (sp.speech) sp.speech.stop();
    stopStream(sp.stream);
    sp.stream = null;
    if (S === s) renderSource();
    if (msg) st(msg, level || 'info');
  }

  /* ---------- kaynak kartı ---------- */
  function renderSource() {
    var s = S;
    if (!s) return;
    var c = s.srcCard;
    s.cardCleanups.forEach(function (fn) { try { fn(); } catch (e) { /* */ } });
    s.cardCleanups = [];
    AS.util.clear(c.body);
    s.panel2 = null;
    s.panel0Err = null;
    s.listenUi = null;
    if (s.track) renderSrtCard(s, c);
    else if (s.listen) renderListenCard(s, c);
    else renderChoiceCard(s, c);
  }

  function renderChoiceCard(s, c) {
    var k = K();
    var U = AS.util;
    c.setIcon('subtitle');
    c.setTitle('Türkçe altyazı');
    c.setSub(s.videoId ? 'Nereden oluşturulsun?' : 'Önce bir video açın; altyazı dosyasını şimdi de ekleyebilirsiniz.');
    s.panel0Err = el('div');
    var subBtn = k.fileButton({ label: 'Altyazı dosyası seç', accept: '.srt,.vtt,text/vtt,application/x-subrip', iconName: 'subtitle', role: 'pick-sub',
      cls: 'as-btn--block', onFiles: function (f) { loadSubtitle(f[0]); } });
    c.body.appendChild(el('div', { class: 'as-col' },
      el('div', { class: 'as-label' }, 'Altyazı dosyam var'),
      el('p', { class: 'as-hint' }, 'Videonun yabancı dildeki .srt veya .vtt dosyası (en fazla 5 MB). Video ile zamanlı eşleşir; izlediğiniz yerden başlayarak çevrilir.'),
      subBtn, s.panel0Err));
    c.body.appendChild(el('hr', { class: 'as-divider' }));
    var md = root.navigator && root.navigator.mediaDevices;
    var can = !!(md && typeof md.getDisplayMedia === 'function');
    var b = U.browser();
    var lr = k.asrLangRow();
    s.cardCleanups.push(lr.dispose);
    var listenBtn = k.button('Videonun sesinden altyazı', { cls: 'as-btn--primary as-btn--block', iconName: 'mic', role: 'yt-listen', disabled: !can,
      title: can ? 'Bu sekmenin sesini dinleyip konuşmayı Türkçe altyazıya çevirir.' : 'Bu tarayıcı sekme sesini paylaşamıyor.',
      onClick: startListening });
    var box = el('div', { class: 'as-col' },
      el('div', { class: 'as-label' }, 'Altyazı dosyam yok'),
      el('p', { class: 'as-hint' }, 'Bu sekmenin sesi bilgisayarınızda yazıya dökülür ve Türkçeye çevrilir (Chrome ve Edge).'),
      lr.node, listenBtn,
      el('ol', { class: 'as-hint', style: { margin: '0', paddingLeft: '20px' } },
        el('li', null, 'Düğmeye basın, açılan pencerede "Bu sekme"yi seçin.'),
        el('li', null, '"Sekme sesini de paylaş" açık kalsın, "Paylaş"a basın.'),
        el('li', null, 'Videoyu oynatın; konuşma birkaç saniye içinde Türkçe altyazı olur.')));
    if (!can) box.appendChild(k.note('warn', 'Bu tarayıcı sekme sesini paylaşamıyor. Altyazı dosyası kullanın ya da Chrome veya Edge ile açın.'));
    else if (!b.chromium) box.appendChild(k.note('info', 'Bu özellik Chrome ve Edge\'de çalışır; bu tarayıcıda ses paylaşılamayabilir.'));
    c.body.appendChild(box);
  }

  function renderSrtCard(s, c) {
    var k = K();
    var t = s.track;
    c.setIcon('subtitle');
    c.setTitle('Altyazı dosyası');
    c.setSub(s.videoId ? 'Video ile eşleniyor' : 'Video açınca altyazı videoyla birlikte gösterilir.');
    s.panel2 = k.srtPanel({
      name: s.sub ? s.sub.name : 'altyazı', count: t.cues.length, from: t.from,
      onFrom: function (v) { s.subFrom = v; if (s.track) { s.trDoneSaid = false; s.track.setFrom(v, curMs()); } },
      offsetMs: s.view.offsetMs,
      onOffset: function (ms) { s.view.setOffset(ms); if (s.track) s.track.seek(curMs()); pollTick(s, true); },
      onDownload: function () {
        if (!s.track) return;
        var name = outBase(s) + '.tr.srt';
        k.downloadText(s.track.exportTr(), name);
        var left = s.track.cues.length - s.track.done;
        st('"' + name + '" indirildi' + (left > 0 ? ' (' + left + ' satır henüz çevrilmedi; orijinal hâliyle yazıldı).' : '.'), left > 0 ? 'warn' : 'ok');
      },
      onRemove: function () { removeSubtitle(false); },
      downloadName: function () { return outBase(s) + '.tr.srt'; }
    });
    s.panel2.progress(t.done, t.cues.length);
    c.body.appendChild(s.panel2.node);
    var timer = setInterval(function () {
      if (S !== s || s.track !== t || !s.panel2) { clearInterval(timer); return; }
      if (!k.translationPossible()) s.panel2.setWarn('warn', 'Çeviri yapılamıyor: bu tarayıcıda cihaz içi çeviri yok ve çevrim içi çeviri kapalı. ', k.goSettingsBtn());
      else if (t.done === 0 && Date.now() - t.startedAt > 12000) s.panel2.setWarn('warn', 'Çeviri gelmiyor. İnternet bağlantınızı ve Ayarlar\'daki "Çevrim içi çeviriye izin ver" seçeneğini kontrol edin. ', k.goSettingsBtn());
      else if (t.done > 0) s.panel2.setWarn(null);
    }, 1500);
    s.cardCleanups.push(function () { clearInterval(timer); });
    if (!k.translationPossible()) s.panel2.setWarn('warn', 'Çeviri yapılamıyor: bu tarayıcıda cihaz içi çeviri yok ve çevrim içi çeviri kapalı. ', k.goSettingsBtn());
  }

  function renderListenCard(s, c) {
    var k = K();
    var sp = s.listen;
    c.setIcon('mic');
    c.setTitle('Videonun sesinden altyazı');
    var ui = s.listenUi = {};
    ui.prog = k.progressRow('');
    ui.stats = el('p', { class: 'as-hint', 'data-role': 'yt-listen-stats' });
    ui.notes = el('div', { class: 'as-col' });
    ui.stop = k.button('Dinlemeyi durdur', { cls: 'as-btn--danger as-btn--block', iconName: 'stop', role: 'yt-listen-stop',
      onClick: function () { stopListening(s, 'Dinleme durduruldu.'); } });
    ui.retry = k.button('Tekrar dene', { cls: 'as-btn--primary as-btn--block', iconName: 'mic', role: 'yt-listen-retry',
      onClick: function () { stopListening(s); startListening(); } });
    var lr = k.asrLangRow();
    s.cardCleanups.push(lr.dispose);
    c.body.appendChild(ui.prog.node);
    c.body.appendChild(ui.stats);
    c.body.appendChild(ui.notes);
    c.body.appendChild(lr.node);
    c.body.appendChild(ui.retry);
    c.body.appendChild(ui.stop);
    updListen(sp, true);
  }

  function updListen(sp, force) {
    var s = S;
    if (!s || s.listen !== sp || !s.listenUi) return;
    var k = K();
    var ui = s.listenUi;
    var c = s.srcCard;
    var m = sp.model;
    if (sp.phase === 'asking') {
      c.setSub('Paylaşım bekleniyor');
      ui.prog.set(-1, 'Açılan pencerede "Bu sekme"yi seçin, "Sekme sesini de paylaş" açık kalsın.');
    } else if (sp.phase === 'model') {
      c.setSub('Konuşma modeli hazırlanıyor');
      var f = m && m.total > 0 ? m.loaded / m.total : -1;
      ui.prog.set(f, f >= 0 && !m.done ? 'Konuşma modeli indiriliyor · %' + Math.round(f * 100) + (m.total > 100000 ? ' (' + AS.util.fmtBytes(m.loaded) + ' / ' + AS.util.fmtBytes(m.total) + ')' : '')
        : 'Konuşma modeli yükleniyor…');
    } else if (sp.phase === 'listening') {
      c.setSub('Dinleniyor');
      ui.prog.set(-1, 'Bu sekmenin sesi dinleniyor; video oynadıkça altyazı gelir.');
    } else if (sp.phase === 'error') {
      c.setSub('Durdu');
      ui.prog.set(0, 'Dinleme başlatılamadı.');
    }
    ui.stats.textContent = sp.count + ' cümle Türkçeye çevrildi';
    ui.stats.hidden = sp.phase !== 'listening' && !sp.count;
    if (!force) return;
    ui.retry.hidden = sp.phase !== 'error';
    ui.stop.hidden = sp.phase === 'error';
    AS.util.clear(ui.notes);
    if (sp.err) ui.notes.appendChild(k.note('error', sp.err));
    if (sp.phase === 'asking') ui.notes.appendChild(k.note('info', 'Yalnızca bu sekmenin sesi kullanılır; görüntü hemen kapatılır ve hiçbir şey kaydedilmez.'));
    if (sp.dropped) ui.notes.appendChild(k.note('warn', 'Bilgisayar konuşma tanımaya yetişemiyor; ' + sp.dropped + ' cümle atlandı. Ayarlar\'dan daha hızlı (tiny) modeli seçebilirsiniz.'));
    if (sp.trErr) ui.notes.appendChild(k.note('warn', 'Çeviri yapılamadı: ' + k.errText(sp.trErr) + ' ', k.goSettingsBtn()));
    if (sp.warn && !sp.err) ui.notes.appendChild(k.note('warn', sp.warn));
  }

  AS.modes.youtube = {
    id: 'youtube',
    title: 'YouTube',
    icon: 'youtube',
    mount: mount,
    unmount: unmount,
    parseLink: parseLink,
    parseTime: parseTime,
    watchUrl: watchUrl,
    errorInfo: errorInfo,
    /* testler için */
    _state: function () {
      var s = S;
      if (!s) return null;
      return {
        videoId: s.videoId, start: s.start, ready: s.ready, state: s.state, offsetMs: s.view.offsetMs,
        track: s.track ? { done: s.track.done, total: s.track.cues.length } : null,
        listen: s.listen ? { phase: s.listen.phase, count: s.listen.count, err: s.listen.err } : null
      };
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);

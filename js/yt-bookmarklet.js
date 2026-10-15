/* Altyazı Şefi Web: YouTube yer imi düğmesi (bookmarklet) → AS.ytBookmarklet
 *
 * Bu fonksiyon bu sitede ÇALIŞTIRILMAZ. js/youtube.js kaynağını (Function#toString) bir "javascript:" adresine
 * çevirip sürüklenebilir bağlantı yapar; kullanıcı onu yer imleri çubuğuna bırakır, YouTube'da bir video açıkken
 * tıklar. Kod o zaman youtube.com sayfasında çalışır:
 *   1. Videonun altyazı listesini oynatıcıdan okur (her dil). Türkçe altyazı varsa çevirmeden gösterir.
 *   2. Seçilen altyazıyı sayfanın kendi adresinden (aynı köken) ister. YouTube boş dönerse oynatıcıda o altyazıyı
 *      açar ve oynatıcının kendi isteğinin cevabını yakalar. O da olmazsa ekranda görünen altyazı yazısını okur.
 *   3. Satırları izlenen yerden başlayarak Türkçeye çevirir (Chrome'un cihaz içi çevirmeni varsa o, yoksa Google
 *      Çeviri, o da olmazsa MyMemory), videonun üstünde gösterir; Türkçe SRT indirilebilir.
 *   4. Reklamları atlar (telefon uygulamasındaki yöntem): reklam alanları gizlenir; sonraki videoların oynatıcı
 *      cevaplarından reklam planı silinir; yine de reklam oynarsa sesi kısılır, gizlenir, sona sarılır, "Atla"ya basılır.
 * YouTube'da çalıştığı için kurallar:
 *   - Tamamen kendi içinde: dışarıdaki hiçbir değişkene dayanmaz (toString ile taşınır).
 *   - DOM yalnızca createElement / textContent ile kurulur. YouTube Trusted Types zorunlu kılar; innerHTML,
 *     DOMParser, eval yok.
 *   - Fonksiyon içinde yorumlar yalnızca tam satır "//" yorumudur (adres oluşturulurken atılır); çok satırlı dize yok.
 *   - Dışarıdan kod yüklemez, çerez ya da sayfanın başka verisini okumaz. Dışarı giden tek şey çevrilecek altyazı
 *     metnidir (gönderen sayfa adresi iletilmez: referrerPolicy no-referrer). */
(function (root) {
  'use strict';
  var AS = root.AS = root.AS || {};

  AS.ytBookmarklet = function () {
    'use strict';
    var W = window, D = document, KEY = '__altyaziSefi', P = 'as-yt-';
    if (W[KEY] && typeof W[KEY].toggle === 'function') { W[KEY].toggle(); return; }
    if (!/(^|\.)youtube\.com$/.test(location.hostname)) {
      W.alert('Altyazı Şefi: Bu düğme YouTube\'da çalışır. Önce YouTube\'da bir video açın, sonra düğmeye yeniden basın.');
      return;
    }
    var GTX = 'https://translate.googleapis.com/translate_a/single';
    var MYM = 'https://api.mymemory.translated.net/get';
    var MAX_BODY = 6000000, MAX_CUES = 6000, MAX_LEN = 110, BATCH_CHARS = 1500, BATCH_LINES = 25, PAR = 2;
    var PLAYER_WAIT_MS = 9000;
    var F0 = W.fetch;
    var XP = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
    var XO = XP && XP.open, XS = XP && XP.send;
    var offs = [];
    var cache = Object.create(null), cacheN = 0;
    var st = {
      vid: null, title: '', tracks: [], want: null, cues: null, cueKey: '', cueLang: '', direct: false, via: '',
      gen: 0, busy: 0, engine: '', on: true, hideYt: true, ads: true, adCount: 0, adSaved: null, adStripped: 0, showOrig: false, size: 1, min: false, closed: false,
      dom: false, domText: '', domAt: 0, domReq: '', domSentAt: 0, gtxOff: 0, mmOff: 0, netFail: 0, blocked: false,
      lastPump: 0, shownKey: ''
    };
    try {
      var saved = JSON.parse(W.localStorage.getItem('altyaziSefi') || '{}');
      if (typeof saved.size === 'number' && saved.size >= 0.6 && saved.size <= 2.2) st.size = saved.size;
      if (typeof saved.showOrig === 'boolean') st.showOrig = saved.showOrig;
      if (typeof saved.hideYt === 'boolean') st.hideYt = saved.hideYt;
      if (typeof saved.ads === 'boolean') st.ads = saved.ads;
    } catch (e) {}
    function savePrefs() {
      try { W.localStorage.setItem('altyaziSefi', JSON.stringify({ size: st.size, showOrig: st.showOrig, hideYt: st.hideYt, ads: st.ads })); } catch (e) {}
    }

    // ---------- küçük yardımcılar ----------
    function el(tag, cls, text) {
      var n = D.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined && text !== null) n.textContent = String(text);
      return n;
    }
    function on(t, ev, fn, opt) { t.addEventListener(ev, fn, opt); offs.push(function () { t.removeEventListener(ev, fn, opt); }); }
    function later(fn, ms) { var id = setTimeout(fn, ms); offs.push(function () { clearTimeout(id); }); return id; }
    function every(fn, ms) { var id = setInterval(fn, ms); offs.push(function () { clearInterval(id); }); }
    function num(v, d) { v = Number(v); return isFinite(v) ? v : d; }
    function clean(s) {
      return String(s === null || s === undefined ? '' : s).replace(/[\u0000-\u001f\u007f ​]/g, ' ').replace(/\s+/g, ' ').trim();
    }
    function base(l) { return String(l || '').toLowerCase().split(/[-_]/)[0]; }
    function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
    function unent(s) {
      return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, function (all, g) {
        var l = g.toLowerCase();
        if (l === 'amp') return '&';
        if (l === 'lt') return '<';
        if (l === 'gt') return '>';
        if (l === 'quot') return '"';
        if (l === 'apos') return '\'';
        if (l === 'nbsp') return ' ';
        var cp = l.charAt(1) === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
        return (cp > 31 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) ? String.fromCodePoint(cp) : ' ';
      });
    }
    function timeoutSignal(ms) {
      if (typeof AbortController !== 'function') return undefined;
      var c = new AbortController();
      setTimeout(function () { try { c.abort(); } catch (e) {} }, ms);
      return c.signal;
    }

    // ---------- YouTube oynatıcısı ----------
    function pl() { return D.getElementById('movie_player') || D.querySelector('.html5-video-player'); }
    function videoEl() { var p = pl(); return (p && p.querySelector('video')) || D.querySelector('video'); }
    function nowMs() { var v = videoEl(); return v ? v.currentTime * 1000 : 0; }
    function curVid() {
      var p = pl();
      try {
        var d = p && p.getVideoData && p.getVideoData();
        if (d && /^[\w-]{11}$/.test(d.video_id || '')) return d.video_id;
      } catch (e) {}
      var m = /[?&]v=([\w-]{11})/.exec(location.search) || /\/(?:shorts|live|embed)\/([\w-]{11})/.exec(location.pathname);
      return m ? m[1] : '';
    }
    function playerResponse() {
      var p = pl(), r = null;
      try { r = p && p.getPlayerResponse && p.getPlayerResponse(); } catch (e) { r = null; }
      var ok = function (x) { return !!(x && x.videoDetails && x.videoDetails.videoId === st.vid); };
      if (ok(r)) return r;
      return ok(W.ytInitialPlayerResponse) ? W.ytInitialPlayerResponse : null;
    }
    function readTracks(r) {
      var c = r && r.captions && r.captions.playerCaptionsTracklistRenderer;
      var list = (c && Array.isArray(c.captionTracks)) ? c.captionTracks : [];
      var out = [];
      for (var i = 0; i < list.length && out.length < 200; i++) {
        var t = list[i];
        if (!t || typeof t.baseUrl !== 'string' || typeof t.languageCode !== 'string') continue;
        var n = t.name || {};
        var name = clean(n.simpleText || (Array.isArray(n.runs) ? n.runs.map(function (x) { return x && x.text; }).join('') : '') || t.languageCode);
        var asr = t.kind === 'asr';
        out.push({ url: t.baseUrl, lang: t.languageCode, asr: asr, name: name, key: t.languageCode + '|' + (asr ? 'asr' : '') });
      }
      return out;
    }
    function rank(t) {
      var b = base(t.lang);
      if (b === 'tr') return t.asr ? 3 : 6;
      if (!t.asr) return b === 'en' ? 5 : 4;
      return 2;
    }
    function bestTrack() {
      var best = null;
      for (var i = 0; i < st.tracks.length; i++) if (!best || rank(st.tracks[i]) > rank(best)) best = st.tracks[i];
      return best;
    }
    function sameOrigin(u) {
      try { var x = new URL(u, location.href); return x.origin === location.origin ? x : null; } catch (e) { return null; }
    }

    // ---------- altyazı ayrıştırma (json3, yedek olarak XML) ----------
    function cue(s, e, t) { return { s: s, e: e, t: t, tr: null, state: 0, fails: 0, retryAt: 0 }; }
    function endsSentence(w) { return /[.?!…]$/.test(w); }
    function endsSentenceOrQuote(t) { return !t || /[.?!…"”\])♪]$/.test(t); }
    function parse(body) {
      var b = String(body || '').replace(/^﻿/, '').trim();
      try {
        if (b.charAt(0) === '{') return finish(parseJson3(JSON.parse(b)));
        if (b.charAt(0) === '<') return finish(parseXml(b));
      } catch (e) {}
      return [];
    }
    function parseJson3(j) {
      var ev = (j && Array.isArray(j.events)) ? j.events : [];
      var word = false, i, k, segs;
      for (i = 0; i < ev.length && !word; i++) {
        segs = ev[i] && ev[i].segs;
        if (!Array.isArray(segs)) continue;
        for (k = 0; k < segs.length; k++) if (segs[k] && segs[k].tOffsetMs !== undefined) { word = true; break; }
      }
      if (word) return fromWords(ev);
      var raw = [];
      for (i = 0; i < ev.length && raw.length < MAX_CUES; i++) {
        var e = ev[i];
        segs = e && e.segs;
        if (!Array.isArray(segs)) continue;
        var t = '';
        for (k = 0; k < segs.length; k++) t += (segs[k] && typeof segs[k].utf8 === 'string') ? segs[k].utf8 : '';
        t = clean(t);
        if (!t) continue;
        var s0 = num(e.tStartMs, 0), du = num(e.dDurationMs, 2000);
        raw.push(cue(s0, s0 + Math.max(du, 300), t));
      }
      return mergeFragments(raw);
    }
    // Kelime zamanlı (otomatik) altyazıdan cümle/satır kurar; kayan satırlarda tekrar eden kelimeleri atar.
    function fromWords(ev) {
      var words = [], starts = [], lastStart = -1, lastWord = '';
      for (var i = 0; i < ev.length && words.length < 200000; i++) {
        var e = ev[i], segs = e && e.segs;
        if (!Array.isArray(segs)) continue;
        var b0 = num(e.tStartMs, 0);
        for (var k = 0; k < segs.length; k++) {
          var w = clean(segs[k] && segs[k].utf8);
          if (!w) continue;
          var s = b0 + num(segs[k].tOffsetMs, 0);
          if (s < lastStart || (s === lastStart && w === lastWord)) continue;
          words.push(w); starts.push(s); lastStart = s; lastWord = w;
        }
      }
      var res = [], cur = '', cs = 0, lw = 0;
      for (var j = 0; j < words.length && res.length < MAX_CUES; j++) {
        var wd = words[j], ws = starts[j];
        if (cur && (ws - lw > 1200 || cur.length + 1 + wd.length > MAX_LEN)) { res.push(cue(cs, lw + 700, cur)); cur = ''; }
        if (!cur) cs = ws; else cur += ' ';
        cur += wd; lw = ws;
        if (endsSentence(wd) && cur.length >= 20) {
          var nx = j + 1 < words.length ? starts[j + 1] : Infinity;
          res.push(cue(cs, Math.max(Math.min(nx, ws + 700), ws + 300), cur));
          cur = '';
        }
      }
      if (cur) res.push(cue(cs, lw + 1200, cur));
      return res;
    }
    // Cümle sonu işareti olmayan, hemen ardından gelen parçaları birleştirir (daha doğru çeviri için).
    function mergeFragments(raw) {
      var res = [], cur = null;
      for (var i = 0; i < raw.length; i++) {
        var c = raw[i];
        if (cur && !endsSentenceOrQuote(cur.t) && c.s - cur.e <= 300 && cur.t.length + 1 + c.t.length <= MAX_LEN) {
          cur = cue(cur.s, Math.max(cur.e, c.e), cur.t + ' ' + c.t);
        } else {
          if (cur) res.push(cur);
          cur = c;
        }
      }
      if (cur) res.push(cur);
      return res;
    }
    function parseXml(s) {
      var raw = [], m, t, s0, du;
      var re1 = /<text\s+start="([0-9.]+)"(?:\s+dur="([0-9.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
      while ((m = re1.exec(s)) && raw.length < MAX_CUES) {
        t = clean(unent(unent(m[3].replace(/<[^>]*>/g, ''))));
        if (!t) continue;
        s0 = parseFloat(m[1]) * 1000; du = m[2] ? parseFloat(m[2]) * 1000 : 2000;
        raw.push(cue(s0, s0 + Math.max(du, 300), t));
      }
      if (!raw.length) {
        var re2 = /<p\s+t="(\d+)"(?:\s+d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g;
        while ((m = re2.exec(s)) && raw.length < MAX_CUES) {
          t = clean(unent(unent(m[3].replace(/<[^>]*>/g, ''))));
          if (!t) continue;
          s0 = parseInt(m[1], 10); du = m[2] ? parseInt(m[2], 10) : 2000;
          raw.push(cue(s0, s0 + Math.max(du, 300), t));
        }
      }
      return mergeFragments(raw);
    }
    // Okunabilirlik: kısa satır biraz uzun kalır ama bir sonraki satırı geçmez.
    function finish(list) {
      list = list.filter(function (c) { return isFinite(c.s) && c.s >= 0; }).slice(0, MAX_CUES);
      list.sort(function (a, b) { return a.s - b.s; });
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        var e = Math.max(c.e, c.s + Math.min(7000, 1200 + 45 * c.t.length));
        if (i + 1 < list.length) e = Math.min(e, Math.max(list[i + 1].s, c.s + 300));
        c.e = e;
      }
      return list;
    }
    function indexAt(c, t) {
      var lo = 0, hi = c.length - 1, best = -1;
      while (lo <= hi) { var mid = (lo + hi) >> 1; if (c[mid].s <= t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
      return best >= 0 && t < c[best].e ? best : -1;
    }
    function indexFrom(c, t) {
      var lo = 0, hi = c.length - 1, ans = c.length;
      while (lo <= hi) { var mid = (lo + hi) >> 1; if (c[mid].e > t) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
      return ans >= c.length ? 0 : ans;
    }
    function srtTime(ms) {
      ms = Math.max(0, Math.round(ms));
      return pad(Math.floor(ms / 3600000), 2) + ':' + pad(Math.floor(ms / 60000) % 60, 2) + ':' + pad(Math.floor(ms / 1000) % 60, 2) + ',' + pad(ms % 1000, 3);
    }
    // HTML işleyen oynatıcılarda betik çalıştırılamasın diye etiket benzeri her "<" etkisizleştirilir.
    function toSrt(cues) {
      var out = [];
      for (var i = 0; i < cues.length; i++) {
        var c = cues[i];
        var t = String(c.tr || c.t).replace(/<\/?[A-Za-z!?][^<>]*>/g, '').replace(/<(?=[A-Za-z\/!?])/g, '‹');
        out.push((i + 1) + '\r\n' + srtTime(c.s) + ' --> ' + srtTime(c.e) + '\r\n' + t + '\r\n');
      }
      return out.join('\r\n');
    }

    // ---------- altyazıyı alma ----------
    function load(t) {
      var g = ++st.gen;
      st.want = t; st.cues = null; st.cueKey = ''; st.via = ''; st.busy = 0; st.dom = false;
      st.domText = ''; st.domReq = '';
      ui.sel.value = String(st.tracks.indexOf(t));
      status('“' + t.name + '” altyazısı alınıyor…');
      applyHide(); render(); progress();
      direct(t).then(function (ok) {
        if (ok || g !== st.gen || st.closed) return;
        status('“' + t.name + '” altyazısı oynatıcıdan alınıyor…');
        viaPlayer(t, 0);
        later(function () { if (g === st.gen && !st.cues && !st.closed) viaPlayer(t, 1); }, 3000);
        later(function () { if (g === st.gen && !st.cues && !st.closed) startDom(); }, PLAYER_WAIT_MS);
      });
    }
    function direct(t) {
      var u = sameOrigin(t.url);
      if (!u) return Promise.resolve(false);
      u.searchParams.set('fmt', 'json3');
      u.searchParams.delete('tlang');
      return F0.call(W, u.href, { credentials: 'same-origin', signal: timeoutSignal(15000) }).then(function (r) {
        return r.ok ? r.text() : '';
      }).then(function (body) {
        return accept(u.href, body, 'doğrudan', t.key);
      }, function () { return false; });
    }
    // Oynatıcıda istenen altyazıyı açar; oynatıcının kendi isteğinin cevabı aşağıdaki kancayla yakalanır.
    function viaPlayer(t, attempt) {
      var p = pl();
      if (!p || typeof p.setOption !== 'function') return;
      try {
        if (attempt === 0 && typeof p.unloadModule === 'function') p.unloadModule('captions');
        if (typeof p.loadModule === 'function') p.loadModule('captions');
        var list = (typeof p.getOption === 'function' && p.getOption('captions', 'tracklist')) || [];
        var pick = null;
        for (var i = 0; i < list.length; i++) {
          var x = list[i];
          if (x && x.languageCode === t.lang && (x.kind === 'asr') === t.asr) { pick = x; break; }
        }
        p.setOption('captions', 'track', pick || { languageCode: t.lang });
        if (attempt > 0) {
          var b = D.querySelector('.ytp-subtitles-button');
          if (b && b.getAttribute('aria-pressed') === 'false') b.click();
        }
      } catch (e) {}
    }
    function captured(url, body) {
      if (st.closed) return;
      var u = sameOrigin(url);
      if (u) accept(u.href, body, 'oynatıcıdan', '');
    }
    function accept(url, body, via, keyHint) {
      if (st.closed || typeof body !== 'string' || body.length < 20 || body.length > MAX_BODY) return false;
      var u = sameOrigin(url);
      if (!u) return false;
      var q = u.searchParams;
      if (q.get('tlang')) return false;
      if (!st.vid || q.get('v') !== st.vid) return false;
      var lang = q.get('lang') || (st.want ? st.want.lang : '');
      var key = keyHint || (lang + '|' + (q.get('kind') === 'asr' ? 'asr' : ''));
      var wantKey = st.want ? st.want.key : '';
      if (st.cues && (key !== wantKey || key === st.cueKey)) return false;
      var cues = parse(body);
      if (!cues.length) return false;
      st.gen++;
      st.busy = 0;
      st.cues = cues; st.cueKey = key; st.cueLang = base(lang); st.via = via;
      st.direct = st.cueLang === 'tr';
      st.dom = false;
      if (st.direct) cues.forEach(function (c) { c.tr = c.t; c.state = 2; });
      var tr = null;
      for (var i = 0; i < st.tracks.length; i++) if (st.tracks[i].key === key) tr = st.tracks[i];
      var name = tr ? tr.name : (lang || '?');
      status(st.direct ? 'Hazır: videonun kendi Türkçe altyazısı (' + cues.length + ' satır), çeviri gerekmedi.'
        : 'Hazır: ' + cues.length + ' satır (' + name + '). Türkçesi videonun üstünde gösteriliyor.');
      ui.dl.disabled = false;
      applyHide(); pump(); render(); progress();
      return true;
    }
    // Son çare: ekranda görünen altyazının yazısı okunur ve anlık çevrilir (dosya yok, SRT indirilemez).
    function startDom() {
      st.dom = true; st.via = 'ekrandan';
      status('Altyazı dosyası alınamadı. Ekranda görünen altyazı anlık çevriliyor (bu yolda SRT indirilemez).');
      applyHide(); progress();
    }
    function domRead() {
      var p = pl();
      if (!p) return '';
      var segs = p.querySelectorAll('.ytp-caption-segment'), out = [];
      for (var i = 0; i < segs.length && i < 20; i++) out.push(segs[i].textContent || '');
      return clean(out.join(' '));
    }
    function domTick(now) {
      var tx = domRead();
      if (tx !== st.domText) { st.domText = tx; st.domAt = now; }
      if (!tx || tx === st.domReq) return;
      if (now - st.domAt < 300 && now - st.domSentAt < 1500) return;
      st.domReq = tx; st.domSentAt = now;
      var g = st.gen, src = st.want ? base(st.want.lang) : '';
      if (src === 'tr') { cachePut(src, tx, tx); render(); return; }
      translateLines([tx], src).then(function (r) { if (g === st.gen && r[0]) render(); });
    }

    // ---------- yakalama kancası (oynatıcının kendi altyazı isteği) ----------
    function isTimed(u) { return String(u || '').indexOf('/api/timedtext') >= 0; }
    function hOpen(m, u) {
      try { this[KEY + 'u'] = String(u); } catch (e) {}
      return XO.apply(this, arguments);
    }
    function hSend() {
      var x = this, u = x[KEY + 'u'];
      if (isTimed(u)) {
        x.addEventListener('load', function () {
          try {
            var t = null;
            if (x.status !== 200) return;
            if (x.responseType === '' || x.responseType === 'text') t = x.responseText;
            else if (x.response instanceof ArrayBuffer) t = new TextDecoder('utf-8').decode(x.response);
            else if (x.responseType === 'json' && x.response) t = JSON.stringify(x.response);
            if (t) captured(u, t);
          } catch (e) {}
        });
      }
      return XS.apply(this, arguments);
    }
    function hFetch(i) {
      var p = F0.apply(W, arguments);
      try {
        var u = (i && typeof i === 'object' && 'url' in i) ? i.url : String(i);
        if (st.ads && /\/youtubei\/v1\/(?:player|next)(?:[?\/]|$)/.test(u)) return p.then(stripResponse);
        if (isTimed(u)) {
          p.then(function (r) {
            if (r && r.ok) r.clone().text().then(function (t) { captured(u, t); }, function () {});
          }, function () {});
        }
      } catch (e) {}
      return p;
    }
    // Sonraki videoların oynatıcı cevabından reklam planı silinir (yeni video sayfa yenilemeden fetch ile gelir).
    var AD_KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams'];
    function stripAds(o, depth) {
      if (!o || typeof o !== 'object' || depth > 4) return 0;
      var n = 0;
      for (var i = 0; i < AD_KEYS.length; i++) {
        var k = AD_KEYS[i];
        if (Object.prototype.hasOwnProperty.call(o, k)) { delete o[k]; n++; }
      }
      if (o.playerResponse) n += stripAds(o.playerResponse, depth + 1);
      if (o.response) n += stripAds(o.response, depth + 1);
      if (Array.isArray(o)) for (var j = 0; j < o.length && j < 8; j++) n += stripAds(o[j], depth + 1);
      return n;
    }
    function stripResponse(res) {
      if (!res || !res.ok || st.closed) return res;
      return res.clone().text().then(function (t) {
        try {
          var j = JSON.parse(t);
          var n = stripAds(j, 0);
          if (!n) return res;
          st.adStripped += n;
          return new Response(JSON.stringify(j), { status: res.status, statusText: res.statusText, headers: res.headers });
        } catch (e) { return res; }
      }, function () { return res; });
    }
    // Yine de reklam oynarsa: sessiz, gizli, 16 kat hızlı, sona sarılmış; "Atla" düğmesine basılır. Bitince eski hâline döner.
    function adTick() {
      var p = pl(), v = videoEl();
      var on = !!(p && p.classList && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')));
      if (!on || !st.ads || st.closed) {
        if (st.adSaved) {
          if (v) { try { v.muted = st.adSaved.muted; v.playbackRate = st.adSaved.rate; v.style.visibility = ''; } catch (e) {} }
          st.adSaved = null;
          if (!on) { st.adCount++; adLine(); }
        }
        return;
      }
      if (!v) return;
      if (!st.adSaved) { st.adSaved = { muted: !!v.muted, rate: v.playbackRate > 0 && v.playbackRate <= 4 ? v.playbackRate : 1 }; adLine(); }
      try { v.muted = true; v.style.visibility = 'hidden'; v.playbackRate = 16; } catch (e) {}
      try { if (v.paused) { var pp = v.play(); if (pp && pp.catch) pp.catch(function () {}); } } catch (e) {}
      try { var d = v.duration; if (isFinite(d) && d > 0 && v.currentTime < d - 0.1) v.currentTime = d; } catch (e) {}
      var b = D.querySelectorAll('.ytp-ad-skip-button,.ytp-ad-skip-button-modern,.ytp-skip-ad-button,.ytp-ad-skip-button-container button');
      for (var i = 0; i < b.length; i++) { try { b[i].click(); } catch (e) {} }
    }
    if (XP && XO && XS) { XP.open = hOpen; XP.send = hSend; }
    if (typeof F0 === 'function') W.fetch = hFetch;
    offs.push(function () {
      if (XP && XP.open === hOpen) XP.open = XO;
      if (XP && XP.send === hSend) XP.send = XS;
      if (W.fetch === hFetch) W.fetch = F0;
    });

    // ---------- çeviri (cihaz içi → Google → MyMemory) ----------
    function cacheGet(src, t) { return cache[src + '\u0001' + t]; }
    function cachePut(src, t, tr) {
      if (cacheN > 20000) { cache = Object.create(null); cacheN = 0; }
      cache[src + '\u0001' + t] = tr; cacheN++;
    }
    function getJson(url) {
      return F0.call(W, url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store', signal: timeoutSignal(15000) }).then(function (r) {
        if (r.status === 429 || r.status === 403) { var e = new Error('limit'); e.limit = true; throw e; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    }
    var dev = { lang: null, p: null };
    function device(src) {
      if (!src || src === 'auto' || !('Translator' in W)) return Promise.resolve(null);
      if (dev.lang === src) return dev.p;
      dev.lang = src;
      dev.p = Promise.resolve().then(function () {
        return W.Translator.availability({ sourceLanguage: src, targetLanguage: 'tr' });
      }).then(function (a) {
        return a === 'available' ? W.Translator.create({ sourceLanguage: src, targetLanguage: 'tr' }) : null;
      }).catch(function () { return null; });
      return dev.p;
    }
    function gtx(lines) {
      var url = GTX + '?client=gtx&sl=auto&tl=tr&dt=t&q=' + encodeURIComponent(lines.join('\n'));
      return getJson(url).then(function (j) {
        var segs = j && j[0], out = '';
        if (!Array.isArray(segs)) throw new Error('bozuk cevap');
        for (var i = 0; i < segs.length; i++) if (segs[i] && typeof segs[i][0] === 'string') out += segs[i][0];
        if (lines.length === 1) return [clean(out)];
        var parts = out.split('\n');
        return parts.length === lines.length ? parts.map(clean) : null;
      });
    }
    function seq(items, fn) {
      var out = [], i = 0;
      return new Promise(function (resolve) {
        (function next() {
          if (i >= items.length || st.closed) { resolve(out); return; }
          var k = i++;
          fn(items[k]).then(function (r) { out[k] = r; next(); }, function () { out[k] = null; next(); });
        })();
      });
    }
    function viaWeb(lines, src) {
      if (Date.now() < st.gtxOff) return viaMyMemory(lines, src);
      return gtx(lines).then(function (r) {
        st.engine = 'Google Çeviri'; st.netFail = 0;
        if (r) return r;
        return seq(lines, function (l) { return gtx([l]).then(function (x) { return x[0]; }); });
      }, function (e) {
        st.gtxOff = Date.now() + (e && e.limit ? 120000 : 20000);
        st.netFail++;
        return viaMyMemory(lines, src);
      });
    }
    function viaMyMemory(lines, src) {
      if (!src || src === 'auto' || Date.now() < st.mmOff) return Promise.resolve(lines.map(function () { return null; }));
      return seq(lines, function (l) {
        var url = MYM + '?q=' + encodeURIComponent(l.slice(0, 480)) + '&langpair=' + encodeURIComponent(src) + '%7Ctr';
        return getJson(url).then(function (j) {
          if (j && j.quotaFinished) { st.mmOff = Date.now() + 3600000; return null; }
          var t = j && j.responseData && j.responseData.translatedText;
          if (typeof t !== 'string' || !t || /MYMEMORY WARNING/i.test(t)) return null;
          st.engine = 'MyMemory'; st.netFail = 0;
          return clean(unent(t));
        });
      });
    }
    /** → Promise<Array<string|null>>; önbellekte olanlar yeniden istenmez. */
    function translateLines(lines, src) {
      var res = [], need = [], idx = [];
      for (var i = 0; i < lines.length; i++) {
        var c = cacheGet(src, lines[i]);
        if (c) res[i] = c; else { need.push(lines[i]); idx.push(i); }
      }
      if (!need.length) return Promise.resolve(res);
      return device(src).then(function (tr) {
        if (tr) {
          st.engine = 'cihaz içi çeviri';
          return Promise.all(need.map(function (l) { return tr.translate(l).then(clean, function () { return null; }); }));
        }
        return viaWeb(need, src);
      }).then(function (out) {
        for (var k = 0; k < need.length; k++) {
          var v = out && out[k];
          res[idx[k]] = v || null;
          if (v) cachePut(src, need[k], v);
        }
        return res;
      }, function () { return res; });
    }
    // İzlenen yerden ileriye doğru çevrilmemiş satırlar; seyrek, en fazla PAR iş aynı anda.
    function nextBatch() {
      var cues = st.cues, n = cues.length, now = Date.now(), out = [], chars = 0;
      var start = indexFrom(cues, nowMs());
      for (var k = 0; k < n && out.length < BATCH_LINES; k++) {
        var c = cues[(start + k) % n];
        if (c.state === 0 || (c.state === 3 && now >= c.retryAt)) {
          var hit = cacheGet(st.cueLang, c.t);
          if (hit) { c.tr = hit; c.state = 2; continue; }
          var len = encodeURIComponent(c.t).length + 3;
          if (out.length && chars + len > BATCH_CHARS) break;
          out.push(c); chars += len;
        } else if (out.length) {
          break;
        }
      }
      return out.length ? out : null;
    }
    function pump() {
      if (st.closed || !st.cues || st.direct) return;
      st.lastPump = Date.now();
      while (st.busy < PAR) {
        var batch = nextBatch();
        if (!batch) break;
        run(batch, st.gen);
      }
    }
    function run(batch, g) {
      st.busy++;
      batch.forEach(function (c) { c.state = 1; });
      translateLines(batch.map(function (c) { return c.t; }), st.cueLang).then(function (r) {
        for (var i = 0; i < batch.length; i++) {
          var c = batch[i];
          if (r[i]) { c.tr = r[i]; c.state = 2; } else { c.fails++; c.state = c.fails >= 3 ? 4 : 3; c.retryAt = Date.now() + 30000; }
        }
      }).then(function () {
        if (g !== st.gen || st.closed) return;
        st.busy--;
        render(); progress(); pump();
      });
    }

    // ---------- görünüm ----------
    var css = [
      '.' + P + 'ov{position:absolute;left:50%;bottom:9%;transform:translateX(-50%);z-index:70;width:max-content;max-width:88%;text-align:center;pointer-events:none;font-family:Roboto,"YouTube Noto",Arial,sans-serif;line-height:1.32}',
      '.ytp-autohide .' + P + 'ov{bottom:5%}',
      '.' + P + 'ov[hidden]{display:none}',
      '.' + P + 'ln{margin:0 0 .15em}',
      '.' + P + 'ln span{background:rgba(8,8,8,.78);color:#fff;padding:.08em .4em;border-radius:.2em;white-space:pre-wrap;-webkit-box-decoration-break:clone;box-decoration-break:clone}',
      '.' + P + 'or span{color:#d9d9d9;font-size:.72em}',
      '.' + P + 'pend span{color:#cfcfcf;font-style:italic}',
      '.' + P + 'pn{position:fixed;top:72px;right:16px;z-index:2147483000;width:300px;max-width:calc(100vw - 32px);background:#17191e;color:#eceff3;border:1px solid #2e323a;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.45);font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;padding:12px 14px;box-sizing:border-box}',
      '.' + P + 'pn *{box-sizing:border-box;font:inherit;color:inherit}',
      '.' + P + 'hd{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
      '.' + P + 'tt{flex:1;font-weight:700;font-size:14px}',
      '.' + P + 'lg{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:#e0803a;color:#17191e;font-weight:800;font-size:11px}',
      '.' + P + 'pn button{background:#262a32;border:1px solid #3a3f49;border-radius:8px;padding:5px 10px;cursor:pointer}',
      '.' + P + 'pn button:hover{background:#30353f}',
      '.' + P + 'pn button:disabled{opacity:.45;cursor:default}',
      '.' + P + 'pn button.' + P + 'pr{background:#e0803a;border-color:#e0803a;color:#17191e;font-weight:700}',
      '.' + P + 'pn button.' + P + 'ic{padding:2px 8px}',
      '.' + P + 'pn select{width:100%;background:#262a32;border:1px solid #3a3f49;border-radius:8px;padding:5px 8px}',
      '.' + P + 'st{margin:0 0 8px;color:#f3d2b6}',
      '.' + P + 'rw{display:flex;align-items:center;gap:8px;margin:6px 0;flex-wrap:wrap}',
      '.' + P + 'ck{display:flex;align-items:center;gap:6px;margin:4px 0;cursor:pointer}',
      '.' + P + 'ck input{margin:0;accent-color:#e0803a}',
      '.' + P + 'sm{color:#9aa3ae;font-size:12px;margin-top:6px}',
      '.' + P + 'pn.' + P + 'min{width:auto;padding:6px 10px}',
      '.' + P + 'pn.' + P + 'min .' + P + 'bd{display:none}',
      '.' + P + 'pn.' + P + 'min .' + P + 'hd{margin:0}'
    ].join('\n');
    var style = el('style'); style.textContent = css;
    var hideStyle = el('style');
    var adStyle = el('style');
    var AD_CSS = '.ytp-ad-module,.ytp-ad-overlay-container,.ytp-ad-overlay-slot,.ytp-ad-image-overlay,.ytp-paid-content-overlay,.video-ads,' +
      '#player-ads,#masthead-ad,ytd-ad-slot-renderer,ytd-in-feed-ad-layout-renderer,ytd-display-ad-renderer,ytd-banner-promo-renderer,' +
      'ytd-promoted-sparkles-web-renderer,ytd-promoted-video-renderer,ytd-companion-slot-renderer,ytd-action-companion-ad-renderer,' +
      'ytd-statement-banner-renderer{display:none!important}\n' +
      'ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer){display:none!important}';
    function applyAdCss() { adStyle.textContent = st.ads ? AD_CSS : ''; }
    (D.head || D.documentElement).appendChild(style);
    (D.head || D.documentElement).appendChild(hideStyle);
    (D.head || D.documentElement).appendChild(adStyle);
    applyAdCss();

    var ov = el('div', P + 'ov');
    ov.setAttribute('data-altyazi-sefi', 'overlay');
    var lnTr = el('div', P + 'ln'), lnOr = el('div', P + 'ln ' + P + 'or');
    var spTr = el('span'), spOr = el('span');
    lnTr.appendChild(spTr); lnOr.appendChild(spOr);
    ov.appendChild(lnTr); ov.appendChild(lnOr);
    ov.hidden = true;

    var ui = {};
    function btn(label, cls, fn, title) {
      var b = el('button', cls || '', label);
      b.type = 'button';
      if (title) { b.title = title; b.setAttribute('aria-label', title); }
      on(b, 'click', function (e) { e.preventDefault(); e.stopPropagation(); fn(); });
      return b;
    }
    function check(label, val, fn) {
      var box = el('input');
      box.type = 'checkbox'; box.checked = !!val;
      on(box, 'change', function () { fn(box.checked); });
      var lab = el('label', P + 'ck');
      lab.appendChild(box); lab.appendChild(D.createTextNode(label));
      return lab;
    }
    var pn = el('div', P + 'pn');
    pn.setAttribute('data-altyazi-sefi', 'panel');
    pn.setAttribute('role', 'dialog');
    pn.setAttribute('aria-label', 'Altyazı Şefi');
    var hd = el('div', P + 'hd');
    hd.appendChild(el('span', P + 'lg', 'AŞ'));
    hd.appendChild(el('span', P + 'tt', 'Altyazı Şefi'));
    ui.minB = btn('–', P + 'ic', function () { setMin(!st.min); }, 'Paneli küçült');
    hd.appendChild(ui.minB);
    hd.appendChild(btn('✕', P + 'ic', close, 'Kapat (Türkçe altyazı da kapanır)'));
    var bd = el('div', P + 'bd');
    ui.st = el('p', P + 'st');
    ui.st.setAttribute('aria-live', 'polite');
    bd.appendChild(ui.st);
    ui.sel = el('select');
    ui.sel.setAttribute('aria-label', 'Kaynak altyazı');
    on(ui.sel, 'change', function () { var t = st.tracks[Number(ui.sel.value)]; if (t) load(t); });
    var r1 = el('div', P + 'rw');
    r1.appendChild(el('span', '', 'Altyazı:'));
    var selWrap = el('div');
    selWrap.style.flex = '1';
    selWrap.appendChild(ui.sel);
    r1.appendChild(selWrap);
    bd.appendChild(r1);
    bd.appendChild(check('Türkçe altyazıyı göster', st.on, function (v) { st.on = v; applyHide(); render(); }));
    bd.appendChild(check('YouTube\'un kendi altyazısını gizle', st.hideYt, function (v) { st.hideYt = v; savePrefs(); applyHide(); }));
    bd.appendChild(check('Orijinalini de göster', st.showOrig, function (v) { st.showOrig = v; savePrefs(); render(); }));
    bd.appendChild(check('Reklamları atla', st.ads, function (v) { st.ads = v; savePrefs(); applyAdCss(); adTick(); adLine(); }));
    var r2 = el('div', P + 'rw');
    r2.appendChild(el('span', '', 'Yazı boyu:'));
    r2.appendChild(btn('A−', '', function () { setSize(st.size - 0.1); }, 'Yazıyı küçült'));
    r2.appendChild(btn('A+', '', function () { setSize(st.size + 0.1); }, 'Yazıyı büyüt'));
    bd.appendChild(r2);
    var r3 = el('div', P + 'rw');
    ui.dl = btn('Türkçe SRT indir', P + 'pr', download, 'Türkçe altyazıyı .srt dosyası olarak kaydeder');
    ui.dl.disabled = true;
    r3.appendChild(ui.dl);
    bd.appendChild(r3);
    ui.ad = el('div', P + 'sm');
    ui.pg = el('div', P + 'sm');
    bd.appendChild(ui.ad);
    bd.appendChild(ui.pg);
    bd.appendChild(el('div', P + 'sm', 'Düğmeye yeniden basınca bu panel açılır/küçülür.'));
    pn.appendChild(hd); pn.appendChild(bd);
    on(hd, 'click', function () { if (st.min) setMin(false); });
    // YouTube'un klavye kısayolları (boşluk, ok tuşları) panelde çalışmasın
    on(pn, 'keydown', function (e) { e.stopPropagation(); });
    D.body.appendChild(pn);

    function status(t) { ui.st.textContent = t; }
    function adLine() {
      if (!ui.ad) return;
      ui.ad.textContent = !st.ads ? 'Reklam atlama kapalı.'
        : st.adSaved ? 'Reklam atlanıyor…'
        : 'Reklam atlama açık' + (st.adCount ? ' · atlanan reklam: ' + st.adCount : '') + '.';
    }
    function setMin(v) {
      st.min = v;
      pn.classList.toggle(P + 'min', v);
      ui.minB.textContent = v ? '+' : '–';
      ui.minB.title = v ? 'Paneli aç' : 'Paneli küçült';
      ui.minB.setAttribute('aria-label', ui.minB.title);
    }
    function setSize(v) { st.size = Math.round(Math.min(2.2, Math.max(0.6, v)) * 10) / 10; savePrefs(); render(); }
    function applyHide() {
      var hide = st.on && st.hideYt && (!!st.cues || st.dom);
      hideStyle.textContent = hide ? '.ytp-caption-window-container{visibility:hidden!important}' : '';
    }
    function fillSelect() {
      while (ui.sel.firstChild) ui.sel.removeChild(ui.sel.firstChild);
      for (var i = 0; i < st.tracks.length; i++) {
        var o = el('option', '', st.tracks[i].name);
        o.value = String(i);
        ui.sel.appendChild(o);
      }
      ui.sel.disabled = !st.tracks.length;
    }
    function progress() {
      var t = '';
      if (st.cues) {
        var done = 0;
        for (var i = 0; i < st.cues.length; i++) if (st.cues[i].state === 2) done++;
        t = st.direct ? 'Türkçe altyazı · ' + st.cues.length + ' satır'
          : 'Türkçe: ' + done + ' / ' + st.cues.length + ' satır' + (st.engine ? ' · ' + st.engine : '');
        t += ' · kaynak: ' + st.via;
        if (!st.direct && st.netFail >= 2 && done < st.cues.length) t += ' · çeviri servisine ulaşılamıyor, yeniden denenecek';
      } else if (st.dom) {
        t = 'Kaynak: ekrandan' + (st.engine ? ' · ' + st.engine : '');
      }
      if (st.blocked) t += ' · YouTube çeviri servisine bağlanmayı engelledi';
      ui.pg.textContent = t;
      ui.dl.disabled = !st.cues;
    }
    function render() {
      var p = pl();
      var text = '', orig = '', pend = false;
      var ad = !!(p && p.classList && p.classList.contains('ad-showing'));
      if (st.on && !ad) {
        if (st.cues) {
          var i = indexAt(st.cues, nowMs());
          if (i >= 0) {
            var c = st.cues[i];
            orig = c.t;
            if (c.tr) text = c.tr; else { text = c.t; pend = true; }
          }
        } else if (st.dom && st.domText) {
          var src = st.want ? base(st.want.lang) : '';
          orig = st.domText;
          text = cacheGet(src, st.domText) || '';
          if (!text) { text = st.domText; pend = true; }
        }
      }
      var showOr = st.showOrig && !pend && orig && orig !== text;
      var k = text + '\u0001' + (showOr ? orig : '') + '\u0001' + pend;
      if (k !== st.shownKey) {
        st.shownKey = k;
        spTr.textContent = text;
        spOr.textContent = showOr ? orig : '';
        lnOr.hidden = !showOr;
        lnTr.classList.toggle(P + 'pend', pend);
        ov.hidden = !text;
      }
      if (p) {
        var h = p.clientHeight || 360;
        var fs = Math.round(Math.min(64, Math.max(13, h * 0.042 * st.size)));
        if (ov.style.fontSize !== fs + 'px') ov.style.fontSize = fs + 'px';
      }
    }
    function fileName() {
      var t = (st.title || st.vid || 'youtube').replace(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*​-‏‪-‮⁦-⁩﻿]/g, ' ');
      t = clean(t).replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80) || 'youtube';
      return t + '.tr.srt';
    }
    function download() {
      if (!st.cues) return;
      var blob = new Blob(['﻿' + toSrt(st.cues)], { type: 'application/x-subrip;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = el('a');
      a.href = url; a.download = fileName(); a.rel = 'noopener'; a.hidden = true;
      D.body.appendChild(a);
      a.click();
      if (a.parentNode) a.parentNode.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 20000);
      var left = 0;
      for (var i = 0; i < st.cues.length; i++) if (!st.cues[i].tr) left++;
      status(left ? 'SRT indirildi. ' + left + ' satır henüz çevrilmediği için orijinal dilde.' : 'Türkçe SRT indirildi.');
    }

    // ---------- video değişimi (YouTube sayfa yenilemeden video değiştirir) ----------
    function onVideo(v) {
      st.vid = v; st.gen++; st.busy = 0; st.cues = null; st.cueKey = ''; st.tracks = []; st.want = null;
      st.dom = false; st.title = ''; st.via = '';
      fillSelect(); applyHide(); render(); progress();
      if (!v) { status('Bir YouTube videosu açın; altyazısı kendiliğinden gelir.'); return; }
      status('Altyazı listesi okunuyor…');
      var g = st.gen, tries = 0;
      (function wait() {
        if (g !== st.gen || st.closed) return;
        var r = playerResponse();
        if (!r) {
          if (++tries < 40) { later(wait, 250); return; }
          status('Video bilgisi okunamadı. Sayfayı yenileyip düğmeye yeniden basın.');
          return;
        }
        st.title = clean(r.videoDetails && r.videoDetails.title);
        st.tracks = readTracks(r);
        fillSelect();
        if (!st.tracks.length) {
          status('Bu videoda altyazı yok. Konuşmayı çevirmek için Altyazı Şefi sitesinde "Canlı çeviri" bölümünü açıp bu sekmeyi paylaşın.');
          return;
        }
        load(bestTrack());
      })();
    }

    function tick() {
      if (st.closed) return;
      var v = curVid();
      if (v !== st.vid) onVideo(v);
      var p = pl();
      if (p && ov.parentNode !== p) p.appendChild(ov);
      if (st.dom && !st.cues) domTick(Date.now());
      if (st.cues && Date.now() - st.lastPump > 1000) pump();
      render();
    }
    function close() {
      if (st.closed) return;
      st.closed = true;
      st.gen++;
      adTick();
      offs.splice(0).forEach(function (f) { try { f(); } catch (e) {} });
      [ov, pn, style, hideStyle, adStyle].forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
      try { delete W[KEY]; } catch (e) { W[KEY] = undefined; }
    }
    on(D, 'securitypolicyviolation', function (e) {
      var u = String((e && e.blockedURI) || '');
      if (u.indexOf('translate.googleapis.com') >= 0 || u.indexOf('mymemory') >= 0) { st.blocked = true; progress(); }
    });
    on(D, 'yt-navigate-finish', function () { later(tick, 50); });
    every(tick, 150);
    every(adTick, 100);
    every(progress, 1000);

    W[KEY] = {
      toggle: function () { setMin(!st.min); },
      close: close,
      _t: {
        parse: parse, toSrt: toSrt, indexAt: indexAt,
        info: function () {
          var done = 0;
          if (st.cues) for (var i = 0; i < st.cues.length; i++) if (st.cues[i].state === 2) done++;
          return {
            vid: st.vid, title: st.title, tracks: st.tracks.map(function (t) { return t.key; }), want: st.want ? st.want.key : '',
            cueKey: st.cueKey, cues: st.cues ? st.cues.length : 0, translated: done, via: st.via, engine: st.engine,
            direct: st.direct, dom: st.dom, shown: ov.hidden ? '' : spTr.textContent, orig: lnOr.hidden ? '' : spOr.textContent,
            status: ui.st.textContent, progress: ui.pg.textContent, min: st.min,
            ads: st.ads, adCount: st.adCount, adActive: !!st.adSaved, adStripped: st.adStripped, adLine: ui.ad.textContent
          };
        }
      }
    };
    adLine();
    adTick();
    tick();
  };
})(typeof window !== 'undefined' ? window : globalThis);

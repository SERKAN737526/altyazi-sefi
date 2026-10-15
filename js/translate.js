/* Altyazı Şefi Web: Türkçeye çeviri → AS.translate
 * Sıra: 1) çeviri belleği (bellek LRU + IndexedDB), 2) Chrome'un cihazdaki Translator API'si,
 *       3) izin varsa çevrim içi (Google gtx, olmazsa MyMemory), 4) hata.
 * İnternete yalnızca çevrilecek cümle gönderilir (çerez yok, referrer yok).
 * Klasik betik (IIFE). Node testlerinde `global.window = global` ile yüklenebilir. */
(function (root) {
  'use strict';
  var AS = root.AS = root.AS || {};

  /* ---------- ayarlanabilir değerler (testler küçültebilir) ---------- */
  var cfg = {
    timeoutMs: 8000,          // çevrim içi istek başına zaman aşımı
    backoffMs: 30000,         // HTTP 429/5xx sonrası motoru dinlendirme süresi
    quotaBackoffMs: 600000,   // MyMemory günlük kota uyarısı sonrası
    maxOnline: 2,             // aynı anda en çok çevrim içi istek
    availTimeoutMs: 2500,     // Translator/LanguageDetector.availability() için
    stallMs: 300000,          // availability() yanıt vermezse cihaz API'si bu kadar süre denenmez
    prepareIdleMs: 90000,     // prepareDevice: bu kadar süre ilerleme gelmezse vazgeç
    createTimeoutMs: 20000,   // hazır ('available') modelin oluşturulması için
    deviceTimeoutMs: 12000,   // cihazda tek çeviri için
    idbOpenTimeoutMs: 2500,
    idbOpTimeoutMs: 1500,
    memMax: 5000,
    idbMax: 20000,
    chunkMax: 450,            // çevrim içi tek istekte en çok karakter (MyMemory sınırı 500)
    maxInput: 5000,           // tek çağrıda en çok karakter
    retryAfterFailMs: 1200,   // PreTranslator: başarısız satırı yeniden denemeden önce
    retryOfflineMs: 3000,
    preConcurrency: 2,
    preMaxTries: 5,
    now: function () { return Date.now(); }
  };

  var TARGET = 'tr';
  var GTX = 'https://translate.googleapis.com/translate_a/single';
  var MYMEMORY = 'https://api.mymemory.translated.net/get';
  var MAX_RESPONSE = 256 * 1024;
  var DB_NAME = 'as-tm';
  var STORE = 'tm';

  var lastEngine = null;   // 'cache' | 'device' | 'google' | 'mymemory' | 'none'

  /* ---------- küçük yardımcılar ---------- */
  function clean(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/\s+/g, ' ').trim();
  }

  function abortError() {
    try { return new DOMException('İşlem iptal edildi.', 'AbortError'); } catch (e) {
      var err = new Error('İşlem iptal edildi.'); err.name = 'AbortError'; return err;
    }
  }
  function isAbort(e) { return !!e && e.name === 'AbortError'; }
  function throwIfAborted(signal) { if (signal && signal.aborted) throw abortError(); }

  function fail(code, message, extra) {
    var e = new Error(message || 'Çeviri yapılamadı');
    e.code = code;
    if (extra) for (var k in extra) e[k] = extra[k];
    return e;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** Promise'i süre sınırıyla bekler; süre dolarsa 'timeout' hatası. */
  function withTimeout(p, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(fail('timeout', 'Zaman aşımı')); }, ms);
      Promise.resolve(p).then(function (v) { clearTimeout(t); resolve(v); },
        function (e) { clearTimeout(t); reject(e); });
    });
  }

  /** Promise'i signal ile yarıştırır (iptal edilirse AbortError). */
  function raceAbort(p, signal) {
    if (!signal) return Promise.resolve(p);
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise(function (resolve, reject) {
      function onAbort() { reject(abortError()); }
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(p).then(function (v) { signal.removeEventListener('abort', onAbort); resolve(v); },
        function (e) { signal.removeEventListener('abort', onAbort); reject(e); });
    });
  }

  function setting(k, dflt) {
    try { var v = AS.settings && AS.settings.get(k); return v === undefined ? dflt : v; } catch (e) { return dflt; }
  }
  function onlineAllowed() { return !!setting('translateOnline', true); }
  function networkUp() {
    try { return !(root.navigator && root.navigator.onLine === false); } catch (e) { return true; }
  }

  function emitStatus(text, level) {
    try { if (AS.bus) AS.bus.emit('status', { mode: 'app', text: text, level: level || 'info' }); } catch (e) { /* yok say */ }
  }
  function emitProgress(p) {
    try { if (AS.bus) AS.bus.emit('progress', p); } catch (e) { /* yok say */ }
  }

  /** ISO dil kodunu sadeleştirir: 'en-US' → 'en', 'zh-TW' → 'zh-Hant'. Geçersizse null. */
  function normLang(code) {
    if (typeof code !== 'string') return null;
    var c = code.trim().replace(/_/g, '-').toLowerCase();
    if (!c || c === 'auto' || c === 'und') return null;
    if (/^zh-(hant|tw|hk|mo)\b/.test(c)) return 'zh-Hant';
    var base = c.split('-')[0];
    if (base === 'iw') base = 'he';
    if (base === 'in') base = 'id';
    if (base === 'jw') base = 'jv';
    return /^[a-z]{2,3}$/.test(base) ? base : null;
  }
  function normFrom(from) {
    if (from === undefined || from === null || from === '' || from === 'auto') return 'auto';
    return normLang(from) || 'auto';
  }
  function normAvail(v) {
    if (v === 'available' || v === 'readily') return 'available';
    if (v === 'downloadable' || v === 'after-download') return 'downloadable';
    if (v === 'downloading') return 'downloading';
    return 'unavailable';
  }

  /* ---------- 1) çeviri belleği: bellek LRU + IndexedDB ---------- */
  var mem = new Map();
  function memGet(k) {
    if (!mem.has(k)) return undefined;
    var v = mem.get(k);
    mem.delete(k); mem.set(k, v);       // en yeni
    return v;
  }
  function memSet(k, v) {
    if (mem.has(k)) mem.delete(k);
    mem.set(k, v);
    while (mem.size > cfg.memMax) mem.delete(mem.keys().next().value);
  }

  var dbPromise = null;
  var dbState = 'init';     // 'init' | 'open' | 'off'
  var putsSincePrune = 0;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      var settled = false;
      function finish(db) {
        if (settled) { if (db) try { db.close(); } catch (e) { /* */ } return; }
        settled = true;
        dbState = db ? 'open' : 'off';
        resolve(db);
      }
      var idb = null;
      try { idb = root.indexedDB || null; } catch (e) { idb = null; }   // bazı gizli kipler erişimde hata atar
      if (!idb || typeof idb.open !== 'function') return finish(null);
      var req;
      try { req = idb.open(DB_NAME, 1); } catch (e) { return finish(null); }
      var timer = setTimeout(function () { finish(null); }, cfg.idbOpenTimeoutMs);
      req.onupgradeneeded = function () {
        try {
          var db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            var st = db.createObjectStore(STORE, { keyPath: 'k' });
            st.createIndex('t', 't');
          }
        } catch (e) { /* başarısız yükseltme onerror ile biter */ }
      };
      req.onsuccess = function () {
        clearTimeout(timer);
        var db = req.result;
        try {
          db.onversionchange = function () { try { db.close(); } catch (e) { /* */ } dbPromise = null; dbState = 'init'; };
          db.onclose = function () { dbPromise = null; dbState = 'init'; };
        } catch (e) { /* */ }
        finish(db);
      };
      req.onerror = function (ev) {
        clearTimeout(timer);
        try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* */ }
        finish(null);
      };
      req.onblocked = function () { /* başka sekme eski sürümü tutuyor: zaman aşımı karar verir */ };
    });
    return dbPromise;
  }

  function idbGet(k) {
    return openDb().then(function (db) {
      if (!db) return undefined;
      return new Promise(function (resolve) {
        var t = setTimeout(function () { resolve(undefined); }, cfg.idbOpTimeoutMs);
        try {
          var r = db.transaction(STORE, 'readonly').objectStore(STORE).get(k);
          r.onsuccess = function () {
            clearTimeout(t);
            var v = r.result;
            resolve(v && typeof v.tr === 'string' ? v.tr : undefined);
          };
          r.onerror = function (ev) { clearTimeout(t); try { ev.preventDefault(); } catch (e) { /* */ } resolve(undefined); };
        } catch (e) { clearTimeout(t); resolve(undefined); }
      });
    }, function () { return undefined; });
  }

  function idbPut(k, tr) {
    return openDb().then(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ k: k, tr: tr, t: cfg.now() });
        tx.onerror = function (ev) { try { ev.preventDefault(); } catch (e) { /* kota dolu vb. */ } };
        tx.onabort = function () { /* yok say */ };
        if (++putsSincePrune >= 200) { putsSincePrune = 0; prune(db); }
      } catch (e) { /* yok say: bellek yine çalışır */ }
    }, function () { /* */ });
  }

  /** IndexedDB çok büyürse en eski kayıtları siler. */
  function prune(db) {
    try {
      var tx = db.transaction(STORE, 'readwrite');
      var st = tx.objectStore(STORE);
      var c = st.count();
      c.onsuccess = function () {
        var extra = c.result - Math.floor(cfg.idbMax * 0.9);
        if (c.result <= cfg.idbMax || extra <= 0) return;
        var cur = st.index('t').openCursor();
        cur.onsuccess = function () {
          var cursor = cur.result;
          if (!cursor || extra-- <= 0) return;
          cursor.delete();
          cursor.continue();
        };
      };
      tx.onerror = function (ev) { try { ev.preventDefault(); } catch (e) { /* */ } };
    } catch (e) { /* */ }
  }

  function remember(k, tr) {
    memSet(k, tr);
    idbPut(k, tr);
  }

  function clearCache() {
    mem.clear();
    return openDb().then(function (db) {
      if (!db) return;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).clear();
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function (ev) { try { ev.preventDefault(); } catch (e) { /* */ } resolve(); };
          tx.onabort = function () { resolve(); };
        } catch (e) { resolve(); }
      });
    });
  }

  /* ---------- 2) Chrome'un cihazdaki çevirmeni ---------- */
  function translatorApi() {
    try {
      var T = root.Translator;
      return T && typeof T.availability === 'function' && typeof T.create === 'function' ? T : null;
    } catch (e) { return null; }
  }
  function detectorApi() {
    try {
      var D = root.LanguageDetector;
      return D && typeof D.availability === 'function' && typeof D.create === 'function' ? D : null;
    } catch (e) { return null; }
  }

  var availCache = new Map();   // dil → {state, until}
  var availPending = new Map(); // dil → Promise<state> (aynı anda tek sorgu)
  var translators = new Map();  // dil → Promise<translator|null>
  var deviceStallUntil = 0;     // API var ama yanıt vermiyor (ör. başsız Chromium): bir süre hiç deneme

  function deviceAvailability(lang, fresh) {
    var T = translatorApi();
    if (!T) return Promise.resolve('unsupported');
    var c = availCache.get(lang);
    if (!fresh && c && c.until > cfg.now()) return Promise.resolve(c.state);
    if (deviceStallUntil > cfg.now()) return Promise.resolve('unavailable');   // 'fresh' de beklemez
    if (availPending.has(lang)) return availPending.get(lang);
    var p = withTimeout(Promise.resolve().then(function () {
      return T.availability({ sourceLanguage: lang, targetLanguage: TARGET });
    }), cfg.availTimeoutMs).then(function (v) {
      deviceStallUntil = 0;
      return normAvail(v);
    }, function (e) {
      if (e && e.code === 'timeout') deviceStallUntil = cfg.now() + cfg.stallMs;
      return 'unavailable';
    }).then(function (state) {
      availPending.delete(lang);
      var ttl = state === 'available' ? 600000 : (state === 'unavailable' ? cfg.stallMs : 30000);
      availCache.set(lang, { state: state, until: cfg.now() + ttl });
      return state;
    });
    availPending.set(lang, p);
    return p;
  }

  function getTranslator(lang) {
    if (translators.has(lang)) return translators.get(lang);
    return deviceAvailability(lang).then(function (state) {
      if (state !== 'available') return null;
      if (translators.has(lang)) return translators.get(lang);
      var T = translatorApi();
      if (!T) return null;
      var p = withTimeout(Promise.resolve().then(function () {
        return T.create({ sourceLanguage: lang, targetLanguage: TARGET });
      }), cfg.createTimeoutMs).then(function (t) {
        return t && typeof t.translate === 'function' ? t : null;
      }, function () { return null; }).then(function (t) {
        if (!t) {
          translators.delete(lang);
          availCache.set(lang, { state: 'unavailable', until: cfg.now() + 60000 });
        }
        return t;
      });
      translators.set(lang, p);
      return p;
    });
  }

  function dropTranslator(lang) {
    var p = translators.get(lang);
    translators.delete(lang);
    if (p) p.then(function (t) { try { if (t && t.destroy) t.destroy(); } catch (e) { /* */ } });
  }

  /** Cihazda çevirir; olmazsa null (çevrim içine geçilir). */
  function tryDevice(s, lang, signal) {
    return getTranslator(lang).then(function (t) {
      if (!t) return null;
      throwIfAborted(signal);
      var p = Promise.resolve().then(function () {
        return signal ? t.translate(s, { signal: signal }) : t.translate(s);
      });
      return raceAbort(withTimeout(p, cfg.deviceTimeoutMs), signal).then(function (out) {
        var r = clean(out);
        return r || null;
      }, function (e) {
        if (isAbort(e) && signal && signal.aborted) throw abortError();
        dropTranslator(lang);   // nesne bozulmuş olabilir: bir dahaki sefere yeniden oluşturulur
        return null;
      });
    });
  }

  var detector = null;
  var detectorP = null;
  var detectorRetryAt = 0;

  function getDetector() {
    if (detector) return Promise.resolve(detector);
    var D = detectorApi();
    if (!D || detectorRetryAt > cfg.now()) return Promise.resolve(null);
    if (detectorP) return detectorP;
    detectorP = withTimeout(Promise.resolve().then(function () { return D.availability(); }), cfg.availTimeoutMs)
      .then(normAvail)
      .then(function (state) {
        if (state !== 'available') return null;   // indirme kullanıcı hareketi ister: prepareDevice
        return withTimeout(Promise.resolve().then(function () { return D.create(); }), cfg.createTimeoutMs);
      })
      .then(function (d) { return d && typeof d.detect === 'function' ? d : null; }, function (e) {
        if (e && e.code === 'timeout') detectorRetryAt = cfg.now() + cfg.stallMs;   // yanıt vermeyen API
        return null;
      })
      .then(function (d) {
        detectorP = null;
        if (d) detector = d; else if (detectorRetryAt <= cfg.now()) detectorRetryAt = cfg.now() + 30000;
        return d;
      });
    return detectorP;
  }

  /** Dili algılar (yalnızca cihazdaki LanguageDetector ile); güven < 0.5 ise null. */
  function detectLang(s) {
    return getDetector().then(function (d) {
      if (!d) return null;
      return withTimeout(Promise.resolve().then(function () { return d.detect(s); }), cfg.availTimeoutMs)
        .then(function (res) {
          if (!res || !res.length) return null;
          var best = res[0];
          for (var i = 1; i < res.length; i++) if (res[i] && best && res[i].confidence > best.confidence) best = res[i];
          if (!best || !(best.confidence >= 0.5)) return null;
          return normLang(best.detectedLanguage);
        }, function () { detector = null; return null; });
    });
  }

  /* ---------- 3) çevrim içi: Google gtx, MyMemory ---------- */
  var backoffUntil = { google: 0, mymemory: 0 };
  var active = 0;
  var waiters = [];

  function acquire(signal, high) {
    if (signal && signal.aborted) return Promise.reject(abortError());
    if (active < cfg.maxOnline) { active++; return Promise.resolve(); }
    return new Promise(function (resolve, reject) {
      var w = { resolve: resolve, signal: signal, onAbort: null };
      if (signal) {
        w.onAbort = function () {
          var i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          reject(abortError());
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      if (high) waiters.unshift(w); else waiters.push(w);
    });
  }
  function release() {
    var w = waiters.shift();
    if (w) {
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
      w.resolve();             // yuva doğrudan bekleyene geçer (active değişmez)
    } else if (active > 0) active--;
  }

  function engineBusy(engine) { return backoffUntil[engine] > cfg.now(); }
  function backoff(engine, ms, note) {
    var was = engineBusy(engine);
    backoffUntil[engine] = cfg.now() + ms;
    if (!was && note) emitStatus(note, 'warn');
  }

  /** GET + JSON; HTTP 429/5xx motoru dinlendirir. */
  function getJson(engine, url, signal, high) {
    return acquire(signal, high).then(function () {
      var ctrl = new AbortController();
      var timedOut = false;
      function onAbort() { ctrl.abort(); }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      var timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, cfg.timeoutMs);
      function done() {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        release();
      }
      return Promise.resolve().then(function () {
        if (typeof root.fetch !== 'function') throw fail('nofetch', 'fetch yok');
        return root.fetch(url, {
          method: 'GET', signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error'
        });
      }).then(function (res) {
        if (res.status === 429 || res.status >= 500) {
          backoff(engine, cfg.backoffMs, engine === 'google'
            ? 'Google çevirisi geçici olarak yanıt vermiyor; bir süre yedek servis kullanılacak.'
            : 'MyMemory geçici olarak yanıt vermiyor.');
          throw fail('http', 'HTTP ' + res.status);
        }
        if (!res.ok) throw fail('http', 'HTTP ' + res.status);
        var len = Number(res.headers && res.headers.get && res.headers.get('content-length'));
        if (len > MAX_RESPONSE) throw fail('big', 'Yanıt çok büyük');
        return res.text();
      }).then(function (body) {
        if (typeof body !== 'string' || body.length > MAX_RESPONSE) throw fail('big', 'Yanıt çok büyük');
        try { return JSON.parse(body); } catch (e) { throw fail('parse', 'Geçersiz yanıt'); }
      }).then(function (json) { done(); return json; }, function (e) {
        done();
        if (signal && signal.aborted) throw abortError();
        if (timedOut) throw fail('timeout', 'Zaman aşımı');
        // Ağ açıkken fetch hatası: çoğunlukla servis bizi doğrulama sayfasına yönlendirdi
        // (redirect:'error') ya da engelledi. Motoru dinlendir, sürekli yeniden denemesin.
        if (e && e.name === 'TypeError' && networkUp()) {
          backoff(engine, cfg.backoffMs, engine === 'google'
            ? 'Google çevirisi şu an erişilemiyor; bir süre yedek servis kullanılacak.'
            : 'MyMemory şu an erişilemiyor.');
        }
        throw e;
      });
    });
  }

  function gtxLang(lang) {
    if (lang === 'zh') return 'zh-CN';
    if (lang === 'zh-Hant') return 'zh-TW';
    return lang;
  }

  function gtx(s, from, signal, high) {
    var url = GTX + '?client=gtx&sl=' + encodeURIComponent(gtxLang(from)) + '&tl=' + TARGET + '&dt=t&q=' + encodeURIComponent(s);
    return getJson('google', url, signal, high).then(function (json) {
      var parts = Array.isArray(json) && Array.isArray(json[0]) ? json[0] : null;
      if (!parts) throw fail('parse', 'Geçersiz yanıt');
      var out = '';
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (Array.isArray(p) && typeof p[0] === 'string') out += p[0];
      }
      out = clean(out);
      if (!out) throw fail('empty', 'Boş çeviri');
      return out;
    });
  }

  // MyMemory uyarıları büyük harfle ve 200 durum koduyla "çeviri" alanında gelir (büyük/küçük harfe duyarlı bakılır,
  // gerçek bir çeviride geçen sıradan kelimeler yanlışlıkla reddedilmesin).
  var MM_BAD = /MYMEMORY WARNING|YOU USED ALL AVAILABLE FREE TRANSLATIONS|NEXT AVAILABLE IN|QUERY LENGTH LIMIT|INVALID (SOURCE|TARGET) LANGUAGE|IS AN INVALID|PLEASE SELECT TWO DISTINCT LANGUAGES|NO QUERY SPECIFIED|LIMIT EXCEEDED|QUOTA/;
  var MM_QUOTA = /QUOTA|ALL AVAILABLE FREE|NEXT AVAILABLE/;

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp);/g, function (all, b) {
      if (b === 'amp') return '&';
      if (b === 'lt') return '<';
      if (b === 'gt') return '>';
      if (b === 'quot') return '"';
      if (b === 'apos') return "'";
      if (b === 'nbsp') return ' ';
      var cp = b.charAt(1) === 'x' || b.charAt(1) === 'X' ? parseInt(b.slice(2), 16) : parseInt(b.slice(1), 10);
      if (!(cp > 0 && cp <= 0x10FFFF) || (cp >= 0xD800 && cp <= 0xDFFF)) return '';
      try { return String.fromCodePoint(cp); } catch (e) { return ''; }
    });
  }

  function mmLang(lang) {
    if (!lang || lang === 'auto') return 'Autodetect';
    if (lang === 'zh') return 'zh-CN';
    if (lang === 'zh-Hant') return 'zh-TW';
    return lang;
  }

  function myMemory(s, lang, signal, high) {
    var url = MYMEMORY + '?q=' + encodeURIComponent(s) + '&langpair=' + encodeURIComponent(mmLang(lang) + '|' + TARGET);
    return getJson('mymemory', url, signal, high).then(function (json) {
      var data = json && json.responseData;
      var out = data && typeof data.translatedText === 'string' ? data.translatedText : '';
      var status = json ? Number(json.responseStatus) : 0;
      if (json && (json.quotaFinished === true || MM_BAD.test(out) || status === 429)) {
        if (json.quotaFinished === true || MM_QUOTA.test(out) || status === 429) {
          backoff('mymemory', cfg.quotaBackoffMs, 'MyMemory çeviri kotası doldu.');
        }
        throw fail('rejected', 'MyMemory uyarısı');
      }
      if (status && status !== 200) throw fail('rejected', 'MyMemory durum ' + status);
      out = clean(decodeEntities(out));
      if (!out) throw fail('empty', 'Boş çeviri');
      return out;
    });
  }

  /** Uzun metni cümle sınırlarından parçalara böler. */
  function chunks(s, max) {
    if (s.length <= max) return [s];
    var sentences = s.match(/[^.!?…。！？]+[.!?…。！？]*["'”’)\]]*\s*|[.!?…。！？]+\s*/g) || [s];
    var out = [], cur = '';
    function push(piece) {
      if ((cur + piece).length <= max) { cur += piece; return; }
      if (cur) out.push(cur.trim());
      cur = '';
      while (piece.length > max) {
        var cut = piece.lastIndexOf(' ', max);
        if (cut < max * 0.5) cut = max;
        out.push(piece.slice(0, cut).trim());
        piece = piece.slice(cut);
      }
      cur = piece;
    }
    for (var i = 0; i < sentences.length; i++) push(sentences[i]);
    if (cur.trim()) out.push(cur.trim());
    return out.filter(Boolean);
  }

  /** Tek parça: gtx, olmazsa MyMemory. */
  function onlineOne(s, from, hint, signal, high) {
    var engines = [];
    if (!engineBusy('google')) engines.push('google');
    if (!engineBusy('mymemory')) engines.push('mymemory');
    if (!engines.length) {
      var wait = Math.max(0, Math.min(backoffUntil.google, backoffUntil.mymemory) - cfg.now());
      return Promise.reject(fail('busy', 'Çeviri yapılamadı: çeviri servisleri şu an yoğun, biraz sonra yeniden denenecek.',
        { retryAfterMs: Math.min(wait, cfg.backoffMs) }));
    }
    var i = 0;
    function next(lastErr) {
      throwIfAborted(signal);
      if (i >= engines.length) return Promise.reject(lastErr || fail('failed', 'Çeviri yapılamadı'));
      var engine = engines[i++];
      if (engineBusy(engine)) return next(lastErr);    // bu arada dinlenmeye geçmiş olabilir
      var p = engine === 'google' ? gtx(s, from, signal, high) : myMemory(s, from === 'auto' ? hint : from, signal, high);
      return p.then(function (out) { return { text: out, engine: engine }; }, function (e) {
        if (isAbort(e) || (signal && signal.aborted)) throw abortError();
        return next(e);
      });
    }
    return Promise.resolve().then(function () { return next(null); }).catch(function (e) {
      if (isAbort(e)) throw e;
      if (e && e.code === 'busy') throw e;
      throw fail('failed', 'Çeviri yapılamadı', { cause: e });
    });
  }

  function online(s, from, hint, signal, high) {
    var parts = chunks(s, cfg.chunkMax);
    var outs = [];
    var engine = null;
    var p = Promise.resolve();
    parts.forEach(function (part) {
      p = p.then(function () {
        throwIfAborted(signal);
        var k = from + '|' + part;
        var hit = parts.length > 1 ? memGet(k) : undefined;
        if (hit !== undefined) { outs.push(hit); return; }
        return onlineOne(part, from, hint, signal, high).then(function (r) {
          outs.push(r.text);
          engine = r.engine;
          if (parts.length > 1) memSet(k, r.text);
        });
      });
    });
    return p.then(function () { return { text: clean(outs.join(' ')), engine: engine || 'google' }; });
  }

  /* ---------- ana akış ---------- */
  var inflight = new Map();   // aynı anda istenen aynı metin tek kez çevrilir

  function run(s, from, key, signal, high) {
    return idbGet(key).then(function (hit) {
      if (hit !== undefined) { memSet(key, hit); lastEngine = 'cache'; return hit; }
      throwIfAborted(signal);
      var hasT = !!translatorApi();
      var langP = from !== 'auto' ? Promise.resolve(from)
        : (detectorApi() ? detectLang(s).catch(function () { return null; }) : Promise.resolve(null));
      return langP.then(function (lang) {
        throwIfAborted(signal);
        if (lang === TARGET) { lastEngine = 'none'; return s; }       // zaten Türkçe
        var devP = (hasT && lang) ? tryDevice(s, lang, signal) : Promise.resolve(null);
        return devP.then(function (out) {
          if (out) { remember(key, out); lastEngine = 'device'; return out; }
          throwIfAborted(signal);
          if (!onlineAllowed()) {
            throw fail('disabled', 'Çeviri yapılamadı: çevrim içi çeviri kapalı ve cihazda bu dil için çeviri modeli yok.');
          }
          if (!networkUp()) throw fail('offline', 'Çeviri yapılamadı: internet bağlantısı yok.');
          return online(s, from, lang, signal, high).then(function (r) {
            remember(key, r.text);
            lastEngine = r.engine;
            return r.text;
          });
        });
      });
    });
  }

  /**
   * Metni Türkçeye çevirir.
   * @param {string} src
   * @param {{from?:string, signal?:AbortSignal, priority?:'high'}} [opts]
   * @returns {Promise<string>}
   */
  function text(src, opts) {
    opts = opts || {};
    var signal = opts.signal || null;
    if (signal && signal.aborted) return Promise.reject(abortError());
    var s = clean(src);
    if (!s) return Promise.resolve('');
    if (s.length > cfg.maxInput) s = s.slice(0, cfg.maxInput);
    var from = normFrom(opts.from);
    if (from === TARGET) return Promise.resolve(s);
    var key = from + '|' + s;
    var m = memGet(key);
    if (m !== undefined) { lastEngine = 'cache'; return Promise.resolve(m); }

    var entry = inflight.get(key);
    if (!entry) {
      var ctrl = new AbortController();
      entry = { ctrl: ctrl, users: 0, promise: null };
      entry.promise = run(s, from, key, ctrl.signal, opts.priority === 'high');
      entry.promise.then(function () { }, function () { }).then(function () {
        if (inflight.get(key) === entry) inflight.delete(key);
      });
      inflight.set(key, entry);
    }
    entry.users++;
    var settled = false;
    function leave() {
      if (settled) return;
      settled = true;
      entry.users--;
      if (entry.users <= 0 && inflight.get(key) === entry) {
        // Kimse beklemiyor: ağ isteğini iptal et, yuvayı boşalt.
        inflight.delete(key);
        entry.ctrl.abort();
      }
    }
    return new Promise(function (resolve, reject) {
      function onAbort() { leave(); reject(abortError()); }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(function (v) {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true; entry.users--;
        resolve(v);
      }, function (e) {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true; entry.users--;
        reject(isAbort(e) && !(signal && signal.aborted) ? fail('failed', 'Çeviri yapılamadı') : e);
      });
    });
  }

  /** Durum bilgisi (ayarlar/yardım ekranı için). */
  function info() {
    var asr = setting('asrLang', 'auto');
    var from = normLang(asr) || 'en';
    var p = translatorApi() ? deviceAvailability(from, true) : Promise.resolve('unsupported');
    return p.then(function (device) {
      if (from === TARGET && device !== 'unsupported') device = 'available';
      return {
        device: device,
        online: onlineAllowed() && networkUp(),
        lastEngine: lastEngine,
        from: from,
        cache: dbState === 'open' ? 'indexeddb' : (dbState === 'off' ? 'memory' : 'pending'),
        detector: !!detectorApi()
      };
    });
  }

  /**
   * Kullanıcı hareketiyle (tıklama) çağrılmalı: cihazdaki çeviri modelini (ve dil algılayıcıyı) indirir/hazırlar.
   * @returns {Promise<boolean>} çevirmen hazırsa true
   */
  function prepareDevice(from, onProgress) {
    var T = translatorApi();
    var D = detectorApi();
    if (!T) return Promise.resolve(false);
    var lang = normLang(from === undefined ? 'en' : from) || 'en';
    if (lang === TARGET) return Promise.resolve(true);
    var label = 'Cihaz çeviri modeli (' + lang + ' → tr)';
    var last = -1;
    var bumpHook = null;
    function report(loaded) {
      var f = Math.max(0, Math.min(1, Number(loaded) || 0));
      if (bumpHook) bumpHook();          // ilerleme var: zaman aşımını ertele
      if (f === last) return;
      last = f;
      try { if (typeof onProgress === 'function') onProgress(f); } catch (e) { /* */ }
      emitProgress({ what: 'translator', label: label, loaded: f, total: 1, done: false });
    }
    function monitor(m) {
      try { m.addEventListener('downloadprogress', function (e) { report(e && e.loaded); }); } catch (e) { /* */ }
    }
    // Kullanıcı etkinleşmesi kaybolmasın diye iki create() çağrısı da hiç beklemeden (await'siz) yapılır.
    var tP, dP;
    try {
      tP = Promise.resolve(T.create({ sourceLanguage: lang, targetLanguage: TARGET, monitor: monitor }));
    } catch (e) { tP = Promise.reject(e); }
    if (D && !detector) {
      try { dP = Promise.resolve(D.create({ monitor: function () { } })); } catch (e) { dP = Promise.reject(e); }
    } else dP = Promise.resolve(detector);
    // Algılayıcı beklenmez (yalnızca 'auto' için gerekir); hazır olunca kullanılır.
    dP.then(function (d) {
      if (d && typeof d.detect === 'function') { detector = d; detectorRetryAt = 0; }
    }, function () { /* algılayıcı olmadan da çalışır */ });
    emitStatus('Cihaz çeviri modeli hazırlanıyor…', 'busy');
    var prev = translators.get(lang);
    // create() kayıt işini her durumda yapar (ilerleme zaman aşımından sonra bitse bile model kullanılır).
    var created = tP.then(function (t) {
      if (!t || typeof t.translate !== 'function') throw new Error('geçersiz');
      translators.set(lang, Promise.resolve(t));
      availCache.set(lang, { state: 'available', until: cfg.now() + 600000 });
      deviceStallUntil = 0;
      if (prev) prev.then(function (o) { try { if (o && o !== t && o.destroy) o.destroy(); } catch (e) { /* */ } });
      return true;
    }, function () {
      availCache.delete(lang);
      return false;
    });
    return new Promise(function (resolve) {
      var finished = false;
      var idle = null;
      function finish(ok) {
        if (finished) return;
        finished = true;
        clearTimeout(idle);
        emitProgress({ what: 'translator', label: label, loaded: ok ? 1 : (last > 0 ? last : 0), total: 1, done: true });
        emitStatus(ok ? 'Cihazda çeviri hazır (çevrim dışı çalışır).'
          : 'Cihazda çeviri hazırlanamadı; çevrim içi çeviri kullanılacak.', ok ? 'ok' : 'warn');
        resolve(ok);
      }
      function bump() {
        if (finished) return;
        clearTimeout(idle);
        idle = setTimeout(function () { finish(false); }, cfg.prepareIdleMs);
      }
      bumpHook = bump;
      bump();
      created.then(finish);
    });
  }

  /** Dili algılar (cihazdaki LanguageDetector). Yoksa ya da emin değilse null. */
  function detect(t) {
    var s = clean(t);
    if (!s || !detectorApi()) return Promise.resolve(null);
    return detectLang(s).catch(function () { return null; });
  }

  /* ---------- arka planda toplu çeviri ---------- */
  /**
   * Altyazı satırlarını oynatma noktasından ileriye doğru (sonra baştan) arka planda çevirir.
   * @param {{text:string}[]} cues
   * @param {{from?:string, onCue?:function(number,string), onProgress?:function(number,number)}} opts
   */
  class PreTranslator {
    constructor(cues, opts) {
      opts = opts || {};
      this.cues = Array.isArray(cues) ? cues : [];
      this.from = opts.from || 'auto';
      this.onCue = typeof opts.onCue === 'function' ? opts.onCue : null;
      this.onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
      var n = this.cues.length;
      this._state = new Uint8Array(n);   // 0 bekliyor, 1 sürüyor, 2 tamam, 3 başarısız
      this._tries = new Uint8Array(n);
      this._res = new Array(n);
      this._cursor = 0;
      this._workers = 0;
      this._gen = 0;
      this._running = false;
      this._done = 0;
      this._settled = 0;
      this._ctrls = new Set();
      this._onSettings = null;
    }

    _clampIndex(i) {
      var n = this.cues.length;
      i = Math.floor(Number(i) || 0);
      return n ? Math.max(0, Math.min(n - 1, i)) : 0;
    }

    start(fromIndex) {
      this._cursor = this._clampIndex(fromIndex);
      if (!this._running) {
        this._running = true;
        var self = this;
        this._onSettings = function (ev) {
          if (ev && ev.key === 'translateOnline' && ev.value === true) self._retryFailed();
        };
        if (AS.bus) AS.bus.on('settings', this._onSettings);
      }
      this._kick();
    }

    seek(index) {
      this._cursor = this._clampIndex(index);
      if (this._running) this._kick();
    }

    stop() {
      if (!this._running) return;
      this._running = false;
      this._gen++;
      this._workers = 0;
      this._ctrls.forEach(function (c) { try { c.abort(); } catch (e) { /* */ } });
      this._ctrls.clear();
      if (this._onSettings && AS.bus) AS.bus.off('settings', this._onSettings);
      this._onSettings = null;
    }

    result() { return this._res.slice(); }

    _retryFailed() {
      for (var i = 0; i < this._state.length; i++) {
        if (this._state[i] === 3) { this._state[i] = 0; this._tries[i] = 0; this._settled--; }
      }
      if (this._running) this._kick();
    }

    _pick() {
      var n = this.cues.length;
      for (var k = 0; k < n; k++) {
        var i = (this._cursor + k) % n;
        if (this._state[i] === 0) { this._state[i] = 1; return i; }
      }
      return -1;
    }

    _hasPending() {
      for (var i = 0; i < this._state.length; i++) if (this._state[i] === 0) return true;
      return false;
    }

    _kick() {
      while (this._running && this._workers < cfg.preConcurrency && this._hasPending()) this._worker();
    }

    _report() {
      var total = this.cues.length;
      try { if (this.onProgress) this.onProgress(this._done, total); } catch (e) { /* */ }
      emitProgress({ what: 'pretranslate', label: 'Altyazılar çevriliyor', loaded: this._done, total: total,
        done: this._settled >= total });
    }

    async _worker() {
      var gen = this._gen;
      var self = this;
      this._workers++;
      var count = 0;
      try {
        while (this._running && gen === this._gen) {
          var i = this._pick();
          if (i < 0) break;
          var ctrl = new AbortController();
          this._ctrls.add(ctrl);
          var cue = this.cues[i] || {};
          try {
            var tr = await text(cue.text, { from: this.from, signal: ctrl.signal });
            this._state[i] = 2;
            this._res[i] = tr;
            this._done++;
            this._settled++;
            if (this._running && this.onCue) { try { this.onCue(i, tr); } catch (e) { console.error(e); } }
            if (this._running) this._report();
          } catch (e) {
            if (isAbort(e) || ctrl.signal.aborted) { if (this._state[i] === 1) this._state[i] = 0; break; }
            var code = e && e.code;
            if (code === 'disabled') {
              this._state[i] = 3; this._settled++;
              if (this._running) this._report();
            } else if (code !== 'offline' && code !== 'busy' && ++this._tries[i] >= cfg.preMaxTries) {
              this._state[i] = 3; this._settled++;
              if (this._running) this._report();
            } else {
              var wait = code === 'offline' ? cfg.retryOfflineMs
                : code === 'busy' ? Math.max(cfg.retryAfterFailMs, e.retryAfterMs || 0) : cfg.retryAfterFailMs;
              await sleep(wait);
              if (this._state[i] === 1) this._state[i] = 0;
            }
          } finally {
            this._ctrls.delete(ctrl);
          }
          if (++count % 16 === 0) await sleep(0);   // arayüzü kilitleme (bellekten gelen çok sayıda yanıt)
        }
      } finally {
        if (gen === self._gen) {
          self._workers--;
          if (self._running && self._hasPending()) self._kick();
        }
      }
    }
  }

  AS.translate = {
    text: text,
    info: info,
    prepareDevice: prepareDevice,
    detect: detect,
    clearCache: clearCache,
    PreTranslator: PreTranslator,
    /* iç ayarlar: testler ve ince ayar için */
    _cfg: cfg,
    _normLang: normLang,
    _chunks: chunks
  };
})(typeof window !== 'undefined' ? window : globalThis);

/* Altyazı Şefi Web: Whisper konuşma tanıma → AS.asr
 * Ağır iş js/asr-worker.js (ES modül worker, transformers.js 3.7.5) içinde yapılır.
 *  - load({model, onProgress}) → Promise<{device, model, modelId}>
 *  - transcribe(pcm16k, {language='auto', timestamps=false, signal}) → Promise<{text, chunks?, language}>
 *  - isLoaded(), device(), dispose(), cleanText(text, {noSpeechProb})
 * Klasik betik (IIFE). cleanText Node testlerinde de kullanılabilir. */
(function (root) {
  'use strict';
  var AS = root.AS = root.AS || {};

  var MODELS = {
    tiny: 'onnx-community/whisper-tiny',
    base: 'onnx-community/whisper-base',
    small: 'onnx-community/whisper-small'
  };
  var RATE = 16000;
  var WEBGPU_DTYPE = { encoder_model: 'fp32', decoder_model_merged: 'q4' };
  var WASM_DTYPE = 'q8';

  var MSG = {
    noWorker: 'Bu tarayıcı konuşma tanımayı desteklemiyor (modül Web Worker yok).',
    download: 'Konuşma modeli indirilemedi. İnternet bağlantınızı kontrol edip yeniden deneyin.',
    loadFailed: 'Konuşma modeli yüklenemedi',
    memory: 'Konuşma modeli için bellek yetmedi. Ayarlardan daha küçük bir model (tiny/base) seçin.',
    workerCrash: 'Konuşma tanıma motoru beklenmedik biçimde durdu.',
    timeout: 'Konuşma tanıma zaman aşımına uğradı.',
    disposed: 'Konuşma tanıma durduruldu.',
    replaced: 'Konuşma modeli değiştirildi.',
    runFailed: 'Konuşma tanınamadı',
    badAudio: 'Ses verisi geçersiz (16 kHz Float32Array bekleniyor).',
    gpuFallback: 'WebGPU ile çalışmadı; WebAssembly (CPU) ile devam ediliyor.',
    gpuStall: 'WebGPU yanıt vermiyor.',
    ready: 'Konuşma modeli hazır'
  };

  var SCRIPT_SRC = (root.document && root.document.currentScript && root.document.currentScript.src) || null;
  function workerUrl() {
    try { if (SCRIPT_SRC) return new URL('asr-worker.js', SCRIPT_SRC).href; } catch (e) { /* aşağıda */ }
    return new URL('js/asr-worker.js', root.document.baseURI).href;
  }

  /* ------------------------------------------------------------------ */
  /* Durum                                                               */
  /* ------------------------------------------------------------------ */
  var st = {
    worker: null,
    gen: 0,              // her yeni worker/iptal ile artar
    epoch: 0,            // dispose() ile artar: kuyrukta bekleyen işler iptal edilir
    loaded: false,
    loading: null,       // Promise
    loadingId: null,
    modelKey: null,
    modelId: null,
    wantKey: null,       // en son istenen model anahtarı (dispose sonrası otomatik yüklemede kullanılır)
    dev: null,
    gpuVerified: false,  // WebGPU'da en az bir gerçek çalıştırma başarılı oldu mu
    loadCb: null,        // {resolve, reject}
    pending: new Map(),  // id → {resolve, reject, timer}
    nextId: 0,
    chain: Promise.resolve(),
    files: {},
    lastEmit: 0,
    progressFns: [],
    label: ''
  };

  function emitStatus(text, level) {
    if (AS.bus) AS.bus.emit('status', { mode: 'app', text: text, level: level || 'info' });
  }

  function emitProgress(done, force) {
    var loaded = 0, total = 0;
    for (var f in st.files) {
      if (!Object.prototype.hasOwnProperty.call(st.files, f)) continue;
      var x = st.files[f];
      loaded += x.loaded || 0;
      total += x.total || 0;
    }
    if (done && total > 0) loaded = total;
    var now = Date.now();
    if (!force && !done && now - st.lastEmit < 150) return;
    st.lastEmit = now;
    var payload = { what: 'asr-model', label: st.label, loaded: loaded, total: total, done: !!done };
    if (AS.bus) AS.bus.emit('progress', payload);
    st.progressFns.forEach(function (fn) { try { fn(payload); } catch (e) { /* yok */ } });
  }

  function testHook() {
    var tp = AS.util && AS.util.testParams ? AS.util.testParams() : null;
    if (!tp || !tp.asrModelPath || !tp.asrModelId) return null;
    var path;
    try {
      var u = new URL(tp.asrModelPath, root.location.href);
      if (u.origin !== root.location.origin) return null; // yalnızca aynı köken
      path = u.href;
      if (path.charAt(path.length - 1) !== '/') path += '/';
    } catch (e) { return null; }
    var device = tp.device === 'webgpu' ? 'webgpu' : 'wasm';
    return { modelPath: path, modelId: String(tp.asrModelId), device: device };
  }

  async function pickDevice() {
    try {
      var gpu = root.navigator && root.navigator.gpu;
      if (!gpu || typeof gpu.requestAdapter !== 'function') return 'wasm';
      var adapter = await Promise.race([
        gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(function () { return null; }),
        new Promise(function (r) { setTimeout(function () { r(null); }, 2500); })
      ]);
      if (!adapter) return 'wasm';
      var info = adapter.info || null;
      if (adapter.isFallbackAdapter || (info && info.isFallbackAdapter)) return 'wasm'; // yazılım (SwiftShader) bağdaştırıcısı: yavaş
      return 'webgpu';
    } catch (e) {
      return 'wasm';
    }
  }

  function mapError(raw, stage) {
    var m = String(raw || '');
    if (/^(Konuşma|Bu tarayıcı|Ses verisi)/.test(m)) return m;
    if (/Failed to fetch|NetworkError|network|fetch|ERR_|Could not locate file|status(?: code)? (?:4|5)\d\d|was not found locally|ERR_INTERNET/i.test(m)) return MSG.download;
    if (/memory|Out of memory|allocation|RangeError: Array buffer|std::bad_alloc|OOM/i.test(m)) return MSG.memory;
    var short = m.replace(/\s+/g, ' ').slice(0, 160);
    return (stage === 'run' ? MSG.runFailed : MSG.loadFailed) + (short ? ' (' + short + ')' : '') + '.';
  }

  /* ------------------------------------------------------------------ */
  /* Worker yönetimi                                                     */
  /* ------------------------------------------------------------------ */
  function failPending(err) {
    st.pending.forEach(function (p) { clearTimeout(p.timer); try { p.reject(err); } catch (e) { /* yok */ } });
    st.pending.clear();
    if (st.loadCb) { var cb = st.loadCb; st.loadCb = null; cb.reject(err); }
  }

  function killWorker(reason) {
    st.gen++;
    var w = st.worker;
    st.worker = null;
    st.loaded = false;
    st.dev = null;
    st.gpuVerified = false;
    if (w) { try { w.terminate(); } catch (e) { /* yok */ } }
    failPending(new Error(reason || MSG.disposed));
  }

  function onWorkerMessage(gen, msg) {
    if (gen !== st.gen || !msg || typeof msg !== 'object') return;
    st.lastMsg = Date.now();
    switch (msg.type) {
      case 'progress': {
        if (typeof msg.file !== 'string') return;
        var f = st.files[msg.file] || (st.files[msg.file] = { loaded: 0, total: 0 });
        if (msg.status === 'progress') {
          if (msg.total > 0) f.total = msg.total;
          if (msg.loaded >= 0) f.loaded = msg.loaded;
        } else if (msg.status === 'done' && f.total > 0) {
          f.loaded = f.total;
        }
        emitProgress(false, msg.status === 'done');
        return;
      }
      case 'ready': {
        st.loaded = true;
        st.dev = msg.device === 'webgpu' ? 'webgpu' : 'wasm';
        if (st.loadCb) { var cb = st.loadCb; st.loadCb = null; cb.resolve(st.dev); }
        return;
      }
      case 'result': {
        var p = st.pending.get(msg.id);
        if (!p) return;
        st.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
        return;
      }
      case 'error': {
        if (msg.id !== undefined && msg.id !== null) {
          var q = st.pending.get(msg.id);
          if (!q) return;
          st.pending.delete(msg.id);
          clearTimeout(q.timer);
          var e = new Error(mapError(msg.message, 'run'));
          e.raw = String(msg.message || '');
          q.reject(e);
        } else if (st.loadCb) {
          var lc = st.loadCb; st.loadCb = null;
          var le = new Error(mapError(msg.message, 'load'));
          le.raw = String(msg.message || '');
          lc.reject(le);
        }
        return;
      }
    }
  }

  /** Yeni worker açar ve modeli yükler. Başarılıysa cihaz adını döndürür. */
  var GPU_STALL_MS = 120000;
  function startWorker(modelId, device, hook) {
    return new Promise(function (resolve, reject) {
      killWorker(MSG.replaced);
      var gen = st.gen;
      var w;
      try {
        if (typeof root.Worker !== 'function') throw new Error('no Worker');
        w = new root.Worker(workerUrl(), { type: 'module', name: 'as-asr' });
      } catch (e) {
        reject(new Error(MSG.noWorker));
        return;
      }
      st.worker = w;
      st.files = {};
      st.loadCb = { resolve: resolve, reject: reject };
      w.onmessage = function (e) { onWorkerMessage(gen, e.data); };
      w.onerror = function (e) {
        if (e && e.preventDefault) e.preventDefault();
        if (gen !== st.gen) return;
        var detail = (e && e.message) ? e.message : '';
        // Modül worker yüklenemezse (eski tarayıcı) message boş gelir
        var err = new Error(st.loaded ? MSG.workerCrash : (detail ? mapError(detail, 'load') : MSG.noWorker));
        st.loaded = false;
        failPending(err);
      };
      w.onmessageerror = function () { if (gen === st.gen) failPending(new Error(MSG.workerCrash)); };
      // WebGPU sürücüsü hata vermeden takılırsa (yanıt yok) wasm'a geçebilmek için bekçi.
      if (device === 'webgpu') {
        st.lastMsg = Date.now();
        var watch = setInterval(function () {
          if (gen !== st.gen || !st.loadCb || st.loadCb.resolve !== resolve) { clearInterval(watch); return; }
          if (Date.now() - st.lastMsg > GPU_STALL_MS) {
            clearInterval(watch);
            var lc = st.loadCb; st.loadCb = null;
            lc.reject(new Error(MSG.gpuStall));
          }
        }, 5000);
      }
      var dtype = hook ? WASM_DTYPE : (device === 'webgpu' ? WEBGPU_DTYPE : WASM_DTYPE);
      w.postMessage({
        type: 'load', model: modelId, device: device, dtype: dtype,
        local: hook ? { modelPath: hook.modelPath } : null
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Genel API                                                           */
  /* ------------------------------------------------------------------ */
  function load(opts) {
    opts = opts || {};
    var hook = testHook();
    var key = opts.model || (AS.settings ? AS.settings.get('asrModel') : 'base');
    if (!Object.prototype.hasOwnProperty.call(MODELS, key)) key = 'base';
    st.wantKey = key;
    var modelId = hook ? hook.modelId : MODELS[key];
    if (typeof opts.onProgress === 'function' && st.progressFns.indexOf(opts.onProgress) < 0) st.progressFns.push(opts.onProgress);

    if (st.loaded && st.modelId === modelId && st.worker) {
      st.progressFns = [];
      return Promise.resolve({ device: st.dev, model: st.modelKey, modelId: modelId });
    }
    if (st.loading && st.loadingId === modelId) return st.loading;

    st.loadingId = modelId;
    st.label = 'Konuşma modeli yükleniyor (' + modelId.split('/').pop() + ')';
    var p = (async function () {
      var device = hook ? hook.device : await pickDevice();
      try {
        emitProgress(false, true);
        var dev = await startWorker(modelId, device, hook);
        st.modelId = modelId;
        st.modelKey = hook ? modelId : key;
        device = dev;
      } catch (e) {
        if (device === 'webgpu' && e && e.message !== MSG.replaced && e.message !== MSG.disposed) {
          if (root.console) console.warn('[AS.asr] WebGPU yüklemesi başarısız, wasm deneniyor:', e.raw || e.message);
          emitStatus(MSG.gpuFallback, 'warn');
          device = 'wasm';
          await startWorker(modelId, 'wasm', hook);
          st.modelId = modelId;
          st.modelKey = hook ? modelId : key;
        } else {
          throw e;
        }
      }
      emitProgress(true, true);
      emitStatus(MSG.ready + ' (' + (st.dev === 'webgpu' ? 'WebGPU' : 'WebAssembly') + ').', 'ok');
      return { device: st.dev, model: st.modelKey, modelId: st.modelId };
    })();
    st.loading = p;
    p.then(function () {
      if (st.loading === p) { st.loading = null; st.loadingId = null; }
      st.progressFns = [];
    }, function (e) {
      if (st.loading === p) { st.loading = null; st.loadingId = null; }
      st.progressFns = [];
      if (e && e.message !== MSG.replaced && e.message !== MSG.disposed) {
        killWorker(e.message);
        if (AS.bus) AS.bus.emit('progress', { what: 'asr-model', label: st.label, loaded: 0, total: 0, done: true, error: e.message });
        emitStatus(e.message, 'error');
      }
    });
    return p;
  }

  function normLang(language) {
    if (!language || typeof language !== 'string') return null;
    var l = language.trim().toLowerCase();
    if (!l || l === 'auto') return null;
    l = l.split(/[-_]/)[0];
    if (l === 'iw') l = 'he';
    if (l === 'in') l = 'id';
    return /^[a-z]{2,3}$/.test(l) ? l : null;
  }

  function abortError() {
    var e;
    try { e = new DOMException('İptal edildi', 'AbortError'); } catch (x) { e = new Error('İptal edildi'); e.name = 'AbortError'; }
    return e;
  }

  function send(audio, opts) {
    return new Promise(function (resolve, reject) {
      if (!st.worker || !st.loaded) { reject(new Error(MSG.workerCrash)); return; }
      var id = ++st.nextId;
      var durMs = audio.length * 1000 / RATE;
      var timeoutMs = 120000 + durMs * 8;
      var onAbort = null;
      var timer = setTimeout(function () {
        if (!st.pending.has(id)) return;
        st.pending.delete(id);
        if (onAbort && opts.signal) opts.signal.removeEventListener('abort', onAbort);
        reject(new Error(MSG.timeout));
        // Worker takıldı: kapat; bir sonraki çağrı modeli yeniden yükler
        killWorker(MSG.timeout);
      }, timeoutMs);
      var settle = function (fn) {
        return function (v) {
          if (onAbort && opts.signal) opts.signal.removeEventListener('abort', onAbort);
          fn(v);
        };
      };
      st.pending.set(id, { resolve: settle(resolve), reject: settle(reject), timer: timer });
      if (opts.signal) {
        onAbort = function () {
          var p = st.pending.get(id);
          if (!p) return;
          st.pending.delete(id); // sonuç gelirse yok sayılır
          clearTimeout(p.timer);
          reject(abortError());
        };
        opts.signal.addEventListener('abort', onAbort);
      }
      try {
        st.worker.postMessage({
          type: 'run', id: id, audio: audio, language: normLang(opts.language),
          timestamps: !!opts.timestamps, reuse: opts._reuseEncoder !== false,
          // Zaman damgasız (canlı bölüt) çağrılarda Whisper "konuşma yok" diyorsa çözümlemeyi atla
          noSpeechSkip: opts.timestamps ? null : NSP_DROP
        }, [audio.buffer]);
      } catch (e) {
        var p = st.pending.get(id);
        if (p) { st.pending.delete(id); clearTimeout(p.timer); }
        reject(new Error(mapError(e && e.message, 'run')));
      }
    });
  }

  async function runOne(audio, opts, epoch) {
    if (epoch !== st.epoch) throw new Error(MSG.disposed);
    if (opts.signal && opts.signal.aborted) throw abortError();
    var empty = { text: '', language: normLang(opts.language) };
    if (opts.timestamps) empty.chunks = [];
    if (audio.length < RATE * 0.1) return empty; // 100 ms'den kısa
    if (!st.loaded || !st.worker) {
      // Süren bir yükleme varsa onu bekle (başka modeli başlatıp onu iptal etme)
      if (st.loading) { try { await st.loading; } catch (e) { /* aşağıda yeniden denenir */ } }
      if (!st.loaded || !st.worker) await load({ model: st.wantKey || undefined });
    }
    if (opts.signal && opts.signal.aborted) throw abortError();
    // WebGPU henüz doğrulanmadıysa yedek kopya tut (ses aktarılınca kaynak boşalır)
    var backup = (st.dev === 'webgpu' && !st.gpuVerified) ? audio.slice() : null;
    var res;
    try {
      res = await send(audio, opts);
      if (st.dev === 'webgpu') st.gpuVerified = true;
    } catch (e) {
      if (backup && e && e.name !== 'AbortError' && e.message !== MSG.disposed && e.message !== MSG.replaced && st.dev === 'webgpu') {
        if (root.console) console.warn('[AS.asr] WebGPU ilk çalıştırma başarısız, wasm deneniyor:', e.raw || e.message);
        emitStatus(MSG.gpuFallback, 'warn');
        var hook = testHook();
        await startWorker(st.modelId, 'wasm', hook);
        res = await send(backup, opts);
      } else {
        throw e;
      }
    }
    return finish(res, opts);
  }

  function finish(res, opts) {
    var out = { text: '', language: res.language || normLang(opts.language) || null };
    var nsp = typeof res.noSpeechProb === 'number' ? res.noSpeechProb : null;
    if (opts.timestamps) {
      var chunks = [];
      var raw = Array.isArray(res.chunks) ? res.chunks : [];
      for (var i = 0; i < raw.length; i++) {
        var c = raw[i];
        if (!c) continue;
        var t = cleanText(c.text, {});
        if (!t) continue;
        var s = Number(c.start), en = Number(c.end);
        if (!isFinite(s) || s < 0) s = 0;
        if (!isFinite(en) || en < s) en = s;
        chunks.push({ start: s, end: en, text: t });
      }
      // Zaman damgalı (dosya) modda pencerenin tamamını "konuşma yok" olasılığıyla atmıyoruz:
      // uzun müzik/sessizlik + kısa konuşma içeren pencerelerde konuşma kaybolabilir. Parça süzgeci yeterli.
      out.chunks = chunks;
      out.text = chunks.map(function (c) { return c.text; }).join(' ').replace(/\s+/g, ' ').trim();
    } else {
      out.text = cleanText(res.text, { noSpeechProb: res.windowed === true ? null : nsp });
    }
    return out;
  }

  /**
   * @param {Float32Array} pcm 16 kHz mono. Tüm tamponsa AKTARILIR (çağırandan sonra boşalır); alt dizi ise kopyalanır.
   * @param {{language?: string, timestamps?: boolean, signal?: AbortSignal}} [opts]
   */
  function transcribe(pcm, opts) {
    opts = opts || {};
    if (!(pcm instanceof Float32Array)) return Promise.reject(new TypeError(MSG.badAudio));
    var whole = pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength &&
      !(typeof root.SharedArrayBuffer === 'function' && pcm.buffer instanceof root.SharedArrayBuffer);
    var audio = whole ? pcm : pcm.slice();
    var epoch = st.epoch;
    var job = st.chain.then(function () { return runOne(audio, opts, epoch); });
    st.chain = job.then(function () {}, function () {});
    return job;
  }

  function dispose() {
    st.epoch++;
    st.loading = null;
    st.loadingId = null;
    st.modelId = null;
    st.modelKey = null;
    st.progressFns = [];
    killWorker(MSG.disposed);
  }

  /* ------------------------------------------------------------------ */
  /* Whisper sanrı (hallucination) süzgeci                               */
  /* ------------------------------------------------------------------ */
  var NSP_DROP = 0.8; // Whisper'ın "konuşma yok" olasılığı bunun üstündeyse metni at

  // Sessizlik/müzikte sık uydurulan kalıplar (noktalama ve büyük/küçük harf yok sayılarak tam eşleşme)
  var EXACT = [
    'you', 'thank you', 'thank you so much', 'thank you very much', 'thanks', 'thank you all',
    'thanks for watching', 'thank you for watching', 'thanks for listening', 'thank you for listening',
    'thank you for watching and see you next time', 'thanks for watching and see you next time',
    'please subscribe', 'subscribe', 'like and subscribe', 'please like and subscribe',
    'dont forget to like and subscribe', 'see you next time', 'see you in the next video', 'bye', 'bye bye',
    'music', 'applause', 'laughter', 'silence', 'blank audio', 'blankaudio', 'no speech',
    'izlediğiniz için teşekkürler', 'abone olmayı unutmayın', 'teşekkürler', 'teşekkür ederim',
    'merci', 'merci davoir regardé', 'merci beaucoup', 'vielen dank', 'danke', 'danke fürs zuschauen',
    'gracias', 'gracias por ver', 'muchas gracias', 'obrigado', 'obrigada', 'grazie', 'grazie per la visione',
    'спасибо', 'спасибо за просмотр', 'продолжение следует',
    'ご視聴ありがとうございました', 'ありがとうございました', '시청해주셔서 감사합니다', '감사합니다',
    '谢谢观看', '谢谢', '謝謝觀看', 'شكرا', 'شكرا للمشاهدة', 'شكرا لكم'
  ];
  var EXACT_SET = {};
  EXACT.forEach(function (s) { EXACT_SET[s] = true; });

  // Altyazı jeneriği tarzı uydurmalar: içeren cümle atılır
  var CREDIT_RES = [
    /amara\.org/i, /\bsubtitles?\s+(by|created|made|provided)\b/i, /\bcaptions?\s+by\b/i, /\btranscri(bed|ption)\s+by\b/i,
    /untertitel\s+(im\s+auftrag|von|der|des)/i, /sous-titr(age|es)\s+(réalisé|par|société|st'?)/i,
    /субтитры\s+(сделал|создавал|подогнал|делал|подготовил)/i, /dimatorzok/i, /altyaz[ıi]\s+m\.?\s?k\.?/i,
    /sottotitoli\s+(creati|a\s+cura)/i, /ondertiteling\s+(door|ingediend)/i, /napisy\s+(stworzone|wykonane)/i,
    /字幕(由|提供|制作)/, /mbc\s*뉴스/i, /請不吝點贊/, /明鏡與點點/
  ];

  var RE_HAS_LETTER = /\p{L}/u;
  var RE_PUNCT = /[\p{P}\p{S}]/gu;

  function norm(s) {
    return s.toLowerCase().replace(/['’`]/g, '').replace(RE_PUNCT, ' ').replace(/\s+/g, ' ').trim();
  }

  function stripAnnotations(t) {
    return t
      // [Music], (upbeat music), [BLANK_AUDIO], *laughs*  → ses betimlemeleri
      .replace(/\[[^\]\n]{0,60}\]/g, ' ')
      // "(laughs)", "(upbeat music)" gibi yalnızca harfli betimlemeler; "(1999)" gibi sayılar kalır
      .replace(/\(\s*[\p{L}\s,'-]{1,40}\)/gu, ' ')
      .replace(/\*[^*\n]{1,40}\*/g, ' ')
      .replace(/[♪♫♬🎵🎶]+/g, ' ')
      .replace(/>>\s*/g, ' ');
  }

  /** Arka arkaya ≥3 kez (tek kelimede ≥5) tekrarlanan n-gramları tek kopyaya indirir. */
  function collapseRepeats(words) {
    var keys = words.map(function (w) { return norm(w); });
    var out = [], outKeys = [];
    var maxRep = 1, repWords = 0;
    var i = 0;
    while (i < words.length) {
      var best = null;
      for (var n = 1; n <= 12 && i + n * 2 <= words.length; n++) {
        var reps = 1;
        while (i + (reps + 1) * n <= words.length) {
          var same = true;
          for (var k = 0; k < n; k++) {
            if (keys[i + k] !== keys[i + reps * n + k] || !keys[i + k]) { same = false; break; }
          }
          if (!same) break;
          reps++;
        }
        var need = n === 1 ? 5 : 3;
        if (reps >= need && (!best || reps * n > best.reps * best.n)) best = { n: n, reps: reps };
      }
      if (best) {
        for (var b = 0; b < best.n; b++) { out.push(words[i + b]); outKeys.push(keys[i + b]); }
        if (best.reps > maxRep) maxRep = best.reps;
        repWords += best.n * best.reps;
        i += best.n * best.reps;
      } else {
        out.push(words[i]); outKeys.push(keys[i]);
        i++;
      }
    }
    return { words: out, maxRep: maxRep, coverage: words.length ? repWords / words.length : 0 };
  }

  /** Cümlelere böler; "Amara.org", "3.5" gibi boşluksuz noktalarda bölmez. */
  function splitSentences(t) {
    var out = [], re = /[.!?…]+(?=\s|$)|[。！？]+/g, last = 0, m;
    while ((m = re.exec(t)) !== null) {
      out.push(t.slice(last, m.index + m[0].length).trim());
      last = m.index + m[0].length;
    }
    if (last < t.length) out.push(t.slice(last).trim());
    return out.filter(Boolean);
  }

  /**
   * Whisper çıktısını temizler; sanrıysa '' döndürür.
   * @param {string} text
   * @param {{noSpeechProb?: number|null}} [o]
   */
  function cleanText(text, o) {
    o = o || {};
    if (typeof text !== 'string') return '';
    var t = text.replace(/<\|[^|>]*\|>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ');
    t = stripAnnotations(t).replace(/\s+/g, ' ').trim();
    if (!t || !RE_HAS_LETTER.test(t)) return '';
    if (typeof o.noSpeechProb === 'number' && o.noSpeechProb >= NSP_DROP) return '';

    // Döngüye giren tekrarlar: tek kopyaya indir. Metnin çoğu kısa bir birimin tekrarıysa
    // ("yw'n yw'n yw'n…", "I am. I am. I am…") tamamen sanrıdır.
    var words = t.split(' ');
    var cr = collapseRepeats(words);
    if (cr.maxRep >= 5 && cr.coverage >= 0.6 && cr.words.length <= 3) return '';
    t = cr.words.join(' ');

    // Cümle düzeyi: tekrarlanan aynı cümleleri teke indir, jenerik uydurmalarını at
    var sents = splitSentences(t);
    var kept = [], seenRun = null, runLen = 0;
    for (var i = 0; i < sents.length; i++) {
      var s = sents[i];
      var k = norm(s);
      if (!k) continue;
      if (CREDIT_RES.some(function (re) { return re.test(s); })) continue;
      if (k === seenRun) { runLen++; if (runLen >= 2) continue; } else { seenRun = k; runLen = 1; }
      kept.push(s);
    }
    if (!kept.length) return '';
    // Tümü bilinen sanrı kalıplarıysa at
    var allHallu = kept.every(function (s) { return EXACT_SET[norm(s)] === true; });
    if (allHallu) return '';
    t = kept.join(' ').replace(/\s+/g, ' ').trim();
    if (!RE_HAS_LETTER.test(t)) return '';
    return t;
  }

  AS.asr = {
    MODELS: MODELS,
    load: load,
    transcribe: transcribe,
    isLoaded: function () { return !!(st.loaded && st.worker); },
    device: function () { return st.loaded ? st.dev : null; },
    model: function () { return st.loaded ? st.modelKey : null; },
    dispose: dispose,
    cleanText: cleanText
  };
})(typeof window !== 'undefined' ? window : globalThis);

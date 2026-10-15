// Altyazı Şefi Web: Whisper konuşma tanıma worker'ı (ES modül worker).
// js/asr.js tarafından `new Worker(new URL('asr-worker.js', <asr.js adresi>), {type:'module'})` ile açılır.
// transformers.js 3.7.5 ve ONNX Runtime wasm dosyaları ../lib/transformers/ altından yüklenir (CDN yok).
//
// Protokol:
//  gelen {type:'load', model, device, dtype, local}           → {type:'progress', status, file, loaded, total}* → {type:'ready', device, model} | {type:'error', message}
//  gelen {type:'run', id, audio, language, timestamps, reuse, noSpeechSkip}
//        → {type:'result', id, text, chunks, language, languageProb, noSpeechProb, windowed, skipped, ms} | {type:'error', id, message}
//  noSpeechSkip: sayı verilirse ve ses ≤ 30 s ise, "konuşma yok" olasılığı bunu aşınca çözümleme yapılmaz (text '').
// Mesajlar sırayla (tek tek) işlenir.

const LIB = new URL('../lib/transformers/', import.meta.url).href;
const RATE = 16000;

let T = null;          // transformers.js modülü
let asr = null;        // automatic-speech-recognition pipeline
let cur = { model: null, device: null };
let reuseOK = false;   // kodlayıcı çıktısını yeniden kullanma yaması uygulandı mı
let noSpeechId = null; // <|nocaptions|> / <|nospeech|> belirteci
let lastLang = null;   // en son güvenle algılanan dil (kısa/belirsiz bölütlerde kullanılır)
let queue = Promise.resolve();

self.addEventListener('message', (e) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;
  queue = queue.then(() => handle(msg), () => handle(msg));
});

// ORT wasm ikilisi sıkıştırılmış (.wasm.gz, ~5 MB) olarak sunulur: GitHub'ın tarayıcıdan yükleme sınırına
// takılmaz ve daha hızlı iner. Burada açılıp env.backends.onnx.wasm.wasmBinary olarak verilir.
// Sunucu dosyayı zaten açarak gönderdiyse (Content-Encoding: gzip) gzip imzası olmaz; o zaman olduğu gibi kullanılır.
const ORT_WASM_GZ = 'ort-wasm-simd-threaded.jsep.wasm.gz';
let ortBinary = null;
async function ortWasmBinary() {
  if (ortBinary) return ortBinary;
  const res = await fetch(LIB + ORT_WASM_GZ);
  if (!res.ok) throw new Error('Konuşma motoru dosyası indirilemedi (HTTP ' + res.status + ')');
  let buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    if (typeof DecompressionStream !== 'function') throw new Error('Bu tarayıcı sıkıştırılmış dosyayı açamıyor; Chrome/Edge güncel sürümünü kullanın.');
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    buf = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  // WebAssembly ikili imzası: \0asm
  if (!(buf.length > 8 && buf[0] === 0 && buf[1] === 0x61 && buf[2] === 0x73 && buf[3] === 0x6d)) {
    throw new Error('Konuşma motoru dosyası bozuk indi.');
  }
  ortBinary = buf;
  return ortBinary;
}

function errText(err) {
  if (!err) return 'bilinmeyen hata';
  if (typeof err === 'string') return err;
  if (typeof err === 'number') return 'ORT hata kodu ' + err;
  return String(err.message || err);
}

async function handle(msg) {
  if (msg.type === 'load') {
    try {
      await doLoad(msg);
      self.postMessage({ type: 'ready', device: cur.device, model: cur.model });
    } catch (err) {
      try { await disposePipe(); } catch (e) { /* yok */ }
      self.postMessage({ type: 'error', message: errText(err) });
    }
  } else if (msg.type === 'run') {
    try {
      const r = await doRun(msg);
      self.postMessage(Object.assign({ type: 'result', id: msg.id }, r));
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, message: errText(err) });
    }
  } else if (msg.type === 'dispose') {
    await disposePipe();
  }
}

async function disposePipe() {
  const p = asr;
  asr = null;
  reuseOK = false;
  noSpeechId = null;
  lastLang = null;
  if (p && typeof p.dispose === 'function') {
    try { await p.dispose(); } catch (e) { /* yok */ }
  }
}

async function doLoad({ model, device, dtype, local }) {
  if (typeof model !== 'string' || !model) throw new Error('model belirtilmedi');
  if (!T) T = await import(LIB + 'transformers.min.js');
  const { env, pipeline } = T;

  // ONNX Runtime: wasm/mjs dosyaları kendi sunucumuzdan (varsayılanı cdn.jsdelivr.net'tir!)
  const onnx = env.backends.onnx;
  onnx.wasm.wasmPaths = LIB;
  onnx.wasm.wasmBinary = await ortWasmBinary();
  onnx.wasm.proxy = false;
  onnx.wasm.numThreads = self.crossOriginIsolated
    ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2)))
    : 1;
  try { onnx.logLevel = 'error'; } catch (e) { /* yok */ }

  if (local && typeof local.modelPath === 'string') {
    // Test kancası: model yerel sunucudan
    env.localModelPath = local.modelPath;
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
  } else {
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
  }
  env.useBrowserCache = typeof caches !== 'undefined';

  await disposePipe();
  const dev = device === 'webgpu' ? 'webgpu' : 'wasm';
  asr = await pipeline('automatic-speech-recognition', model, {
    device: dev,
    dtype: dtype || 'q8',
    progress_callback: (p) => {
      if (!p || typeof p !== 'object') return;
      if (p.status === 'progress' || p.status === 'done' || p.status === 'initiate') {
        self.postMessage({
          type: 'progress', status: p.status, file: String(p.file || ''),
          loaded: Number(p.loaded) || 0, total: Number(p.total) || 0
        });
      }
    }
  });
  cur = { model, device: dev };
  setupInternals();
  if (dev === 'webgpu') {
    // İlk çalıştırma: gölgelendiricileri derler ve WebGPU'nun gerçekten çalıştığını doğrular.
    // Hata verirse ana iş parçacığı wasm'a geçer.
    const noise = new Float32Array(RATE);
    for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() - 0.5) * 0.002;
    await doRun({ audio: noise, language: 'en', timestamps: false, reuse: true });
  }
}

/** transformers.js 3.7.5 iç yapısına bağlı küçük iyileştirmeler; tutmazsa sessizce kapatılır. */
function setupInternals() {
  reuseOK = false;
  noSpeechId = null;
  try {
    const m = asr.model;
    if (m && Array.isArray(m.forward_params) && typeof m._prepare_encoder_decoder_kwargs_for_generation === 'function') {
      // generate() 'encoder_outputs' verilirse kodlayıcıyı yeniden çalıştırmaz (dil algılama için zaten hesaplandı)
      if (!m.forward_params.includes('encoder_outputs')) m.forward_params = m.forward_params.concat('encoder_outputs');
      reuseOK = true;
    }
  } catch (e) { reuseOK = false; }
  try {
    const tok = asr.tokenizer;
    const map = tok && tok.model && tok.model.tokens_to_ids;
    for (const name of ['<|nocaptions|>', '<|nospeech|>']) {
      let id = map && typeof map.get === 'function' ? map.get(name) : undefined;
      if (id === undefined && tok && Array.isArray(tok.added_tokens)) {
        const at = tok.added_tokens.find((t) => t && t.content === name);
        if (at) id = at.id;
      }
      if (typeof id === 'number') { noSpeechId = id; break; }
    }
  } catch (e) { noSpeechId = null; }
}

function toFloat32(data) {
  if (data instanceof Float32Array) return data;
  if (typeof Float16Array !== 'undefined' && data instanceof Float16Array) return Float32Array.from(data);
  if (data instanceof Uint16Array) { // ham fp16
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const h = data[i], s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
      out[i] = e === 0 ? s * Math.pow(2, -14) * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * Math.pow(2, e - 15) * (1 + f / 1024);
    }
    return out;
  }
  return Float32Array.from(data, Number);
}

/**
 * Kodlayıcıyı bir kez çalıştırır ve <|startoftranscript|> sonrası ilk adımın logit'lerinden
 * dil olasılıklarını ve "konuşma yok" olasılığını çıkarır (transformers.js 3.7.5 dili kendisi
 * algılamıyor; dil verilmezse İngilizce varsayıyor).
 */
async function analyse(audio, detectLanguage) {
  const { model, processor } = asr;
  const gc = model.generation_config || {};
  const { input_features } = await processor(audio);
  const prepared = await model._prepare_encoder_decoder_kwargs_for_generation({
    inputs_tensor: input_features,
    model_inputs: { input_features },
    model_input_name: 'input_features',
    generation_config: { guidance_scale: null }
  });
  const encoder_outputs = prepared.encoder_outputs;
  const sot = gc.decoder_start_token_id;
  let language = null, languageProb = null, noSpeechProb = null;
  if (typeof sot === 'number' && (detectLanguage || noSpeechId !== null)) {
    const decoder_input_ids = new T.Tensor('int64', BigInt64Array.of(BigInt(sot)), [1, 1]);
    const out = await model.forward({ input_features, encoder_outputs, decoder_input_ids });
    try {
      const logits = toFloat32(out.logits.data);
      const V = logits.length; // [1, 1, vocab]
      let max = -Infinity;
      for (let i = 0; i < V; i++) if (logits[i] > max) max = logits[i];
      let sum = 0;
      for (let i = 0; i < V; i++) sum += Math.exp(logits[i] - max);
      if (noSpeechId !== null && noSpeechId < V) noSpeechProb = Math.exp(logits[noSpeechId] - max) / sum;
      if (detectLanguage && gc.lang_to_id) {
        let bestTok = null, best = -Infinity, lsum = 0;
        const entries = Object.entries(gc.lang_to_id);
        let lmax = -Infinity;
        for (const [, id] of entries) if (id < V && logits[id] > lmax) lmax = logits[id];
        for (const [tok, id] of entries) {
          if (id >= V) continue;
          const v = logits[id];
          lsum += Math.exp(v - lmax);
          if (v > best) { best = v; bestTok = tok; }
        }
        if (bestTok) {
          language = bestTok.replace(/^<\|/, '').replace(/\|>$/, '');
          languageProb = Math.exp(best - lmax) / lsum;
        }
      }
    } finally {
      // Önbellek tensörlerini bırak (WebGPU'da GPU belleği tutar)
      for (const k of Object.keys(out)) {
        if (k !== 'logits' && out[k] && typeof out[k].dispose === 'function') { try { out[k].dispose(); } catch (e) { /* yok */ } }
      }
    }
  }
  return { encoder_outputs, language, languageProb, noSpeechProb };
}

function maxTokens(seconds) {
  // OpenAI Whisper 30 s pencere başına en fazla 224 belirteç üretir; kısa bölütlerde sanrı döngülerini erken keser.
  return Math.min(224, Math.ceil(seconds * 8) + 32);
}

async function doRun({ audio, language, timestamps, reuse, noSpeechSkip }) {
  if (!asr) throw new Error('Model yüklenmedi');
  if (!(audio instanceof Float32Array)) throw new Error('ses verisi geçersiz');
  const t0 = performance.now();
  const dur = audio.length / RATE;
  const model = asr.model;
  const gc = model.generation_config || {};
  const multilingual = gc.is_multilingual !== false && !!gc.lang_to_id;

  let lang = null;
  if (multilingual && typeof language === 'string' && language) {
    if (gc.lang_to_id['<|' + language + '|>'] !== undefined) lang = language;
  }

  const windowed = dur > 30;
  const opts = { return_timestamps: !!timestamps, max_new_tokens: maxTokens(windowed ? 30 : dur) };
  if (multilingual) opts.task = 'transcribe';
  if (windowed) { opts.chunk_length_s = 30; opts.stride_length_s = 5; }

  let noSpeechProb = null, detected = null, languageProb = null;
  // Uzun seste dil verilmişse ön analiz gereksiz (kodlayıcı çıktısı pencerelerde yeniden kullanılamaz)
  if (!(windowed && (lang || !multilingual))) {
    try {
      const head = windowed ? audio.subarray(0, 30 * RATE) : audio;
      const a = await analyse(head, multilingual && !lang);
      noSpeechProb = a.noSpeechProb;
      detected = a.language;
      languageProb = a.languageProb;
      if (!windowed && reuseOK && reuse !== false) opts.encoder_outputs = a.encoder_outputs;
      // Kısa bölütlerde dil algılama kararsızsa son güvenilir dili kullan
      if (detected && languageProb !== null) {
        if (languageProb >= 0.6) lastLang = detected;
        else if (lastLang) detected = lastLang;
      }
    } catch (e) {
      // Analiz isteğe bağlı; başarısızsa düz yoldan devam
      console.warn('[asr-worker] dil/sessizlik analizi yapılamadı:', errText(e));
    }
  }
  if (multilingual && (lang || detected)) opts.language = lang || detected;

  if (!windowed && typeof noSpeechSkip === 'number' && noSpeechProb !== null && noSpeechProb >= noSpeechSkip) {
    return {
      text: '', chunks: timestamps ? [] : undefined, language: opts.language || null, languageProb,
      noSpeechProb, windowed, skipped: true, ms: Math.round(performance.now() - t0)
    };
  }

  const out = await asr(audio, opts);
  let chunks;
  if (timestamps) {
    chunks = [];
    const list = Array.isArray(out.chunks) ? out.chunks : [];
    for (const c of list) {
      const ts = Array.isArray(c.timestamp) ? c.timestamp : [];
      let s = typeof ts[0] === 'number' ? ts[0] : 0;
      let e = typeof ts[1] === 'number' ? ts[1] : null;
      if (e === null || !(e >= s)) e = Math.min(dur, Math.max(s + 1, s));
      s = Math.max(0, Math.min(s, dur));
      e = Math.max(s, Math.min(e, dur));
      chunks.push({ start: s, end: e, text: String(c.text || '').trim() });
    }
  }
  return {
    text: String(out.text || '').trim(),
    chunks,
    language: opts.language || null,
    languageProb,
    noSpeechProb,
    windowed,
    skipped: false,
    ms: Math.round(performance.now() - t0)
  };
}

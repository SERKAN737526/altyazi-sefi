/* Altyazı Şefi Web: hizmet çalışanı (service worker).
 * - Kurulumda küçük uygulama kabuğunu (html/css/js/simgeler/manifest) önbelleğe alır.
 * - Kabuk dosyaları: önce ağ (geliştirme döngüsünü bozmaz), ağ yoksa önbellek.
 * - Aynı kökenli lib/ dosyaları: önce önbellek (büyük ve sürümü sabit kitaplıklar).
 * - Başka kökenler (Hugging Face, çeviri servisleri, YouTube): hiç dokunulmaz (modelleri transformers.js kendisi saklar).
 * - Sayfa gezintisi çevrimdışıysa önbellekteki index.html döner.
 * - Kısmi (206), opak ya da hatalı yanıtlar asla önbelleğe yazılmaz; Range istekleri doğrudan ağa gider.
 * - Sayfa "Çevrimdışı için hazırla" dediğinde (postMessage) LIB_FILES dosyalarını ilerleme bildirerek indirir.
 * Kitaplık veya kabuk değişince VERSION artırılır; eski "as-shell-*" / "as-lib-*" önbellekleri silinir. */
'use strict';

const VERSION = 'v2';
const SHELL_CACHE = 'as-shell-' + VERSION;
const LIB_CACHE = 'as-lib-' + VERSION;
const OWN_PREFIXES = ['as-shell-', 'as-lib-'];

/** Kabuk: index.html'in yüklediği her şey ve bu betiklerin açtığı worker/worklet dosyaları
 *  (eksik olan dosya kurulumu bozmaz). js/ klasörüne dosya eklenince buraya da eklenmeli (tests/e2e/app.e2e.js denetler). */
const SHELL_FILES = [
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/ns.js',
  'js/srt.js',
  'js/translate.js',
  'js/assembler.js',
  'js/ocr.js',
  'js/audio.js',
  'js/pcm-worklet.js',
  'js/asr.js',
  'js/asr-worker.js',
  'js/subs.js',
  'js/live.js',
  'js/ticker-worker.js',
  'js/filemode.js',
  'js/youtube.js',
  'js/app.js',
  'icons/logo.svg',
  'icons/favicon.ico',
  'icons/favicon-32.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
];

/** Her açılışta gereken küçük kitaplık dosyaları: kurulumda alınır. */
const LIB_EARLY = ['lib/tesseract/tesseract.min.js'];

/** "Çevrimdışı için hazırla": tüm kitaplıklar. tesseract.js işçisi OEM 1 (yalnız LSTM) ile yalnızca
 *  *-lstm.wasm.js çekirdeklerini yükler (wasm içlerine gömülüdür): SIMD olan ve olmayan sürüm. */
const LIB_FILES = [
  'lib/tesseract/tesseract.min.js',
  'lib/tesseract/worker.min.js',
  'lib/tesseract/core/tesseract-core-simd-lstm.wasm.js',
  'lib/tesseract/core/tesseract-core-lstm.wasm.js',
  'lib/tessdata/eng.traineddata.gz',
  'lib/transformers/transformers.min.js',
  'lib/transformers/ort-wasm-simd-threaded.jsep.mjs',
  'lib/transformers/ort-wasm-simd-threaded.jsep.wasm.gz'
];

const SCOPE = new URL(self.registration ? self.registration.scope : './', self.location.href).href;
const LIB_PREFIX = new URL('lib/', SCOPE).href;
const INDEX_URL = new URL('index.html', SCOPE).href;
const NO_CACHE_PREFIXES = [new URL('__test/', SCOPE).href, new URL('tests/', SCOPE).href];
const SHELL_EXT = /\.(?:html|css|js|mjs|webmanifest|json|svg|png|ico)$/i;
const NETWORK_TIMEOUT_MS = 4000;

const abs = (p) => new URL(p, SCOPE).href;

/** Önbelleğe yazılabilir mi: tam (200), aynı kökenli ("basic"), yönlendirmesiz yanıt. */
function cacheable(res) {
  return !!res && res.status === 200 && res.type === 'basic' && !res.redirected;
}

/** Sorgu ve parça olmadan anahtar. */
function keyOf(url) {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.href;
}

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(SHELL_FILES.map(async (p) => {
    const url = abs(p);
    try {
      const res = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
      if (cacheable(res)) await cache.put(url, res);
    } catch (e) { /* çevrimdışı kurulum ya da eksik dosya: atla */ }
  }));
  const lib = await caches.open(LIB_CACHE);
  await Promise.all(LIB_EARLY.map(async (p) => {
    const url = abs(p);
    try {
      if (await lib.match(url)) return;
      const res = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
      if (cacheable(res)) await lib.put(url, res);
    } catch (e) { /* */ }
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, LIB_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.map((n) => {
      const ours = OWN_PREFIXES.some((p) => n.indexOf(p) === 0);
      return ours && !keep.has(n) ? caches.delete(n) : null;
    }));
    await self.clients.claim();
  })());
});

/* ------------------------------------------------------------------ */
/* istek yönetimi                                                      */
/* ------------------------------------------------------------------ */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (url.indexOf(SCOPE) !== 0) return;                 // başka köken / kapsam dışı: dokunma
  if (req.headers.has('range')) return;                 // kısmi istek: doğrudan ağ (206 asla önbelleğe girmez)
  if (NO_CACHE_PREFIXES.some((p) => url.indexOf(p) === 0)) return;

  if (req.mode === 'navigate') {
    event.respondWith(navigation(event));
    return;
  }
  if (url.indexOf(LIB_PREFIX) === 0) {
    event.respondWith(libCacheFirst(event));
    return;
  }
  const path = new URL(url).pathname;
  if (SHELL_EXT.test(path)) {
    event.respondWith(shellNetworkFirst(event));
  }
  // diğerleri (video, altyazı dosyası vb.): tarayıcı normal şekilde alır
});

/** Önce önbellek; yoksa ağdan al ve tam yanıtı sakla. */
async function libCacheFirst(event) {
  const req = event.request;
  const cache = await caches.open(LIB_CACHE);
  const key = keyOf(req.url);
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(res)) {
    const copy = res.clone();
    event.waitUntil(cache.put(key, copy).catch(() => { /* kota dolu vb. */ }));
  }
  return res;
}

/** Önce ağ (zaman aşımıyla), olmazsa önbellek. */
async function shellNetworkFirst(event) {
  const req = event.request;
  const cache = await caches.open(SHELL_CACHE);
  const key = keyOf(req.url);
  const net = fetch(req).then((res) => {
    if (cacheable(res)) {
      const copy = res.clone();
      event.waitUntil(cache.put(key, copy).catch(() => {}));
    }
    return res;
  });
  try {
    return await raceTimeout(net, NETWORK_TIMEOUT_MS, () => cache.match(key));
  } catch (e) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw e;
  }
}

/** Gezinme: önce ağ; çevrimdışıysa önbellekteki sayfa ya da index.html. */
async function navigation(event) {
  const req = event.request;
  const cache = await caches.open(SHELL_CACHE);
  const path = new URL(req.url).pathname;
  const scopePath = new URL(SCOPE).pathname;
  const isIndex = path === scopePath || path === scopePath + 'index.html';
  const key = isIndex ? INDEX_URL : keyOf(req.url);
  const net = fetch(req).then((res) => {
    if (cacheable(res) && isIndex) {
      const copy = res.clone();
      event.waitUntil(cache.put(key, copy).catch(() => {}));
    }
    return res;
  });
  const fallback = async () => (await cache.match(key)) || (await cache.match(INDEX_URL));
  try {
    return await raceTimeout(net, NETWORK_TIMEOUT_MS, fallback);
  } catch (e) {
    const hit = await fallback();
    if (hit) return hit;
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Altyazı Şefi</title><p>İnternet bağlantısı yok ve sayfa henüz bu cihaza kaydedilmedi. Bağlanınca tekrar deneyin.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

/** Ağ `ms` içinde yanıt vermezse ve önbellekte kopya varsa onu döndürür; ağ yine de arka planda biter. */
function raceTimeout(netPromise, ms, cachedFn) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(async () => {
      if (settled) return;
      try {
        const hit = await cachedFn();
        if (hit && !settled) { settled = true; resolve(hit); }
      } catch (e) { /* önbellek yok: ağı bekle */ }
    }, ms);
    netPromise.then((res) => {
      clearTimeout(timer);
      if (!settled) { settled = true; resolve(res); }
    }, (err) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(err); }
    });
  });
}

/* ------------------------------------------------------------------ */
/* sayfadan gelen istekler (MessageChannel ile yanıt)                  */
/*   {type:'lib-list'}            → {type:'lib-list', files:[url], version}
 *   {type:'cache-file', url}     → {type:'progress', url, loaded, total}* sonra {type:'done', url, ok, cached, bytes}
 *   {type:'status'}              → {type:'status', version, shell:n, lib:{url:bool}}            */
/* ------------------------------------------------------------------ */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];
  const reply = (msg) => {
    try { if (port) port.postMessage(msg); else if (event.source) event.source.postMessage(msg); } catch (e) { /* sayfa kapandı */ }
  };
  if (data.type === 'lib-list') {
    reply({ type: 'lib-list', files: LIB_FILES.map(abs), version: VERSION });
  } else if (data.type === 'cache-file') {
    const url = typeof data.url === 'string' ? data.url : '';
    const allowed = LIB_FILES.map(abs);
    if (allowed.indexOf(url) < 0) { reply({ type: 'error', url, message: 'Bilinmeyen dosya' }); return; }
    event.waitUntil(cacheOne(url, reply).catch((e) => reply({ type: 'error', url, message: String(e && e.message || e) })));
  } else if (data.type === 'status') {
    event.waitUntil(cacheStatus().then(reply, (e) => reply({ type: 'error', message: String(e && e.message || e) })));
  } else if (data.type === 'skip-waiting') {
    self.skipWaiting();
  }
});

async function cacheOne(url, reply) {
  const cache = await caches.open(LIB_CACHE);
  const hit = await cache.match(url);
  if (hit) {
    const len = Number(hit.headers.get('content-length')) || 0;
    reply({ type: 'done', url, ok: true, cached: true, bytes: len });
    return;
  }
  const res = await fetch(new Request(url, { cache: 'no-cache', credentials: 'same-origin' }));
  if (!cacheable(res)) throw new Error('İndirilemedi (HTTP ' + res.status + ')');
  // Sıkıştırılmış aktarımda Content-Length sıkıştırılmış boyuttur; o zaman toplam bilinmiyor sayılır.
  const encoded = !!res.headers.get('content-encoding');
  const total = encoded ? 0 : (Number(res.headers.get('content-length')) || 0);
  const type = res.headers.get('content-type') || 'application/octet-stream';
  let body;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    let last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      const now = Date.now();
      if (now - last > 150) { last = now; reply({ type: 'progress', url, loaded, total }); }
    }
    body = new Blob(chunks, { type });
  } else {
    body = await res.blob();
  }
  if (total && body.size !== total) throw new Error('Dosya eksik indi');
  await cache.put(url, new Response(body, {
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': type, 'Content-Length': String(body.size) }
  }));
  reply({ type: 'progress', url, loaded: body.size, total: body.size });
  reply({ type: 'done', url, ok: true, cached: false, bytes: body.size });
}

async function cacheStatus() {
  const lib = await caches.open(LIB_CACHE);
  const shell = await caches.open(SHELL_CACHE);
  const out = {};
  await Promise.all(LIB_FILES.map(async (p) => {
    const url = abs(p);
    out[url] = !!(await lib.match(url));
  }));
  const shellKeys = await shell.keys();
  return { type: 'status', version: VERSION, shell: shellKeys.length, lib: out };
}

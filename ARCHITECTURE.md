# Altyazı Şefi Web: architecture contract

A browser-only (no install) desktop version of the Android app "Altyazı Şefi". It translates foreign
subtitles/speech into Turkish. Served as static files over https (GitHub Pages / Netlify).
Target browsers: Chrome/Edge desktop (Windows, Mac, Linux) = full features; Safari/Firefox = reduced
(no tab audio capture → OCR + file mode with subtitles only). UI language: **Turkish**. Code comments may be Turkish or English.

Everything here is a binding contract between modules written by different people. Do not change a public
API without updating this file (and only the coordinator may change this file).

## Hard rules

- Plain ES2020 **classic scripts**, each an IIFE that adds to `window.AS` (see `js/ns.js`, already written, read it).
  The only ES module is `js/asr-worker.js` (module worker). No bundler, no build step, no npm deps at runtime.
- All libraries are **self-hosted** under `lib/` (no CDN). Paths are relative to the page (`index.html` at root).
- **Security**: never use `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`/`eval`/`new Function`/
  string `setTimeout`. Build DOM with `AS.util.el()` (text via `textContent`). Treat SRT text, OCR text,
  translations, file names, URLs and query params as untrusted. No inline `<script>` or inline event handlers
  (CSP forbids them). No third-party analytics. Validate sizes of user files (subtitle ≤ 5 MB).
- CSP (meta tag in index.html, owned by the UI author) must allow exactly what the code needs:
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://www.youtube.com https://s.ytimg.com;
  worker-src 'self' blob:; connect-src 'self' blob: data: https://huggingface.co https://*.huggingface.co https://*.hf.co
  https://translate.googleapis.com https://api.mymemory.translated.net; img-src 'self' data: blob: https://i.ytimg.com;
  media-src 'self' blob: mediastream:; frame-src https://www.youtube-nocookie.com https://www.youtube.com;
  style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'`.
  If your module needs more, say so in your final report instead of silently widening it.
- **Offline**: after first use, everything except online translation and first model download must work offline
  (service worker caches the app + `lib/`; transformers.js caches models in Cache Storage; Chrome's on-device
  Translator works offline once its language pack is downloaded).
- Browser feature detection, never UA sniffing for features (UA only for wording hints, `AS.util.browser()`).
- Errors shown to the user in Turkish, short, actionable. Emit status via `AS.bus.emit('status', {...})`.
- Test hooks are active only on localhost with `?test=1` (`AS.util.testParams()` returns null otherwise).

## Load order (index.html, all `defer`)

`lib/tesseract/tesseract.min.js`, `js/ns.js`, `js/srt.js`, `js/translate.js`, `js/assembler.js`, `js/ocr.js`,
`js/audio.js`, `js/asr.js`, `js/subs.js`, `js/live.js`, `js/filemode.js`, `js/yt-bookmarklet.js`, `js/youtube.js`, `js/app.js`.
`js/lock.js` loads right after `js/ns.js`; `app.js` boots through `AS.lock.gate(start)`.
`js/app.js` runs last and calls `AS.app.start()` on `DOMContentLoaded`.

## Bus events (`AS.bus`)

| event | payload | emitted by |
|---|---|---|
| `subtitle` | `{tr, src, cont, kind}` tr=Turkish text, src=original, cont=bool (replace previous line), kind=`'ocr'|'speech'|'srt'` | modes |
| `status` | `{mode, text, level}` mode=`'live'|'file'|'youtube'|'app'`, level=`'info'|'ok'|'warn'|'error'|'busy'` | anyone |
| `progress` | `{what, label, loaded, total, done}` (bytes or items; `what`: `'asr-model'|'ocr-model'|'translator'|'pretranslate'|'transcribe'`) | anyone |
| `settings` | `{key, value}` | ns.js |

## Module APIs

### js/ns.js (done)
`AS.bus`, `AS.settings` (`get/set/all/reset/defaults/onChange`, keys in DEFAULTS), `AS.util`
(`el, clear, sleep, clamp, now, fmtBytes, testParams, LANGS, browser`), `AS.modes`.

### js/srt.js → `AS.srt`
- `parse(text) → Cue[]` auto-detects SRT or WebVTT. `Cue = {start, end, text}` (ms, ms, string with `\n` between lines).
  Strip tags (`<i>`, `{\an8}`, `<c.x>`, VTT cue settings), BOM, CRLF; tolerate missing index lines, `.`/`,` ms separators,
  hours optional in VTT; skip broken blocks; sort by start; cap 20000 cues.
- `build(cues) → string` SRT (`HH:MM:SS,mmm`, CRLF-free `\n`, 1-based index, blank line between).
- `time(ms) → 'HH:MM:SS,mmm'`.
- `indexAt(cues, ms) → index | -1` (binary search; cue active when start ≤ ms < end).

### js/translate.js → `AS.translate`
Target language is always Turkish (`tr`). `from` is an ISO code or `'auto'`.
- `text(src, {from='auto', signal}) → Promise<string>` Turkish. Order:
  1. Cache hit (memory LRU 5000 + IndexedDB `as-tm` / store `tm`, key `${from}|${src}`).
  2. Chrome on-device **Translator API** (`self.Translator`): when `from==='auto'`, detect with `self.LanguageDetector`
     (if available; take top result with confidence ≥ 0.5) else skip to 3. `Translator.availability({sourceLanguage, targetLanguage:'tr'})`;
     use only if `'available'` (creating a `'downloadable'` one needs a user gesture; that's `prepareDevice`). Cache translator per source.
     If source already `tr` return src.
  3. If `AS.settings.get('translateOnline')`: Google gtx `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=tr&dt=t&q=...`
     (join `json[0][i][0]`), then MyMemory `https://api.mymemory.translated.net/get?q=...&langpair=${from==='auto'?'Autodetect':from}|tr`
     (`responseData.translatedText`; reject if it contains "MYMEMORY WARNING"/quota text). 8 s timeout each, max 2 concurrent online requests,
     back off 30 s from an engine after HTTP 429/5xx.
  4. Otherwise throw `Error('Çeviri yapılamadı')` (message Turkish).
  Trim, collapse whitespace; empty → `''`. Never cache failures.
- `info() → Promise<{device: 'available'|'downloadable'|'downloading'|'unavailable'|'unsupported', online: bool, lastEngine}>` (for `from` = current `asrLang` or `'en'`).
- `prepareDevice(from='en', onProgress) → Promise<boolean>` must be called from a user gesture; creates the Translator (downloads the pack) and LanguageDetector.
- `detect(text) → Promise<string|null>`.
- `class PreTranslator(cues, {from, onCue(index, tr), onProgress(done,total)})` with `start(fromIndex)`, `seek(index)` (re-prioritise from index, wraps to earlier ones last), `stop()`, `result() → string[]` (sparse). Concurrency 2. Used by file mode & YouTube SRT sync.

### js/assembler.js → `AS.Assembler`
Port of Android `SubtitleAssembler.java` (read it: `/mnt/project-files/altyazi-cevir/app/src/main/java/com/serkan/altyazicevir/SubtitleAssembler.java`).
`new AS.Assembler()`, `.onText(raw, nowMs, confidence0to100) → {sentence, continuation} | null`, `.reset()`. Also exposes `AS.Assembler.similarity(a,b)`.

### js/ocr.js → `AS.ocr`
Port of the line finder in Android `OcrEngine.java` (same folder; include the v3.1 fixes: highlight-word white rule,
cluster split at gaps > 3.5×h, drop isolated right-edge component when gap > 1.2×h and centre > 0.78×width).
- `findLines(img) → Line[]` pure function, `img = {width, height, data: Uint8ClampedArray RGBA}`; `Line = {x, y, w, h, mask}` where mask is `'white'|'light'|'dark'` (whatever the port needs). Works in Node (no DOM).
- `prepareLine(img, line) → {width, height, data}` binarised/scaled crop ready for Tesseract (dark text on white, ~32–48 px tall), pure.
- `class Reader`: `static async create({onProgress}) → Reader` (tesseract.js v6 `Tesseract.createWorker('eng', 1, {workerPath:'lib/tesseract/worker.min.js', corePath:'lib/tesseract/core', langPath:'lib/tessdata', workerBlobURL:false, gzip:true})`, PSM 7 single line),
  `async read(source, region) → {text, conf, lines}` where `source` is an `HTMLVideoElement|HTMLCanvasElement|ImageBitmap` and `region = {x,y,w,h}` fractions;
  it grabs the region into an offscreen canvas, finds lines, recognises each (bounded: max 4 lines), joins with space, returns mean confidence 0–100.
  Fast path: if the region's downscaled fingerprint is unchanged since last call return `{same:true}` without OCR.
  `async terminate()`.

### js/audio.js → `AS.audio` (+ `js/pcm-worklet.js`)
- `tap(mediaStream, onChunk(Float32Array)) → Promise<{stop(), sampleRate:16000}>`: takes the stream's first audio track; AudioContext at default rate;
  AudioWorklet `js/pcm-worklet.js` downmixes and downsamples to **16 kHz mono** (low-pass + decimate/linear), posts ~100 ms chunks.
  Don't route audio to speakers (connect through a 0-gain node so the graph runs). Throws `Error('Paylaşılan kaynakta ses yok...')` if no audio track.
- `class Segmenter({onSegment(Float32Array, {startMs, endMs, final}), minSpeechMs=400, maxSegMs=7000, silenceMs=450, preRollMs=200})` with `push(chunk)`, `flush()`, `reset()`.
  Adaptive energy VAD (noise floor tracking), so music beds don't keep it open forever; long speech is cut at maxSegMs.
- `decodeFile(file, onProgress) → Promise<Float32Array>` 16 kHz mono via `OfflineAudioContext`/`decodeAudioData`; reject with Turkish message if file > 600 MB or no audio.

### js/asr.js (+ `js/asr-worker.js`) → `AS.asr`
Whisper via transformers.js 3.7.5 (`lib/transformers/transformers.min.js`, ORT wasm in same folder; set
`env.backends.onnx.wasm.wasmPaths` to that folder's absolute URL, `env.allowLocalModels=false` normally).
- Models: `tiny → onnx-community/whisper-tiny`, `base → onnx-community/whisper-base`, `small → onnx-community/whisper-small`.
  WebGPU (if `navigator.gpu` adapter exists): `dtype {encoder_model:'fp32', decoder_model_merged:'q4'}`; else wasm `dtype 'q8'`.
  If WebGPU load/first run fails, fall back to wasm automatically.
- Test hook (`AS.util.testParams()` has `asrModelPath` & `asrModelId`): `env.localModelPath = asrModelPath`, `allowRemoteModels=false`, `allowLocalModels=true`, model = asrModelId, device = testParams.device || 'wasm'.
- `load({model, onProgress}) → Promise<{device, model}>` (idempotent; switching model reloads). Progress also emitted as bus `progress` `what:'asr-model'`.
- `transcribe(pcm16k, {language='auto', timestamps=false}) → Promise<{text, chunks?: [{start, end, text}] (seconds)}>`;
  `language` ISO code or `'auto'` (omit → Whisper detects). Calls are serialised (one at a time) in the worker; `audio` is transferred.
  Filters Whisper hallucinations (silence / "Thank you.", "Thanks for watching", "[Music]", "♪", repeated n-grams, text with no letters) → returns `text:''`.
- `isLoaded()`, `device()`, `dispose()`.
- Worker protocol: in `{type:'load', model, device, dtype, local}` → out `{type:'progress', ...}` / `{type:'ready', device}` / `{type:'error', message}`;
  in `{type:'run', id, audio, language, timestamps}` → out `{type:'result', id, text, chunks}` / `{type:'error', id, message}`.

### js/subs.js → `AS.subs`
Renders the Turkish subtitle (and optionally original) on registered stages and in a floating window.
- `attach(stageEl) → overlayEl` (adds `.as-sub` overlay inside stageEl, which must be `position:relative`), `detach(stageEl)`.
- `show({tr, src, cont, kind})`: if `cont`, replace the current line, else push (keep last 2 lines max). Auto-clears after `holdMs` of no updates. Also listens to bus `subtitle` and calls itself.
- `clear()`.
- `openPip() → Promise<boolean>` (user gesture): Document Picture-in-Picture window (`documentPictureInPicture.requestWindow({width: 960, height: 200})`) with copied stylesheet, black bg; fallback `window.open('', 'as-altyazi', 'popup,width=960,height=200')` built with DOM APIs; returns false if blocked.
  `closePip()`, `isPipOpen()`.
- Applies settings `fontSize`, `bgOpacity`, `showOriginal`, `position` live (listen to settings changes).
- `fullscreen(stageEl)` toggles fullscreen on the stage so the overlay stays visible.

### Modes → `AS.modes.live`, `AS.modes.file`, `AS.modes.youtube`
Each: `{id, title, icon, mount(panelEl), unmount()}`. `mount` builds its own DOM inside `panelEl` with `AS.util.el`.
- **live** (`js/live.js`): "Sekme / ekran çevir". `getDisplayMedia({video:{frameRate:10}, audio:{suppressLocalAudioPlayback:false}, systemAudio:'include', selfBrowserSurface:'exclude', surfaceSwitching:'include'})`.
  Shows a muted mirror `<video>` stage with draggable subtitle-region box (saves `ocrRegion`), mode select auto/ocr/speech, "Altyazı penceresi" (PiP) button, stop.
  OCR loop every `ocrInterval` → `AS.ocr.Reader.read` → `AS.Assembler` → translate → bus `subtitle` kind `ocr`.
  Speech: `AS.audio.tap` → `Segmenter` → `AS.asr.transcribe` → translate → bus `subtitle` kind `speech`.
  Auto: run both; show speech only if OCR produced nothing for 4 s (like Android). `startWithStream(stream)` public for tests.
  Handles track `ended` (user pressed "Paylaşmayı durdur").
- **file** (`js/filemode.js`): local video (+ optional .srt/.vtt) played in a stage with overlay. With subtitles: PreTranslator from current position, sync on `timeupdate`/rAF, export Turkish SRT (download via Blob + `<a download>`). Without subtitles: transcribe with Whisper (decodeFile; chunked 28 s windows with timestamps, starting from the playhead, building cues), translate, show, export. If file too big to decode, fall back to live transcription via `video.captureStream()`.
- **youtube** (`js/youtube.js`): paste a link → strict ID extraction `[A-Za-z0-9_-]{11}` → YouTube IFrame API (`https://www.youtube.com/iframe_api`, host `https://www.youtube-nocookie.com`, `playerVars {fs:0, playsinline:1, rel:0}`) inside our stage wrapper with overlay and our own fullscreen button. Subtitles: load an SRT (sync with `getCurrentTime()`), or "Bu sekmenin sesini dinle" (`getDisplayMedia({preferCurrentTab:true, audio:true, video:true})` → speech pipeline). Honest note: ads inside the YouTube embed can't be removed.
- **Device lock** (`js/lock.js` → `AS.lock`): each browser gets a random 40-bit device code (Crockford base32, `XXXX-XXXX`, `localStorage['as.lock.device']`). An activation code is `AS1.` + base64url of an 8-byte payload `[1][device 5 bytes][end day u16, 0 = no end, 1 = 2026-01-01]` plus an ECDSA P-256/SHA-256 signature (64 bytes, r||s). Only the public key is in the site; the private key lives in the owner's phone generator page (kept outside the site folder). Verification is local (Web Crypto), works offline; the code must match this device and not be expired. Pasting the whole WhatsApp message works (the 96 code characters after `AS1.` are taken). On localhost/127.0.0.1 the lock is skipped unless `?lock=1`; `&lockKey=x.y` swaps in a test key. Limits: client-side, so someone who edits the code can remove it; clearing site data creates a new device code. Tests: `tests/unit/lock.test.js`, `tests/e2e/lock.e2e.js` (`AS_GEN_HTML=<generator>` also checks the real key pair).
- **Bookmarklet setup guide** (`js/youtube.js` `openGuide` → `AS.ytGuide.open`): a native `<dialog>` with four illustrated steps (drawn browser mockups + `img/yer-imi-ornek.webp`), a no-drag fallback (Ctrl+D, edit URL, paste) and a troubleshooting list. Opens from the card's "Resimli anlatım" button, when someone clicks the bookmark link on the site, and from Help. Dragging the link shows a fixed "drop it on the bookmarks bar, not the address bar" hint.
- **YouTube bookmarklet** (`js/yt-bookmarklet.js` → `AS.ytBookmarklet`, never run on our site): `js/youtube.js` turns its source (`Function#toString`, full-line `//` comments and indentation stripped, only `% # \n` percent-encoded) into a draggable `javascript:` link plus a "Kodu kopyala" fallback. On youtube.com it reads the caption track list from the player response, fetches the chosen track same-origin (`fmt=json3`); if YouTube answers empty (proof-of-origin token) it switches the track in the player and captures the player's own `/api/timedtext` response through an XHR/fetch hook; last resort reads `.ytp-caption-segment` text. Turkish tracks are shown as-is; others are translated from the playhead onward (on-device Translator → gtx batches joined by `\n` → MyMemory) into an overlay inside `#movie_player` (works in fullscreen), with a small panel (track select, show/hide, YouTube captions hidden, size, Turkish SRT, ad skipping). Ad skipping (on by default, same method as the Android `res/raw/adblock.js`): ad-element CSS, `adPlacements/playerAds/adSlots/adBreakHeartbeatParams` stripped from later `/youtubei/v1/player|next` fetch responses, and while `#movie_player.ad-showing`: mute, hide, `playbackRate` 16, seek to `duration`, click skip buttons; restored afterwards. Cannot touch ads inside our own IFrame embed (cross-origin). Self-contained, DOM only via createElement/textContent (YouTube enforces Trusted Types), no remote code, `referrerPolicy: no-referrer`. Tested against a fake youtube.com page with a Trusted Types CSP (`tests/e2e/ytbm.e2e.js`); not verified on the real site from the sandbox.

### js/app.js → `AS.app`
`start()`: builds header (logo + name), tab nav for the three modes + "Ayarlar" + "Yardım", mounts one mode at a time, settings panel (all `AS.settings` keys with Turkish labels and ⓘ info text), status bar (listens to `status`/`progress`), browser capability banner (`AS.util.browser()`), offline-prep button ("Çevrimdışı için hazırla": caches lib files via the SW, loads the ASR model, `AS.translate.prepareDevice`). Registers `sw.js`.

### sw.js, manifest.webmanifest, icons/
Service worker: versioned cache `as-shell-v1`; precache the small app shell (html/css/js/icons/manifest); runtime cache-first for same-origin `lib/` files; network-only for cross-origin (models are cached by transformers.js itself). Navigation fallback to cached `index.html` when offline. Never cache opaque/error responses. PWA manifest (Turkish name "Altyazı Şefi", standalone, theme color).

## Testing

- `tests/serve.js` (done): static server on 127.0.0.1 with Range support; `/__test/models/` → local Whisper test model
  (`Xenova/whisper-tiny` with `onnx/encoder_model_quantized.onnx`, `onnx/decoder_model_merged_quantized.onnx` → use dtype `'q8'`), `/__test/media/` → `tests/media`.
  `const { start } = require('../serve'); const s = await start(0); s.url; await s.close()`.
- `tests/media/` (done): `sample.webm` (8 s, 1280×720, VP8 + Opus, burned-in white subtitles "Where are you going tonight?" 0.5–3.8 s and "I am going to the cinema." 4.2–7.8 s at y≈h−110, flite English speech), `sample.srt`, `speech-en.wav` (16 kHz mono, "Hello my friend. Where are you going tonight?").
- Unit tests: `tests/unit/*.test.js` with `node --test` (load classic scripts with `global.window = global; require('../../js/ns.js')`).
- Browser tests: `tests/e2e/*.e2e.js` using Playwright: `NODE_PATH=$(npm root -g) node tests/e2e/<file>.e2e.js` (Chromium at /opt/pw-browsers, never run `playwright install`).
  The sandbox has no internet for HF/CDN: mock translation with `page.route('https://translate.googleapis.com/**', ...)` returning gtx-shaped JSON, and use the local Whisper test model via `?test=1&asrModelPath=/__test/models/&asrModelId=Xenova/whisper-tiny&device=wasm`.
  Headless Chromium here exposes `Translator` and `navigator.gpu` but they likely aren't usable; code must fall back cleanly.
- `tests/run-all.sh` runs every unit + e2e test and exits non-zero on failure.

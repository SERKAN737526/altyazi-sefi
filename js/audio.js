/* Altyazı Şefi Web: ses yakalama ve ön işleme → AS.audio
 *  - tap(stream, onChunk): MediaStream (getDisplayMedia / video.captureStream) sesini 16 kHz mono
 *    Float32Array parçalarına (~100 ms) çevirir (AudioWorklet: js/pcm-worklet.js; yoksa ScriptProcessor).
 *  - Segmenter: uyarlanır gürültü tabanlı enerji VAD'ı; konuşma bölütlerini çıkarır.
 *  - decodeFile(file): yerel dosyanın sesini 16 kHz mono Float32Array olarak çözer.
 * Klasik betik (IIFE); Node testlerinde `global.window = global` ile yüklenebilir (Segmenter/Resampler). */
(function (root) {
  'use strict';
  var AS = root.AS = root.AS || {};

  var RATE = 16000;
  var MAX_DECODE_BYTES = 600 * 1024 * 1024;
  var MSG = {
    noAudio: 'Paylaşılan kaynakta ses yok. Paylaşırken "Sekme sesini de paylaş" (veya "Sistem sesini paylaş") seçeneğini işaretleyin.',
    badStream: 'Geçersiz medya akışı.',
    noWebAudio: 'Bu tarayıcı Web Audio desteklemiyor; konuşma çevirisi kullanılamıyor.',
    tapFailed: 'Ses işlenemedi: ',
    clickToStart: 'Sesi işlemeye başlamak için sayfada bir yere tıklayın.',
    noFile: 'Dosya seçilmedi.',
    tooBig: 'Dosya çok büyük (600 MB üstü); sesi bir kerede çözülemiyor. Canlı dinleme kullanılacak.',
    empty: 'Dosya boş.',
    noDecoder: 'Bu tarayıcı ses dosyası çözmeyi desteklemiyor.',
    readFailed: 'Dosya okunamadı.',
    decodeFailed: 'Dosyadaki ses çözülemedi (ses izi yok ya da biçim desteklenmiyor).',
    noTrackAudio: 'Dosyada ses bulunamadı.',
    memory: 'Dosyanın sesi çözülürken bellek yetmedi. Canlı dinleme kullanılacak.',
    tooLong: 'Video uzun; sesini bir kerede çözmek tarayıcı sekmesini çökertebilir. Canlı dinleme kullanılacak.'
  };

  // Bu betiğin adresi: worklet'i alt yolda barındırmada da doğru yerden yüklemek için.
  var SCRIPT_SRC = (root.document && root.document.currentScript && root.document.currentScript.src) || null;
  function workletUrl() {
    try { if (SCRIPT_SRC) return new URL('pcm-worklet.js', SCRIPT_SRC).href; } catch (e) { /* aşağıda */ }
    return new URL('js/pcm-worklet.js', root.document.baseURI).href;
  }

  /* ------------------------------------------------------------------ */
  /* Yeniden örnekleyici (js/pcm-worklet.js içindekiyle AYNI; değiştirirseniz ikisini de değiştirin) */
  /* ------------------------------------------------------------------ */
  class Resampler {
    constructor(inRate, outRate) {
      this.inRate = inRate;
      this.outRate = outRate;
      this.step = inRate / outRate;
      const nyq = Math.min(inRate, outRate) / 2;
      const cutoffHz = nyq * 0.875;
      const transHz = Math.min(inRate, outRate) * 0.1;
      const atten = 70;
      const beta = 0.1102 * (atten - 8.7);
      const taps = Math.ceil((atten - 8) / (2.285 * 2 * Math.PI * transHz / inRate));
      this.half = Math.max(2, Math.ceil(taps / 2));
      this.res = 64;
      const fc = cutoffHz / inRate;
      const n = this.half * this.res + 2;
      const table = new Float32Array(n);
      const i0b = Resampler.besselI0(beta);
      for (let i = 0; i < n; i++) {
        const x = i / this.res;
        if (x >= this.half) { table[i] = 0; continue; }
        const r = x / this.half;
        const w = Resampler.besselI0(beta * Math.sqrt(1 - r * r)) / i0b;
        const a = 2 * fc * x;
        const sinc = a === 0 ? 1 : Math.sin(Math.PI * a) / (Math.PI * a);
        table[i] = 2 * fc * sinc * w;
      }
      this.table = table;
      this.buf = new Float32Array(Math.max(4096, this.half * 4));
      this.len = this.half;
      this.pos = this.half;
    }

    static besselI0(x) {
      let sum = 1, term = 1;
      const q = (x * x) / 4;
      for (let k = 1; k < 64; k++) {
        term *= q / (k * k);
        sum += term;
        if (term < sum * 1e-12) break;
      }
      return sum;
    }

    maxOut(inputLength) {
      return Math.ceil((this.len + inputLength) / this.step) + 2;
    }

    process(input, count, out) {
      if (count === undefined) count = input.length;
      if (this.len + count > this.buf.length) {
        const bigger = new Float32Array(Math.max(this.buf.length * 2, this.len + count + 1024));
        bigger.set(this.buf.subarray(0, this.len));
        this.buf = bigger;
      }
      this.buf.set(count === input.length ? input : input.subarray(0, count), this.len);
      this.len += count;

      const buf = this.buf, table = this.table, res = this.res, half = this.half, step = this.step;
      let pos = this.pos, written = 0;
      const lastIdx = this.len - 1;
      while (pos + half <= lastIdx && written < out.length) {
        const k0 = Math.ceil(pos - half);
        const k1 = Math.floor(pos + half);
        let acc = 0, wsum = 0;
        for (let k = k0 < 0 ? 0 : k0; k <= k1; k++) {
          const d = (pos > k ? pos - k : k - pos) * res;
          const i = d | 0;
          const h = table[i] + (table[i + 1] - table[i]) * (d - i);
          acc += buf[k] * h;
          wsum += h;
        }
        out[written++] = wsum > 1e-9 ? acc / wsum : 0;
        pos += step;
      }
      const drop = Math.floor(pos - half);
      if (drop > 0) {
        buf.copyWithin(0, drop, this.len);
        this.len -= drop;
        pos -= drop;
      }
      this.pos = pos;
      return written;
    }
  }

  /** Tüm bir diziyi tek seferde yeniden örnekler (çevrimdışı yardımcı). */
  function resampleAll(input, inRate, outRate) {
    if (inRate === outRate) return input;
    const rs = new Resampler(inRate, outRate);
    const tail = new Float32Array(rs.half + 2); // son örneklerin de çıkması için sıfır dolgu
    const out = new Float32Array(Math.ceil(input.length * outRate / inRate) + 4);
    let n = 0;
    const blk = 65536;
    for (let i = 0; i < input.length; i += blk) {
      const part = input.subarray(i, Math.min(input.length, i + blk));
      n += rs.process(part, part.length, out.subarray(n));
    }
    n += rs.process(tail, tail.length, out.subarray(n));
    const want = Math.round(input.length * outRate / inRate);
    return out.slice(0, Math.min(n, want));
  }

  /* ------------------------------------------------------------------ */
  /* tap(): MediaStream → 16 kHz mono parçalar                           */
  /* ------------------------------------------------------------------ */
  function liveAudioTrack(stream) {
    const tracks = stream.getAudioTracks();
    for (let i = 0; i < tracks.length; i++) if (tracks[i].readyState === 'live') return tracks[i];
    return null;
  }

  /** video.captureStream() ses izini oynatma başlayınca ekleyebilir; kısa süre bekle. */
  function waitForAudioTrack(stream, ms) {
    return new Promise(function (resolve) {
      let done = false;
      function finish(t) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { stream.removeEventListener('addtrack', onAdd); } catch (e) { /* yok */ }
        resolve(t);
      }
      function onAdd() { const t = liveAudioTrack(stream); if (t) finish(t); }
      const timer = setTimeout(function () { finish(liveAudioTrack(stream)); }, ms);
      try { stream.addEventListener('addtrack', onAdd); } catch (e) { /* yok */ }
    });
  }

  function raceTimeout(p, ms) {
    return Promise.race([Promise.resolve(p).catch(function () {}), new Promise(function (r) { setTimeout(r, ms); })]);
  }

  function emitStatus(mode, text, level) {
    if (AS.bus) AS.bus.emit('status', { mode: mode || 'app', text: text, level: level || 'info' });
  }

  /**
   * @param {MediaStream} stream
   * @param {(pcm: Float32Array) => void} onChunk  ~100 ms'lik 16 kHz mono parçalar (her çağrıda yeni dizi)
   * @param {{mode?: string, chunkMs?: number}} [opts]
   * @returns {Promise<{stop: () => void, sampleRate: 16000, inputSampleRate: number, backend: string}>}
   */
  async function tap(stream, onChunk, opts) {
    opts = opts || {};
    if (!stream || typeof stream.getAudioTracks !== 'function') throw new Error(MSG.badStream);
    if (typeof onChunk !== 'function') throw new TypeError('onChunk bir işlev olmalı');
    let track = liveAudioTrack(stream);
    if (!track) track = await waitForAudioTrack(stream, opts.waitMs >= 0 ? opts.waitMs : 1500);
    if (!track) throw new Error(MSG.noAudio);

    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) throw new Error(MSG.noWebAudio);
    let ctx;
    try { ctx = new AC({ latencyHint: 'playback' }); } catch (e) { ctx = new AC(); }
    const chunkMs = opts.chunkMs > 0 ? opts.chunkMs : 100;
    let stopped = false;
    let source = null, node = null, sink = null, sp = null;
    let gestureCleanup = null;

    function deliver(pcm) {
      if (stopped) return;
      try { onChunk(pcm); } catch (e) { if (root.console) console.error('[AS.audio] onChunk', e); }
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      try { track.removeEventListener('ended', stop); } catch (e) { /* yok */ }
      if (gestureCleanup) gestureCleanup();
      try { if (node) { node.port.postMessage({ type: 'stop' }); node.port.onmessage = null; } } catch (e) { /* yok */ }
      try { if (sp) sp.onaudioprocess = null; } catch (e) { /* yok */ }
      [source, node, sp, sink].forEach(function (n) { try { if (n) n.disconnect(); } catch (e) { /* yok */ } });
      try { if (ctx.state !== 'closed') ctx.close().catch(function () {}); } catch (e) { /* yok */ }
    }

    try {
      // Yalnızca seçilen ses izi (akışta birden çok iz olabilir)
      const MS = root.MediaStream;
      const only = (MS && stream.getAudioTracks().length > 1) ? new MS([track]) : stream;
      source = ctx.createMediaStreamSource(only);
      sink = ctx.createGain();
      sink.gain.value = 0; // hoparlöre ses verme ama grafik çalışsın
      sink.connect(ctx.destination);

      let backend = 'worklet';
      if (ctx.audioWorklet && typeof root.AudioWorkletNode === 'function') {
        try {
          await ctx.audioWorklet.addModule(workletUrl());
          node = new root.AudioWorkletNode(ctx, 'as-pcm16k', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
            channelCount: 2, channelCountMode: 'clamped-max', channelInterpretation: 'speakers',
            processorOptions: { targetRate: RATE, chunkMs: chunkMs }
          });
          node.port.onmessage = function (e) { if (e.data instanceof Float32Array) deliver(e.data); };
          node.onprocessorerror = function () { emitStatus(opts.mode, MSG.tapFailed + 'ses işlemcisi durdu.', 'error'); };
          source.connect(node);
          node.connect(sink);
        } catch (e) {
          if (root.console) console.warn('[AS.audio] AudioWorklet kullanılamadı, ScriptProcessor yedeğine geçiliyor', e);
          node = null;
          backend = 'script';
        }
      } else {
        backend = 'script';
      }

      if (backend === 'script') {
        if (typeof ctx.createScriptProcessor !== 'function') throw new Error(MSG.noWebAudio);
        const rs = new Resampler(ctx.sampleRate, RATE);
        const chunkLen = Math.round(RATE * chunkMs / 1000);
        let chunk = new Float32Array(chunkLen), fill = 0;
        let mono = new Float32Array(4096), tmp = new Float32Array(rs.maxOut(4096) + 8);
        sp = ctx.createScriptProcessor(4096, 2, 1);
        sp.onaudioprocess = function (ev) {
          const ib = ev.inputBuffer;
          const frames = ib.length, chs = ib.numberOfChannels;
          if (mono.length < frames) mono = new Float32Array(frames);
          if (chs === 1) mono.set(ib.getChannelData(0));
          else {
            const a = ib.getChannelData(0), b = ib.getChannelData(1);
            for (let i = 0; i < frames; i++) mono[i] = (a[i] + b[i]) * 0.5;
          }
          const need = rs.maxOut(frames);
          if (tmp.length < need) tmp = new Float32Array(need + 8);
          const n = rs.process(mono, frames, tmp);
          let i = 0;
          while (i < n) {
            const take = Math.min(n - i, chunkLen - fill);
            chunk.set(tmp.subarray(i, i + take), fill);
            fill += take; i += take;
            if (fill === chunkLen) { const full = chunk; chunk = new Float32Array(chunkLen); fill = 0; deliver(full); }
          }
        };
        source.connect(sp);
        sp.connect(sink);
      }

      track.addEventListener('ended', stop);

      if (ctx.state !== 'running') await raceTimeout(ctx.resume(), 400);
      if (ctx.state !== 'running' && ctx.state !== 'closed' && root.document) {
        // Otomatik oynatma kuralı: bir kullanıcı hareketi gerekiyor
        const resume = function () { ctx.resume().catch(function () {}); if (ctx.state === 'running' && gestureCleanup) gestureCleanup(); };
        const evs = ['pointerdown', 'keydown', 'touchend'];
        evs.forEach(function (ev) { root.document.addEventListener(ev, resume, true); });
        gestureCleanup = function () { evs.forEach(function (ev) { root.document.removeEventListener(ev, resume, true); }); gestureCleanup = null; };
        ctx.addEventListener('statechange', function () { if (ctx.state === 'running' && gestureCleanup) gestureCleanup(); });
        emitStatus(opts.mode, MSG.clickToStart, 'warn');
      }

      return { stop: stop, sampleRate: RATE, inputSampleRate: ctx.sampleRate, backend: backend };
    } catch (e) {
      stop();
      if (e && e.message === MSG.noWebAudio) throw e;
      throw new Error(MSG.tapFailed + ((e && e.message) || String(e)));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Segmenter: uyarlanır enerji VAD'ı                                   */
  /* ------------------------------------------------------------------ */
  function optNum(v, def, min) {
    const n = Number(v);
    if (v === undefined || v === null || !isFinite(n)) return def;
    return min !== undefined ? Math.max(min, n) : n;
  }

  /** Büyüyebilen Float32 tamponu. */
  class GrowBuf {
    constructor(cap) { this.a = new Float32Array(cap || 16000); this.n = 0; }
    push(src) {
      if (this.n + src.length > this.a.length) {
        const b = new Float32Array(Math.max(this.a.length * 2, this.n + src.length));
        b.set(this.a.subarray(0, this.n));
        this.a = b;
      }
      this.a.set(src, this.n);
      this.n += src.length;
    }
  }

  /**
   * new Segmenter({onSegment(pcm, {startMs, endMs, final}), minSpeechMs=400, maxSegMs=7000, silenceMs=450, preRollMs=200})
   *  - push(chunk): 16 kHz mono parça ekler (her boy olur).
   *  - flush(): açık bölütü (yeterince konuşma varsa) final=true ile verir.
   *  - reset(): her şeyi (zaman, gürültü tabanı) sıfırlar.
   * final=false: bölüt maxSegMs nedeniyle kesildi, konuşma sürüyor (sonraki bölüt devamıdır).
   * Zamanlar ilk push'tan (veya reset'ten) beri geçen ses süresidir (ms).
   */
  class Segmenter {
    constructor(opts) {
      opts = opts || {};
      this.onSegment = typeof opts.onSegment === 'function' ? opts.onSegment : function () {};
      this.minSpeechMs = optNum(opts.minSpeechMs, 400, 0);
      this.maxSegMs = optNum(opts.maxSegMs, 7000, 1000);
      this.silenceMs = optNum(opts.silenceMs, 450, 20);
      this.preRollMs = optNum(opts.preRollMs, 200, 0);
      this.sampleRate = RATE;
      this.frameLen = 320;            // 20 ms
      this.frameMs = 20;
      // VAD ayarları
      this.startDb = optNum(opts.startDb, 9);     // taban + bu kadar dB → konuşma başlar
      this.keepDb = optNum(opts.keepDb, 5);       // konuşma sürerken eşik
      this.minDb = optNum(opts.minDb, -55);       // mutlak alt sınır (dBFS); altı hep sessizlik
      this.warmupFrames = Math.round(optNum(opts.warmupMs, 200, 0) / this.frameMs); // ilk ölçümler: yalnızca taban öğrenilir
      this.tailMs = optNum(opts.tailMs, 200, 0);  // bölüt sonunda bırakılan sessizlik
      this.historyFrames = 150;       // 3 s gürültü tabanı geçmişi
      this.percentile = 0.1;
      // 150 Hz Butterworth yüksek geçiren (yalnızca enerji ölçümü için; uğultu/bas müziği bastırır)
      const w0 = 2 * Math.PI * 150 / RATE, cw = Math.cos(w0), al = Math.sin(w0) / (2 * Math.SQRT1_2);
      const a0 = 1 + al;
      this.hpB = [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0];
      this.hpA = [-2 * cw / a0, (1 - al) / a0];
      this.reset();
    }

    reset() {
      this.samples = 0;                       // çerçevelere işlenmiş toplam örnek
      this.frame = new Float32Array(this.frameLen);
      this.frameFill = 0;
      this.hist = new Float32Array(this.historyFrames);
      this.sorted = new Float32Array(this.historyFrames);
      this.histLen = 0;
      this.histPos = 0;
      this.hx1 = this.hx2 = this.hy1 = this.hy2 = 0;
      this.floorDb = -90;
      this.levelDb = -100;
      const preLen = Math.round(this.preRollMs * RATE / 1000);
      this.pre = new Float32Array(Math.max(1, preLen));
      this.preLen = preLen;
      this.preFill = 0;
      this.prePos = 0;
      this._idle();
    }

    _idle() {
      this.inSpeech = false;
      this.seg = null;
      this.segStart = 0;
      this.frames = [];        // {off, db, voiced}
      this.voicedMs = 0;
      this.silenceRun = 0;
    }

    /** UI göstergeleri için anlık değerler. */
    stats() { return { levelDb: this.levelDb, floorDb: this.floorDb, inSpeech: this.inSpeech }; }

    push(chunk) {
      if (!chunk || !chunk.length) return;
      const fl = this.frameLen;
      let i = 0;
      while (i < chunk.length) {
        const take = Math.min(chunk.length - i, fl - this.frameFill);
        this.frame.set(chunk.subarray(i, i + take), this.frameFill);
        this.frameFill += take;
        i += take;
        if (this.frameFill === fl) {
          this._processFrame(this.frame);
          this.frameFill = 0;
        }
      }
    }

    flush() {
      if (this.inSpeech) {
        let len = this.seg.n;
        if (this.silenceRun > this.tailMs) {
          len = Math.max(0, len - Math.round((this.silenceRun - this.tailMs) * RATE / 1000));
        } else if (this.frameFill > 0) {
          this.seg.push(this.frame.subarray(0, this.frameFill));
          len = this.seg.n;
        }
        this._emit(len, true);
        this._idle();
      }
      this.samples += this.frameFill;
      this.frameFill = 0;
    }

    _energyDb(frame) {
      const b = this.hpB, a = this.hpA;
      let x1 = this.hx1, x2 = this.hx2, y1 = this.hy1, y2 = this.hy2, sum = 0;
      for (let i = 0; i < frame.length; i++) {
        const x = frame[i];
        const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        sum += y * y;
      }
      // NaN/Infinity koruması
      if (!isFinite(y1) || !isFinite(y2)) { y1 = y2 = 0; }
      this.hx1 = x1; this.hx2 = x2; this.hy1 = y1; this.hy2 = y2;
      const ms = sum / frame.length;
      return isFinite(ms) ? 10 * Math.log10(ms + 1e-10) : -100;
    }

    /** Gürültü tabanı: son 3 s'nin %10'luk dilimi. Hızlı düşer (sessizlik anları yeter),
     *  yavaş yükselir (sürekli müzik ~2.7 s sonra "gürültü" sayılır). */
    _floor() {
      const n = this.histLen;
      if (n === 0) return -90;
      const s = this.sorted;
      for (let i = 0; i < n; i++) s[i] = this.hist[i];
      const view = s.subarray(0, n);
      view.sort();
      const f = view[Math.min(n - 1, Math.floor(n * this.percentile))];
      return Math.max(-90, f);
    }

    _processFrame(frame) {
      const db = this._energyDb(frame);
      const floor = this._floor();
      const warm = this.histLen >= this.warmupFrames;
      this.floorDb = floor;
      this.levelDb = db;
      // geçmişe ekle (taban bir sonraki çerçeveden itibaren bunu da görür)
      this.hist[this.histPos] = db;
      this.histPos = (this.histPos + 1) % this.historyFrames;
      if (this.histLen < this.historyFrames) this.histLen++;

      const frameStart = this.samples;
      this.samples += frame.length;

      if (!this.inSpeech) {
        const start = warm && db >= this.minDb && db - floor >= this.startDb;
        if (start) {
          this.inSpeech = true;
          this.seg = new GrowBuf(Math.round(RATE * Math.min(this.maxSegMs, 8000) / 1000) + 4096);
          const pre = this._takePreRoll();
          this.seg.push(pre);
          this.segStart = frameStart - pre.length;
          this.frames = [];
          this.voicedMs = 0;
          this.silenceRun = 0;
          this._addFrame(frame, db, true);
          this._maybeCut();
        } else {
          this._pushPreRoll(frame);
        }
        return;
      }

      const voiced = db >= this.minDb - 5 && db - floor >= this.keepDb;
      this._addFrame(frame, db, voiced);
      if (this.silenceRun >= this.silenceMs) {
        // doğal son: fazla sessizliği kırp, bir kısmını bırak
        const extraMs = Math.max(0, this.silenceRun - this.tailMs);
        const cut = Math.max(0, this.seg.n - Math.round(extraMs * RATE / 1000));
        const trailing = this.seg.a.slice(cut, this.seg.n);
        this._emit(cut, true);
        this._idle();
        // kırpılan sessizlik bir sonraki bölütün ön-kaydı olur
        this._pushPreRoll(trailing);
        return;
      }
      this._maybeCut();
    }

    _addFrame(frame, db, voiced) {
      this.frames.push({ off: this.seg.n, db: db, voiced: voiced });
      this.seg.push(frame);
      if (voiced) { this.voicedMs += this.frameMs; this.silenceRun = 0; } else this.silenceRun += this.frameMs;
    }

    /** Bölüt maxSegMs'e ulaştıysa en sessiz yerden (son ~2 s içinde) kes, kalanla devam et. */
    _maybeCut() {
      const maxLen = Math.round(this.maxSegMs * RATE / 1000);
      if (this.seg.n < maxLen) return;
      const fr = this.frames;
      const lookFrames = Math.max(1, Math.round(Math.min(2000, this.maxSegMs * 0.3) / this.frameMs));
      const from = Math.max(1, fr.length - lookFrames);
      let minDb = Infinity;
      for (let i = from; i < fr.length; i++) if (fr[i].db < minDb) minDb = fr[i].db;
      // en sessize yakın (≤ +3 dB) çerçevelerden en sondakini seç: bölüt maxSegMs'e yakın kalsın
      let best = fr.length - 1;
      for (let i = fr.length - 1; i >= from; i--) { if (fr[i].db <= minDb + 3) { best = i; break; } }
      const cut = Math.min(this.seg.n, fr[best].off + (this.frameLen >> 1));
      const rest = this.seg.a.slice(cut, this.seg.n);
      const restFrames = fr.slice(best + 1);
      this._emit(cut, false);
      // kalan kısım yeni bölütün başı olur
      const newStart = this.segStart + cut;
      this.seg = new GrowBuf(Math.round(RATE * Math.min(this.maxSegMs, 8000) / 1000) + 4096);
      this.seg.push(rest);
      this.segStart = newStart;
      const shift = cut;
      this.frames = restFrames.map(function (f) { return { off: f.off - shift, db: f.db, voiced: f.voiced }; });
      this.voicedMs = 0;
      this.silenceRun = 0;
      for (let i = 0; i < this.frames.length; i++) {
        if (this.frames[i].voiced) { this.voicedMs += this.frameMs; this.silenceRun = 0; } else this.silenceRun += this.frameMs;
      }
    }

    _emit(len, final) {
      // Kesilen parçada yeterince konuşma var mı?
      let voiced = 0;
      for (let i = 0; i < this.frames.length; i++) if (this.frames[i].off < len && this.frames[i].voiced) voiced += this.frameMs;
      if (voiced < this.minSpeechMs || len <= 0) return;
      const pcm = this.seg.a.slice(0, len);
      const startMs = Math.round(this.segStart * 1000 / RATE);
      const endMs = Math.round((this.segStart + len) * 1000 / RATE);
      try { this.onSegment(pcm, { startMs: startMs, endMs: endMs, final: !!final }); } catch (e) { if (root.console) console.error('[AS.audio] onSegment', e); }
    }

    _pushPreRoll(src) {
      const cap = this.preLen;
      if (cap <= 0) return;
      let s = src;
      if (s.length >= cap) s = s.subarray(s.length - cap);
      for (let i = 0; i < s.length; i++) {
        this.pre[this.prePos] = s[i];
        this.prePos = (this.prePos + 1) % cap;
      }
      this.preFill = Math.min(cap, this.preFill + s.length);
    }

    _takePreRoll() {
      const n = this.preFill, cap = this.preLen;
      const out = new Float32Array(n);
      if (n > 0) {
        let p = (this.prePos - n + cap) % cap;
        for (let i = 0; i < n; i++) { out[i] = this.pre[p]; p = (p + 1) % cap; }
      }
      this.preFill = 0;
      return out;
    }
  }

  /* ------------------------------------------------------------------ */
  /* decodeFile(): yerel dosya → 16 kHz mono                             */
  /* ------------------------------------------------------------------ */
  async function readAll(file, onProgress) {
    const total = file.size;
    function report(n) { if (onProgress) { try { onProgress(n, total); } catch (e) { /* yok */ } } }
    if (typeof file.stream === 'function') {
      const out = new Uint8Array(total);
      const reader = file.stream().getReader();
      let off = 0, last = 0;
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        const v = r.value;
        if (off + v.length > total) throw new Error(MSG.readFailed);
        out.set(v, off);
        off += v.length;
        if (off - last > 4 * 1048576) { last = off; report(off); }
      }
      report(off);
      return off === total ? out.buffer : out.slice(0, off).buffer;
    }
    if (typeof file.arrayBuffer === 'function') {
      const ab = await file.arrayBuffer();
      report(ab.byteLength);
      return ab;
    }
    return await new Promise(function (resolve, reject) {
      const fr = new root.FileReader();
      fr.onprogress = function (e) { if (e.lengthComputable) report(e.loaded); };
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error(MSG.readFailed)); };
      fr.readAsArrayBuffer(file);
    });
  }

  function decodeData(ctx, ab) {
    return new Promise(function (resolve, reject) {
      let done = false;
      const ok = function (b) { if (!done) { done = true; resolve(b); } };
      const fail = function (e) { if (!done) { done = true; reject(e || new Error('decode')); } };
      try {
        const p = ctx.decodeAudioData(ab, ok, fail);
        if (p && typeof p.then === 'function') p.then(ok, fail);
      } catch (e) { fail(e); }
    });
  }

  /** AudioBuffer → mono. 5.1 için Web Audio'nun konuşmacı kuralı (diyalog merkez kanaldadır). */
  function downmix(buf) {
    const n = buf.length, chs = buf.numberOfChannels;
    if (chs === 1) return buf.getChannelData(0).slice();
    const out = new Float32Array(n);
    if (chs === 6) {
      const L = buf.getChannelData(0), R = buf.getChannelData(1), C = buf.getChannelData(2);
      const SL = buf.getChannelData(4), SR = buf.getChannelData(5);
      const g = 1 / (2 * Math.SQRT1_2 + 1 + 1); // kabaca normalleştir
      for (let i = 0; i < n; i++) out[i] = (Math.SQRT1_2 * (L[i] + R[i]) + C[i] + 0.5 * (SL[i] + SR[i])) * g;
      return out;
    }
    for (let c = 0; c < chs; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i];
    }
    const g = 1 / chs;
    for (let i = 0; i < n; i++) out[i] *= g;
    return out;
  }

  /** Cihaz belleğine göre bir kerede çözülecek en uzun süre (sn). Tepe ≈ 2 × süre × 48000 × kanal × 4 bayt. */
  function maxDecodeSec() {
    let gb = 0;
    try { gb = Number(root.navigator && root.navigator.deviceMemory) || 0; } catch (e) { gb = 0; }
    if (!gb) return 30 * 60;          // bilinmiyor (Safari/Firefox)
    if (gb >= 8) return 40 * 60;      // Chrome en çok 8 bildirir; 40 dk 5.1 ≈ 5,5 GB, stereo ≈ 1,8 GB tepe
    if (gb >= 4) return 20 * 60;
    return 10 * 60;
  }

  /** Dosyanın süresi (sn) medya öğesiyle (yalnızca üst veri); bilinemezse 0. */
  function probeDuration(file) {
    return new Promise(function (resolve) {
      const doc = root.document;
      const URLs = root.URL;
      if (!doc || !URLs || typeof URLs.createObjectURL !== 'function') { resolve(0); return; }
      let url = null, m = null, timer = null, done = false;
      const finish = function (v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { if (m) { m.removeAttribute('src'); m.load(); } } catch (e) { /* yok */ }
        try { if (url) URLs.revokeObjectURL(url); } catch (e) { /* yok */ }
        resolve(isFinite(v) && v > 0 ? v : 0);
      };
      try {
        m = doc.createElement('video');
        m.preload = 'metadata';
        m.muted = true;
        m.onloadedmetadata = function () { finish(m.duration); };
        m.onerror = function () { finish(0); };
        timer = setTimeout(function () { finish(0); }, 5000);
        url = URLs.createObjectURL(file);
        m.src = url;
      } catch (e) { finish(0); }
    });
  }

  /**
   * @param {Blob|File} file
   * @param {(loaded: number, total: number) => void} [onProgress] okuma ilerlemesi (bayt)
   * @returns {Promise<Float32Array>} 16 kHz mono
   */
  async function decodeFile(file, onProgress) {
    if (!file || typeof file.size !== 'number') throw new Error(MSG.noFile);
    if (file.size > MAX_DECODE_BYTES) throw new Error(MSG.tooBig);
    if (file.size === 0) throw new Error(MSG.empty);
    const OAC = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    if (!OAC) throw new Error(MSG.noDecoder);
    // decodeAudioData tüm sesi önce özgün hız ve kanal sayısında (ör. 48 kHz 5.1) belleğe açar: 90 dk 5.1 ≈ 13 GB
    // tepe kullanım; sekme yakalanamayan bir bellek hatasıyla çöker. Süre sınırı aşılırsa canlı dinlemeye geçilir.
    const dur = await probeDuration(file);
    if (dur > maxDecodeSec()) throw new Error(MSG.tooLong);
    let ab;
    try { ab = await readAll(file, onProgress); } catch (e) { throw new Error(MSG.readFailed); }
    let ctx;
    try { ctx = new OAC(1, 1, RATE); } catch (e) {
      try { ctx = new OAC(1, RATE, RATE); } catch (e2) { throw new Error(MSG.noDecoder); }
    }
    let buf;
    try {
      buf = await decodeData(ctx, ab);
    } catch (e) {
      if (e && (e.name === 'RangeError' || /memory/i.test(String(e.message)))) throw new Error(MSG.memory);
      throw new Error(MSG.decodeFailed);
    }
    ab = null;
    if (!buf || !buf.length || !buf.numberOfChannels) throw new Error(MSG.noTrackAudio);
    let pcm;
    try {
      pcm = downmix(buf);
      if (buf.sampleRate !== RATE) pcm = resampleAll(pcm, buf.sampleRate, RATE);
    } catch (e) {
      throw new Error(MSG.memory);
    }
    // Tamamen sessiz mi? (ses izi olmayan bazı kapsayıcılar sıfır döndürür)
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 7) { const v = pcm[i] < 0 ? -pcm[i] : pcm[i]; if (v > peak) peak = v; if (peak > 1e-4) break; }
    if (peak <= 1e-4) throw new Error(MSG.noTrackAudio);
    return pcm;
  }

  AS.audio = {
    SAMPLE_RATE: RATE,
    tap: tap,
    Segmenter: Segmenter,
    decodeFile: decodeFile,
    // testler ve yedek yol için
    Resampler: Resampler,
    resample: resampleAll,
    MAX_DECODE_BYTES: MAX_DECODE_BYTES
  };
})(typeof window !== 'undefined' ? window : globalThis);

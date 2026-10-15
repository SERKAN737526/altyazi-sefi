/* Altyazı Şefi Web: AudioWorklet işlemcisi.
 * Gelen sesi (her kanal sayısı, her örnekleme hızı: 44.1k / 48k / ...) mono'ya indirger,
 * Kaiser pencereli sinc alçak geçiren süzgeçle (kesim ~7 kHz, ~70 dB bastırma) 16 kHz'e
 * yeniden örnekler ve ~100 ms'lik Float32Array parçalarını ana iş parçacığına gönderir.
 *
 * NOT: Resampler sınıfının aynısı js/audio.js içinde de var (AudioWorklet olmayan tarayıcılar
 * için ScriptProcessor yedeği). İkisi tests/unit/segmenter.test.js ile karşılaştırılır; birini
 * değiştirirseniz ötekini de değiştirin. */
'use strict';

class Resampler {
  constructor(inRate, outRate) {
    this.inRate = inRate;
    this.outRate = outRate;
    this.step = inRate / outRate;                    // çıkış örneği başına giriş örneği
    const nyq = Math.min(inRate, outRate) / 2;
    const cutoffHz = nyq * 0.875;                    // 16 kHz çıkışta 7 kHz
    const transHz = Math.min(inRate, outRate) * 0.1; // 16 kHz çıkışta 1.6 kHz geçiş bandı
    const atten = 70;                                // dB
    const beta = 0.1102 * (atten - 8.7);
    const taps = Math.ceil((atten - 8) / (2.285 * 2 * Math.PI * transHz / inRate));
    this.half = Math.max(2, Math.ceil(taps / 2));    // giriş örneği cinsinden yarı genişlik
    this.res = 64;                                   // tablo çözünürlüğü (giriş örneği başına)
    const fc = cutoffHz / inRate;                    // giriş örneği başına devir
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
    this.len = this.half;  // başta yarı genişlik kadar sıfır (ilk çıkış t=0'da hesaplanabilsin)
    this.pos = this.half;  // sonraki çıkış örneğinin tampondaki (kesirli) konumu
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

  /** Bir sonraki process() çağrısında üretilebilecek en fazla çıkış sayısı. */
  maxOut(inputLength) {
    return Math.ceil((this.len + inputLength) / this.step) + 2;
  }

  /** input[0..count) işler, çıktıları out[] içine yazar, yazılan sayıyı döndürür. */
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
    // Artık gerekmeyen eski örnekleri at
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

class PcmDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const po = (options && options.processorOptions) || {};
    this.outRate = po.targetRate > 0 ? po.targetRate : 16000;
    const chunkMs = po.chunkMs > 0 ? po.chunkMs : 100;
    this.chunkLen = Math.max(160, Math.round(this.outRate * chunkMs / 1000));
    // `sampleRate` AudioWorkletGlobalScope'un genel değişkenidir (bağlamın hızı)
    this.rs = new Resampler(sampleRate, this.outRate);
    this.mono = new Float32Array(128);
    this.tmp = new Float32Array(this.rs.maxOut(128) + 8);
    this.chunk = new Float32Array(this.chunkLen);
    this.fill = 0;
    this.stopped = false;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'flush' || m.type === 'stop') this.flush();
      if (m.type === 'stop') this.stopped = true;
    };
  }

  flush() {
    if (this.fill > 0) {
      const part = this.chunk.slice(0, this.fill);
      this.port.postMessage(part, [part.buffer]);
      this.fill = 0;
    }
  }

  push(src, n) {
    let i = 0;
    while (i < n) {
      const take = Math.min(n - i, this.chunkLen - this.fill);
      this.chunk.set(src.subarray(i, i + take), this.fill);
      this.fill += take;
      i += take;
      if (this.fill === this.chunkLen) {
        const full = this.chunk;
        this.port.postMessage(full, [full.buffer]);
        this.chunk = new Float32Array(this.chunkLen);
        this.fill = 0;
      }
    }
  }

  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0];
    if (!input || input.length === 0) return true; // bağlı/etkin kaynak yok
    const frames = input[0].length;
    if (this.mono.length < frames) this.mono = new Float32Array(frames);
    const mono = this.mono;
    const chs = input.length;
    if (chs === 1) {
      mono.set(input[0]);
    } else {
      const g = 1 / chs;
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < chs; c++) s += input[c][i];
        mono[i] = s * g;
      }
    }
    const need = this.rs.maxOut(frames);
    if (this.tmp.length < need) this.tmp = new Float32Array(need + 8);
    const n = this.rs.process(mono, frames, this.tmp);
    if (n > 0) this.push(this.tmp, n);
    return true;
  }
}

registerProcessor('as-pcm16k', PcmDownsampler);

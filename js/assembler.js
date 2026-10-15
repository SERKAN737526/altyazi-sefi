/* Altyazı Şefi Web: okunan alt yazıları cümleye çevirir → AS.Assembler
 * Android SubtitleAssembler.java'nın birebir çevirisi:
 *  - aynı alt yazıyı tekrar göndermez (benzerlik ≥ 0.8),
 *  - kayan / kelime kelime beliren (YouTube otomatik altyazı) satırlarda yalnızca yeni kelimeleri alır,
 *  - güveni düşük okumaları art arda iki tutarlı okumada kabul eder,
 *  - noktalama ile bitmeyen parçayı 6 sn içinde gelen sonraki parçayla birleştirir (en çok 280 karakter).
 * Klasik betik (IIFE); DOM kullanmaz, Node'da da çalışır. */
(function (root) {
  'use strict';
  var AS = root.AS = root.AS || {};

  var JOIN_WINDOW_MS = 6000;
  var MAX_SENTENCE = 280;
  var HIGH_CONF = 74;

  var LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;

  /** Satır sonlarını ve boşlukları teke indirir, baştaki konuşmacı tirelerini/gürültüyü atar. */
  function normalize(s) {
    if (s === null || s === undefined) return '';
    s = String(s).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/^[-–—•·\s]+/, '');
    return s;
  }

  function words(s) {
    var out = [];
    var parts = s.split(' ');
    for (var i = 0; i < parts.length; i++) if (parts[i] !== '') out.push(parts[i]);
    return out;
  }

  function join(w, from) {
    return w.slice(from).join(' ');
  }

  /** Karşılaştırma anahtarı: yalnızca harf/rakam, küçük harf (Java Character.toLowerCase gibi tek karakter). */
  function key(w) {
    var out = '';
    for (var ch of w) {
      if (!LETTER_OR_DIGIT.test(ch)) continue;
      var lo = ch.toLowerCase();
      // 'İ'.toLowerCase() === 'i̇' (2 karakter); Java tek karaktere indirir ('i').
      if (lo.length > ch.length) lo = lo.charAt(0);
      out += lo;
    }
    return out;
  }

  function levenshtein(a, b) {
    var prev = new Array(b.length + 1), cur = new Array(b.length + 1), t;
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
      cur[0] = i;
      var ac = a.charCodeAt(i - 1);
      for (j = 1; j <= b.length; j++) {
        var cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(Math.min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
      }
      t = prev; prev = cur; cur = t;
    }
    return prev[b.length];
  }

  function wordEq(a, b) {
    var x = key(a), y = key(b);
    if (x === y) return true;
    return Math.max(x.length, y.length) > 3 && levenshtein(x, y) <= 1;
  }

  /** 0..1 benzerlik (yalnızca harf/rakamlar üzerinde, boşluklar yok sayılır). */
  function similarity(a, b) {
    var x = key(String(a == null ? '' : a).split(' ').join('_'));
    var y = key(String(b == null ? '' : b).split(' ').join('_'));
    var max = Math.max(x.length, y.length);
    if (max === 0) return 1;
    return 1 - levenshtein(x, y) / max;
  }

  /** Eski metnin sonu ile yeni metnin başında ortak olan kelime sayısı. */
  function overlap(old, cur) {
    var i, same;
    // Yeni metin eskisinin uzamış hali mi? (kelime kelime beliren alt yazı)
    if (old.length <= cur.length && old.length >= 2) {
      same = 0;
      for (i = 0; i < old.length; i++) if (wordEq(old[i], cur[i])) same++;
      if (same >= old.length - (old.length >= 5 ? 1 : 0)) return old.length;
    }
    // Kayan alt yazı: eskinin son k kelimesi yeninin ilk k kelimesi.
    for (var k = Math.min(old.length, cur.length); k >= 2; k--) {
      same = 0;
      for (i = 0; i < k; i++) if (wordEq(old[old.length - k + i], cur[i])) same++;
      if (same >= k - (k >= 5 ? 1 : 0)) return k;
    }
    return 0;
  }

  function endsSentence(s) {
    if (!s) return true;
    var c = s.charAt(s.length - 1);
    return c === '.' || c === '!' || c === '?' || c === '…' || c === '。' || c === '！' || c === '？' ||
      (c === '"' && s.length > 1 && '.!?'.indexOf(s.charAt(s.length - 2)) >= 0);
  }

  class Assembler {
    constructor() {
      this.candidate = '';
      this.lastRaw = '';
      this.pending = '';
      this.pendingTime = 0;
    }

    reset() {
      this.lastRaw = '';
      this.pending = '';
      this.candidate = '';
    }

    /**
     * Yeni okunan metni işler.
     * @param {string} raw okunan metin
     * @param {number} now ms (monoton saat)
     * @param {number} confidence 0..100 (verilmezse yüksek güven sayılır)
     * @returns {{sentence:string, continuation:boolean}|null} çevrilecek bir şey yoksa null
     */
    onText(raw, now, confidence) {
      var norm = normalize(raw);
      if (norm === '') {
        this.lastRaw = '';
        this.candidate = '';
        return null;
      }
      var conf = typeof confidence === 'number' && isFinite(confidence) ? confidence : 100;
      now = typeof now === 'number' && isFinite(now) ? now : Date.now();
      // Güveni düşük okumalar, art arda iki okumada tutarlıysa kabul edilir (rastgele gürültü
      // iki kez aynı çıkmaz). Yüksek güvenli okumalar hemen kabul edilir.
      if (conf < HIGH_CONF && !(this.candidate.length > 0 && similarity(norm, this.candidate) >= 0.8)) {
        this.candidate = norm;
        return null;
      }
      this.candidate = '';
      if (this.lastRaw !== '' && similarity(norm, this.lastRaw) >= 0.8) return null;

      var nw = words(norm);
      var skip = this.lastRaw === '' ? 0 : overlap(words(this.lastRaw), nw);
      this.lastRaw = norm;
      if (skip >= nw.length) return null;
      var newPart = join(nw, skip);

      var continuing = this.pending !== '' && !endsSentence(this.pending) &&
        now - this.pendingTime < JOIN_WINDOW_MS;
      var sentence = continuing ? this.pending + ' ' + newPart : newPart;
      if (sentence.length > MAX_SENTENCE) {
        sentence = newPart;
        continuing = false;
      }
      this.pending = sentence;
      this.pendingTime = now;
      return { sentence: sentence, continuation: continuing };
    }
  }

  Assembler.similarity = similarity;
  Assembler.normalize = normalize;
  Assembler.overlap = overlap;
  Assembler.endsSentence = endsSentence;
  Assembler.words = words;
  Assembler.wordEq = wordEq;
  Assembler.levenshtein = levenshtein;
  Assembler.JOIN_WINDOW_MS = JOIN_WINDOW_MS;
  Assembler.MAX_SENTENCE = MAX_SENTENCE;
  Assembler.HIGH_CONF = HIGH_CONF;

  AS.Assembler = Assembler;
})(typeof window !== 'undefined' ? window : globalThis);

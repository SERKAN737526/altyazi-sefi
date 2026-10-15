/* Altyazı Şefi Web: SRT / WebVTT okuyucu ve SRT yazıcı → AS.srt
 * Klasik betik (IIFE). Node testlerinde `global.window = global` ile yüklenebilir.
 * Girdi güvenilmez kabul edilir: etiketler atılır, yalnızca düz metin döner (gösterim textContent ile yapılmalı). */
(function (root) {
  'use strict';
  var AS = root.AS = root.AS || {};

  var MAX_CUES = 20000;
  var MAX_LINE = 2000;          // tek satır için üst sınır (bozuk/ikili dosyaya karşı)
  var MAX_CUE_TEXT = 4000;      // tek altyazı metni için üst sınır

  // Zaman damgası: SRT "HH:MM:SS,mmm", VTT "[HH:]MM:SS.mmm"; ayırıcı . veya , ; saat isteğe bağlı.
  var TS = '((?:\\d{1,3}:)?\\d{1,2}:\\d{1,2}(?:[.,:]\\d{1,4})?)';
  var TIMING = new RegExp('^\\s*' + TS + '\\s*-{1,2}>\\s*' + TS + '(?:\\s.*)?$');

  /** "01:02:03,456" | "02:03.4" | "1:02:03" → ms; geçersizse NaN. */
  function parseTs(s) {
    var m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,:](\d{1,4}))?$/.exec(s);
    if (!m) return NaN;
    var h = m[1] ? parseInt(m[1], 10) : 0;
    var min = parseInt(m[2], 10);
    var sec = parseInt(m[3], 10);
    if (min > 59 || sec > 59) return NaN;
    var frac = 0;
    if (m[4]) frac = parseInt((m[4] + '00').slice(0, 3), 10); // ondalık kesir: ",5" = 500 ms
    return ((h * 60 + min) * 60 + sec) * 1000 + frac;
  }

  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '', shy: '' };

  function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/g, function (all, body) {
      if (body.charAt(0) === '#') {
        var cp = body.charAt(1) === 'x' || body.charAt(1) === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (!(cp > 0 && cp <= 0x10FFFF) || (cp >= 0xD800 && cp <= 0xDFFF)) return '';
        if (cp < 32 && cp !== 10) return ' ';
        try { return String.fromCodePoint(cp); } catch (e) { return ''; }
      }
      var v = ENT[body.toLowerCase()];
      return v === undefined ? all : v;
    });
  }

  /** Tek metin satırını temizler: HTML/VTT etiketleri, ASS {\an8} komutları, görünmez karakterler. */
  function cleanLine(line) {
    var s = line;
    if (s.length > MAX_LINE) s = s.slice(0, MAX_LINE);
    s = s.replace(/\{\\[^}]*\}/g, '');          // {\an8}, {\i1} ...
    s = s.replace(/<[^>\n]*>/g, '');            // <i>, </i>, <font ...>, <c.x>, <v Ad>, <00:00:01.000>
    s = s.replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ');
    s = decodeEntities(s);
    s = s.replace(/[​-‏﻿\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    return s;
  }

  function finishText(lines) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var parts = cleanLine(lines[i]).split('\n');
      for (var k = 0; k < parts.length; k++) {
        var p = parts[k].replace(/[ \t 　]+/g, ' ').trim();
        if (p) out.push(p);
      }
    }
    var text = out.join('\n');
    if (text.length > MAX_CUE_TEXT) text = text.slice(0, MAX_CUE_TEXT);
    return text;
  }

  /**
   * SRT ya da WebVTT metnini çözümler (biçim kendiliğinden anlaşılır).
   * @returns {{start:number,end:number,text:string}[]} başlangıca göre sıralı
   */
  function parse(input) {
    if (typeof input !== 'string' || !input) return [];
    var text = input;
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    text = text.replace(/\r\n?/g, '\n');
    var lines = text.split('\n');
    var cues = [];
    var cur = null;       // açık altyazı: {start, end, lines: []}

    function close() {
      if (!cur) return;
      var t = finishText(cur.lines);
      if (t) cues.push({ start: cur.start, end: cur.end, text: t });
      cur = null;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var m = line.indexOf('>') >= 0 ? TIMING.exec(line) : null;
      if (m) {
        var start = parseTs(m[1]);
        var end = parseTs(m[2]);
        if (cur) {
          // Boş satır olmadan yeni zaman satırı geldi: önceki metnin son satırı büyük olasılıkla sıra numarasıdır.
          if (cur.lines.length && /^\s*\d+\s*$/.test(cur.lines[cur.lines.length - 1])) cur.lines.pop();
          close();
        }
        if (cues.length >= MAX_CUES) break;
        if (!isFinite(start) || !isFinite(end)) { cur = null; continue; } // bozuk blok: atla
        if (end <= start) end = start + 1500;                           // bozuk süre: makul bir süre ver
        cur = { start: start, end: end, lines: [] };
        continue;
      }
      if (!cur) continue;               // sıra numarası, VTT başlığı, NOTE/STYLE blokları, çöp
      if (/^\s*$/.test(line)) { close(); continue; }
      if (cur.lines.length < 50) cur.lines.push(line);
    }
    close();
    if (cues.length > MAX_CUES) cues.length = MAX_CUES;
    cues.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    return cues;
  }

  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  /** ms → "HH:MM:SS,mmm" */
  function time(ms) {
    ms = Math.round(Number(ms));
    if (!isFinite(ms) || ms < 0) ms = 0;
    var h = Math.floor(ms / 3600000);
    var m = Math.floor(ms / 60000) % 60;
    var s = Math.floor(ms / 1000) % 60;
    var f = ms % 1000;
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + ',' + pad(f, 3);
  }

  /** Altyazıları SubRip metnine çevirir (\n satır sonu, 1'den başlayan sıra, aralarda boş satır). */
  function build(cues) {
    var out = [];
    var idx = 0;
    if (!cues || !cues.length) return '';
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      if (!c) continue;
      var t = String(c.text == null ? '' : c.text).replace(/\r/g, '');
      // Düz metin dışa aktarılır: girişte atılan etiketler, varlık çözümü (&lt;b&gt;) ya da çeviri yoluyla geri gelmesin.
      // HTML işleyen oynatıcılarda (innerHTML) betik çalıştırılamasın diye etiket benzeri her "<" etkisizleştirilir.
      t = t.replace(/<\/?[A-Za-z!?][^<>]*>/g, '').replace(/<(?=[A-Za-z\/!?])/g, '‹');
      // Altyazı içinde boş satır SRT'yi bozar: boş satırları at.
      t = t.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).join('\n');
      if (!t) continue;
      var st = Math.max(0, Math.round(Number(c.start) || 0));
      var en = Math.round(Number(c.end) || 0);
      if (!(en > st)) en = st + 300;
      idx++;
      out.push(idx + '\n' + time(st) + ' --> ' + time(en) + '\n' + t);
    }
    return out.length ? out.join('\n\n') + '\n' : '';
  }

  /** ms anında etkin altyazının indeksi (start ≤ ms < end), yoksa -1. İkili arama. */
  function indexAt(cues, ms) {
    if (!cues || !cues.length || !isFinite(ms)) return -1;
    var lo = 0, hi = cues.length - 1, best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >>> 1;
      if (cues[mid].start <= ms) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < 0) return -1;
    if (ms < cues[best].end) return best;
    // Üst üste binen altyazılar: daha önce başlamış uzun bir altyazı hâlâ ekranda olabilir.
    for (var k = best - 1, n = 0; k >= 0 && n < 16; k--, n++) {
      if (cues[k].start <= ms && ms < cues[k].end) return k;
    }
    return -1;
  }

  AS.srt = { parse: parse, build: build, time: time, indexAt: indexAt, parseTime: parseTs, MAX_CUES: MAX_CUES };
})(typeof window !== 'undefined' ? window : globalThis);

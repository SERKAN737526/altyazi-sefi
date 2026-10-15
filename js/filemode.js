/* Altyazı Şefi Web: "Video dosyası" bölümü → AS.modes.file, ortak altyazı araçları → AS.subkit
 *
 * AS.modes.file: bilgisayardaki videoyu (veya ses dosyasını) .as-stage içinde oynatır, Türkçe altyazıyı üstüne çizer.
 *   - Altyazı dosyası (.srt/.vtt, en fazla 5 MB) varsa: AS.translate.PreTranslator oynatma noktasından çevirir,
 *     timeupdate + requestAnimationFrame ile eşler; "Senkron kaydır" (−10…+10 sn); "Türkçe SRT indir".
 *     Çevirisi henüz gelmemiş satır GÖSTERİLMEZ (tutarlı kural: ekranda yalnızca Türkçe metin olur).
 *   - Yoksa "Konuşmadan altyazı oluştur": AS.asr (Whisper) + AS.audio.decodeFile; ses ≤28 sn'lik pencerelere
 *     (sessiz noktalardan) bölünür, oynatma noktasının penceresinden başlanır, sonra ileri, sonra geriye doğru;
 *     atlamada yeniden sıralanır. Satırlar çevrilir (oynatma noktasına yakın olan önce), eşlenir, Türkçe ve
 *     orijinal SRT indirilebilir. Ses bir kerede çözülemezse (çok büyük/biçim) video.captureStream() ile
 *     oynatırken canlı dinlenir; satırlar video zamanıyla kaydedilir.
 * AS.subkit (js/youtube.js de kullanır): simgeler, ⓘ'li seçenek satırı, altyazı dosyası okuma (kodlama tahmini),
 *   CueView (zamanlı satır gösterici), SrtTrack (dosya altyazısı + ön çeviri), CueTranslator (dinamik satır çevirisi),
 *   LiveSpeech (tap → Segmenter → transcribe), indirme ve dosya adı yardımcıları.
 * Güvenlik: DOM yalnızca AS.util.el / textContent ile; dosya adları, altyazı, tanınan ve çevrilen metinler güvenilmez. */
(function (root) {
  'use strict';
  var AS = root.AS = root.AS || {};
  var U = AS.util;
  var el = U.el;
  var doc = root.document;
  var RATE = 16000;

  /* ================================================================== */
  /* AS.subkit: ortak araçlar                                            */
  /* ================================================================== */
  var SVGNS = 'http://www.w3.org/2000/svg';
  var ICONS = {
    info: [['circle', { cx: 12, cy: 12, r: 9.5 }], ['path', { d: 'M12 11v5.5' }], ['path', { d: 'M12 7.7h.01', 'stroke-width': 2.8 }]],
    film: [['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2.5 }], ['path', { d: 'M7.5 3v18M16.5 3v18M3 7.5h4.5M3 12h18M3 16.5h4.5M16.5 7.5H21M16.5 16.5H21' }]],
    video: [['rect', { x: 2.5, y: 5, width: 14, height: 14, rx: 2.5 }], ['path', { d: 'M16.5 10l5-3v10l-5-3' }]],
    subtitle: [['rect', { x: 2.5, y: 4.5, width: 19, height: 15, rx: 2.5 }], ['path', { d: 'M6.5 12.5h4M12.5 12.5h5M6.5 15.5h11' }]],
    mic: [['rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }], ['path', { d: 'M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21' }]],
    fullscreen: [['path', { d: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' }]],
    exitFullscreen: [['path', { d: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' }]],
    download: [['path', { d: 'M12 3.5v11M7 10l5 5 5-5M5 20h14' }]],
    upload: [['path', { d: 'M12 15.5v-11M7 9l5-5 5 5M5 20h14' }]],
    play: [['path', { d: 'M7.5 4.8v14.4L19 12z' }]],
    pause: [['path', { d: 'M8.5 5v14M15.5 5v14' }]],
    stop: [['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }]],
    close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
    reset: [['path', { d: 'M4 12a8 8 0 1 0 2.34-5.66' }], ['path', { d: 'M4 4v5h5' }]],
    sync: [['path', { d: 'M3.5 12h17M7.5 8l-4 4 4 4M16.5 8l4 4-4 4' }]],
    external: [['path', { d: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' }]],
    live: [['rect', { x: 2, y: 3.5, width: 20, height: 13.5, rx: 2.5 }], ['path', { d: 'M8 21h8M12 17v4' }], ['path', { d: 'M7 13h10M9.5 10h5' }]],
    youtube: [['rect', { x: 2, y: 5, width: 20, height: 14, rx: 4 }], ['path', { d: 'M10 9.3v5.4l4.6-2.7z', fill: 'currentColor' }]],
    globe: [['circle', { cx: 12, cy: 12, r: 9.5 }], ['path', { d: 'M2.5 12h19M12 2.5c2.6 2.8 3.8 6 3.8 9.5s-1.2 6.7-3.8 9.5c-2.6-2.8-3.8-6-3.8-9.5s1.2-6.7 3.8-9.5z' }]],
    shield: [['path', { d: 'M12 3l8 3v5.5c0 4.6-3.3 8.4-8 9.5-4.7-1.1-8-4.9-8-9.5V6z' }], ['path', { d: 'M8.8 12.2l2.2 2.2 4.3-4.4' }]],
    warn: [['path', { d: 'M10.3 4.2L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z' }], ['path', { d: 'M12 9.5v4.2' }], ['path', { d: 'M12 17.3h.01', 'stroke-width': 2.8 }]],
    ok: [['circle', { cx: 12, cy: 12, r: 9.5 }], ['path', { d: 'M8 12.3l2.7 2.7L16.2 9.5' }]],
    error: [['circle', { cx: 12, cy: 12, r: 9.5 }], ['path', { d: 'M12 7.5v5.5' }], ['path', { d: 'M12 16.4h.01', 'stroke-width': 2.8 }]],
    bulb: [['path', { d: 'M9 18h6M10 21h4' }], ['path', { d: 'M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z' }]]
  };

  function icon(name, cls, size) {
    var spec = ICONS[name] || ICONS.info;
    var s = doc.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    if (size) { s.setAttribute('width', String(size)); s.setAttribute('height', String(size)); s.style.flex = 'none'; }
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    if (cls) s.setAttribute('class', cls);
    for (var i = 0; i < spec.length; i++) {
      var c = doc.createElementNS(SVGNS, spec[i][0]);
      var a = spec[i][1];
      for (var k in a) if (Object.prototype.hasOwnProperty.call(a, k)) c.setAttribute(k, String(a[k]));
      s.appendChild(c);
    }
    return s;
  }

  function status(mode, text, level) {
    AS.bus.emit('status', { mode: mode, text: text, level: level || 'info' });
  }
  function errText(e) {
    var m = (e && (e.message || e.name)) || String(e || '');
    m = String(m).replace(/\s+/g, ' ').trim();
    if (m.length > 240) m = m.slice(0, 237) + '…';
    return m || 'Bilinmeyen hata';
  }
  function isAbort(e) { return !!e && e.name === 'AbortError'; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** sn → "3:05" ya da "1:02:03" */
  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return h ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
  }
  /** sn → "+1,5 sn" */
  function fmtOffset(sec) {
    var v = Math.round(Number(sec) * 10) / 10;
    if (!isFinite(v) || Math.abs(v) < 0.05) return '0,0 sn';
    var t = Math.abs(v).toLocaleString('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return (v > 0 ? '+' : '−') + t + ' sn';
  }
  function langName(code) {
    var L = U.LANGS || [];
    for (var i = 0; i < L.length; i++) if (L[i][0] === code) return L[i][1];
    return code ? String(code).toUpperCase() : '';
  }

  /* ---------- ⓘ açıklamalı seçenek satırı (app.js ayar satırıyla aynı yapı ve sınıflar) ---------- */
  var optSeq = 0;
  function uid(prefix) { return (prefix || 'as-x') + '-' + (++optSeq); }

  /** {label, info, control(Node|Node[]), labelFor?, kind?:'select'|'range'|'switch'|'seg', below?} → .as-set */
  function optionRow(o) {
    var id = uid('as-opt');
    var infoId = id + '-info';
    var box = el('div', { class: 'as-set__info', id: infoId, hidden: true }, o.info);
    var btn = el('button', {
      class: 'as-info-btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': infoId,
      title: 'Bu seçenek ne işe yarar?', 'aria-label': o.label + ': açıklamayı göster',
      on: { click: function () { var open = box.hidden; box.hidden = !open; btn.setAttribute('aria-expanded', open ? 'true' : 'false'); } }
    }, icon('info'));
    // Dar yan kartta etiket iki satıra bölünmesin; denetim daralır.
    var labelEl = o.labelFor ? el('label', { for: o.labelFor, style: { whiteSpace: 'nowrap' } }, o.label) : el('span', { style: { whiteSpace: 'nowrap' } }, o.label);
    return el('div', { class: 'as-set', 'data-opt': o.key || null },
      el('div', { class: 'as-set__row' },
        el('div', { class: 'as-set__label' }, labelEl, btn),
        o.control ? el('div', { class: 'as-set__ctrl as-set__ctrl--' + (o.kind || 'select') }, o.control) : null),
      o.below || null,
      box);
  }

  /** Dil seçimi (U.LANGS); value 'auto' dahil. */
  function langSelect(value, onChange, aria) {
    var id = uid('as-lang');
    var sel = el('select', { class: 'as-select', id: id, 'aria-label': aria || null, on: { change: function () { onChange(String(sel.value)); } } },
      (U.LANGS || [['auto', 'Otomatik algıla']]).map(function (o) { return el('option', { value: o[0] }, o[1]); }));
    sel.value = value || 'auto';
    if (sel.value !== (value || 'auto')) sel.value = 'auto';
    return { node: sel, id: id, set: function (v) { sel.value = v; } };
  }

  /** "Konuşma dili" satırı: AS.settings 'asrLang' ile çift yönlü bağlı. */
  function asrLangRow(info) {
    var ls = langSelect(AS.settings.get('asrLang'), function (v) {
      try { AS.settings.set('asrLang', v); } catch (e) { /* geçersiz */ }
    });
    var fn = function (ev) { if (ev && ev.key === 'asrLang') ls.set(ev.value); };
    AS.bus.on('settings', fn);
    var row = optionRow({ key: 'asrLang', label: 'Konuşma dili', labelFor: ls.id, control: ls.node, info: info ||
      'Videoda konuşulan dil. Biliyorsanız seçin: otomatik algılamadan daha doğru ve hızlıdır. Bu ayar Ayarlar bölümündeki "Konuşma dili" ile aynıdır.' });
    return { node: row, dispose: function () { AS.bus.off('settings', fn); } };
  }

  /** Görünmez <input type=file> taşıyan düğme (.as-file). */
  function fileButton(o) {
    var input = el('input', { type: 'file', accept: o.accept || null, multiple: !!o.multiple, 'data-role': o.role || null, 'aria-label': o.label });
    var btn = el('label', { class: 'as-btn as-file' + (o.cls ? ' ' + o.cls : ''), title: o.title || null },
      o.iconName ? icon(o.iconName) : null, el('span', null, o.label), input);
    input.addEventListener('change', function () {
      var files = Array.prototype.slice.call(input.files || []);
      input.value = '';
      if (files.length) o.onFiles(files);
    });
    input.addEventListener('focus', function () { btn.classList.add('is-active'); });
    input.addEventListener('blur', function () { btn.classList.remove('is-active'); });
    btn.input = input;
    return btn;
  }

  function button(label, opts) {
    opts = opts || {};
    return el('button', {
      class: 'as-btn' + (opts.cls ? ' ' + opts.cls : ''), type: 'button', title: opts.title || null,
      'data-role': opts.role || null, 'aria-label': opts.aria || null, disabled: !!opts.disabled,
      on: { click: opts.onClick }
    }, opts.iconName ? icon(opts.iconName) : null, el('span', null, label));
  }
  function setBtnLabel(btn, text) {
    var spans = btn.getElementsByTagName('span');
    if (spans.length) spans[spans.length - 1].textContent = text;
  }

  function note(level, text, extra) {
    return el('div', { class: 'as-note as-note--' + level, role: level === 'error' ? 'alert' : null },
      icon(level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'ok' ? 'ok' : 'info', null, 18),
      el('div', { class: 'as-grow' }, text, extra || null));
  }

  function card(iconName, title, sub) {
    var subEl = el('div', { class: 'as-card__sub' }, sub || '');
    var titleEl = el('h3', { class: 'as-card__title' }, title);
    var body = el('div', { class: 'as-col' });
    var node = el('section', { class: 'as-card' },
      el('div', { class: 'as-card__head' },
        el('div', { class: 'as-card__icon' }, icon(iconName)),
        el('div', { class: 'as-grow' }, titleEl, subEl)),
      body);
    if (!sub) subEl.hidden = true;
    return {
      node: node, body: body,
      setTitle: function (t) { titleEl.textContent = t; },
      setSub: function (t) { subEl.textContent = t || ''; subEl.hidden = !t; },
      setIcon: function (n) { var ic = node.querySelector('.as-card__icon'); U.clear(ic); ic.appendChild(icon(n)); }
    };
  }

  /** İlerleme çubuğu + etiket. set(frac|-1, label) */
  function progressRow(label) {
    var bar = el('div', { class: 'as-progress__bar' });
    var prog = el('div', { class: 'as-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar);
    var lab = el('div', { class: 'as-hint', 'aria-live': 'polite' }, label || '');
    var node = el('div', { class: 'as-col' }, lab, prog);
    node.style.gap = '6px';
    return {
      node: node, label: lab,
      set: function (frac, text) {
        if (text !== undefined) lab.textContent = text;
        if (frac < 0 || !isFinite(frac)) {
          prog.classList.add('is-indeterminate'); bar.style.width = ''; prog.removeAttribute('aria-valuenow');
        } else {
          prog.classList.remove('is-indeterminate');
          var pc = U.clamp(frac, 0, 1) * 100;
          bar.style.width = pc.toFixed(1) + '%';
          prog.setAttribute('aria-valuenow', String(Math.round(pc)));
        }
        if (text) prog.setAttribute('aria-valuetext', text);
      }
    };
  }

  /** "Senkron kaydır" denetimi: −10…+10 sn, 0,1 sn adım. onChange(ms) */
  function offsetControl(initialMs, onChange) {
    var id = uid('as-offset');
    var cur = 0;
    var badge = el('span', { class: 'as-badge', 'data-role': 'offset-value', 'aria-hidden': 'true' });
    var range = el('input', { class: 'as-range', type: 'range', id: id, min: '-10', max: '10', step: '0.1', value: '0', 'data-role': 'offset',
      on: { input: function () { set(Number(range.value), true); } } });
    function set(v, fromRange) {
      v = Math.round(U.clamp(Number(v) || 0, -10, 10) * 10) / 10;
      cur = v;
      if (!fromRange) range.value = String(v);
      badge.textContent = fmtOffset(v);
      range.setAttribute('aria-valuetext', fmtOffset(v));
      onChange(Math.round(v * 1000));
    }
    var minus = el('button', { class: 'as-btn as-btn--sm', type: 'button', title: 'Altyazıyı 0,1 sn erken göster', 'aria-label': 'Altyazıyı 0,1 saniye erken göster', 'data-role': 'offset-minus',
      on: { click: function () { set(cur - 0.1); } } }, '−0,1');
    var plus = el('button', { class: 'as-btn as-btn--sm', type: 'button', title: 'Altyazıyı 0,1 sn geç göster', 'aria-label': 'Altyazıyı 0,1 saniye geç göster', 'data-role': 'offset-plus',
      on: { click: function () { set(cur + 0.1); } } }, '+0,1');
    var reset = el('button', { class: 'as-btn as-btn--sm as-btn--ghost', type: 'button', title: 'Kaydırmayı sıfırla', 'data-role': 'offset-reset',
      on: { click: function () { set(0); } } }, 'Sıfırla');
    var below = el('div', { class: 'as-row' }, minus, el('div', { class: 'as-grow' }, range), plus, reset);
    below.style.flexWrap = 'nowrap';
    below.style.marginTop = '8px';
    var row = optionRow({ key: 'offset', label: 'Senkron kaydır', labelFor: id, kind: 'seg', control: badge, below: below,
      info: 'Altyazı konuşmadan önce çıkıyorsa değeri artırın (+), konuşmadan sonra çıkıyorsa azaltın (−). En fazla 10 saniye, 0,1 saniyelik adımlarla kaydırılır; indirilen Türkçe SRT dosyasına da uygulanır.' });
    cur = Math.round((Number(initialMs) || 0) / 100) / 10;
    range.value = String(cur);
    badge.textContent = fmtOffset(cur);
    range.setAttribute('aria-valuetext', fmtOffset(cur));
    return { node: row, set: set, get: function () { return Math.round(cur * 1000); } };
  }

  /* ---------- dosyalar ---------- */
  var SUB_MAX = 5 * 1024 * 1024;
  var SUB_EXT = /\.(srt|vtt)$/i;
  var MEDIA_EXT = /\.(mp4|m4v|webm|mkv|mov|avi|ogv|ogg|oga|mpg|mpeg|ts|m2ts|mts|3gp|wmv|flv|mp3|m4a|aac|wav|flac|opus|wma)$/i;

  function isSubtitleFile(f) {
    return !!f && (SUB_EXT.test(f.name || '') || /^(text\/vtt|application\/x-subrip|text\/srt|application\/srt)$/i.test(f.type || ''));
  }
  function isMediaFile(f) {
    return !!f && !isSubtitleFile(f) && (/^(video|audio)\//i.test(f.type || '') || MEDIA_EXT.test(f.name || ''));
  }
  function isAudioOnly(f) {
    return !!f && (/^audio\//i.test(f.type || '') || /\.(mp3|m4a|aac|wav|flac|opus|oga|wma)$/i.test(f.name || ''));
  }

  /** Bayt dizisinden metin: UTF-8 (BOM'lu/BOM'suz), UTF-16, yoksa Windows-1252 / Kiril (1251) tahmini. */
  function decodeText(buf) {
    var b = new Uint8Array(buf);
    function dec(enc, opts) { return new TextDecoder(enc, opts).decode(b); }
    if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return dec('utf-16le');
    if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return dec('utf-16be');
    // BOM'suz UTF-16: tek (veya çift) konumlarda çok sayıda sıfır bayt
    var n = Math.min(b.length, 4000), z0 = 0, z1 = 0;
    for (var i = 0; i < n; i++) if (b[i] === 0) { if (i & 1) z1++; else z0++; }
    if (n > 20 && z1 > n * 0.3 && z0 < n * 0.05) return dec('utf-16le');
    if (n > 20 && z0 > n * 0.3 && z1 < n * 0.05) return dec('utf-16be');
    try { return dec('utf-8', { fatal: true }); } catch (e) { /* eski kodlama */ }
    // Tek baytlık kodlama: harf baytlarının çoğu ≥0xC0 ise büyük olasılıkla Kiril (Windows-1251)
    var hi = 0, letters = 0;
    for (var k = 0; k < b.length && k < 200000; k++) {
      var c = b[k];
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letters++;
      else if (c >= 0xC0) { hi++; letters++; }
    }
    try { return dec(letters > 50 && hi > letters * 0.45 ? 'windows-1251' : 'windows-1252'); } catch (e2) { return dec('utf-8'); }
  }

  /** Altyazı dosyasını doğrular ve çözümler → Promise<Cue[]> (Türkçe hata iletileriyle). */
  function readSubtitleFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error('Altyazı dosyası seçilmedi.')); return; }
      if (!isSubtitleFile(file)) { reject(new Error('Yalnızca .srt veya .vtt altyazı dosyaları kullanılabilir.')); return; }
      if (file.size > SUB_MAX) { reject(new Error('Altyazı dosyası çok büyük (' + U.fmtBytes(file.size) + '); en fazla 5 MB olabilir.')); return; }
      if (!file.size) { reject(new Error('Altyazı dosyası boş.')); return; }
      var p = typeof file.arrayBuffer === 'function' ? file.arrayBuffer() : new Promise(function (ok, bad) {
        var fr = new root.FileReader();
        fr.onload = function () { ok(fr.result); };
        fr.onerror = function () { bad(fr.error); };
        fr.readAsArrayBuffer(file);
      });
      p.then(function (buf) {
        var text = decodeText(buf);
        var nul = (text.slice(0, 20000).match(/\u0000/g) || []).length;
        if (nul > 10) throw new Error('Bu dosya bir altyazı dosyası gibi görünmüyor.');
        var cues = AS.srt.parse(text);
        if (!cues.length) throw new Error('Dosyada okunabilir altyazı satırı bulunamadı. Dosyanın .srt veya .vtt biçiminde olduğundan emin olun.');
        resolve(cues.map(function (c) { return { start: c.start, end: c.end, text: c.text, tr: null }; }));
      }).catch(function (e) {
        reject(e && /altyazı|dosya/i.test(e.message || '') ? e : new Error('Altyazı dosyası okunamadı.'));
      });
    });
  }

  /** Dosya adından uzantısız temel ad. */
  function baseName(name) {
    var n = String(name || '').split(/[\\/]/).pop();
    return n.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  }
  /** "Film.en" / "Film.eng" / "Film.en-US" → "Film" */
  function stripLang(base) {
    return String(base || '').replace(/[._-](?:[a-z]{2,3}(?:[-_][A-Za-z]{2,4})?|forced|sdh|cc)$/i, '');
  }
  /** İndirme adı için güvenli parça (yol, denetim ve yön karakterleri yok). */
  function safeFileName(base, fallback) {
    var s = String(base || '');
    try { s = s.normalize('NFC'); } catch (e) { /* eski motor */ }
    s = s.replace(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
      .replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '');
    if (s.length > 120) s = s.slice(0, 120).trim();
    if (!s || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = fallback || 'altyazi';
    return s;
  }

  var liveUrls = [];
  /** Metni dosya olarak indirir (Blob + <a download>); UTF-8 BOM ve CRLF: TV'ler ve eski oynatıcılar Türkçe harfleri doğru gösterir. */
  function downloadText(text, filename) {
    var body = '\ufeff' + String(text || '').replace(/\r?\n/g, '\r\n');
    var blob = new Blob([body], { type: 'application/x-subrip;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename, rel: 'noopener' });
    a.hidden = true;
    (doc.body || doc.documentElement).appendChild(a);
    a.click();
    if (a.parentNode) a.parentNode.removeChild(a);
    liveUrls.push(url);
    setTimeout(function () {
      var i = liveUrls.indexOf(url);
      if (i >= 0) liveUrls.splice(i, 1);
      URL.revokeObjectURL(url);
    }, 20000);
  }
  function revokeDownloads() {
    while (liveUrls.length) { try { URL.revokeObjectURL(liveUrls.pop()); } catch (e) { /* */ } }
  }

  /** Uzun tek satırı ortadaki boşluktan iki satıra böler (SRT okunabilirliği için). */
  function wrapLine(text) {
    var t = String(text || '').trim();
    if (!t) return t;
    return t.split('\n').map(function (line) {
      if (line.length <= 42) return line;
      var mid = Math.floor(line.length / 2), best = -1;
      for (var d = 0; d < mid; d++) {
        if (line.charAt(mid + d) === ' ') { best = mid + d; break; }
        if (line.charAt(mid - d) === ' ') { best = mid - d; break; }
      }
      return best > 0 ? line.slice(0, best).trim() + '\n' + line.slice(best + 1).trim() : line;
    }).join('\n');
  }

  /** Satırları (ofset uygulanmış) SRT metnine çevirir. pick(cue) → metin (boşsa satır atlanır). */
  function buildSrt(cues, offsetMs, pick) {
    var off = Number(offsetMs) || 0;
    var list = [];
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      var t = pick(c);
      if (!t) continue;
      var s = c.start + off, e = c.end + off;
      if (e <= 0) continue;
      list.push({ start: Math.max(0, s), end: e, text: wrapLine(t) });
    }
    return AS.srt.build(list);
  }

  /* ---------- zamanlı gösterim ---------- */
  /** t anında etkin satırların indeksleri (artan, en fazla 3). cues başlangıca göre sıralı olmalı. */
  function activeAt(cues, t) {
    var n = cues.length;
    if (!n || !isFinite(t)) return [];
    var lo = 0, hi = n - 1, best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >>> 1;
      if (cues[mid].start <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    var out = [];
    for (var k = best, m = 0; k >= 0 && m < 48 && out.length < 3; k--, m++) if (cues[k].end > t) out.push(k);
    return out.reverse();
  }
  /** Ön çeviri için öncelik: t anında etkin ilk satır ya da ondan sonraki ilk satır. */
  function indexFrom(cues, t) {
    var act = activeAt(cues, t);
    if (act.length) return act[0];
    var lo = 0, hi = cues.length;
    while (lo < hi) { var mid = (lo + hi) >>> 1; if (cues[mid].start <= t) lo = mid + 1; else hi = mid; }
    return Math.min(lo, Math.max(0, cues.length - 1));
  }

  /** Zamanlı satır gösterici: yalnızca çevirisi hazır satırları AS.subs'a (bus 'subtitle', kind 'srt') verir. */
  function CueView() {
    this.cues = [];
    this.offsetMs = 0;
    this.key = '';
    this.visible = false;
    this.lastMs = NaN;
  }
  CueView.prototype.setCues = function (cues) { this.cues = cues || []; this.refresh(); };
  CueView.prototype.update = function (ms) {
    if (typeof ms === 'number' && isFinite(ms)) this.lastMs = ms;
    if (!isFinite(this.lastMs)) return;
    var t = this.lastMs - this.offsetMs;
    var act = activeAt(this.cues, t);
    var key = '', tr = [], src = [], endMs = 0;
    for (var k = 0; k < act.length; k++) {
      var c = this.cues[act[k]];
      key += act[k] + (c.tr ? '+' : '-') + ',';
      if (c.tr) { tr.push(c.tr); src.push(c.text); endMs = Math.max(endMs, c.end); }
    }
    if (key === this.key) return;
    this.key = key;
    if (tr.length) {
      this.visible = true;
      AS.bus.emit('subtitle', { tr: tr.join('\n'), src: src.join('\n'), cont: false, kind: 'srt', holdMs: 120000 });
    } else if (this.visible) {
      this.visible = false;
      if (AS.subs) AS.subs.clear();
    }
  };
  CueView.prototype.refresh = function () { this.key = null; this.update(); };
  CueView.prototype.setOffset = function (ms) { this.offsetMs = Number(ms) || 0; this.refresh(); };
  CueView.prototype.reset = function () {
    if (this.visible && AS.subs) AS.subs.clear();
    this.visible = false;
    this.key = '';
    this.lastMs = NaN;
  };

  /** Altyazı dosyası izleği: PreTranslator + CueView. */
  function SrtTrack(o) {
    this.cues = o.cues;
    this.view = o.view;
    this.from = o.from || 'auto';
    this.onProgress = o.onProgress || null;
    this.pre = null;
    this.gen = 0;
    this.done = 0;
    this.startedAt = 0;
  }
  SrtTrack.prototype.start = function (atMs) {
    var self = this;
    var gen = ++this.gen;
    if (this.pre) this.pre.stop();
    for (var i = 0; i < this.cues.length; i++) this.cues[i].tr = null;
    this.done = 0;
    this.startedAt = Date.now();
    this.view.setCues(this.cues);
    this.pre = new AS.translate.PreTranslator(this.cues, {
      from: this.from,
      onCue: function (idx, tr) {
        if (gen !== self.gen) return;
        var c = self.cues[idx];
        if (!c) return;
        c.tr = tr ? String(tr) : null;
        self.view.refresh();
      },
      onProgress: function (d, t) {
        if (gen !== self.gen) return;
        self.done = d;
        if (self.onProgress) self.onProgress(d, t);
      }
    });
    var t = (Number(atMs) || 0) - this.view.offsetMs;
    this.pre.start(indexFrom(this.cues, t));
    if (this.onProgress) this.onProgress(0, this.cues.length);
  };
  SrtTrack.prototype.seek = function (atMs) {
    if (this.pre) this.pre.seek(indexFrom(this.cues, (Number(atMs) || 0) - this.view.offsetMs));
  };
  SrtTrack.prototype.setFrom = function (lang, atMs) {
    if (lang === this.from) return;
    this.from = lang || 'auto';
    this.start(atMs);
  };
  SrtTrack.prototype.stop = function () {
    this.gen++;
    if (this.pre) { this.pre.stop(); this.pre = null; }
  };
  SrtTrack.prototype.exportTr = function () {
    return buildSrt(this.cues, this.view.offsetMs, function (c) { return c.tr || c.text; });
  };

  /** Zamanla büyüyen satır listesi için çeviri kuyruğu (oynatma noktasına yakın olan önce). */
  function CueTranslator(o) {
    this.getFocusMs = o.getFocusMs;
    this.onDone = o.onDone;
    this.onFail = o.onFail || null;
    this.queue = [];
    this.failed = [];
    this.running = 0;
    this.max = 2;
    this.stopped = false;
    this.ctrls = [];
    this.timers = [];
    var self = this;
    this.onSettings = function (ev) {
      if (ev && ev.key === 'translateOnline' && ev.value === true && self.failed.length) {
        var f = self.failed; self.failed = [];
        f.forEach(function (c) { c.trTries = 0; self.add(c); });
      }
    };
    AS.bus.on('settings', this.onSettings);
  }
  CueTranslator.prototype.add = function (cue) {
    if (this.stopped || !cue) return;
    this.queue.push(cue);
    this.kick();
  };
  CueTranslator.prototype._pick = function () {
    var focus = Number(this.getFocusMs()) || 0;
    var bi = -1, bk = Infinity;
    for (var i = 0; i < this.queue.length; i++) {
      var c = this.queue[i];
      var k = c.end >= focus ? Math.max(0, c.start - focus) : 1e12 + (focus - c.end);
      if (c.urgent) k = -1;
      if (k < bk) { bk = k; bi = i; }
    }
    return bi < 0 ? null : this.queue.splice(bi, 1)[0];
  };
  CueTranslator.prototype.kick = function () {
    while (!this.stopped && this.running < this.max && this.queue.length) this._run(this._pick());
  };
  CueTranslator.prototype._run = function (cue) {
    var self = this;
    this.running++;
    var ctrl = new AbortController();
    this.ctrls.push(ctrl);
    var focus = Number(this.getFocusMs()) || 0;
    var near = cue.urgent || (cue.end >= focus - 2000 && cue.start <= focus + 30000);
    AS.translate.text(cue.text, { from: cue.lang || 'auto', signal: ctrl.signal, priority: near ? 'high' : undefined }).then(function (tr) {
      if (self.stopped) return;
      cue.tr = tr ? String(tr) : null;
      cue.urgent = false;
      if (cue.tr) self.onDone(cue);
    }, function (e) {
      if (self.stopped || isAbort(e)) return;
      var code = e && e.code;
      cue.trTries = (cue.trTries || 0) + 1;
      if (code === 'disabled' || (code !== 'offline' && code !== 'busy' && cue.trTries >= 4)) {
        self.failed.push(cue);
        if (self.onFail) self.onFail(e, cue);
        return;
      }
      var wait = code === 'offline' ? 5000 : code === 'busy' ? Math.max(1500, (e && e.retryAfterMs) || 0) : 1200 * cue.trTries;
      var tm = setTimeout(function () {
        var i = self.timers.indexOf(tm); if (i >= 0) self.timers.splice(i, 1);
        self.add(cue);
      }, wait);
      self.timers.push(tm);
    }).then(function () {
      var i = self.ctrls.indexOf(ctrl); if (i >= 0) self.ctrls.splice(i, 1);
      self.running--;
      self.kick();
    });
  };
  CueTranslator.prototype.stop = function () {
    this.stopped = true;
    this.queue = [];
    this.ctrls.forEach(function (c) { try { c.abort(); } catch (e) { /* */ } });
    this.ctrls = [];
    this.timers.forEach(clearTimeout);
    this.timers = [];
    AS.bus.off('settings', this.onSettings);
  };

  /** Canlı konuşma hattı: MediaStream → AS.audio.tap → Segmenter → AS.asr.transcribe.
   *  o: {stream, mode, language(), onText(res, info), onChunk?(pcm, streamMs), onError?(e), onEnded?(), onDrop?(n), maxBacklog?} */
  function LiveSpeech(o) {
    this.o = o;
    this.tap = null;
    this.seg = null;
    this.stopped = false;
    this.pending = [];
    this.streamMs = 0;
    this.dropped = 0;
    this.track = null;
    this._ended = null;
  }
  LiveSpeech.prototype.start = function () {
    var self = this, o = this.o;
    this.seg = new AS.audio.Segmenter({ onSegment: function (pcm, info) { self._segment(pcm, info); } });
    return AS.audio.tap(o.stream, function (chunk) {
      if (self.stopped) return;
      self.streamMs += chunk.length * 1000 / RATE;
      if (o.onChunk) { try { o.onChunk(chunk, self.streamMs); } catch (e) { /* */ } }
      self.seg.push(chunk);
    }, { mode: o.mode }).then(function (tap) {
      if (self.stopped) { tap.stop(); return; }
      self.tap = tap;
      var tracks = o.stream.getAudioTracks();
      self.track = tracks[0] || null;
      if (self.track) {
        self._ended = function () {
          if (self.stopped) return;
          try { self.seg.flush(); } catch (e) { /* */ }
          self.stop(true);   // son cümlenin tanınması sürsün
          if (o.onEnded) o.onEnded();
        };
        self.track.addEventListener('ended', self._ended);
      }
    });
  };
  LiveSpeech.prototype._segment = function (pcm, info) {
    if (this.stopped) return;
    var self = this, o = this.o;
    var item = { ctrl: new AbortController() };
    this.pending.push(item);
    var max = o.maxBacklog > 0 ? o.maxBacklog : 3;
    while (this.pending.length > max) {
      var old = this.pending.shift();
      try { old.ctrl.abort(); } catch (e) { /* */ }
      this.dropped++;
      if (o.onDrop) o.onDrop(this.dropped);
    }
    var lang = o.language ? o.language() : 'auto';
    AS.asr.transcribe(pcm, { language: lang, signal: item.ctrl.signal }).then(function (r) {
      self._done(item);
      if (self.stopped && !self.graceful) return;
      if (r && r.text) o.onText(r, info);
    }, function (e) {
      self._done(item);
      if (self.stopped || isAbort(e)) return;
      if (o.onError) o.onError(e);
    });
  };
  LiveSpeech.prototype._done = function (item) {
    var i = this.pending.indexOf(item);
    if (i >= 0) this.pending.splice(i, 1);
  };
  /** graceful: kuyruktaki bölütlerin sonucu yine iletilir (paylaşım bittiğinde son cümle kaybolmasın). */
  LiveSpeech.prototype.stop = function (graceful) {
    if (this.stopped) { if (!graceful) this._abortAll(); return; }
    this.stopped = true;
    this.graceful = !!graceful;
    if (this.tap) { try { this.tap.stop(); } catch (e) { /* */ } }
    if (this.track && this._ended) this.track.removeEventListener('ended', this._ended);
    if (!graceful) this._abortAll();
    if (this.seg) this.seg.reset();
  };
  LiveSpeech.prototype._abortAll = function () {
    this.graceful = false;
    this.pending.forEach(function (it) { try { it.ctrl.abort(); } catch (e) { /* */ } });
    this.pending = [];
  };

  /** Sahne için tam ekran düğmesi; durumu fullscreenchange ile güncellenir. */
  function fullscreenButton(stage, extraCls) {
    var btn = el('button', { class: extraCls || 'as-icon-btn', type: 'button', 'data-role': 'fullscreen',
      title: 'Tam ekran (Türkçe altyazıyla)', 'aria-label': 'Tam ekran (Türkçe altyazıyla)', 'aria-pressed': 'false',
      on: { click: function () { if (AS.subs) AS.subs.fullscreen(stage); } } }, icon('fullscreen'));
    function sync() {
      var on = !!(AS.subs && AS.subs.isFullscreen && AS.subs.isFullscreen(stage));
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      U.clear(btn);
      btn.appendChild(icon(on ? 'exitFullscreen' : 'fullscreen'));
      var t = on ? 'Tam ekrandan çık (Esc)' : 'Tam ekran (Türkçe altyazıyla)';
      btn.title = t;
      btn.setAttribute('aria-label', t);
    }
    doc.addEventListener('fullscreenchange', sync);
    doc.addEventListener('webkitfullscreenchange', sync);
    btn.dispose = function () {
      doc.removeEventListener('fullscreenchange', sync);
      doc.removeEventListener('webkitfullscreenchange', sync);
    };
    return btn;
  }

  /** Yüklü altyazı dosyası kartının gövdesi (dosya ve YouTube modu ortak).
   *  o: {name, count, from, onFrom(v), offsetMs, onOffset(ms), onDownload(), onRemove(), downloadName} */
  function srtPanel(o) {
    var prog = progressRow('Çeviri başlıyor…');
    var warn = el('div');
    var ls = langSelect(o.from || 'auto', o.onFrom);
    var langRow = optionRow({ key: 'subLang', label: 'Altyazı dili', labelFor: ls.id, control: ls.node,
      info: 'Altyazı dosyasının yazıldığı dil. "Otomatik algıla" çoğu zaman doğru çalışır; çeviri tuhaf görünürse dili elle seçin. Hedef dil her zaman Türkçedir.' });
    var off = offsetControl(o.offsetMs || 0, o.onOffset);
    var dl = button('Türkçe SRT indir', { cls: 'as-btn--primary as-btn--block', iconName: 'download', role: 'download-tr',
      title: 'Türkçe altyazıyı .srt dosyası olarak kaydeder; çevrilmemiş satırlar orijinal hâliyle kalır.', onClick: o.onDownload });
    var dlHint = el('p', { class: 'as-hint' }, 'Dosya adı: ' + o.downloadName());
    var rm = button('Altyazıyı kaldır', { cls: 'as-btn--ghost as-btn--sm', iconName: 'close', role: 'remove-sub', onClick: o.onRemove });
    var head = el('div', { class: 'as-row' },
      el('span', { class: 'as-chip', title: o.name, 'data-role': 'sub-name' }, shorten(o.name, 34)),
      el('span', { class: 'as-chip' }, o.count + ' satır'));
    var node = el('div', { class: 'as-col', 'data-role': 'srt-panel' }, head, prog.node, warn, langRow, off.node, dl, dlHint,
      el('div', { class: 'as-row' }, rm));
    return {
      node: node,
      offset: off,
      progress: function (d, t) {
        var frac = t ? d / t : 0;
        prog.set(frac, d + ' / ' + t + ' satır çevrildi' + (d >= t && t ? ' ✓' : ''));
      },
      setWarn: function (level, text, extra) {
        U.clear(warn);
        if (text) warn.appendChild(note(level, text, extra));
      },
      setDownloadName: function () { dlHint.textContent = 'Dosya adı: ' + o.downloadName(); }
    };
  }

  function shorten(s, n) {
    s = String(s || '');
    if (s.length <= n) return s;
    var head = Math.ceil((n - 1) * 0.6), tail = n - 1 - head;
    return s.slice(0, head) + '…' + s.slice(s.length - tail);
  }

  /** Çeviri yapılabilir mi? (cihaz çevirmeni API'si ya da çevrim içi izin) */
  function translationPossible() {
    return ('Translator' in root) || !!AS.settings.get('translateOnline');
  }
  function goSettingsBtn() {
    return button('Ayarlar\'a git', { cls: 'as-btn--sm', onClick: function () { if (AS.app && AS.app.select) AS.app.select('settings'); } });
  }

  AS.subkit = {
    icon: icon, optionRow: optionRow, langSelect: langSelect, asrLangRow: asrLangRow, fileButton: fileButton, button: button,
    setBtnLabel: setBtnLabel, note: note, card: card, progressRow: progressRow, offsetControl: offsetControl,
    isSubtitleFile: isSubtitleFile, isMediaFile: isMediaFile, readSubtitleFile: readSubtitleFile, decodeText: decodeText,
    baseName: baseName, stripLang: stripLang, safeFileName: safeFileName, downloadText: downloadText,
    revokeDownloads: revokeDownloads, buildSrt: buildSrt, wrapLine: wrapLine, activeAt: activeAt, indexFrom: indexFrom,
    CueView: CueView, SrtTrack: SrtTrack, CueTranslator: CueTranslator, LiveSpeech: LiveSpeech,
    fullscreenButton: fullscreenButton, srtPanel: srtPanel, shorten: shorten, fmtClock: fmtClock, fmtOffset: fmtOffset,
    errText: errText, isAbort: isAbort, status: status, langName: langName, translationPossible: translationPossible,
    goSettingsBtn: goSettingsBtn, SUB_MAX: SUB_MAX
  };

  /* ================================================================== */
  /* Konuşmadan altyazı: pencere planı ve satır üretimi (saf işlevler)    */
  /* ================================================================== */
  var DECODE_MAX_S = 3 * 3600;   // bundan uzun ses decodeFile ile çözülmez (bellek), canlı dinlemeye geçilir
  var WIN_MAX_S = 28;      // Whisper 30 sn'ye kadar alır; 28 sn güvenli
  var WIN_MIN_S = 22;      // kesim 22–28 sn arasındaki en sessiz 200 ms'ye yapılır
  var FRAME = 320;         // 20 ms enerji çerçevesi
  var SILENT_E = 1e-5;     // ≈ −50 dBFS RMS: tamamı bunun altındaki pencere atlanır

  /** pcm → [{i, a, b, state, silent}] (örnek indeksleri). Uzun dosyada arayüzü kilitlememek için parça parça. */
  async function planWindows(pcm, alive) {
    var n = pcm.length;
    var nf = Math.ceil(n / FRAME);
    var energy = new Float32Array(nf);
    for (var f = 0; f < nf; f++) {
      var a = f * FRAME, b = Math.min(n, a + FRAME), s = 0;
      for (var i = a; i < b; i++) { var v = pcm[i]; s += v * v; }
      energy[f] = s / Math.max(1, b - a);
      if ((f & 0x3fff) === 0x3fff) { await U.sleep(0); if (alive && !alive()) return null; }
    }
    var wins = [];
    var start = 0;
    while (start < n) {
      var end;
      if (n - start <= WIN_MAX_S * RATE) end = n;
      else {
        var f0 = Math.floor((start + WIN_MIN_S * RATE) / FRAME);
        var f1 = Math.floor((start + WIN_MAX_S * RATE) / FRAME) - 10;
        var run = 0, best = f1, bestE = Infinity;
        for (var g = f0; g < f0 + 10; g++) run += energy[g];
        for (g = f0; g <= f1; g++) {
          if (run < bestE) { bestE = run; best = g; }
          run += (energy[g + 10] || 0) - energy[g];
        }
        end = Math.min(n, (best + 5) * FRAME);
      }
      var peak = 0;
      for (var q = Math.floor(start / FRAME), qe = Math.ceil(end / FRAME); q < qe; q++) if (energy[q] > peak) peak = energy[q];
      wins.push({ i: wins.length, a: start, b: end, state: peak < SILENT_E ? 2 : 0, silent: peak < SILENT_E, tries: 0 });
      start = end;
    }
    return wins;
  }

  /** Oynatma noktasının penceresinden başla, ileri git, sonra geriye (yakından uzağa). */
  function pickWindow(wins, focusSample) {
    if (!wins || !wins.length) return null;
    var lo = 0, hi = wins.length - 1, w0 = 0;
    while (lo <= hi) { var mid = (lo + hi) >>> 1; if (wins[mid].a <= focusSample) { w0 = mid; lo = mid + 1; } else hi = mid - 1; }
    for (var i = w0; i < wins.length; i++) if (wins[i].state === 0) return wins[i];
    for (i = w0 - 1; i >= 0; i--) if (wins[i].state === 0) return wins[i];
    return null;
  }

  function normText(t) {
    return String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  /** Uzun metni cümle sınırlarından ≤ max karakterlik parçalara böler. */
  function splitText(text, max) {
    if (text.length <= max) return [text];
    var sents = text.match(/[^.!?…。！？]+[.!?…。！？]+["'”»)]*\s*|[^.!?…。！？]+$/g) || [text];
    var out = [], cur = '';
    sents.forEach(function (s) {
      s = s.trim();
      if (!s) return;
      if (cur && (cur + ' ' + s).length > max) { out.push(cur); cur = s; } else cur = cur ? cur + ' ' + s : s;
    });
    if (cur) out.push(cur);
    // Tek başına çok uzun cümle: ortaya en yakın virgülden (yoksa boşluktan) ikiye böl.
    var res = [];
    function halve(p, depth) {
      if (p.length <= max * 1.25 || depth > 6) { if (p) res.push(p); return; }
      var mid = p.length >> 1, cut = -1, best = Infinity;
      for (var i = 1; i < p.length - 1; i++) {
        if (p.charAt(i) !== ' ') continue;
        var w = Math.abs(i - mid) - (/[,;:]/.test(p.charAt(i - 1)) ? p.length / 6 : 0);
        if (w < best) { best = w; cut = i; }
      }
      if (cut < 0) { res.push(p); return; }
      halve(p.slice(0, cut).trim(), depth + 1);
      halve(p.slice(cut + 1).trim(), depth + 1);
    }
    out.forEach(function (p) { halve(p, 0); });
    return res;
  }

  /** Whisper parçaları (pencereye göre sn) → video zamanında satırlar (ms). Boş/sanrı/yinelenen atılır, sınırlar kıstırılır. */
  function chunksToCues(chunks, winStartMs, winEndMs, lang) {
    var dur = winEndMs - winStartMs;
    var raw = [];
    var prev = '';
    (chunks || []).forEach(function (c) {
      if (!c) return;
      var text = String(c.text || '').replace(/\s+/g, ' ').trim();
      if (!text || !/\p{L}/u.test(text)) return;
      var nt = normText(text);
      if (!nt || nt === prev) return;              // aynı cümle art arda (Whisper döngüsü)
      prev = nt;
      var s = Number(c.start) * 1000, e = Number(c.end) * 1000;
      if (!isFinite(s) || s < 0) s = 0;
      if (s > dur + 500) return;                    // pencere dışı (bozuk zaman damgası)
      s = Math.min(s, Math.max(0, dur - 300));
      if (!isFinite(e) || e <= s) e = NaN; else e = Math.min(e, dur);
      raw.push({ s: s, e: e, text: text });
    });
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var r = raw[i];
      var next = i + 1 < raw.length ? raw[i + 1].s : dur;
      var est = 900 + r.text.length * 60;
      var e = isFinite(r.e) ? r.e : Math.min(next > r.s + 300 ? next : dur, r.s + est);
      if (e - r.s > 10000) e = r.s + Math.max(7000, Math.min(10000, est));   // müzik/sessizlik payını kırp
      if (e - r.s < 700) e = Math.min(Math.max(next, r.s + 300), r.s + 700, dur);
      if (e <= r.s) e = Math.min(dur, r.s + 300);
      var parts = splitText(r.text, 84);   // ekranda en çok 2 × 42 karakter
      var total = parts.reduce(function (n, p) { return n + p.length; }, 0) || 1;
      var t0 = r.s;
      for (var k = 0; k < parts.length; k++) {
        var t1 = k === parts.length - 1 ? e : t0 + (e - r.s) * parts[k].length / total;
        out.push({ start: Math.round(winStartMs + t0), end: Math.round(winStartMs + t1), text: parts[k], lang: lang || null, tr: null });
        t0 = t1;
      }
    }
    return out;
  }

  /** Sıralı diziye ekler ve çakışmaları düzeltir. */
  function insertCues(list, add) {
    add.forEach(function (c) {
      var lo = 0, hi = list.length;
      while (lo < hi) { var mid = (lo + hi) >>> 1; if (list[mid].start <= c.start) lo = mid + 1; else hi = mid; }
      list.splice(lo, 0, c);
    });
    for (var i = 0; i + 1 < list.length; i++) {
      var a = list[i], b = list[i + 1];
      if (a.end > b.start) a.end = Math.max(a.start + 300, b.start);
    }
  }

  /* ================================================================== */
  /* AS.modes.file                                                       */
  /* ================================================================== */
  var K = AS.subkit;
  var MODE = 'file';
  var S = null;   // bağlıyken mod durumu

  function st(text, level) { status(MODE, text, level); }
  function alive(gen) { return !!S && S.gen === gen; }

  function mount(panel) {
    if (S) unmount();
    var s = S = {
      gen: 1, panel: panel, cleanups: [], file: null, url: null, videoErr: null, sub: null, track: null,
      asr: null, raf: 0, view: new CueView(), subFirst: false
    };
    buildUi(s);
    panel.appendChild(s.root);
    AS.subs.attach(s.stage);
    s.cleanups.push(function () { AS.subs.detach(s.stage); });
    renderSource();
  }

  function unmount() {
    var s = S;
    if (!s) return;
    S = null;
    stopAsr(s);
    stopTrack(s);
    stopRaf(s);
    s.view.reset();
    if (AS.subs) AS.subs.clear();
    releaseVideo(s);
    (s.cardCleanups || []).concat(s.cleanups).forEach(function (fn) { try { fn(); } catch (e) { /* */ } });
    s.cleanups = [];
    s.cardCleanups = [];
    revokeDownloads();
    if (s.root && s.root.parentNode) s.root.parentNode.removeChild(s.root);
  }

  /* ---------- arayüz ---------- */
  var MEDIA_ACCEPT = 'video/*,audio/*,.mkv,.mp4,.m4v,.webm,.mov,.avi,.ogv,.ts,.m2ts,.3gp,.wmv,.flv,.mp3,.m4a,.wav,.flac,.opus';
  var SUB_ACCEPT = '.srt,.vtt,text/vtt,application/x-subrip';

  function buildUi(s) {
    // Sahne: boşken bırakma alanı, sonra video
    s.video = el('video', { controls: true, playsinline: true, preload: 'metadata', controlslist: 'nofullscreen noremoteplayback',
      disablepictureinpicture: true, 'data-role': 'video', 'aria-label': 'Video' });
    s.video.hidden = true;
    s.empty = el('div', { class: 'as-stage__empty', 'data-role': 'drop' },
      icon('film'),
      el('div', { class: 'as-card__title' }, 'Videonuzu buraya sürükleyip bırakın'),
      el('div', { class: 'as-hint' }, 'Altyazı dosyasını (.srt / .vtt) da birlikte bırakabilirsiniz.'),
      el('div', { class: 'as-row', style: { justifyContent: 'center', marginTop: '6px' } },
        K.fileButton({ label: 'Video seç', accept: MEDIA_ACCEPT + ',' + SUB_ACCEPT, multiple: true, cls: 'as-btn--primary as-btn--lg',
          iconName: 'video', role: 'pick', onFiles: handleFiles }),
        K.fileButton({ label: 'Altyazı dosyası ekle', accept: SUB_ACCEPT, iconName: 'subtitle', role: 'pick-sub-empty', cls: 'as-btn--lg',
          onFiles: function (f) { handleFiles(f, 'sub'); } })),
      el('div', { class: 'as-hint', style: { maxWidth: '560px' } },
        'MP4 ve WebM en sorunsuz çalışır. Chrome bazı .mkv ve .avi dosyalarının görüntü ya da ses biçimini (codec) oynatamayabilir; o zaman dosyayı MP4\'e dönüştürmeyi deneyin.'));
    s.controls = el('div', { class: 'as-stage__controls' });
    s.controls.hidden = true;
    s.stage = el('div', { class: 'as-stage', 'data-role': 'stage' }, s.video, s.empty, s.controls);
    s.fsBtn = K.fullscreenButton(s.stage);
    s.controls.appendChild(s.fsBtn);
    s.cleanups.push(s.fsBtn.dispose);

    // Sahne altı araç çubuğu
    s.nameChip = el('span', { class: 'as-chip', 'data-role': 'video-name' });
    s.durChip = el('span', { class: 'as-chip' });
    s.durChip.hidden = true;
    s.fsBtn2 = K.button('Tam ekran', { iconName: 'fullscreen', cls: 'as-btn--sm', title: 'Videoyu Türkçe altyazıyla tam ekran izleyin (Esc ile çıkılır).',
      onClick: function () { AS.subs.fullscreen(s.stage); } });
    s.toolbar = el('div', { class: 'as-row' }, s.nameChip, s.durChip, el('span', { class: 'as-spacer' }), s.fsBtn2,
      K.fileButton({ label: 'Başka video', accept: MEDIA_ACCEPT + ',' + SUB_ACCEPT, multiple: true, cls: 'as-btn--sm as-btn--ghost',
        iconName: 'upload', role: 'pick-again', onFiles: handleFiles }));
    s.toolbar.hidden = true;
    s.videoNote = el('div');

    var left = el('div', { class: 'as-col' }, s.stage, s.toolbar, s.videoNote);
    left.style.gap = '12px';
    left.style.minWidth = '0';

    s.srcCard = K.card('subtitle', 'Türkçe altyazı', '');
    s.srcCard.node.setAttribute('data-role', 'source-card');
    var tips = K.card('bulb', 'İpuçları');
    tips.body.appendChild(el('ul', { class: 'as-hint', style: { margin: '0', paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '6px' } },
      el('li', null, 'Tam ekran için videonun kendi düğmesini değil, videonun altındaki "Tam ekran" düğmesini kullanın; Türkçe altyazı ancak böyle görünür.'),
      el('li', null, 'Altyazıyı ayrı, her zaman üstte duran bir pencerede görmek için üstteki "Altyazı penceresi" düğmesini kullanın.'),
      el('li', null, 'Videonuz bilgisayarınızdan çıkmaz. Çevrim içi çeviri açıksa yalnızca çevrilecek metin gönderilir.')));
    var right = el('div', { class: 'as-col' }, s.srcCard.node, tips.node);
    right.style.gap = '16px';
    right.style.minWidth = '0';

    s.root = el('div', { class: 'as-split', 'data-mode-root': 'file' }, left, right);

    // Videonun olayları
    var v = s.video;
    var on = function (ev, fn) { v.addEventListener(ev, fn); };
    on('timeupdate', function () { tick(); });
    on('seeking', function () { onSeek(); });
    on('seeked', function () { tick(); });
    on('play', function () { startRaf(); });
    on('playing', function () { startRaf(); if (S && S.asr && S.asr.phase === 'live') ensureLiveTap(S.asr); });
    on('pause', function () { tick(); });
    on('loadedmetadata', onMeta);
    on('error', onVideoError);
    on('dblclick', function (e) { e.preventDefault(); AS.subs.fullscreen(s.stage); });

    // Sürükle-bırak (tüm bölüm)
    var depth = 0;
    function hasFiles(e) {
      var t = e.dataTransfer && e.dataTransfer.types;
      return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0;
    }
    function over(onOff) {
      if (onOff) { s.stage.style.outline = '2px dashed var(--accent)'; s.stage.style.outlineOffset = '-10px'; }
      else { s.stage.style.outline = ''; s.stage.style.outlineOffset = ''; }
    }
    s.root.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; e.preventDefault(); depth++; over(true); });
    s.root.addEventListener('dragover', function (e) { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    s.root.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) over(false); });
    s.root.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0; over(false);
      handleFiles(Array.prototype.slice.call(e.dataTransfer.files || []));
    });
  }

  function handleFiles(files, hint) {
    if (!S || !files || !files.length) return;
    var vids = [], subs = [], other = [];
    files.forEach(function (f) {
      if (K.isSubtitleFile(f)) subs.push(f);
      else if (K.isMediaFile(f)) vids.push(f);
      else other.push(f);
    });
    if (hint === 'sub' && vids.length && !subs.length) {
      st('Bu bir altyazı dosyası değil. .srt veya .vtt dosyası seçin.', 'error');
      return;
    }
    if (!vids.length && !subs.length) {
      st('Bu dosya türü desteklenmiyor (' + K.shorten(other[0].name, 40) + '). Video (MP4, WebM, MKV, MOV…) ya da altyazı (.srt, .vtt) seçin.', 'error');
      return;
    }
    if (vids.length) loadVideo(vids[0]);
    if (subs.length) loadSubtitle(subs[0]);
    if (vids.length > 1 || subs.length > 1) st('Birden çok dosya bırakıldı; yalnızca ilk video ve ilk altyazı kullanıldı.', 'warn');
  }

  /* ---------- video ---------- */
  function loadVideo(file) {
    var s = S;
    if (!s) return;
    // Yeni dosya: önceki tüm işleri bırak. Altyazı videodan önce eklendiyse korunur.
    stopAsr(s);
    if (s.track && !s.subFirst) removeSubtitle(true);
    s.subFirst = false;
    s.gen++;
    releaseVideo(s);
    s.file = file;
    s.videoErr = null;
    s.audioOnly = isAudioOnly(file);
    s.url = URL.createObjectURL(file);
    s.video.src = s.url;
    s.video.hidden = false;
    s.empty.hidden = true;
    s.controls.hidden = false;
    s.toolbar.hidden = false;
    s.nameChip.textContent = K.shorten(file.name || 'video', 48);
    s.nameChip.title = (file.name || '') + ' · ' + U.fmtBytes(file.size);
    s.durChip.hidden = true;
    U.clear(s.videoNote);
    if (/\.(mkv|avi|wmv|flv)$/i.test(file.name || '')) {
      s.videoNote.appendChild(K.note('info', 'Chrome bazı .' + (file.name.split('.').pop() || '').toLowerCase() +
        ' dosyalarının görüntü ya da ses biçimini oynatamayabilir. Görüntü veya ses gelmezse dosyayı MP4\'e dönüştürüp tekrar deneyin.'));
    }
    s.view.reset();
    if (s.track) { s.view.setCues(s.track.cues); s.track.seek(0); }
    renderSource();
    st('"' + K.shorten(file.name, 60) + '" açıldı.', 'ok');
  }

  function releaseVideo(s) {
    stopRaf(s);
    try { s.video.pause(); } catch (e) { /* */ }
    s.video.removeAttribute('src');
    try { s.video.load(); } catch (e) { /* */ }
    if (s.url) { URL.revokeObjectURL(s.url); s.url = null; }
  }

  function onMeta() {
    var s = S;
    if (!s || !s.file) return;
    var v = s.video;
    if (isFinite(v.duration) && v.duration > 0) {
      s.durChip.textContent = K.fmtClock(v.duration);
      s.durChip.hidden = false;
    }
    if (!s.audioOnly && v.videoWidth === 0 && v.videoHeight === 0) {
      U.clear(s.videoNote);
      s.videoNote.appendChild(K.note('warn', 'Görüntü çözülemedi; tarayıcı bu dosyanın görüntü biçimini (codec) desteklemiyor olabilir. Ses ve altyazı yine çalışır. Görüntü için dosyayı MP4 (H.264) biçimine dönüştürün.'));
    }
    tick();
  }

  function onVideoError() {
    var s = S;
    if (!s || !s.file || !s.video.getAttribute('src')) return;
    var code = s.video.error && s.video.error.code;
    var msg = code === 4
      ? 'Tarayıcı bu dosyayı oynatamıyor (biçim ya da codec desteklenmiyor). MP4 (H.264/AAC) veya WebM\'e dönüştürüp tekrar deneyin.'
      : code === 3 ? 'Video çözülürken hata oluştu; dosya bozuk olabilir ya da biçimi desteklenmiyor.'
        : 'Video açılamadı.';
    s.videoErr = msg;
    U.clear(s.videoNote);
    s.videoNote.appendChild(K.note('error', msg));
    st(msg, 'error');
    renderSource();
  }

  /* ---------- eşleme döngüsü ---------- */
  function nowMs() { return S && S.file ? S.video.currentTime * 1000 : 0; }

  function tick() {
    var s = S;
    if (!s || !s.file) return;
    s.view.update(s.video.currentTime * 1000);
    if (s.asr && s.asrUi && s.asr.phase === 'run') {
      var now = Date.now();
      if (!(now - (s.uiAt || 0) < 400)) { s.uiAt = now; updAsrUi(s.asr, true); }
    }
  }

  function onSeek() {
    var s = S;
    if (!s || !s.file) return;
    var ms = s.video.currentTime * 1000;
    if (s.track) s.track.seek(ms);
    if (s.asr && s.asr.tq) s.asr.tq.kick();
    tick();
  }

  function startRaf() {
    var s = S;
    if (!s || s.raf) return;
    var frame = function () {
      if (S !== s) return;
      if (s.video.paused || s.video.ended) { s.raf = 0; tick(); return; }
      tick();
      s.raf = root.requestAnimationFrame(frame);
    };
    s.raf = root.requestAnimationFrame(frame);
  }
  function stopRaf(s) {
    if (s.raf) { root.cancelAnimationFrame(s.raf); s.raf = 0; }
  }

  /* ---------- altyazı dosyası ---------- */
  function loadSubtitle(file) {
    var s = S;
    if (!s) return;
    var gen = s.gen;
    K.readSubtitleFile(file).then(function (cues) {
      if (!alive(gen)) return;
      if (s.asr) { stopAsr(s); st('Konuşmadan altyazı oluşturma durduruldu; altyazı dosyası kullanılıyor.', 'info'); }
      removeSubtitle(true);
      s.sub = file;
      s.subFirst = !s.file;
      var from = s.subFrom || 'auto';
      s.track = new SrtTrack({ cues: cues, view: s.view, from: from, onProgress: function (d, t) { if (S === s && s.panel2) s.panel2.progress(d, t); watchTranslation(s); } });
      s.view.offsetMs = 0;
      renderSource();
      s.track.start(nowMs());
      tick();
      st('Altyazı dosyası yüklendi: ' + cues.length + ' satır. Oynatma noktasından başlayarak çevriliyor…', 'busy');
    }, function (e) {
      if (!alive(gen)) return;
      st(K.errText(e), 'error');
      if (s.panel0Err) { U.clear(s.panel0Err); s.panel0Err.appendChild(K.note('error', K.errText(e))); }
    });
  }

  /** Çeviri hiç ilerlemiyorsa kullanıcıyı uyar; tamamlanınca bildir. */
  function watchTranslation(s) {
    var t = s.track;
    if (!t || !s.panel2) return;
    var total = t.cues.length;
    if (t.done >= total && total) {
      s.panel2.setWarn(null);
      if (!s.trDoneSaid) { s.trDoneSaid = true; st('Altyazının tamamı Türkçeye çevrildi (' + total + ' satır).', 'ok'); }
    }
  }

  function translationWatchdog(s, track) {
    var timer = setInterval(function () {
      if (S !== s || s.track !== track) { clearInterval(timer); return; }
      if (!s.panel2) return;
      if (!K.translationPossible()) {
        s.panel2.setWarn('warn', 'Çeviri yapılamıyor: bu tarayıcıda cihaz içi çeviri yok ve çevrim içi çeviri kapalı. ', K.goSettingsBtn());
      } else if (track.done === 0 && Date.now() - track.startedAt > 12000) {
        s.panel2.setWarn('warn', 'Çeviri gelmiyor. İnternet bağlantınızı ve Ayarlar\'daki "Çevrim içi çeviriye izin ver" seçeneğini kontrol edin. ', K.goSettingsBtn());
      } else if (track.done > 0) {
        s.panel2.setWarn(null);
      }
    }, 1500);
    s.cardCleanups.push(function () { clearInterval(timer); });
  }

  function removeSubtitle(silent) {
    var s = S;
    if (!s) return;
    stopTrack(s);
    s.sub = null;
    s.subFirst = false;
    s.trDoneSaid = false;
    s.view.reset();
    s.view.setCues([]);
    if (!silent) { renderSource(); st('Altyazı dosyası kaldırıldı.', 'info'); }
  }

  function stopTrack(s) {
    if (s.track) { s.track.stop(); s.track = null; }
  }

  function outBase(s) {
    if (s.file) return K.safeFileName(K.baseName(s.file.name), 'video');
    if (s.sub) return K.safeFileName(K.stripLang(K.baseName(s.sub.name)), 'altyazi');
    return 'altyazi';
  }

  /* ---------- kaynak kartı ---------- */
  function renderSource() {
    var s = S;
    if (!s) return;
    var c = s.srcCard;
    (s.cardCleanups || []).forEach(function (fn) { fn(); });
    s.cardCleanups = [];
    U.clear(c.body);
    s.panel2 = null;
    s.asrUi = null;
    s.panel0Err = null;
    if (s.track) renderSrtCard(s, c);
    else if (s.asr) renderAsrCard(s, c);
    else renderChoiceCard(s, c);
  }

  function renderChoiceCard(s, c) {
    c.setIcon('subtitle');
    c.setTitle('Türkçe altyazı');
    c.setSub(s.file ? 'Nereden oluşturulsun?' : 'Önce bir video seçin; altyazı dosyasını şimdi de ekleyebilirsiniz.');
    s.panel0Err = el('div');
    var subBtn = K.fileButton({ label: 'Altyazı dosyası seç', accept: SUB_ACCEPT, iconName: 'subtitle', role: 'pick-sub', cls: 'as-btn--block',
      onFiles: function (f) { handleFiles(f, 'sub'); } });
    var asrBtn = K.button('Konuşmadan altyazı oluştur', { cls: 'as-btn--primary as-btn--block', iconName: 'mic', role: 'asr-start',
      disabled: !s.file || !!s.videoErr, onClick: startAsr,
      title: s.file ? 'Videodaki konuşmayı yazıya döker ve Türkçeye çevirir.' : 'Önce bir video seçin.' });
    var lr = K.asrLangRow('Videoda konuşulan dil. Biliyorsanız seçin: otomatik algılamadan daha doğru ve hızlıdır. Bu ayar Ayarlar bölümündeki "Konuşma dili" ile aynıdır.');
    s.cardCleanups.push(lr.dispose);
    var model = AS.settings.get('asrModel');
    var modelName = { tiny: 'Hızlı (tiny)', base: 'Dengeli (base)', small: 'En doğru (small)' }[model] || model;
    c.body.appendChild(el('div', { class: 'as-col' },
      el('div', { class: 'as-label' }, 'Altyazı dosyam var'),
      el('p', { class: 'as-hint' }, 'Videonun yabancı dildeki .srt veya .vtt dosyası (en fazla 5 MB). Satırlar izlediğiniz yerden başlayarak arka planda çevrilir.'),
      subBtn, s.panel0Err));
    c.body.appendChild(el('hr', { class: 'as-divider' }));
    c.body.appendChild(el('div', { class: 'as-col' },
      el('div', { class: 'as-label' }, 'Altyazı dosyam yok'),
      el('p', { class: 'as-hint' }, 'Konuşma, bilgisayarınızda çalışan yapay zekâ modeliyle yazıya dökülür ve Türkçeye çevrilir. İzlediğiniz yerden başlar; uzun videolarda zaman alır.'),
      lr.node,
      asrBtn,
      el('p', { class: 'as-hint' }, 'Model: ' + modelName + ' · ilk kullanımda bir kez indirilir. ',
        el('a', { href: '#ayarlar', on: { click: function (e) { e.preventDefault(); if (AS.app) AS.app.select('settings'); } } }, 'Değiştir'))));
  }

  function renderSrtCard(s, c) {
    var t = s.track;
    c.setIcon('subtitle');
    c.setTitle('Altyazı dosyası');
    c.setSub(s.file ? 'Video ile eşleniyor' : 'Video seçerseniz altyazı videoyla birlikte gösterilir.');
    s.panel2 = K.srtPanel({
      name: s.sub ? s.sub.name : 'altyazı', count: t.cues.length, from: t.from,
      onFrom: function (v) { s.subFrom = v; if (s.track) { s.track.setFrom(v, nowMs()); s.trDoneSaid = false; } },
      offsetMs: s.view.offsetMs,
      onOffset: function (ms) { s.view.setOffset(ms); if (s.track) s.track.seek(nowMs()); tick(); },
      onDownload: function () {
        if (!s.track) return;
        var name = outBase(s) + '.tr.srt';
        K.downloadText(s.track.exportTr(), name);
        var left = s.track.cues.length - s.track.done;
        st('"' + name + '" indirildi' + (left > 0 ? ' (' + left + ' satır henüz çevrilmedi; orijinal hâliyle yazıldı).' : '.'), left > 0 ? 'warn' : 'ok');
      },
      onRemove: function () { removeSubtitle(false); },
      downloadName: function () { return outBase(s) + '.tr.srt'; }
    });
    s.panel2.progress(t.done, t.cues.length);
    c.body.appendChild(s.panel2.node);
    translationWatchdog(s, t);
    if (!K.translationPossible()) s.panel2.setWarn('warn', 'Çeviri yapılamıyor: bu tarayıcıda cihaz içi çeviri yok ve çevrim içi çeviri kapalı. ', K.goSettingsBtn());
  }

  /* ================================================================== */
  /* Konuşmadan altyazı                                                  */
  /* ================================================================== */
  function startAsr() {
    var s = S;
    if (!s || !s.file || s.asr) return;
    if (!AS.asr || !AS.audio) { st('Konuşma tanıma bileşeni yüklenemedi. Sayfayı yenileyin.', 'error'); return; }
    var job = {
      gen: s.gen, abort: new AbortController(), phase: 'model', cues: [], windows: null, pcm: null, totalSec: 0,
      paused: false, wake: null, tq: null, model: null, read: null, modelReady: false, err: null, note: null,
      translated: 0, trFailed: 0, trDisabled: false, failedWins: 0, langs: {}, live: null, liveSpeech: null,
      stream: null, map: [], dropped: 0, startedAt: Date.now(), order: []
    };
    s.asr = job;
    job.tq = new CueTranslator({
      getFocusMs: nowMs,
      onDone: function (cue) {
        if (!jobAlive(job)) return;
        job.translated++;
        if (cue.fresh) {
          cue.fresh = false;
          // Canlı dinlemede yeni satır hemen gösterilir (zamanı çoktan geçmiş olur).
          if (Date.now() - cue.addedAt < 12000) AS.bus.emit('subtitle', { tr: cue.tr, src: cue.text, cont: false, kind: 'speech' });
        }
        s.view.refresh();
        updAsrUi(job);
      },
      onFail: function (e) {
        if (!jobAlive(job)) return;
        job.trFailed++;
        if (e && e.code === 'disabled') job.trDisabled = true;
        updAsrUi(job);
      }
    });
    s.view.reset();
    s.view.setCues(job.cues);
    renderSource();
    st('Konuşmadan altyazı hazırlanıyor…', 'busy');

    var modelP = Promise.resolve().then(function () {
      return AS.asr.load({ model: AS.settings.get('asrModel'), onProgress: function (p) { if (jobAlive(job)) { job.model = p; updAsrUi(job); } } });
    }).then(function (r) { job.modelReady = true; job.device = r && r.device; if (jobAlive(job)) updAsrUi(job); return r; });
    modelP.catch(function () { /* aşağıda ele alınır */ });
    // Çok uzun ses bir kerede çözülürse (küçük ama saatlerce süren dosya dahil) bellek biter ve sekme çöker:
    // süre sınırın üstündeyse çözmeden canlı dinlemeye geçilir.
    var dur = s.video ? Number(s.video.duration) : NaN;
    var decodeP = (isFinite(dur) && dur > DECODE_MAX_S)
      ? Promise.reject(new Error('Video çok uzun (' + K.fmtClock(dur) + '); sesi bir kerede çözülemiyor. Canlı dinleme kullanılacak.'))
      : AS.audio.decodeFile(s.file, function (l, t) { if (jobAlive(job)) { job.read = { l: l, t: t }; updAsrUi(job); } });
    decodeP.catch(function () { /* aşağıda ele alınır */ });

    (async function () {
      var pcm = null, decodeErr = null;
      job.phase = 'decode';
      updAsrUi(job);
      try { pcm = await decodeP; } catch (e) { decodeErr = e; }
      if (!jobAlive(job)) return;
      if (decodeErr && !canFallback(decodeErr)) { failJob(job, decodeErr); return; }
      if (!job.modelReady) { job.phase = 'model'; updAsrUi(job); }
      try { await modelP; } catch (e) { if (jobAlive(job)) failJob(job, e); return; }
      if (!jobAlive(job)) return;
      if (decodeErr) { startLive(job, decodeErr); return; }
      job.pcm = pcm;
      job.totalSec = pcm.length / RATE;
      job.phase = 'plan';
      updAsrUi(job);
      var wins = await planWindows(pcm, function () { return jobAlive(job); });
      if (!jobAlive(job) || !wins) return;
      job.windows = wins;
      job.phase = 'run';
      updAsrUi(job);
      st('Konuşma yazıya dökülüyor (oynatma noktasından başlayarak)…', 'busy');
      await runWindows(job);
    })().catch(function (e) { if (jobAlive(job)) failJob(job, e); });
  }

  function jobAlive(job) { return !!S && S.asr === job && !job.abort.signal.aborted; }

  /** decodeFile hatası canlı dinlemeyle aşılabilir mi? (ses yoksa / dosya boşsa hayır) */
  function canFallback(e) {
    var m = String((e && e.message) || '');
    return !/ses bulunamadı|boş|seçilmedi/i.test(m);
  }

  async function runWindows(job) {
    var s = S;
    while (jobAlive(job)) {
      if (job.paused) {
        await new Promise(function (r) { job.wake = r; });
        job.wake = null;
        continue;
      }
      var w = pickWindow(job.windows, Math.round(nowMs() * RATE / 1000));
      if (!w) break;
      w.state = 1;
      job.current = w;
      job.order.push(w.i);
      updAsrUi(job);
      try {
        var lang = AS.settings.get('asrLang');
        var r = await AS.asr.transcribe(job.pcm.subarray(w.a, w.b), { language: lang, timestamps: true, signal: job.abort.signal });
        if (!jobAlive(job)) return;
        w.state = 2;
        if (r && r.language) job.langs[r.language] = (job.langs[r.language] || 0) + 1;
        var add = chunksToCues(r && r.chunks, w.a * 1000 / RATE, w.b * 1000 / RATE, (r && r.language) || (lang !== 'auto' ? lang : null));
        if (add.length) {
          insertCues(job.cues, add);
          add.forEach(function (c) { job.tq.add(c); });
          s.view.refresh();
        }
      } catch (e) {
        if (!jobAlive(job) || isAbort(e)) return;
        w.tries++;
        job.lastErr = e;
        if (/bellek|memory/i.test(String(e && e.message))) { failJob(job, e); return; }
        if (w.tries >= 2) { w.state = 3; job.failedWins++; } else w.state = 0;
        if (root.console) console.warn('[AS.file] pencere yazıya dökülemedi:', w.i, e && e.message);
        await U.sleep(400);
      }
      job.current = null;
      updAsrUi(job);
    }
    if (!jobAlive(job)) return;
    job.phase = 'done';
    if (!job.failedWins) job.pcm = null;   // belleği bırak (yeniden deneme gerekmiyorsa)
    updAsrUi(job, false, true);
    var n = job.cues.length;
    st(n ? 'Konuşmadan altyazı oluşturuldu: ' + n + ' satır' + (job.failedWins ? ' (' + job.failedWins + ' bölüm yazıya dökülemedi)' : '') + '.'
      : 'Videoda yazıya dökülecek konuşma bulunamadı.', n ? (job.failedWins ? 'warn' : 'ok') : 'warn');
  }

  function failJob(job, e) {
    job.phase = 'error';
    job.err = K.errText(e);
    updAsrUi(job, false, true);
    if (job.busAt) busProgress(job, 0, true, true);
    st(job.err, 'error');
  }

  /** Uzun süren yazıya dökme işinin ilerlemesi durum çubuğunda da görünsün (bus 'progress', what 'transcribe'):
   *  kullanıcı Ayarlar/Yardım'a geçse de iş arka planda sürer. Bitince (ya da iptalde) bir kez done:true. */
  function busProgress(job, frac, done, error) {
    if (job.busDone) return;
    var now = Date.now();
    if (!done && job.busAt && now - job.busAt < 400) return;
    job.busAt = now;
    if (done) job.busDone = true;
    AS.bus.emit('progress', {
      what: 'transcribe',
      label: done ? (error ? 'Yazıya dökme durdu' : 'Konuşma yazıya döküldü') : 'Konuşma yazıya dökülüyor' + (job.paused ? ' (duraklatıldı)' : ''),
      loaded: Math.round(U.clamp(frac, 0, 1) * 1000), total: 1000, done: !!done, error: error ? true : undefined
    });
  }

  function stopAsr(s) {
    var job = s.asr;
    if (!job) return;
    s.asr = null;
    try { job.abort.abort(); } catch (e) { /* */ }
    if (job.wake) job.wake();
    if (job.tq) job.tq.stop();
    stopLiveTap(job);
    if (job.stream) { job.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* */ } }); job.stream = null; }
    if (job.onPlaying) { s.video.removeEventListener('playing', job.onPlaying); job.onPlaying = null; }
    if (job.busAt) busProgress(job, 0, true, true);
    job.pcm = null;
    s.view.reset();
    s.view.setCues(s.track ? s.track.cues : []);
  }

  function togglePause(job) {
    job.paused = !job.paused;
    if (job.phase === 'live') {
      if (job.paused) stopLiveTap(job); else ensureLiveTap(job);
    } else if (!job.paused && job.wake) job.wake();
    updAsrUi(job, false, true);
    st(job.paused ? 'Yazıya dökme duraklatıldı.' : 'Yazıya dökme sürüyor…', job.paused ? 'info' : 'busy');
  }

  function retryFailed(job) {
    if (!job.windows || !job.pcm) return;
    job.windows.forEach(function (w) { if (w.state === 3) { w.state = 0; w.tries = 0; } });
    job.failedWins = 0;
    job.phase = 'run';
    job.busDone = false;
    job.busAt = 0;
    updAsrUi(job, false, true);
    runWindows(job).catch(function (e) { if (jobAlive(job)) failJob(job, e); });
  }

  /* ---------- canlı dinleme yedeği (video.captureStream) ---------- */
  function startLive(job, why) {
    job.phase = 'live';
    job.liveWhy = K.errText(why);
    job.live = { listenedMs: 0, segs: 0 };
    updAsrUi(job, false, true);
    st('Dosyanın sesi bir kerede çözülemedi; video oynarken konuşma dinlenecek.', 'warn');
    ensureLiveTap(job);
  }

  function ensureLiveTap(job) {
    var s = S;
    if (!jobAlive(job) || job.paused || job.liveSpeech || job.phase !== 'live') return;
    var v = s.video;
    var cap = v.captureStream || v.mozCaptureStream;
    if (typeof cap !== 'function') {
      failJob(job, new Error('Bu tarayıcı oynatılan videonun sesini dinleyemiyor. Chrome ya da Edge kullanın.'));
      return;
    }
    if (v.paused) {
      if (!job.onPlaying) {
        job.onPlaying = function () { v.removeEventListener('playing', job.onPlaying); job.onPlaying = null; ensureLiveTap(job); };
        v.addEventListener('playing', job.onPlaying);
      }
      updAsrUi(job, false, true);
      return;
    }
    try { if (!job.stream) job.stream = cap.call(v); } catch (e) { failJob(job, e); return; }
    var map = job.map;
    var sp = new LiveSpeech({
      stream: job.stream, mode: MODE, maxBacklog: 4,
      language: function () { return AS.settings.get('asrLang'); },
      onChunk: function (chunk, sMs) {
        map.push({ s: sMs, v: v.currentTime * 1000 });
        if (map.length > 1500) map.splice(0, 300);
        if (!v.paused) job.live.listenedMs += chunk.length * 1000 / RATE;
        if (map.length % 10 === 0) updAsrUi(job);
      },
      onText: function (r, info) { liveCue(job, r, info); },
      onError: function (e) { job.lastErr = e; updAsrUi(job, false, true); },
      onDrop: function (n) { job.dropped = n; updAsrUi(job, false, true); },
      onEnded: function () { job.liveSpeech = null; if (job.stream) { job.stream = null; } updAsrUi(job, false, true); }
    });
    job.liveSpeech = sp;
    sp.start().then(function () { updAsrUi(job, false, true); }, function (e) {
      if (!jobAlive(job)) return;
      job.liveSpeech = null;
      failJob(job, e);
    });
    updAsrUi(job, false, true);
  }

  function stopLiveTap(job) {
    if (job.liveSpeech) { job.liveSpeech.stop(); job.liveSpeech = null; }
  }

  /** Akış zamanı (ms) → video zamanı (ms): her parça geldiğinde kaydedilen eşleşmelerden. */
  function mapStreamMs(map, ms) {
    if (!map.length) return NaN;
    var lo = 0, hi = map.length - 1;
    while (lo < hi) { var mid = (lo + hi) >>> 1; if (map[mid].s < ms) lo = mid + 1; else hi = mid; }
    return map[lo].v;
  }

  function liveCue(job, r, info) {
    if (!jobAlive(job)) return;
    var LAT = 120;   // parça gecikmesi payı
    var dur = Math.max(300, info.endMs - info.startMs);
    var vEnd = mapStreamMs(job.map, info.endMs) - LAT;
    var vStart = mapStreamMs(job.map, info.startMs) - LAT;
    if (!isFinite(vEnd)) return;
    if (!isFinite(vStart) || vStart > vEnd || vEnd - vStart > dur + 1500) vStart = vEnd - dur;   // arada atlama/duraklama
    vStart = Math.max(0, vStart);
    if (vEnd <= vStart) vEnd = vStart + 300;
    if (r.language) job.langs[r.language] = (job.langs[r.language] || 0) + 1;
    // Aynı aralık yeniden dinlendiyse (geri sarma) eski satırları bırak
    for (var i = job.cues.length - 1; i >= 0; i--) {
      var c = job.cues[i];
      if (c.start < vEnd - 200 && c.end > vStart + 200) job.cues.splice(i, 1);
    }
    // Uzun konuşma parçası: ekrana sığacak satırlara böl, süreyi uzunluğa göre paylaştır.
    var parts = splitText(String(r.text || '').replace(/\s+/g, ' ').trim(), 84);
    var total = parts.reduce(function (n, p) { return n + p.length; }, 0) || 1;
    var t0 = vStart, now = Date.now(), add = [];
    parts.forEach(function (p, k) {
      var t1 = k === parts.length - 1 ? vEnd : t0 + (vEnd - vStart) * p.length / total;
      add.push({ start: Math.round(t0), end: Math.round(t1), text: p, lang: r.language || null, tr: null,
        fresh: true, urgent: true, addedAt: now });
      t0 = t1;
    });
    insertCues(job.cues, add);
    job.live.segs++;
    add.forEach(function (cue) { job.tq.add(cue); });
    S.view.refresh();
    updAsrUi(job);
  }

  /* ---------- konuşma kartı ---------- */
  function renderAsrCard(s, c) {
    var job = s.asr;
    c.setIcon('mic');
    c.setTitle('Konuşmadan altyazı');
    var ui = s.asrUi = {};
    ui.prog = K.progressRow('');
    ui.stats = el('p', { class: 'as-hint', 'data-role': 'asr-stats' });
    ui.ahead = el('p', { class: 'as-hint' });
    ui.notes = el('div', { class: 'as-col' });
    ui.pause = K.button('Duraklat', { cls: 'as-btn--sm', iconName: 'pause', role: 'asr-pause', onClick: function () { togglePause(job); } });
    ui.retry = K.button('Tekrar dene', { cls: 'as-btn--sm', iconName: 'reset', role: 'asr-retry', onClick: function () {
      if (job.phase === 'error') { stopAsr(s); renderSource(); startAsr(); } else retryFailed(job);
    } });
    ui.cancel = K.button('Vazgeç', { cls: 'as-btn--sm as-btn--ghost', iconName: 'close', role: 'asr-cancel', onClick: function () {
      stopAsr(s); renderSource(); st('Konuşmadan altyazı oluşturma iptal edildi.', 'info');
    } });
    ui.dlTr = K.button('Türkçe SRT indir', { cls: 'as-btn--primary as-btn--block', iconName: 'download', role: 'download-tr',
      title: 'Türkçe altyazıyı .srt dosyası olarak kaydeder; çevrilmemiş satırlar orijinal hâliyle kalır.',
      onClick: function () { downloadAsr(job, true); } });
    ui.dlSrc = K.button('Orijinal SRT indir', { cls: 'as-btn--block', iconName: 'download', role: 'download-src',
      title: 'Konuşmanın yazıya dökülmüş orijinal (çevrilmemiş) hâlini .srt olarak kaydeder.',
      onClick: function () { downloadAsr(job, false); } });
    var lr = K.asrLangRow('Videoda konuşulan dil. Biliyorsanız seçin: otomatik algılamadan daha doğru ve hızlıdır. Değişiklik henüz işlenmemiş bölümlere uygulanır.');
    s.cardCleanups.push(lr.dispose);
    c.body.appendChild(ui.prog.node);
    c.body.appendChild(ui.stats);
    c.body.appendChild(ui.ahead);
    c.body.appendChild(ui.notes);
    c.body.appendChild(el('div', { class: 'as-row' }, ui.pause, ui.retry, ui.cancel));
    c.body.appendChild(lr.node);
    c.body.appendChild(el('div', { class: 'as-col', style: { gap: '8px' } }, ui.dlTr, ui.dlSrc));
    updAsrUi(job, false, true);
  }

  function downloadAsr(job, turkish) {
    var s = S;
    if (!s || !job.cues.length) { st('Henüz indirilecek satır yok.', 'warn'); return; }
    var base = outBase(s);
    var name, text;
    if (turkish) {
      name = base + '.tr.srt';
      text = buildSrt(job.cues, 0, function (c) { return c.tr || c.text; });
    } else {
      var lang = mainLang(job);
      name = base + '.' + (lang && /^[a-z]{2,3}$/.test(lang) && lang !== 'tr' ? lang : 'orijinal') + '.srt';
      text = buildSrt(job.cues, 0, function (c) { return c.text; });
    }
    K.downloadText(text, name);
    var left = job.cues.filter(function (c) { return !c.tr; }).length;
    st('"' + name + '" indirildi (' + job.cues.length + ' satır' + (turkish && left ? ', ' + left + ' satır henüz çevrilmedi' : '') +
      (job.phase !== 'done' ? '; işlem sürdükçe yeniden indirerek tamamını alabilirsiniz' : '') + ').', 'ok');
  }

  function mainLang(job) {
    var best = null, n = 0;
    for (var k in job.langs) if (job.langs[k] > n) { n = job.langs[k]; best = k; }
    return best;
  }

  /** Kart metinlerini günceller (yeniden kurmadan). light: yalnızca ilerleme; force: düğmeler/notlar da. */
  function updAsrUi(job, light, force) {
    var s = S;
    if (!s || s.asr !== job || !s.asrUi) return;
    var ui = s.asrUi;
    var c = s.srcCard;
    var phase = job.phase;
    var cues = job.cues;
    var trd = 0;
    for (var i = 0; i < cues.length; i++) if (cues[i].tr) trd++;
    var head;
    if (phase === 'model' || phase === 'decode') {
      var m = job.model;
      var mf = m && m.total > 0 ? m.loaded / m.total : -1;
      var rf = job.read && job.read.t ? job.read.l / job.read.t : -1;
      if (!job.modelReady && m && m.total > 0 && !(m.done)) {
        head = 'Konuşma modeli indiriliyor';
        ui.prog.set(mf, head + ' · %' + Math.round(mf * 100) + (m.total > 100000 ? ' (' + U.fmtBytes(m.loaded) + ' / ' + U.fmtBytes(m.total) + ')' : ''));
      } else if (phase === 'decode') {
        head = 'Ses çıkarılıyor';
        ui.prog.set(rf >= 1 || rf < 0 ? -1 : rf, rf >= 1 ? 'Ses çözülüyor… (büyük dosyalarda biraz sürer)' : 'Dosya okunuyor… ' + (rf >= 0 ? '%' + Math.round(rf * 100) : ''));
      } else {
        head = 'Konuşma modeli hazırlanıyor';
        ui.prog.set(-1, 'Konuşma modeli yükleniyor…');
      }
      c.setSub(head);
    } else if (phase === 'plan') {
      c.setSub('Hazırlanıyor');
      ui.prog.set(-1, 'Ses bölümlere ayrılıyor…');
    } else if (phase === 'run' || phase === 'done') {
      var wins = job.windows || [];
      var doneSec = 0;
      wins.forEach(function (w) { if (w.state === 2 || w.state === 3) doneSec += (w.b - w.a) / RATE; });
      var frac = job.totalSec ? doneSec / job.totalSec : 0;
      ui.prog.set(phase === 'done' ? 1 : frac, 'İşlenen süre: ' + K.fmtClock(doneSec) + ' / ' + K.fmtClock(job.totalSec) + ' · %' + Math.floor(frac * 100));
      busProgress(job, phase === 'done' ? 1 : frac, phase === 'done');
      c.setSub(phase === 'done' ? 'Tamamlandı' : job.paused ? 'Duraklatıldı' : 'Yazıya dökülüyor' + (job.device === 'webgpu' ? ' (WebGPU)' : ''));
      // Oynatma noktasından ileride hazır olan süre
      if (phase === 'run' && wins.length) {
        var at = nowMs() * RATE / 1000, k = 0;
        while (k + 1 < wins.length && wins[k + 1].a <= at) k++;
        var readyTo = at;
        while (k < wins.length && (wins[k].state === 2 || wins[k].state === 3)) { readyTo = wins[k].b; k++; }
        var ahead = (readyTo - at) / RATE;
        ui.ahead.textContent = ahead >= 1 ? 'Oynatma noktasından ' + K.fmtClock(ahead) + ' ileriye kadar hazır.' : 'Oynatma noktasındaki bölüm işleniyor…';
        ui.ahead.hidden = false;
      } else ui.ahead.hidden = true;
    } else if (phase === 'live') {
      var L = job.live || { listenedMs: 0 };
      var listening = !!job.liveSpeech && !job.paused && !S.video.paused;
      ui.prog.set(listening ? -1 : 0, 'Dinlenen süre: ' + K.fmtClock(L.listenedMs / 1000));
      c.setSub(job.paused ? 'Duraklatıldı' : job.liveSpeech && !S.video.paused ? 'Video oynarken dinleniyor' : 'Videoyu oynatın');
      ui.ahead.hidden = true;
    } else if (phase === 'error') {
      c.setSub('Tamamlanamadı');
      ui.prog.set(0, 'Durdu');
      ui.ahead.hidden = true;
    }
    ui.stats.textContent = cues.length + ' satır · ' + trd + ' çevrildi' + (job.trFailed ? ' · ' + job.trFailed + ' çevrilemedi' : '');
    if (light) return;
    ui.dlTr.disabled = !cues.length;
    ui.dlSrc.disabled = !cues.length;
    if (!force) return;
    var running = phase === 'run' || phase === 'live';
    ui.pause.hidden = !running;
    K.setBtnLabel(ui.pause, job.paused ? 'Sürdür' : 'Duraklat');
    var pic = ui.pause.querySelector('svg');
    if (pic) ui.pause.replaceChild(icon(job.paused ? 'play' : 'pause'), pic);
    ui.retry.hidden = !(phase === 'error' || (phase === 'done' && job.failedWins && job.pcm));
    K.setBtnLabel(ui.cancel, phase === 'done' ? 'Kapat' : 'Vazgeç');
    U.clear(ui.notes);
    if (phase === 'error' && job.err) ui.notes.appendChild(K.note('error', job.err));
    if (phase === 'live') {
      var why = String(job.liveWhy || '').replace(/\s*Canlı dinleme kullanılacak\.?\s*$/i, '').trim();
      if (!/[çğıöşüÇĞİÖŞÜ]/.test(why)) why = '';   // teknik (Türkçe olmayan) hata metnini gösterme
      if (why && !/[.!?…]$/.test(why)) why += '.';
      ui.notes.appendChild(K.note('info', (why ? why + ' ' : 'Dosyanın sesi bir kerede çözülemedi. ') +
        'Bunun yerine video oynarken konuşma dinleniyor; altyazı yalnızca izlediğiniz kısım için oluşur. Videonun sesini kısmayın.'));
      if (S.video.paused && !job.paused) ui.notes.appendChild(K.note('warn', 'Videoyu oynatın; konuşma dinlenip Türkçe altyazıya dönüştürülecek.'));
      if (job.dropped) ui.notes.appendChild(K.note('warn', 'Bilgisayar konuşma tanımaya yetişemiyor; ' + job.dropped + ' cümle atlandı. Ayarlar\'dan daha hızlı (tiny) modeli seçebilirsiniz.'));
    }
    if (phase === 'done' && !cues.length) ui.notes.appendChild(K.note('warn', 'Videoda yazıya dökülecek konuşma bulunamadı. Konuşma dili yanlış seçildiyse düzeltip tekrar deneyin.'));
    if (phase === 'done' && job.failedWins) ui.notes.appendChild(K.note('warn', job.failedWins + ' bölüm yazıya dökülemedi' + (job.lastErr ? ' (' + K.errText(job.lastErr) + ')' : '') + '.'));
    if (job.trDisabled || !K.translationPossible()) ui.notes.appendChild(K.note('warn', 'Çeviri yapılamıyor: bu tarayıcıda cihaz içi çeviri yok ve çevrim içi çeviri kapalı. ', K.goSettingsBtn()));
  }

  AS.modes.file = {
    id: 'file',
    title: 'Video dosyası',
    icon: 'file',
    mount: mount,
    unmount: unmount,
    /* test ve hata ayıklama için saf yardımcılar */
    _planWindows: planWindows,
    _pickWindow: pickWindow,
    _chunksToCues: chunksToCues,
    _insertCues: insertCues,
    _state: function () {
      var s = S;
      if (!s) return null;
      var job = s.asr;
      return {
        file: s.file ? s.file.name : null, sub: s.sub ? s.sub.name : null, offsetMs: s.view.offsetMs,
        track: s.track ? { done: s.track.done, total: s.track.cues.length, from: s.track.from } : null,
        asr: job ? {
          phase: job.phase, cues: job.cues.map(function (c) { return { start: c.start, end: c.end, text: c.text, tr: c.tr }; }),
          windows: (job.windows || []).map(function (w) { return { a: w.a, b: w.b, state: w.state, silent: w.silent }; }),
          order: job.order || null, paused: job.paused, err: job.err
        } : null
      };
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);

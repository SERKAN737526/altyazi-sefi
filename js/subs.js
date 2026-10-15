/* Altyazı Şefi Web: Türkçe altyazı katmanı (AS.subs).
 * Kayıtlı sahnelerin (video kutularının) üstünde ve ayrı bir "altyazı penceresinde" (Document Picture-in-Picture,
 * yoksa açılır pencere) aynı satırları gösterir. Metin her zaman textContent ile yazılır (güvenilmeyen girdi).
 *
 * API (ARCHITECTURE.md):
 *   attach(stageEl) → overlayEl      detach(stageEl)
 *   show({tr, src, cont, kind})       clear()
 *   openPip() → Promise<boolean>      closePip()      isPipOpen()
 *   fullscreen(stageEl) → Promise<boolean>  (true: artık tam ekran)
 * Ekler: isFullscreen(stageEl), current() → [{tr, src, kind}], sample(stageEl, lines) (ayar önizlemesi),
 *   show() isteğe bağlı `holdMs` alanı (bu satıra özel ekranda kalma süresi),
 *   bus olayı 'pip' {open, kind} (pencere açıldı/kapandı).
 */
(function (root) {
  'use strict';
  var AS = root.AS;
  if (!AS || !AS.util) throw new Error('ns.js önce yüklenmeli');
  var U = AS.util;
  var doc = root.document;

  var MAX_LINES = 2;
  var MAX_CHARS = 600;
  var VISUAL_KEYS = { fontSize: 1, bgOpacity: 1, showOriginal: 1, position: 1 };

  var stages = [];   // {stage, overlay, linesEl, sample?, seen}
  var lines = [];    // {id, tr, src, kind, at, until}
  var seq = 0;
  var timer = null;
  var pip = null;    // {win, kind, overlay, linesEl, poll, onHide}

  /* ------------------------------------------------------------------ */
  /* yardımcılar                                                         */
  /* ------------------------------------------------------------------ */
  function status(text, level) {
    AS.bus.emit('status', { mode: 'app', text: text, level: level || 'info' });
  }

  /** Güvenilmeyen metni temizler: denetim karakterleri yok, boşluklar sade, satır sonları korunur, uzunluk sınırlı. */
  function norm(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    // eslint-disable-next-line no-control-regex
    s = s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f\u200b\u2028\u2029]/g, ' ');
    s = s.replace(/[ \t\f\v\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
    if (s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS - 1).replace(/\s+\S*$/, '') + '…';
    return s;
  }

  function holdMs() {
    var v = Number(AS.settings.get('holdMs'));
    return U.clamp(isFinite(v) ? v : 6000, 1000, 60000);
  }

  function mk(d, tag, cls, text) {
    var n = d.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function absUrl(p) {
    try { return new URL(p, doc.baseURI).href; } catch (e) { return p; }
  }

  /* ------------------------------------------------------------------ */
  /* katman oluşturma ve çizim                                           */
  /* ------------------------------------------------------------------ */
  function buildOverlay(d, extraClass, withHint) {
    var overlay = mk(d, 'div', 'as-sub is-empty' + (extraClass ? ' ' + extraClass : ''));
    overlay.setAttribute('aria-live', 'polite');
    overlay.setAttribute('aria-atomic', 'false');
    overlay.setAttribute('translate', 'no');
    overlay.setAttribute('lang', 'tr');
    var linesEl = mk(d, 'div', 'as-sub__lines');
    overlay.appendChild(linesEl);
    if (withHint) {
      var hint = mk(d, 'div', 'as-sub__hint');
      var img = mk(d, 'img');
      img.setAttribute('src', absUrl('icons/logo.svg'));
      img.setAttribute('alt', '');
      hint.appendChild(img);
      hint.appendChild(mk(d, 'span', null, 'Türkçe altyazı burada görünecek'));
      overlay.appendChild(hint);
    }
    return { overlay: overlay, linesEl: linesEl };
  }

  function applyVars(overlay) {
    var s = AS.settings.all();
    var size = Number(s.fontSize);
    size = U.clamp(isFinite(size) ? size : 34, 10, 160);
    var op = Number(s.bgOpacity);
    op = U.clamp(isFinite(op) ? op : 0.6, 0, 1);
    overlay.style.setProperty('--as-sub-scale', String(size));
    overlay.style.setProperty('--as-sub-bg', 'rgba(0, 0, 0, ' + (Math.round(op * 100) / 100) + ')');
    overlay.setAttribute('data-pos', s.position === 'top' ? 'top' : 'bottom');
    overlay.classList.toggle('as-sub--orig', !!s.showOriginal);
  }

  /** Satırları bir katmana yazar; aynı kimlikli satırın düğümü korunur (giriş animasyonu yalnızca yeni satırda). */
  function renderInto(rec, list) {
    var linesEl = rec.linesEl;
    var d = linesEl.ownerDocument;
    var existing = {};
    var child = linesEl.firstChild;
    while (child) {
      var next = child.nextSibling;
      if (child.nodeType === 1 && child.getAttribute('data-id')) existing[child.getAttribute('data-id')] = child;
      else linesEl.removeChild(child);
      child = next;
    }
    var keep = {};
    var prev = null;
    for (var i = 0; i < list.length; i++) {
      var L = list[i];
      var key = String(L.id);
      var node = existing[key];
      if (!node) {
        node = mk(d, 'div', 'as-sub__line');
        node.setAttribute('data-id', key);
        var trw = mk(d, 'div', 'as-sub__trw');
        trw.appendChild(mk(d, 'span', 'as-sub__tr'));
        var srcw = mk(d, 'div', 'as-sub__srcw');
        var srcSpan = mk(d, 'span', 'as-sub__src');
        srcSpan.setAttribute('translate', 'no');
        srcw.appendChild(srcSpan);
        node.appendChild(trw);
        node.appendChild(srcw);
      }
      var trEl = node.firstChild.firstChild;
      var srcEl = node.lastChild.firstChild;
      if (trEl.textContent !== L.tr) trEl.textContent = L.tr;
      var src = (L.src && L.src !== L.tr) ? L.src : '';
      if (srcEl.textContent !== src) srcEl.textContent = src;
      node.lastChild.hidden = !src;
      node.classList.toggle('is-old', i < list.length - 1);
      var want = prev ? prev.nextSibling : linesEl.firstChild;
      if (want !== node) linesEl.insertBefore(node, want);
      keep[key] = true;
      prev = node;
    }
    for (var k in existing) {
      if (!keep[k] && existing[k].parentNode === linesEl) linesEl.removeChild(existing[k]);
    }
    rec.overlay.classList.toggle('is-empty', list.length === 0);
  }

  function renderAll() {
    var alive = [];
    for (var i = 0; i < stages.length; i++) {
      var rec = stages[i];
      // Sahne DOM'dan kaldırılmış ve detach unutulmuşsa kaydı bırak (bir kez bağlı görülmüş olmalı).
      if (rec.stage.isConnected) rec.seen = true;
      else if (rec.seen) continue;
      alive.push(rec);
      try { renderInto(rec, rec.sample || lines); } catch (e) { if (root.console) console.error('[AS.subs]', e); }
    }
    stages = alive;
    if (pip) {
      try { renderInto(pip, lines); } catch (e) { onPipGone(); }
    }
  }

  function applyAllVars() {
    for (var i = 0; i < stages.length; i++) applyVars(stages[i].overlay);
    if (pip) { try { applyVars(pip.overlay); } catch (e) { /* pencere kapanıyor */ } }
  }

  /* ------------------------------------------------------------------ */
  /* zamanlayıcı: her satır, son güncellemesinden holdMs sonra silinir    */
  /* ------------------------------------------------------------------ */
  function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!lines.length) return;
    var soonest = Infinity;
    for (var i = 0; i < lines.length; i++) soonest = Math.min(soonest, lines[i].until);
    var wait = Math.max(20, soonest - U.now());
    timer = setTimeout(expire, wait);
  }

  function expire() {
    timer = null;
    var now = U.now();
    var before = lines.length;
    lines = lines.filter(function (L) { return L.until > now + 10; });
    if (lines.length !== before) renderAll();
    schedule();
  }

  /* ------------------------------------------------------------------ */
  /* genel API                                                           */
  /* ------------------------------------------------------------------ */
  function show(p) {
    if (!p || typeof p !== 'object') return;
    var tr = norm(p.tr);
    var src = norm(p.src);
    var kind = (p.kind === 'ocr' || p.kind === 'speech' || p.kind === 'srt') ? p.kind : 'ocr';
    var cont = !!p.cont;
    var now = U.now();
    var hold = holdMs();
    var custom = Number(p.holdMs);
    if (isFinite(custom) && custom > 0) hold = U.clamp(custom, 300, 120000);

    if (!tr) {
      // Boş "devam" satırı: son satırı kaldır (ör. altyazı ekrandan gitti).
      if (cont && lines.length) { lines.pop(); renderAll(); schedule(); }
      return;
    }
    var last = lines.length ? lines[lines.length - 1] : null;
    if (cont && last) {
      last.tr = tr; last.src = src; last.kind = kind; last.at = now; last.until = now + hold;
      if (kind === 'srt') lines = [last];
    } else if (last && last.tr === tr && (last.src === src || !src)) {
      last.at = now; last.until = now + hold;   // aynı satır tekrar geldi: yalnızca süreyi uzat
    } else {
      var item = { id: ++seq, tr: tr, src: src, kind: kind, at: now, until: now + hold };
      if (kind === 'srt') lines = [item];       // zamanlı altyazı: yalnızca etkin satır
      else {
        lines.push(item);
        while (lines.length > MAX_LINES) lines.shift();
      }
    }
    renderAll();
    schedule();
  }

  function clear() {
    lines = [];
    if (timer) { clearTimeout(timer); timer = null; }
    renderAll();
  }

  function findRec(stage) {
    for (var i = 0; i < stages.length; i++) if (stages[i].stage === stage) return stages[i];
    return null;
  }

  function attach(stage) {
    if (!stage || stage.nodeType !== 1) throw new TypeError('AS.subs.attach: geçerli bir sahne öğesi gerekli');
    var rec = findRec(stage);
    if (rec && rec.overlay.parentNode === stage) return rec.overlay;
    if (rec) stages.splice(stages.indexOf(rec), 1);
    try {
      var cs = stage.isConnected ? root.getComputedStyle(stage) : null;
      if (cs && cs.position === 'static') stage.style.position = 'relative';
    } catch (e) { /* hesaplanamadı */ }
    var built = buildOverlay(stage.ownerDocument || doc, '', false);
    rec = { stage: stage, overlay: built.overlay, linesEl: built.linesEl, sample: null, seen: stage.isConnected };
    stage.appendChild(rec.overlay);
    stages.push(rec);
    applyVars(rec.overlay);
    renderInto(rec, lines);
    return rec.overlay;
  }

  function detach(stage) {
    var rec = findRec(stage);
    if (!rec) return;
    stages.splice(stages.indexOf(rec), 1);
    if (rec.overlay.parentNode) rec.overlay.parentNode.removeChild(rec.overlay);
  }

  /** Ayarlar önizlemesi: sabit örnek satırlar, canlı ayarlarla çizilir. */
  function sample(stage, sampleLines) {
    var overlay = attach(stage);
    var rec = findRec(stage);
    var list = [];
    (sampleLines || []).slice(-MAX_LINES).forEach(function (s, i) {
      var tr = norm(s && s.tr);
      if (tr) list.push({ id: 's' + i, tr: tr, src: norm(s && s.src), kind: 'ocr' });
    });
    rec.sample = list;
    renderInto(rec, list);
    return overlay;
  }

  function current() {
    return lines.map(function (L) { return { tr: L.tr, src: L.src, kind: L.kind }; });
  }

  /* ------------------------------------------------------------------ */
  /* altyazı penceresi                                                   */
  /* ------------------------------------------------------------------ */
  function isPipOpen() {
    if (!pip) return false;
    try { if (pip.win.closed) { onPipGone(); return false; } } catch (e) { onPipGone(); return false; }
    return true;
  }

  /** Ana sayfanın stil kurallarını pencereye taşır. CSP style-src 'self' satır içi <style> yasaklar:
   *  önce CSSOM kopyası (adoptedStyleSheets, satır içi sayılmaz), olmazsa aynı kökenli <link>. */
  function installStyles(win) {
    var d = win.document;
    var css = [];
    var hrefs = [];
    var sheets = doc.styleSheets || [];
    for (var i = 0; i < sheets.length; i++) {
      var sh = sheets[i];
      if (sh.href) hrefs.push(sh.href);
      try {
        var rules = sh.cssRules;
        for (var j = 0; j < rules.length; j++) css.push(rules[j].cssText);
      } catch (e) { /* farklı köken: yalnızca bağlantı */ }
    }
    var adopted = false;
    if (css.length && 'adoptedStyleSheets' in d && typeof win.CSSStyleSheet === 'function') {
      try {
        var sheet = new win.CSSStyleSheet();
        sheet.replaceSync(css.join('\n'));
        d.adoptedStyleSheets = [sheet];
        adopted = true;
      } catch (e) { adopted = false; }
    }
    if (!adopted) {
      for (var h = 0; h < hrefs.length; h++) {
        var link = d.createElement('link');
        link.rel = 'stylesheet';
        link.href = hrefs[h];
        d.head.appendChild(link);
      }
    }
  }

  function setupPip(win, kind) {
    var d = win.document;
    if (!d.head) d.documentElement.insertBefore(d.createElement('head'), d.documentElement.firstChild);
    if (!d.body) d.documentElement.appendChild(d.createElement('body'));
    U.clear(d.head);
    U.clear(d.body);
    var meta = d.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    d.head.appendChild(meta);
    try { d.title = 'Altyazı Şefi · Türkçe altyazı'; } catch (e) { /* */ }
    installStyles(win);
    d.documentElement.classList.add('as-pip-doc');
    d.documentElement.setAttribute('lang', 'tr');
    d.body.className = 'as-pip';
    var stage = mk(d, 'div', 'as-pip-stage');
    var built = buildOverlay(d, 'as-sub--pip', true);
    stage.appendChild(built.overlay);
    d.body.appendChild(stage);

    var rec = { win: win, kind: kind, overlay: built.overlay, linesEl: built.linesEl, poll: null, onHide: null };
    rec.onHide = function () { if (pip === rec) onPipGone(); };
    win.addEventListener('pagehide', rec.onHide);
    if (kind === 'popup') {
      rec.poll = setInterval(function () {
        var closed = true;
        try { closed = win.closed; } catch (e) { closed = true; }
        if (closed && pip === rec) onPipGone();
      }, 800);
    }
    pip = rec;
    applyVars(rec.overlay);
    renderInto(rec, lines);
    AS.bus.emit('pip', { open: true, kind: kind });
  }

  function onPipGone() {
    var rec = pip;
    if (!rec) return;
    pip = null;
    if (rec.poll) clearInterval(rec.poll);
    try { rec.win.removeEventListener('pagehide', rec.onHide); } catch (e) { /* */ }
    AS.bus.emit('pip', { open: false, kind: rec.kind });
  }

  function openPopup() {
    var win = null;
    try { win = root.open('', 'as-altyazi', 'popup,width=960,height=200'); } catch (e) { win = null; }
    if (!win) {
      status('Altyazı penceresi engellendi. Adres çubuğundaki simgeden açılır pencerelere izin verip tekrar deneyin.', 'warn');
      return false;
    }
    try {
      void win.document.body;   // aynı köken mi?
      setupPip(win, 'popup');
      try { win.focus(); } catch (e) { /* */ }
      return true;
    } catch (e) {
      try { win.close(); } catch (x) { /* */ }
      status('Altyazı penceresi açılamadı.', 'error');
      return false;
    }
  }

  /** Kullanıcı tıklamasıyla çağrılmalı. */
  function openPip() {
    if (isPipOpen()) {
      try { pip.win.focus(); } catch (e) { /* */ }
      return Promise.resolve(true);
    }
    var dpip = root.documentPictureInPicture;
    if (dpip && typeof dpip.requestWindow === 'function') {
      var req;
      try { req = dpip.requestWindow({ width: 960, height: 200 }); } catch (e) { req = Promise.reject(e); }
      return Promise.resolve(req).then(function (win) {
        setupPip(win, 'docpip');
        return true;
      }, function (e) {
        if (root.console) console.warn('[AS.subs] documentPictureInPicture:', e && e.message);
        if (e && e.name === 'NotAllowedError') {
          status('Altyazı penceresi yalnızca bir düğmeye tıklayınca açılabilir. Tekrar tıklayın.', 'warn');
          return false;
        }
        return openPopup();
      });
    }
    return Promise.resolve(openPopup());
  }

  function closePip() {
    var rec = pip;
    if (!rec) return;
    onPipGone();
    try { rec.win.close(); } catch (e) { /* */ }
  }

  /* ------------------------------------------------------------------ */
  /* tam ekran                                                           */
  /* ------------------------------------------------------------------ */
  function fsElement() { return doc.fullscreenElement || doc.webkitFullscreenElement || null; }
  function isFullscreen(stage) { var f = fsElement(); return !!f && (!stage || f === stage); }

  function enterFs(stage) {
    var req = stage.requestFullscreen || stage.webkitRequestFullscreen || stage.webkitRequestFullScreen;
    if (typeof req !== 'function') {
      status('Bu tarayıcı tam ekranı desteklemiyor.', 'warn');
      return Promise.resolve(false);
    }
    var r;
    try { r = req.call(stage, { navigationUI: 'hide' }); } catch (e) { r = Promise.reject(e); }
    return Promise.resolve(r).then(function () { return true; }, function () {
      status('Tam ekran açılamadı. Düğmeye tekrar tıklayın.', 'warn');
      return false;
    });
  }

  function fullscreen(stage) {
    if (!stage || stage.nodeType !== 1) return Promise.resolve(false);
    var cur = fsElement();
    if (cur) {
      var exit = doc.exitFullscreen || doc.webkitExitFullscreen || doc.webkitCancelFullScreen;
      var p;
      try { p = exit ? exit.call(doc) : null; } catch (e) { p = null; }
      return Promise.resolve(p).then(function () {
        return cur === stage ? false : enterFs(stage);
      }, function () { return false; });
    }
    return enterFs(stage);
  }

  /* ------------------------------------------------------------------ */
  /* olaylar                                                             */
  /* ------------------------------------------------------------------ */
  AS.bus.on('subtitle', show);
  AS.settings.onChange(function (key, value) {
    if (VISUAL_KEYS[key]) applyAllVars();
    else if (key === 'holdMs') {
      var h = holdMs();
      for (var i = 0; i < lines.length; i++) lines[i].until = lines[i].at + h;
      expire();
    }
  });
  root.addEventListener('pagehide', function (e) {
    // Açılır pencere ana sayfayla birlikte kapanmaz; Document PiP kendiliğinden kapanır.
    if (e && e.persisted) return;
    if (pip && pip.kind === 'popup') { try { pip.win.close(); } catch (x) { /* */ } }
  });

  AS.subs = {
    attach: attach,
    detach: detach,
    show: show,
    clear: clear,
    openPip: openPip,
    closePip: closePip,
    isPipOpen: isPipOpen,
    fullscreen: fullscreen,
    isFullscreen: isFullscreen,
    current: current,
    sample: sample
  };
})(typeof window !== 'undefined' ? window : globalThis);

/* Altyazı Şefi Web: uygulama kabuğu (AS.app).
 * Üst bilgi, sekmeler (Canlı çeviri / Video dosyası / YouTube / Ayarlar / Yardım), mod bağlama,
 * ayarlar ekranı, durum çubuğu, tarayıcı yetenek bandı, "Çevrimdışı için hazırla", hizmet çalışanı kaydı.
 * Tüm DOM AS.util.el ile kurulur (innerHTML yok); simgeler createElementNS ile çizilir. */
(function (root) {
  'use strict';
  var AS = root.AS;
  if (!AS || !AS.util) throw new Error('ns.js önce yüklenmeli');
  var U = AS.util;
  var el = U.el;
  var doc = root.document;
  var SVGNS = 'http://www.w3.org/2000/svg';

  var LS_TAB = 'as.ui.tab';
  var LS_BANNER = 'as.ui.banner.';
  var LS_PREP = 'as.ui.offlineReady';

  function lsGet(k) { try { return root.localStorage ? root.localStorage.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (root.localStorage) root.localStorage.setItem(k, String(v)); } catch (e) { /* kapalı/dolu */ } }

  function errMsg(e) {
    var m = (e && (e.message || e.name)) || String(e || 'bilinmeyen hata');
    m = String(m).replace(/\s+/g, ' ').trim();
    return m.length > 160 ? m.slice(0, 157) + '…' : m;
  }
  function joinTr(list) {
    if (list.length <= 1) return list.join('');
    return list.slice(0, -1).join(', ') + ' ve ' + list[list.length - 1];
  }
  function emitStatus(text, level, mode) {
    AS.bus.emit('status', { mode: mode || 'app', text: text, level: level || 'info' });
  }

  /* ------------------------------------------------------------------ */
  /* simgeler                                                            */
  /* ------------------------------------------------------------------ */
  var ICONS = {
    live: [['rect', { x: 2, y: 3.5, width: 20, height: 13.5, rx: 2.5 }], ['path', { d: 'M8 21h8M12 17v4' }], ['path', { d: 'M7 13h10M9.5 10h5' }]],
    file: [['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2.5 }], ['path', { d: 'M7.5 3v18M16.5 3v18M3 7.5h4.5M3 12h18M3 16.5h4.5M16.5 7.5H21M16.5 16.5H21' }]],
    youtube: [['rect', { x: 2, y: 5, width: 20, height: 14, rx: 4 }], ['path', { d: 'M10 9.3v5.4l4.6-2.7z', fill: 'currentColor' }]],
    settings: [['path', { d: 'M4 7h9M17.5 7H20M4 17h2.5M11 17h9' }], ['circle', { cx: 15.2, cy: 7, r: 2.3 }], ['circle', { cx: 8.8, cy: 17, r: 2.3 }]],
    help: [['circle', { cx: 12, cy: 12, r: 9.5 }], ['path', { d: 'M9.4 9.3a2.7 2.7 0 0 1 5.2 1c0 1.8-2.6 2.3-2.6 4' }], ['path', { d: 'M12 17.4h.01', 'stroke-width': 2.8 }]],
    info: [['circle', { cx: 12, cy: 12, r: 9.5 }], ['path', { d: 'M12 11v5.5' }], ['path', { d: 'M12 7.7h.01', 'stroke-width': 2.8 }]],
    download: [['path', { d: 'M12 3.5v11M7 10l5 5 5-5M5 20h14' }]],
    check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
    pip: [['rect', { x: 2.5, y: 4, width: 19, height: 15, rx: 2.5 }], ['rect', { x: 11.5, y: 11, width: 7.5, height: 5.5, rx: 1.2, fill: 'currentColor', stroke: 'none' }]],
    close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
    warn: [['path', { d: 'M10.3 4.2L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z' }], ['path', { d: 'M12 9.5v4.2' }], ['path', { d: 'M12 17.3h.01', 'stroke-width': 2.8 }]],
    ok: [['circle', { cx: 12, cy: 12, r: 9.5 }], ['path', { d: 'M8 12.3l2.7 2.7L16.2 9.5' }]],
    error: [['circle', { cx: 12, cy: 12, r: 9.5 }], ['path', { d: 'M12 7.5v5.5' }], ['path', { d: 'M12 16.4h.01', 'stroke-width': 2.8 }]],
    reload: [['path', { d: 'M20 12a8 8 0 1 1-2.34-5.66' }], ['path', { d: 'M20 4v5h-5' }]],
    reset: [['path', { d: 'M4 12a8 8 0 1 0 2.34-5.66' }], ['path', { d: 'M4 4v5h5' }]],
    globe: [['circle', { cx: 12, cy: 12, r: 9.5 }], ['path', { d: 'M2.5 12h19M12 2.5c2.6 2.8 3.8 6 3.8 9.5s-1.2 6.7-3.8 9.5c-2.6-2.8-3.8-6-3.8-9.5s1.2-6.7 3.8-9.5z' }]],
    mic: [['rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }], ['path', { d: 'M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21' }]],
    type: [['path', { d: 'M4 7.5V5h16v2.5M12 5v14M9 19h6' }]],
    shield: [['path', { d: 'M12 3l8 3v5.5c0 4.6-3.3 8.4-8 9.5-4.7-1.1-8-4.9-8-9.5V6z' }], ['path', { d: 'M8.8 12.2l2.2 2.2 4.3-4.4' }]],
    lock: [['rect', { x: 4.5, y: 10.5, width: 15, height: 10, rx: 2 }], ['path', { d: 'M8 10.5V7.5a4 4 0 0 1 8 0v3' }]],
    tool: [['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1' }]]
  };

  function icon(name, cls) {
    var spec = ICONS[name] || ICONS.info;
    var s = doc.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
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

  /* ------------------------------------------------------------------ */
  /* sekmeler                                                            */
  /* ------------------------------------------------------------------ */
  var TABS = [
    { id: 'live', mode: true, hash: 'canli', icon: 'live', label: 'Canlı çeviri', sub: 'Sekme veya ekran',
      desc: 'Başka bir sekmede ya da pencerede oynayan videonun altyazısını veya konuşmasını anında Türkçeye çevirir.' },
    { id: 'file', mode: true, hash: 'dosya', icon: 'file', label: 'Video dosyası', sub: 'Bilgisayarınızdan',
      desc: 'Bilgisayarınızdaki videoyu oynatır; altyazı dosyasını ya da konuşmayı Türkçeye çevirir ve Türkçe SRT olarak kaydeder.' },
    { id: 'youtube', mode: true, hash: 'youtube', icon: 'youtube', label: 'YouTube', sub: 'Bağlantı yapıştırın',
      desc: 'YouTube bağlantısını yapıştırın; videonun altyazı dosyasından ya da sesinden Türkçe altyazı üretir.' },
    { id: 'settings', hash: 'ayarlar', icon: 'settings', label: 'Ayarlar',
      desc: 'Değişiklikler hemen uygulanır ve bu tarayıcıda saklanır.' },
    { id: 'help', hash: 'yardim', icon: 'help', label: 'Yardım',
      desc: 'Her bölümün kısa kullanım rehberi, tarayıcı notları ve sık karşılaşılan sorunların çözümü.' }
  ];
  var TAB_BY_ID = {};
  TABS.forEach(function (t) { TAB_BY_ID[t.id] = t; });

  var ui = {
    started: false,
    root: null,
    tabs: {},
    panels: {},
    active: null,
    mounted: null,      // {id, mode}
    status: null,
    progress: null,
    banners: null,
    pipBtn: null,
    prepBtns: [],
    settings: null
  };

  function defaultTab() {
    var b = U.browser();
    return b.displayMedia ? 'live' : 'file';
  }
  function tabFromHash() {
    var h = String(root.location.hash || '').replace(/^#/, '');
    for (var i = 0; i < TABS.length; i++) if (TABS[i].hash === h) return TABS[i].id;
    return null;
  }

  function select(id, opts) {
    opts = opts || {};
    if (!TAB_BY_ID[id]) id = defaultTab();
    ui.active = id;
    TABS.forEach(function (t) {
      var on = t.id === id;
      var btn = ui.tabs[t.id];
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
      ui.panels[t.id].panel.hidden = !on;
    });
    var tab = TAB_BY_ID[id];
    if (tab.mode) mountMode(id);
    if (id === 'settings' && ui.settings) ui.settings.refresh();
    lsSet(LS_TAB, id);
    if (opts.updateHash !== false) {
      try {
        var url = root.location.pathname + root.location.search + '#' + tab.hash;
        if (root.location.hash !== '#' + tab.hash) root.history.replaceState(null, '', url);
      } catch (e) { /* file:// vb. */ }
    }
    if (opts.focus) ui.tabs[id].focus();
    AS.bus.emit('tab', { id: id });
  }

  function onTabKey(e) {
    var keys = { ArrowLeft: -1, ArrowRight: 1, Home: 'first', End: 'last' };
    if (!(e.key in keys)) return;
    e.preventDefault();
    var ids = TABS.map(function (t) { return t.id; });
    var cur = ids.indexOf(e.currentTarget.getAttribute('data-tab'));
    var k = keys[e.key];
    var next = k === 'first' ? 0 : k === 'last' ? ids.length - 1 : (cur + k + ids.length) % ids.length;
    ui.tabs[ids[next]].focus();
  }

  /* ------------------------------------------------------------------ */
  /* modlar                                                              */
  /* ------------------------------------------------------------------ */
  function modeObj(id) {
    var m = AS.modes && AS.modes[id];
    return (m && typeof m.mount === 'function') ? m : null;
  }

  function mountMode(id) {
    var m = ui.mounted;
    if (m && m.id === id && (m.mode || !modeObj(id))) return;   // zaten bağlı (yer tutucuysa ve mod geldiyse yeniden dene)
    unmountMode();
    var host = ui.panels[id].mount;
    U.clear(host);
    var mode = modeObj(id);
    ui.mounted = { id: id, mode: mode };
    if (!mode) { host.appendChild(placeholder(id, null)); return; }
    try {
      var r = mode.mount(host);
      if (r && typeof r.then === 'function') r.then(null, function (e) { modeFailed(id, mode, e); });
    } catch (e) { modeFailed(id, mode, e); }
  }

  function unmountMode() {
    var m = ui.mounted;
    ui.mounted = null;
    if (!m) return;
    if (m.mode && typeof m.mode.unmount === 'function') {
      try {
        var r = m.mode.unmount();
        if (r && typeof r.then === 'function') r.then(null, function (e) { if (root.console) console.error('[AS.app] unmount', e); });
      } catch (e) { if (root.console) console.error('[AS.app] unmount', e); }
    }
    U.clear(ui.panels[m.id].mount);
  }

  function modeFailed(id, mode, e) {
    if (root.console) console.error('[AS.app] mod açılamadı:', id, e);
    if (ui.mounted && ui.mounted.id === id && ui.mounted.mode === mode) {
      var host = ui.panels[id].mount;
      U.clear(host);
      host.appendChild(placeholder(id, e));
    }
    emitStatus(TAB_BY_ID[id].label + ' bölümü açılamadı: ' + errMsg(e), 'error', id);
  }

  function placeholder(id, err) {
    var t = TAB_BY_ID[id];
    return el('div', { class: 'as-placeholder' + (err ? ' as-placeholder--error' : ''), role: err ? 'alert' : null },
      el('div', { class: 'as-placeholder__icon' }, icon(err ? 'warn' : t.icon)),
      el('h3', { class: 'as-placeholder__title' }, err ? 'Bu bölüm açılamadı' : 'Bu bölüm henüz yüklenmedi'),
      el('p', { class: 'as-placeholder__text' }, err
        ? 'Bir hata oluştu (' + errMsg(err) + '). Sayfayı yenileyip tekrar deneyin.'
        : '"' + t.label + '" bölümünün dosyası yüklenemedi. Sayfayı yenilemeyi deneyin; sorun sürerse diğer bölümleri kullanabilirsiniz.'),
      el('div', { class: 'as-row' },
        el('button', { class: 'as-btn', type: 'button', on: { click: function () { root.location.reload(); } } }, icon('reload'), 'Sayfayı yenile'),
        el('button', { class: 'as-btn as-btn--ghost', type: 'button', on: { click: function () { select('help', { focus: true }); } } }, 'Yardım')));
  }

  /* ------------------------------------------------------------------ */
  /* durum çubuğu                                                        */
  /* ------------------------------------------------------------------ */
  var LEVELS = { info: 1, ok: 1, warn: 1, error: 1, busy: 1 };
  var MODE_TAG = { live: 'Canlı', file: 'Dosya', youtube: 'YouTube' };
  var WHAT_LABEL = {
    'asr-model': 'Konuşma modeli indiriliyor',
    'ocr-model': 'Ekran okuma motoru hazırlanıyor',
    translator: 'Cihaz çeviri modeli indiriliyor',
    pretranslate: 'Altyazılar çevriliyor',
    transcribe: 'Konuşma yazıya dökülüyor',
    'app-files': 'Uygulama dosyaları indiriliyor'
  };

  function buildStatusBar() {
    var dot = el('span', { class: 'as-status__dot', 'aria-hidden': 'true' });
    var tag = el('span', { class: 'as-status__mode', hidden: true });
    var text = el('span', { class: 'as-status__text', role: 'status', 'aria-live': 'polite' }, 'Hazır. Yukarıdan bir bölüm seçin.');
    var status = el('div', { class: 'as-status', 'data-level': 'info' }, dot, tag, text);
    var bar = el('div', { class: 'as-progress__bar' });
    var prog = el('div', { class: 'as-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'İlerleme' }, bar);
    var plabel = el('span', { class: 'as-pbar__label' });
    var pct = el('span', { class: 'as-pbar__pct' });
    var more = el('span', { class: 'as-pbar__more' });
    var pbar = el('div', { class: 'as-pbar', hidden: true }, plabel, prog, pct, more);
    var footer = el('footer', { class: 'as-statusbar' }, el('div', { class: 'as-wrap as-statusbar__in' }, status, pbar));
    ui.status = { root: status, tag: tag, text: text };
    ui.progress = { root: pbar, bar: bar, prog: prog, label: plabel, pct: pct, more: more, items: {}, raf: 0 };
    return footer;
  }

  function onStatus(s) {
    if (!s || typeof s !== 'object' || !ui.status) return;
    var text = String(s.text === undefined || s.text === null ? '' : s.text).replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (text.length > 300) text = text.slice(0, 297) + '…';
    var level = LEVELS[s.level] ? s.level : 'info';
    ui.status.root.setAttribute('data-level', level);
    var tag = MODE_TAG[s.mode] || '';
    ui.status.tag.textContent = tag;
    ui.status.tag.hidden = !tag;
    ui.status.text.textContent = text;
    ui.status.text.title = text;
  }

  function onProgress(p) {
    if (!p || typeof p !== 'object' || !ui.progress) return;
    var what = (typeof p.what === 'string' && p.what) ? p.what.slice(0, 40) : 'genel';
    var items = ui.progress.items;
    var it = items[what] || (items[what] = { what: what });
    var label = (typeof p.label === 'string' && p.label.trim()) ? p.label.trim() : (WHAT_LABEL[what] || 'İşleniyor');
    it.label = label.length > 120 ? label.slice(0, 117) + '…' : label;
    it.loaded = Math.max(0, Number(p.loaded) || 0);
    it.total = Math.max(0, Number(p.total) || 0);
    it.done = !!p.done;
    it.at = Date.now();
    if (it.timer) { clearTimeout(it.timer); it.timer = null; }
    if (it.done) {
      it.timer = setTimeout(function () {
        if (items[what] === it) { delete items[what]; queueProgress(); }
      }, p.error ? 300 : 1400);
    }
    queueProgress();
  }

  function queueProgress() {
    var P = ui.progress;
    if (P.raf) return;
    var run = function () { P.raf = 0; renderProgress(); };
    P.raf = root.requestAnimationFrame ? root.requestAnimationFrame(run) : setTimeout(run, 16);
    if (doc.hidden) { if (root.cancelAnimationFrame) root.cancelAnimationFrame(P.raf); P.raf = 0; renderProgress(); }
  }

  function renderProgress() {
    var P = ui.progress;
    var list = Object.keys(P.items).map(function (k) { return P.items[k]; });
    if (!list.length) { P.root.hidden = true; return; }
    list.sort(function (a, b) { return (a.done - b.done) || (b.at - a.at); });
    var it = list[0];
    P.root.hidden = false;
    var frac = it.total > 0 ? U.clamp(it.loaded / it.total, 0, 1) : (it.done ? 1 : -1);
    P.prog.classList.toggle('is-indeterminate', frac < 0);
    if (frac >= 0) {
      P.bar.style.width = (frac * 100).toFixed(1) + '%';
      P.pct.textContent = '%' + Math.round(frac * 100);
      P.prog.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
    } else {
      P.bar.style.width = '';
      P.pct.textContent = '';
      P.prog.removeAttribute('aria-valuenow');
    }
    var label = it.label;
    if (it.total >= 100000 && frac >= 0 && !it.done) label += ' · ' + U.fmtBytes(it.loaded) + ' / ' + U.fmtBytes(it.total);
    P.label.textContent = label;
    P.label.title = label;
    P.prog.setAttribute('aria-valuetext', label);
    var active = list.filter(function (x) { return !x.done; }).length;
    P.more.textContent = active > 1 ? '+' + (active - 1) : '';
    P.more.title = active > 1 ? (active - 1) + ' iş daha sürüyor' : '';
  }

  /* ------------------------------------------------------------------ */
  /* yetenek bandı                                                       */
  /* ------------------------------------------------------------------ */
  function browserName(b) {
    return b.edge ? 'Edge' : b.chrome ? 'Chrome' : b.firefox ? 'Firefox' : b.safari ? 'Safari' : b.chromium ? 'Chromium' : 'Bu tarayıcı';
  }

  function renderBanners() {
    var box = ui.banners;
    if (!box) return;
    U.clear(box);
    var b = U.browser();
    var name = browserName(b);
    var items = [];
    if (root.isSecureContext === false) {
      items.push({ id: 'insecure', level: 'error', title: 'Güvenli bağlantı yok',
        text: 'Sayfa https ile açılmadığı için ekran paylaşımı ve çevrimdışı kullanım çalışmaz. Adresi https:// ile açın.' });
    }
    if (typeof root.WebAssembly !== 'object' || typeof root.Worker !== 'function') {
      items.push({ id: 'old', level: 'error', title: 'Tarayıcınız çok eski',
        text: 'Ekran okuma ve konuşma tanıma için WebAssembly gerekir. Güncel Chrome veya Edge kullanın.' });
    }
    var limits = [];
    if (!b.displayMedia) limits.push('Ekran ve sekme paylaşımı yok: "Canlı çeviri" kullanılamaz; "Video dosyası" ve "YouTube" çalışır.');
    else if (!b.tabAudio) limits.push('Başka sekmelerin sesi alınamaz: "Canlı çeviri" yalnızca ekrandaki altyazıları okur, konuşmayı çeviremez.');
    if (!b.docPip) limits.push('Altyazı penceresi her zaman üstte duran pencere yerine normal bir açılır pencere olarak açılır.');
    if (limits.length) {
      items.push({ id: 'limits-' + name, level: 'warn', title: name + ' bazı özellikleri desteklemiyor',
        list: limits, text: 'Tüm özellikler için Windows veya Mac\'te Chrome ya da Edge kullanın.' });
    } else if (!items.length) {
      items.push({ id: 'full-' + name, level: 'ok', title: name + ' tüm özellikleri destekliyor',
        text: 'Sekme sesi, ekrandaki altyazıyı okuma ve her zaman üstte duran altyazı penceresi kullanılabilir' +
          (b.onDeviceTranslator ? '; çeviri cihazınızda da yapılabilir.' : '.') });
    }
    if (!b.onDeviceTranslator && !AS.settings.get('translateOnline')) {
      items.push({ id: 'notranslate', level: 'warn', title: 'Çeviri yapılamaz', sticky: true,
        text: 'Bu tarayıcıda cihaz içi çeviri yok ve çevrim içi çeviri kapalı. Ayarlar\'dan çevrim içi çeviriyi açın.',
        action: { label: 'Ayarlar\'a git', fn: function () { select('settings', { focus: true }); } } });
    }
    items.forEach(function (it) {
      if (!it.sticky && it.level !== 'error' && lsGet(LS_BANNER + it.id) === '1') return;
      var body = el('div', { class: 'as-banner__body' }, el('div', { class: 'as-banner__title' }, it.title));
      if (it.list) body.appendChild(el('ul', { class: 'as-banner__list' }, it.list.map(function (t) { return el('li', null, t); })));
      if (it.text) body.appendChild(el('div', null, it.text));
      var node = el('div', { class: 'as-banner as-banner--' + it.level, role: it.level === 'error' ? 'alert' : 'note', 'data-banner': it.id },
        icon(it.level === 'ok' ? 'ok' : it.level === 'error' ? 'error' : it.level === 'warn' ? 'warn' : 'info', 'as-banner__icon'),
        body);
      if (it.action) node.appendChild(el('button', { class: 'as-btn as-btn--sm', type: 'button', on: { click: it.action.fn } }, it.action.label));
      if (it.level !== 'error' && !it.sticky) {
        node.appendChild(el('button', {
          class: 'as-icon-btn as-banner__close', type: 'button', title: 'Kapat', 'aria-label': 'Bu notu kapat',
          on: { click: function () { lsSet(LS_BANNER + it.id, '1'); if (node.parentNode) node.parentNode.removeChild(node); } }
        }, icon('close')));
      }
      box.appendChild(node);
    });
  }

  /* ------------------------------------------------------------------ */
  /* hizmet çalışanı                                                     */
  /* ------------------------------------------------------------------ */
  var sw = { regPromise: null, reg: null };

  function swAllowed() {
    if (!root.navigator || !('serviceWorker' in root.navigator)) return false;
    var loc = root.location;
    var h = loc.hostname;
    var local = h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
    if (loc.protocol !== 'https:' && !(local && loc.protocol === 'http:')) return false;
    // Test sayfaları (?test=1) ağ taklitleri SW'den etkilenmesin diye kaydetmez; &sw=1 ile açılır.
    var tp = U.testParams();
    if (tp && tp.sw !== '1') return false;
    return true;
  }

  function registerSW() {
    if (!swAllowed()) { sw.regPromise = Promise.resolve(null); return sw.regPromise; }
    sw.regPromise = new Promise(function (resolve) {
      var go = function () {
        root.navigator.serviceWorker.register('sw.js', { scope: './' }).then(function (reg) {
          sw.reg = reg;
          resolve(reg);
        }, function (e) {
          if (root.console) console.warn('[AS.app] Hizmet çalışanı kaydedilemedi:', e);
          resolve(null);
        });
      };
      if (doc.readyState === 'complete') go();
      else root.addEventListener('load', go, { once: true });
    });
    return sw.regPromise;
  }

  function activeWorker(timeoutMs) {
    if (!sw.regPromise) return Promise.resolve(null);
    return sw.regPromise.then(function (reg) {
      if (!reg) return null;
      if (reg.active) return reg.active;
      return Promise.race([
        root.navigator.serviceWorker.ready.then(function (r) { return r.active; }),
        U.sleep(timeoutMs || 10000).then(function () { return null; })
      ]);
    });
  }

  /** SW'ye MessageChannel ile ileti gönderir; 'progress' iletileri zaman aşımını erteler. */
  function swRequest(worker, msg, onProg, idleMs) {
    return new Promise(function (resolve, reject) {
      var ch = new MessageChannel();
      var timer = null;
      function finish() {
        clearTimeout(timer);
        ch.port1.onmessage = null;
        try { ch.port1.close(); } catch (e) { /* */ }
      }
      function arm() {
        clearTimeout(timer);
        timer = setTimeout(function () { finish(); reject(new Error('zaman aşımı')); }, idleMs || 15000);
      }
      ch.port1.onmessage = function (e) {
        var d = e.data || {};
        if (d.type === 'progress') { arm(); if (onProg) { try { onProg(d); } catch (x) { /* */ } } return; }
        finish();
        if (d.type === 'error') reject(new Error(d.message || 'hata'));
        else resolve(d);
      };
      arm();
      try { worker.postMessage(msg, [ch.port2]); } catch (e) { finish(); reject(e); }
    });
  }

  function swStatus() {
    return activeWorker(3000).then(function (w) {
      if (!w) return null;
      return swRequest(w, { type: 'status' }, null, 8000).catch(function () { return null; });
    });
  }

  /* ------------------------------------------------------------------ */
  /* çevrimdışı hazırlık                                                 */
  /* ------------------------------------------------------------------ */
  var prep = { busy: false, ready: false };

  function cacheLibFiles() {
    if (!swAllowed()) {
      return Promise.resolve({ ok: false, skipped: true,
        reason: root.isSecureContext === false ? 'https gerekli'
          : (U.testParams() ? 'test kipinde kapalı' : 'bu tarayıcıda çevrimdışı önbellek yok') });
    }
    return activeWorker(10000).then(function (w) {
      if (!w) throw new Error('Çevrimdışı önbellek henüz hazır değil; sayfayı yenileyip tekrar deneyin.');
      return swRequest(w, { type: 'lib-list' }, null, 8000).then(function (res) {
        var files = (res && Array.isArray(res.files)) ? res.files : [];
        var n = files.length;
        var failed = [];
        var i = 0;
        function emit(frac, done, extra) {
          var label = 'Uygulama dosyaları (' + Math.min(i + 1, n) + '/' + n + ')' + (extra ? ' · ' + extra : '');
          AS.bus.emit('progress', { what: 'app-files', label: done ? 'Uygulama dosyaları hazır' : label,
            loaded: Math.round((i + U.clamp(frac, 0, 1)) * 1000), total: n * 1000, done: !!done });
        }
        function next() {
          if (i >= n) {
            emit(0, true);
            return { ok: failed.length === 0, failed: failed, total: n };
          }
          var url = files[i];
          var name = String(url).split('/').pop();
          emit(0, false, name);
          return swRequest(w, { type: 'cache-file', url: url }, function (m) {
            var t = Number(m.total) || 0;
            var l = Number(m.loaded) || 0;
            emit(t ? l / t : 0, false, name + (t ? ' ' + U.fmtBytes(l) + ' / ' + U.fmtBytes(t) : ' ' + U.fmtBytes(l)));
          }, 120000).then(function (r) {
            if (!r || !r.ok) failed.push(name);
          }, function (e) {
            if (root.console) console.warn('[AS.app] önbelleğe alınamadı:', name, e && e.message);
            failed.push(name);
          }).then(function () { i++; return next(); });
        }
        return next();
      });
    });
  }

  function loadAsr() {
    var A = AS.asr;
    if (!A || typeof A.load !== 'function') return Promise.resolve({ ok: false, skipped: true });
    return Promise.resolve(A.load({ model: AS.settings.get('asrModel') })).then(function (r) {
      return { ok: true, device: r && r.device };
    });
  }

  function prepareOffline() {
    if (prep.busy) return Promise.resolve(null);
    prep.busy = true;
    renderPrepButtons();
    // Kullanıcı hareketi gerektirdiği için cihaz içi çevirmen beklemeden (ilk iş olarak) başlatılır.
    var trP = Promise.resolve(null);
    var T = AS.translate;
    if (T && typeof T.prepareDevice === 'function' && ('Translator' in root)) {
      var from = AS.settings.get('asrLang');
      if (!from || from === 'auto' || from === 'tr') from = 'en';
      try {
        trP = Promise.resolve(T.prepareDevice(from)).then(function (v) { return !!v; }, function () { return false; });
      } catch (e) { trP = Promise.resolve(false); }
    }
    emitStatus('Çevrimdışı kullanım için hazırlanıyor…', 'busy');
    var rep = { files: null, asr: null, translator: null };
    return cacheLibFiles().then(function (r) { rep.files = r; }, function (e) { rep.files = { ok: false, error: errMsg(e) }; })
      .then(function () {
        return loadAsr().then(function (r) { rep.asr = r; }, function (e) { rep.asr = { ok: false, error: errMsg(e) }; });
      })
      .then(function () {
        // Cihaz çevirmeni uzun sürebilir (dil paketi): en fazla 20 sn daha bekle, sonra arka planda sürsün.
        return Promise.race([trP, U.sleep(20000).then(function () { return 'pending'; })]);
      })
      .then(function (tr) {
        rep.translator = tr;
        finishPrep(rep);
        return rep;
      }, function (e) {
        emitStatus('Hazırlık tamamlanamadı: ' + errMsg(e), 'error');
        return rep;
      })
      .then(function (r) {
        prep.busy = false;
        renderPrepButtons();
        if (ui.settings) ui.settings.refresh();
        return r;
      });
  }

  function finishPrep(rep) {
    var good = [];
    var bad = [];
    if (rep.files && rep.files.ok) good.push('uygulama dosyaları');
    else if (rep.files && rep.files.skipped) bad.push('uygulama dosyaları (' + rep.files.reason + ')');
    else bad.push('uygulama dosyaları');
    if (rep.asr && rep.asr.ok) good.push('konuşma modeli');
    else if (!(rep.asr && rep.asr.skipped)) bad.push('konuşma modeli');
    if (rep.translator === true) good.push('cihaz içi çeviri');
    var tail = rep.translator === true ? '' : rep.translator === 'pending'
      ? ' Cihaz çeviri modeli arka planda inmeye devam ediyor.'
      : ' Çeviri için yine internet gerekir.';
    if (!bad.length) {
      prep.ready = true;
      lsSet(LS_PREP, String(Date.now()));
      emitStatus('Hazır: ' + joinTr(good) + ' artık internetsiz de kullanılabilir.' + tail, 'ok');
    } else {
      emitStatus('Bazı parçalar hazırlanamadı: ' + joinTr(bad) + '. İnternet bağlantınızı kontrol edip tekrar deneyin.' +
        (good.length ? ' Hazır olanlar: ' + joinTr(good) + '.' : ''), 'warn');
    }
  }

  function makePrepButton(extraClass) {
    var label = el('span', { class: 'as-btn__label' }, 'Çevrimdışı için hazırla');
    var ico = el('span', { class: 'as-btn__ico' }, icon('download'));
    var btn = el('button', {
      class: 'as-btn' + (extraClass ? ' ' + extraClass : ''), type: 'button',
      title: 'Ekran okuma, konuşma tanıma ve (Chrome\'da) cihaz içi çeviri için gereken her şeyi şimdi indirir; sonra internet olmadan da çalışır.',
      on: { click: function () { prepareOffline(); } }
    }, ico, label);
    var rec = { btn: btn, label: label, ico: ico };
    ui.prepBtns.push(rec);
    return btn;
  }

  function renderPrepButtons() {
    ui.prepBtns.forEach(function (r) {
      r.btn.classList.toggle('is-busy', prep.busy);
      r.btn.setAttribute('aria-busy', prep.busy ? 'true' : 'false');
      r.ico.hidden = prep.busy;
      U.clear(r.ico);
      r.ico.appendChild(icon(prep.ready ? 'check' : 'download'));
      r.label.textContent = prep.busy ? 'Hazırlanıyor…' : prep.ready ? 'Çevrimdışı hazır' : 'Çevrimdışı için hazırla';
    });
  }

  /* ------------------------------------------------------------------ */
  /* üst bilgi                                                           */
  /* ------------------------------------------------------------------ */
  function buildHeader() {
    var net = el('span', { class: 'as-net', role: 'status', title: 'İnternet bağlantısı' });
    function updateNet() {
      var on = root.navigator.onLine !== false;
      net.classList.toggle('is-offline', !on);
      net.textContent = on ? 'Çevrim içi' : 'Çevrim dışı';
    }
    updateNet();
    root.addEventListener('online', updateNet);
    root.addEventListener('offline', updateNet);

    var pipLabel = el('span', { class: 'as-btn__label' }, 'Altyazı penceresi');
    var pipBtn = el('button', {
      class: 'as-btn', type: 'button', 'aria-pressed': 'false',
      title: 'Türkçe altyazıyı her pencerenin üstünde duran ayrı, küçük bir pencerede gösterir.',
      on: { click: onPipClick }
    }, icon('pip'), pipLabel);
    ui.pipBtn = { btn: pipBtn, label: pipLabel };

    return el('header', { class: 'as-header' },
      el('div', { class: 'as-wrap as-header__in' },
        el('div', { class: 'as-brand' },
          el('img', { class: 'as-brand__logo', src: 'icons/logo.svg', alt: '', width: '54', height: '54' }),
          el('div', { class: 'as-brand__text' },
            el('h1', { class: 'as-brand__name' }, 'Altyazı Şefi', el('span', { class: 'as-brand__web' }, 'Web')),
            el('div', { class: 'as-brand__tag' }, 'Yabancı altyazıyı ve konuşmayı anında Türkçeye çevirir'))),
        el('div', { class: 'as-header__actions' }, net, pipBtn, makePrepButton(''))));
  }

  function onPipClick() {
    var S = AS.subs;
    if (!S) { emitStatus('Altyazı penceresi kullanılamıyor.', 'error'); return; }
    if (S.isPipOpen()) { S.closePip(); return; }
    S.openPip().then(function (ok) {
      if (ok) emitStatus('Altyazı penceresi açıldı. Pencereyi videonun yanına ya da altına sürükleyin.', 'ok');
    }, function (e) { emitStatus('Altyazı penceresi açılamadı: ' + errMsg(e), 'error'); });
  }

  function onPipChange(ev) {
    if (!ui.pipBtn) return;
    var open = !!(ev && ev.open);
    ui.pipBtn.btn.setAttribute('aria-pressed', open ? 'true' : 'false');
    ui.pipBtn.btn.classList.toggle('is-active', open);
    ui.pipBtn.label.textContent = open ? 'Pencereyi kapat' : 'Altyazı penceresi';
  }

  /* ------------------------------------------------------------------ */
  /* ayarlar                                                             */
  /* ------------------------------------------------------------------ */
  function fmtSec(ms, digits) {
    return (ms / 1000).toLocaleString('tr-TR', { minimumFractionDigits: digits || 0, maximumFractionDigits: 1 }) + ' sn';
  }
  function regionText(r) {
    if (!r || typeof r !== 'object') return 'Varsayılan';
    var pc = function (v) { return Math.round(U.clamp(Number(v) || 0, 0, 1) * 100); };
    var x = pc(r.x), y = pc(r.y), w = pc(r.w), h = pc(r.h);
    if (x === 0 && w === 100 && y + h >= 99) return 'Alt şerit · yükseklik %' + h;
    if (x === 0 && w === 100 && y === 0) return 'Üst şerit · yükseklik %' + h;
    return 'Özel bölge · %' + w + ' × %' + h;
  }

  var SETTINGS = [
    { group: 'look', key: 'fontSize', type: 'range', min: 18, max: 72, step: 1, label: 'Yazı boyutu',
      fmt: function (v) { return v + ' px'; },
      info: 'Türkçe altyazının büyüklüğü (1280 piksel genişliğindeki görüntüye göre); video küçüldükçe yazı da orantılı küçülür.' },
    { group: 'look', key: 'bgOpacity', type: 'range', min: 0, max: 1, step: 0.05, label: 'Arka plan koyuluğu',
      fmt: function (v) { return '%' + Math.round(v * 100); },
      info: 'Yazının arkasındaki siyah kutunun koyuluğu; 0 seçerseniz yalnızca gölgeli yazı görünür.' },
    { group: 'look', key: 'position', type: 'seg', options: [['bottom', 'Altta'], ['top', 'Üstte']], label: 'Altyazı konumu',
      info: 'Videonun kendi altyazısıyla çakışıyorsa Türkçe altyazıyı üste alın.' },
    { group: 'look', key: 'showOriginal', type: 'switch', label: 'Orijinal metni de göster',
      info: 'Türkçe çevirinin altında, küçük sarı yazıyla kaynak dildeki metni de gösterir; dil öğrenirken işe yarar.' },
    { group: 'look', key: 'holdMs', type: 'range', min: 2000, max: 15000, step: 500, label: 'Ekranda kalma süresi',
      fmt: function (v) { return fmtSec(v, v % 1000 ? 1 : 0); },
      info: 'Yeni altyazı gelmezse son satır bu süre dolunca ekrandan silinir.' },
    { group: 'live', key: 'liveMode', type: 'select', label: 'Canlı çeviri yöntemi',
      options: [['auto', 'Otomatik (önerilen)'], ['ocr', 'Yalnızca ekrandaki altyazıyı oku'], ['speech', 'Yalnızca konuşmayı dinle']],
      info: 'Otomatik yöntem ekranda altyazı varsa onu okur; birkaç saniye altyazı görmezse konuşmayı dinleyip çevirir.' },
    { group: 'live', key: 'ocrInterval', type: 'range', min: 200, max: 1500, step: 100, label: 'Ekran okuma sıklığı',
      fmt: function (v) { return fmtSec(v, 1); },
      info: 'Ekrandaki altyazı bu aralıkla okunur; kısaltmak daha hızlı tepki verir ama işlemciyi daha çok yorar.' },
    { group: 'live', key: 'ocrRegion', type: 'region', label: 'Altyazı bölgesi',
      info: 'Ekranın yalnızca bu kısmı okunur; "Canlı çeviri" bölümünde turuncu kutuyu sürükleyerek değiştirebilirsiniz.' },
    { group: 'asr', key: 'asrModel', type: 'select', label: 'Konuşma tanıma modeli',
      options: [['tiny', 'Hızlı (tiny)'], ['base', 'Dengeli (base), önerilen'], ['small', 'En doğru (small)']],
      info: 'Büyük model daha doğru yazar ama yavaştır; ilk indirme yaklaşık hızlı 40 MB, dengeli 80–130 MB, en doğru 250–450 MB.' },
    { group: 'asr', key: 'asrLang', type: 'select', label: 'Konuşma dili', options: U.LANGS,
      info: 'Videonun dilini biliyorsanız seçin; otomatik algılamadan daha doğru ve hızlıdır.' },
    { group: 'tr', key: 'translateOnline', type: 'switch', label: 'Çevrim içi çeviriye izin ver',
      info: 'Cihazda çeviri yoksa yalnızca çevrilecek metin Google Çeviri\'ye veya MyMemory\'ye gönderilir; kapatırsanız metin bilgisayarınızdan çıkmaz.' }
  ];

  function setSetting(key, value) {
    try { AS.settings.set(key, value); } catch (e) { emitStatus('Ayar kaydedilemedi: ' + errMsg(e), 'error'); }
  }

  function makeControl(def, id) {
    var cur = AS.settings.get(def.key);
    if (def.type === 'range') {
      var badge = el('span', { class: 'as-badge', 'aria-hidden': 'true' });
      var input = el('input', {
        class: 'as-range', type: 'range', id: id, min: String(def.min), max: String(def.max), step: String(def.step),
        on: { input: function () { var v = Number(input.value); badge.textContent = def.fmt(v); input.setAttribute('aria-valuetext', def.fmt(v)); setSetting(def.key, v); } }
      });
      var upd = function (v) {
        input.value = String(v);
        badge.textContent = def.fmt(Number(v));
        input.setAttribute('aria-valuetext', def.fmt(Number(v)));
      };
      upd(cur);
      return { node: [input, badge], update: upd, labelFor: id };
    }
    if (def.type === 'switch') {
      var cb = el('input', { class: 'as-switch', type: 'checkbox', role: 'switch', id: id,
        on: { change: function () { setSetting(def.key, !!cb.checked); } } });
      var updS = function (v) { cb.checked = !!v; };
      updS(cur);
      return { node: cb, update: updS, labelFor: id };
    }
    if (def.type === 'select') {
      var sel = el('select', { class: 'as-select', id: id, on: { change: function () { setSetting(def.key, String(sel.value)); } } },
        def.options.map(function (o) { return el('option', { value: o[0] }, o[1]); }));
      var updSel = function (v) { sel.value = String(v); };
      updSel(cur);
      return { node: sel, update: updSel, labelFor: id };
    }
    if (def.type === 'seg') {
      var btns = {};
      var group = el('div', { class: 'as-seg', role: 'group', 'aria-labelledby': id + '-label' },
        def.options.map(function (o) {
          var b = el('button', { type: 'button', 'aria-pressed': 'false', 'data-value': o[0],
            on: { click: function () { setSetting(def.key, o[0]); } } }, o[1]);
          btns[o[0]] = b;
          return b;
        }));
      var updSeg = function (v) { for (var k in btns) btns[k].setAttribute('aria-pressed', k === v ? 'true' : 'false'); };
      updSeg(cur);
      return { node: group, update: updSeg, labelFor: null };
    }
    if (def.type === 'region') {
      var txt = el('span', { class: 'as-chip', id: id });
      var reset = el('button', { class: 'as-btn as-btn--sm as-btn--ghost', type: 'button', title: 'Varsayılan bölgeye döndür',
        on: { click: function () { setSetting('ocrRegion', AS.settings.defaults().ocrRegion); } } }, icon('reset'), 'Sıfırla');
      var updR = function (v) { txt.textContent = regionText(v); };
      updR(cur);
      return { node: [txt, reset], update: updR, labelFor: null };
    }
    return { node: null, update: function () {} };
  }

  function settingRow(def, controls) {
    var id = 'as-set-' + def.key;
    var infoId = id + '-info';
    var box = el('div', { class: 'as-set__info', id: infoId, hidden: true }, def.info);
    var btn = el('button', {
      class: 'as-info-btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': infoId,
      title: 'Bu ayar ne işe yarar?', 'aria-label': def.label + ': açıklamayı göster',
      on: { click: function () { var open = box.hidden; box.hidden = !open; btn.setAttribute('aria-expanded', open ? 'true' : 'false'); } }
    }, icon('info'));
    var ctrl = makeControl(def, id);
    controls[def.key] = ctrl;
    var labelEl = ctrl.labelFor
      ? el('label', { for: ctrl.labelFor, id: id + '-label' }, def.label)
      : el('span', { id: id + '-label' }, def.label);
    return el('div', { class: 'as-set', 'data-key': def.key },
      el('div', { class: 'as-set__row' },
        el('div', { class: 'as-set__label' }, labelEl, btn),
        el('div', { class: 'as-set__ctrl as-set__ctrl--' + def.type }, ctrl.node)),
      box);
  }

  function card(iconName, title, sub) {
    var c = el('section', { class: 'as-card' },
      el('div', { class: 'as-card__head' },
        el('div', { class: 'as-card__icon' }, icon(iconName)),
        el('div', null, el('h3', { class: 'as-card__title' }, title), sub ? el('div', { class: 'as-card__sub' }, sub) : null)));
    return c;
  }

  function statusItem(name) {
    var chip = el('span', { class: 'as-chip' }, '…');
    var row = el('div', { class: 'as-status-item' }, el('span', { class: 'as-status-item__name' }, name), chip);
    return { row: row, set: function (text, kind, title) {
      chip.textContent = text;
      chip.className = 'as-chip' + (kind ? ' as-chip--' + kind : '');
      chip.title = title || '';
    } };
  }

  var DEVICE_TEXT = {
    available: ['Hazır', 'ok', 'Çeviri cihazınızda yapılır; internet gerekmez.'],
    downloadable: ['İndirilebilir', null, 'Dil paketi indirilirse çeviri internetsiz yapılır.'],
    downloading: ['İniyor…', 'accent', 'Dil paketi indiriliyor.'],
    unavailable: ['Bu dil için yok', 'warn', 'Bu dil çifti için cihaz içi çeviri yok; çevrim içi çeviri kullanılır.'],
    unsupported: ['Tarayıcıda yok', 'warn', 'Cihaz içi çeviri yalnızca güncel Chrome/Edge\'de var; çevrim içi çeviri kullanılır.'],
    unknown: ['Denetlenemedi', null, 'Tarayıcı yanıt vermedi; çeviri gerekirse çevrim içi servisler kullanılır.']
  };

  function buildSettings(panelBody) {
    var controls = {};
    var groups = { look: [], live: [], asr: [], tr: [] };
    SETTINGS.forEach(function (d) { groups[d.group].push(settingRow(d, controls)); });

    // Görünüm + önizleme
    var look = card('type', 'Altyazı görünümü', 'Türkçe altyazının videodaki ve altyazı penceresindeki görünüşü');
    var preview = el('div', { class: 'as-stage as-preview', 'aria-label': 'Altyazı önizlemesi' },
      el('div', { class: 'as-preview__bg' }), el('span', { class: 'as-preview__tag' }, 'Önizleme'));
    look.appendChild(preview);
    groups.look.forEach(function (n) { look.appendChild(n); });

    var live = card('live', 'Canlı çeviri', 'Sekme veya ekran paylaşırken');
    groups.live.forEach(function (n) { live.appendChild(n); });

    var asr = card('mic', 'Konuşma tanıma', 'Konuşmayı yazıya döken yapay zekâ modeli (bilgisayarınızda çalışır)');
    groups.asr.forEach(function (n) { asr.appendChild(n); });

    var tr = card('globe', 'Çeviri', 'Hedef dil her zaman Türkçe');
    groups.tr.forEach(function (n) { tr.appendChild(n); });
    var devItem = statusItem('Cihaz içi çeviri (Chrome)');
    var trList = el('div', { class: 'as-status-list' }, devItem.row);
    var devBtn = el('button', { class: 'as-btn as-btn--sm', type: 'button', hidden: true,
      title: 'Seçili konuşma dilinden Türkçeye çeviri paketini indirir (bir kez).',
      on: { click: function () {
        var T = AS.translate;
        if (!T || typeof T.prepareDevice !== 'function') return;
        var from = AS.settings.get('asrLang');
        if (!from || from === 'auto' || from === 'tr') from = 'en';
        devBtn.classList.add('is-busy');
        Promise.resolve(T.prepareDevice(from)).catch(function () { return false; }).then(function () {
          devBtn.classList.remove('is-busy');
          refresh();
        });
      } } }, icon('download'), 'Cihaz çevirisini hazırla');
    var clearBtn = el('button', { class: 'as-btn as-btn--sm as-btn--ghost', type: 'button',
      title: 'Bu tarayıcıda saklanan çevrilmiş cümleleri (çeviri hafızası) siler.',
      on: { click: function () {
        var T = AS.translate;
        if (!T || typeof T.clearCache !== 'function') return;
        clearBtn.classList.add('is-busy');
        Promise.resolve().then(function () { return T.clearCache(); }).then(function () {
          emitStatus('Çeviri geçmişi silindi.', 'ok');
        }, function (e) {
          emitStatus('Çeviri geçmişi silinemedi: ' + errMsg(e), 'error');
        }).then(function () { clearBtn.classList.remove('is-busy'); });
      } } }, icon('reset'), 'Çeviri geçmişini sil');
    tr.appendChild(el('div', { class: 'as-divider' }));
    tr.appendChild(trList);
    tr.appendChild(devBtn);
    tr.appendChild(clearBtn);

    var off = card('download', 'Çevrimdışı kullanım', 'Bir kez hazırlayın, sonra internetsiz çalışsın');
    var filesItem = statusItem('Uygulama dosyaları (~17 MB)');
    var modelItem = statusItem('Konuşma modeli');
    var devItem2 = statusItem('Cihaz içi çeviri');
    off.appendChild(el('p', { class: 'as-hint' },
      'Ekran okuma, konuşma tanıma ve (Chrome\'da) cihaz içi çeviri için gereken dosyaları şimdi indirir. Sonra internet olmadan da çalışır; yalnızca çevrim içi çeviri internet ister.'));
    off.appendChild(el('div', { class: 'as-status-list' }, filesItem.row, modelItem.row, devItem2.row));
    off.appendChild(el('div', { class: 'as-settings__foot' }, makePrepButton('as-btn--primary')));

    // Sıfırla (iki adımlı onay)
    var resetArmed = null;
    var resetBtn = el('button', { class: 'as-btn as-btn--ghost', type: 'button',
      on: { click: function () {
        if (!resetArmed) {
          resetBtn.lastChild.textContent = 'Emin misiniz? Tekrar tıklayın';
          resetBtn.classList.add('as-btn--danger');
          resetArmed = setTimeout(function () { resetArmed = null; resetBtn.lastChild.textContent = 'Ayarları varsayılana döndür'; resetBtn.classList.remove('as-btn--danger'); }, 4000);
          return;
        }
        clearTimeout(resetArmed);
        resetArmed = null;
        resetBtn.lastChild.textContent = 'Ayarları varsayılana döndür';
        resetBtn.classList.remove('as-btn--danger');
        AS.settings.reset();
        emitStatus('Ayarlar varsayılan değerlere döndürüldü.', 'ok');
      } } }, icon('reset'), el('span', null, 'Ayarları varsayılana döndür'));

    var grid = el('div', { class: 'as-settings' },
      el('div', { class: 'as-settings__col' }, look, off),
      el('div', { class: 'as-settings__col' }, live, asr, tr,
        el('div', { class: 'as-settings__foot' }, resetBtn, el('span', { class: 'as-hint' }, 'Ayarlar yalnızca bu tarayıcıda saklanır.'))));
    panelBody.appendChild(grid);

    if (AS.subs && typeof AS.subs.sample === 'function') {
      AS.subs.sample(preview, [
        { tr: 'Merhaba dostum, nasılsın?', src: 'Hello my friend, how are you?' },
        { tr: 'Bu akşam nereye gidiyorsun?', src: 'Where are you going tonight?' }
      ]);
    }

    function onSetting(key, value) {
      if (controls[key]) controls[key].update(value);
      if (key === 'translateOnline') renderBanners();
      if (key === 'asrLang' || key === 'translateOnline' || key === 'asrModel') refresh();
    }
    AS.settings.onChange(onSetting);

    var refreshSeq = 0;
    function refresh() {
      var my = ++refreshSeq;
      // Cihaz içi çeviri
      var T = AS.translate;
      var infoP = (T && typeof T.info === 'function')
        ? Promise.race([
          Promise.resolve().then(function () { return T.info(); }).catch(function () { return null; }),
          U.sleep(6000).then(function () { return { device: 'unknown' }; })
        ])
        : Promise.resolve(null);
      infoP.then(function (info) {
        if (my !== refreshSeq) return;
        var dev = info && DEVICE_TEXT[info.device] ? info.device : (T && 'Translator' in root ? 'unknown' : 'unsupported');
        var d = DEVICE_TEXT[dev];
        devItem.set(d[0], d[1], d[2]);
        devItem2.set(d[0], d[1], d[2]);
        devBtn.hidden = !(dev === 'downloadable');
      });
      // Uygulama dosyaları
      if (!swAllowed()) {
        var why = root.isSecureContext === false ? 'https gerekli'
          : (U.testParams() ? 'Test kipinde kapalı (&sw=1 ile açılır)' : 'Bu tarayıcıda çevrimdışı önbellek yok');
        filesItem.set('Kullanılamıyor', 'warn', why);
      } else {
        swStatus().then(function (st) {
          if (my !== refreshSeq) return;
          if (!st || !st.lib) { filesItem.set('Bekleniyor', null, 'Çevrimdışı önbellek hazırlanıyor'); return; }
          var keys = Object.keys(st.lib);
          var have = keys.filter(function (k) { return st.lib[k]; }).length;
          if (have === keys.length && keys.length) { filesItem.set('Hazır', 'ok'); prep.ready = prep.ready || !!lsGet(LS_PREP); }
          else filesItem.set(have ? have + '/' + keys.length + ' indirildi' : 'İndirilmedi', null);
          renderPrepButtons();
        });
      }
      // Konuşma modeli
      var A = AS.asr;
      var model = AS.settings.get('asrModel');
      if (!A) { modelItem.set('Yok', 'warn', 'Konuşma tanıma bileşeni yüklenemedi'); }
      else if (typeof A.isLoaded === 'function' && A.isLoaded()) {
        modelItem.set('Yüklü (' + (A.device && A.device() === 'webgpu' ? 'WebGPU' : 'WebAssembly') + ')', 'ok');
      } else {
        modelCached(model).then(function (yes) {
          if (my !== refreshSeq) return;
          modelItem.set(yes ? 'İndirildi' : 'İndirilmedi', yes ? 'ok' : null, yes ? 'Model bu tarayıcıda kayıtlı' : 'İlk kullanımda bir kez indirilir');
        });
      }
    }

    ui.settings = { refresh: refresh, controls: controls, preview: preview };
    refresh();
  }

  /** transformers.js modelleri 'transformers-cache' önbelleğinde saklar. */
  function modelCached(model) {
    if (!root.caches || typeof root.caches.has !== 'function') return Promise.resolve(false);
    var needle = 'whisper-' + model + '/';
    return root.caches.has('transformers-cache').then(function (has) {
      if (!has) return false;
      return root.caches.open('transformers-cache').then(function (c) { return c.keys(); }).then(function (keys) {
        return keys.some(function (r) { return r.url.indexOf(needle) >= 0; });
      });
    }).catch(function () { return false; });
  }

  /* ------------------------------------------------------------------ */
  /* yardım                                                              */
  /* ------------------------------------------------------------------ */
  function rich() {
    // ('düz', ['kalın'], 'düz') → metin ve <strong> düğümleri
    var out = [];
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i];
      out.push(Array.isArray(a) ? el('strong', null, a[0]) : a);
    }
    return out;
  }
  function li() { return el('li', null, rich.apply(null, arguments)); }

  function buildHelp(panelBody) {
    var live = card('live', 'Canlı çeviri (sekme veya ekran)', 'Netflix, Prime Video, ders videoları, canlı yayınlar…');
    live.appendChild(el('ol', null,
      li('Çevirmek istediğiniz videoyu ', ['başka bir sekmede'], ' açın.'),
      li('Burada ', ['Canlı çeviri'], ' bölümünde ', ['"Sekme / pencere seç"'], ' düğmesine basın. Açılan pencerede videonun olduğu ', ['sekmeyi'], ' seçin ve ', ['"Sekme sesini de paylaş"'], ' kutusunu işaretli bırakın.'),
      li('Önizlemedeki ', ['turuncu kutuyu'], ' videonun altyazısının çıktığı yere sürükleyin.'),
      li('Türkçe altyazı önizlemede görünür. ', ['"Altyazı penceresini aç"'], ' düğmesiyle her zaman üstte duran ayrı bir pencerede açıp videonun altına yerleştirin, sonra videonun sekmesine geçin.')));
    live.appendChild(el('p', null, rich(['Otomatik'], ' yöntem ekranda altyazı varsa onu okur; birkaç saniye altyazı görmezse konuşmayı dinleyip yazıya döker ve çevirir.')));

    var file = card('file', 'Video dosyası', 'Bilgisayarınızdaki filmler ve diziler');
    file.appendChild(el('ol', null,
      li(['Video dosyası'], ' bölümünde bilgisayarınızdaki videoyu seçin (tarayıcının oynatabildiği MP4, WebM vb.).'),
      li('Yabancı dilde altyazı dosyanız (', ['.srt / .vtt'], ') varsa onu da ekleyin; satırlar izlediğiniz yerden başlayarak arka planda çevrilir.'),
      li('Altyazı dosyası yoksa ', ['"Konuşmadan altyazı oluştur"'], ' düğmesine basın: konuşma, bilgisayarınızda çalışan yapay zekâ modeliyle yazıya dökülür ve çevrilir.'),
      li('Türkçe altyazıyı ', ['"Türkçe SRT indir"'], ' düğmesiyle kaydedip başka oynatıcılarda da kullanabilirsiniz.')));

    var yt = card('youtube', 'YouTube', 'Bağlantıyı yapıştırın, Türkçe izleyin');
    yt.appendChild(el('ol', null,
      li('YouTube video bağlantısını kopyalayıp ', ['YouTube'], ' bölümündeki kutuya yapıştırın.'),
      li('Videonun altyazısı elinizde (', ['.srt / .vtt'], ') varsa yükleyin; video ile zamanlı eşleşir.'),
      li('Altyazı yoksa ', ['"Videonun sesinden altyazı"'], ' düğmesine basın; açılan pencerede ', ['"Bu sekme"'], 'yi seçip sekme sesini paylaşın, konuşma Türkçeye çevrilir (Chrome ve Edge).'),
      li('Tam ekran için oynatıcının kendi düğmesini değil, videonun altındaki ', ['"Tam ekran"'], ' düğmesini kullanın; Türkçe altyazı ancak böyle görünür.')));
    yt.appendChild(el('p', null, 'Not: YouTube oynatıcısının içindeki reklamlar kaldırılamaz.'));

    var pipCard = card('pip', 'Altyazı penceresi', 'Her zaman üstte duran küçük pencere');
    pipCard.appendChild(el('ul', null,
      li('Üstteki ', ['Altyazı penceresi'], ' düğmesi Türkçe altyazıyı ayrı, küçük ve her pencerenin üstünde duran bir pencerede gösterir (Chrome ve Edge).'),
      li('Pencereyi filmi izlediğiniz sitenin altına sürükleyin; köşesinden büyütürseniz yazı da büyür.'),
      li('Bu özelliği desteklemeyen tarayıcılarda normal bir açılır pencere açılır; engellenirse adres çubuğundaki simgeden izin verin.')));

    var browsers = el('section', { class: 'as-card as-card--wide' },
      el('div', { class: 'as-card__head' }, el('div', { class: 'as-card__icon' }, icon('globe')),
        el('div', null, el('h3', { class: 'as-card__title' }, 'Tarayıcı notları'), el('div', { class: 'as-card__sub' }, 'En iyi sonuç için Windows veya Mac\'te Chrome ya da Edge'))),
      el('div', { class: 'as-browser-grid' },
        el('div', { class: 'as-browser' }, el('div', { class: 'as-browser__name' }, 'Chrome ve Edge', el('span', { class: 'as-chip as-chip--ok' }, 'Tam')),
          el('ul', null,
            li('Tüm özellikler çalışır: sekme sesi, ekran okuma, altyazı penceresi.'),
            li('Güncel Chrome\'da çeviri cihazınızda, internetsiz yapılabilir.'),
            li('Mac\'te yalnızca ', ['sekme'], ' sesi paylaşılabilir; Windows\'ta tüm ekran paylaşımında sistem sesi de alınabilir.'))),
        el('div', { class: 'as-browser' }, el('div', { class: 'as-browser__name' }, 'Safari', el('span', { class: 'as-chip as-chip--warn' }, 'Kısıtlı')),
          el('ul', null,
            li('Başka sekmelerin ', ['sesi yakalanamaz'], ': konuşma çevirisi yalnızca Video dosyası bölümünde çalışır.'),
            li('Ekrandaki altyazıyı okuma (OCR) ve altyazı dosyalı çeviri çalışır.'),
            li('Altyazı penceresi normal açılır pencere olarak açılır.'))),
        el('div', { class: 'as-browser' }, el('div', { class: 'as-browser__name' }, 'Firefox', el('span', { class: 'as-chip as-chip--warn' }, 'Kısıtlı')),
          el('ul', null,
            li('Başka sekmelerin ', ['sesi yakalanamaz'], '; Canlı çeviri yalnızca ekrandaki altyazıyı okur.'),
            li('Video dosyası bölümü ve altyazı dosyalı YouTube çevirisi çalışır.'),
            li('Altyazı penceresi normal açılır pencere olarak açılır.')))));

    var drm = card('lock', 'Netflix ve korumalı (DRM) videolar', 'Görüntü siyah çıkarsa');
    drm.appendChild(el('ul', null,
      li('Netflix, Disney+, Prime Video gibi sitelerde video görüntüsü paylaşımda ', ['siyah'], ' görünebilir. Bu, sitenin kopya korumasıdır.'),
      li('Bu sitelerin kendi altyazıları videonun üstüne ayrıca çizildiği için genellikle ', ['yine görünür ve okunur'], ': sitede yabancı dilde altyazıyı açın.'),
      li('Videonun içine gömülü (', ['yakılmış'], ') altyazılar ise görüntüyle birlikte kararır ve okunamaz; bu durumda konuşmayı dinleme yöntemini seçin.'),
      li('Ses çoğu zaman paylaşılabilir; görüntü siyah olsa da konuşma çevirisi çalışabilir.')));

    var privacy = card('shield', 'Gizlilik ve internet', 'Neler bilgisayarınızda kalır?');
    privacy.appendChild(el('ul', null,
      li('Ekran okuma ve konuşma tanıma ', ['tamamen bilgisayarınızda'], ' çalışır; görüntü ve ses hiçbir yere gönderilmez.'),
      li('Çeviri önce tarayıcının cihaz içi çevirmeniyle denenir. Bu yoksa ve ', ['çevrim içi çeviri'], ' açıksa yalnızca çevrilecek metin Google Çeviri\'ye veya MyMemory\'ye gönderilir; Ayarlar\'dan kapatabilirsiniz.'),
      li('Konuşma modeli ilk kullanımda Hugging Face\'ten bir kez indirilir ve tarayıcıda saklanır.'),
      li('Aynı cümle tekrar çevrilmesin diye çeviriler bu tarayıcıda saklanır; Ayarlar → Çeviri → ', ['Çeviri geçmişini sil'], ' ile silebilirsiniz.'),
      li(['Çevrimdışı için hazırla'], ' düğmesiyle gereken her şeyi önceden indirebilirsiniz.')));

    var trouble = card('tool', 'Sorun giderme', 'Sık karşılaşılan durumlar');
    trouble.classList.add('as-card--wide');
    trouble.appendChild(el('ul', { class: 'as-help__cols' },
      li(['Ses gelmiyor, konuşma çevrilmiyor: '], 'paylaşırken "Sekme sesini de paylaş" kutusunu işaretleyin; pencere paylaşımında ses yoktur.'),
      li(['Altyazı okunmuyor: '], 'turuncu kutunun altyazıyı tamamen kapsadığından emin olun; video sekmesini küçültmeyin.'),
      li(['Çeviri gelmiyor: '], 'internet bağlantınızı ve Ayarlar\'daki çevrim içi çeviri seçeneğini kontrol edin.'),
      li(['Yavaş çalışıyor: '], 'Ayarlar\'dan daha hızlı (tiny) konuşma modelini seçin ya da "Ekran okuma sıklığı" değerini büyütün (ör. 0,8 sn); ekran daha seyrek okunur, işlemci rahatlar.'),
      li(['Altyazı penceresi açılmıyor: '], 'düğmeye tıklayarak açın; tarayıcı açılır pencereyi engellediyse izin verin.')));

    panelBody.appendChild(el('div', { class: 'as-help' }, live, file, yt, pipCard, drm, privacy, trouble, browsers));
    panelBody.appendChild(el('p', { class: 'as-help__foot' }, 'Altyazı Şefi Web · sürüm ' + (AS.version || '1.0') + ' · Kurulum gerektirmez, verileriniz bilgisayarınızda kalır.'));
  }

  /* ------------------------------------------------------------------ */
  /* başlatma                                                            */
  /* ------------------------------------------------------------------ */
  function buildPanels(main) {
    TABS.forEach(function (t) {
      var head = el('div', { class: 'as-panel__head' },
        el('div', null, el('h2', { class: 'as-panel__title' }, t.label), el('p', { class: 'as-panel__desc' }, t.desc)));
      var body = el('div', { class: t.mode ? 'as-mode-mount' : 'as-panel__body', 'data-mode': t.mode ? t.id : null });
      var panel = el('section', {
        class: 'as-panel', id: 'as-panel-' + t.id, role: 'tabpanel', 'aria-labelledby': 'as-tab-' + t.id, hidden: true,
        'data-panel': t.id
      }, head, body);
      ui.panels[t.id] = { panel: panel, mount: body };
      main.appendChild(panel);
    });
    buildSettings(ui.panels.settings.mount);
    buildHelp(ui.panels.help.mount);
  }

  function buildTabs() {
    var mk = function (t) {
      var btn = el('button', {
        class: 'as-tab' + (t.mode ? '' : ' as-tab--small'), type: 'button', role: 'tab', id: 'as-tab-' + t.id,
        'aria-controls': 'as-panel-' + t.id, 'aria-selected': 'false', tabindex: '-1', 'data-tab': t.id,
        title: t.mode ? t.desc : null,
        on: { click: function () { select(t.id); }, keydown: onTabKey }
      }, icon(t.icon, 'as-tab__icon'),
      el('span', { class: 'as-tab__text' }, el('span', { class: 'as-tab__label' }, t.label), t.sub ? el('span', { class: 'as-tab__sub' }, t.sub) : null));
      ui.tabs[t.id] = btn;
      return btn;
    };
    return el('nav', { class: 'as-wrap' },
      el('div', { class: 'as-tabs', role: 'tablist', 'aria-label': 'Bölümler' },
        el('div', { class: 'as-tabs__group' }, TABS.filter(function (t) { return t.mode; }).map(mk)),
        el('div', { class: 'as-tabs__group as-tabs__group--end' }, TABS.filter(function (t) { return !t.mode; }).map(mk))));
  }

  function start() {
    if (ui.started) return AS.app;
    ui.started = true;
    var rootEl = doc.getElementById('as-root') || doc.body;
    U.clear(rootEl);
    ui.root = rootEl;

    AS.bus.on('status', onStatus);
    AS.bus.on('progress', onProgress);
    AS.bus.on('pip', onPipChange);

    var footer = buildStatusBar();
    ui.banners = el('div', { class: 'as-wrap as-banners', 'aria-label': 'Tarayıcı notları' });
    var main = el('main', { class: 'as-wrap as-main', id: 'as-main' });
    rootEl.appendChild(buildHeader());
    rootEl.appendChild(ui.banners);
    rootEl.appendChild(buildTabs());
    rootEl.appendChild(main);
    rootEl.appendChild(footer);
    buildPanels(main);
    renderBanners();

    prep.ready = !!lsGet(LS_PREP);
    renderPrepButtons();

    var first = tabFromHash() || lsGet(LS_TAB);
    select(TAB_BY_ID[first] ? first : defaultTab(), { updateHash: !!tabFromHash() || !!TAB_BY_ID[first] });
    root.addEventListener('hashchange', function () {
      var id = tabFromHash();
      if (id && id !== ui.active) select(id, { updateHash: false });
    });

    root.addEventListener('error', function (e) {
      if (!e || !e.error) return;   // kaynak yükleme hataları değil, yalnızca betik hataları
      emitStatus('Beklenmeyen bir hata oluştu. Sorun sürerse sayfayı yenileyin.', 'error');
    });

    registerSW().then(function (reg) {
      if (!reg) return;
      // Önbellek tamamsa düğme "hazır" görünsün.
      swStatus().then(function (st) {
        if (!st || !st.lib) return;
        var keys = Object.keys(st.lib);
        var all = keys.length && keys.every(function (k) { return st.lib[k]; });
        if (!all && prep.ready) { prep.ready = false; renderPrepButtons(); }
      });
    });
    return AS.app;
  }

  AS.app = {
    start: start,
    select: select,
    prepareOffline: prepareOffline,
    swReady: function () { return sw.regPromise || Promise.resolve(null); },
    active: function () { return ui.active; }
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})(typeof window !== 'undefined' ? window : globalThis);

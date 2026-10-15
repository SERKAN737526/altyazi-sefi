/* Altyazı Şefi Web: ortak ad alanı (window.AS), olay yolu, ayarlar, yardımcılar.
 * Klasik betik; Node testlerinde `global.window = global` ile de yüklenebilir. */
(function (root) {
  'use strict';
  var AS = root.AS = root.AS || {};
  AS.version = '1.0.0';

  /* ---------- olay yolu ---------- */
  var handlers = {};
  AS.bus = {
    on: function (evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return fn; },
    off: function (evt, fn) {
      var list = handlers[evt]; if (!list) return;
      var i = list.indexOf(fn); if (i >= 0) list.splice(i, 1);
    },
    emit: function (evt, data) {
      var list = (handlers[evt] || []).slice();
      for (var i = 0; i < list.length; i++) {
        try { list[i](data); } catch (e) { if (root.console) console.error('[AS.bus]', evt, e); }
      }
    }
  };

  /* ---------- ayarlar (localStorage, yoksa bellek) ---------- */
  var DEFAULTS = {
    fontSize: 34,          // px, alt yazı yazı boyutu
    bgOpacity: 0.6,        // 0..1 alt yazı arka planı
    showOriginal: false,   // çevirinin altında kaynak metni de göster
    position: 'bottom',    // 'bottom' | 'top'
    holdMs: 6000,          // son alt yazı ekranda en fazla bu kadar kalır
    liveMode: 'auto',      // 'auto' | 'ocr' | 'speech'
    ocrInterval: 400,      // ms, ekran okuma aralığı
    ocrRegion: { x: 0, y: 0.62, w: 1, h: 0.38 }, // kesir; alt yazı bölgesi
    asrModel: 'base',      // 'tiny' | 'base' | 'small'
    asrLang: 'auto',       // 'auto' | 'en' | 'de' | 'fr' | 'es' | 'it' | 'pt' | 'ru' | 'ja' | 'ko' | 'zh' ...
    translateOnline: true  // cihazda çeviri yoksa çevrim içi servislere izin ver
  };
  var KEY = 'as.settings.v1';
  var store = null;
  try { store = root.localStorage || null; if (store) store.getItem('__t'); } catch (e) { store = null; }
  var memory = {};
  function load() {
    var out = {};
    for (var k in DEFAULTS) out[k] = clone(DEFAULTS[k]);
    var raw = null;
    try { raw = store ? store.getItem(KEY) : null; } catch (e) { raw = null; }
    if (raw) {
      try {
        var saved = JSON.parse(raw);
        if (saved && typeof saved === 'object') {
          for (var key in DEFAULTS) {
            if (Object.prototype.hasOwnProperty.call(saved, key) && typeof saved[key] === typeof DEFAULTS[key]) {
              out[key] = saved[key];
            }
          }
        }
      } catch (e) { /* bozuk kayıt: varsayılanlar */ }
    } else {
      for (var m in memory) out[m] = memory[m];
    }
    return out;
  }
  function clone(v) { return (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v; }
  var current = load();
  var changeFns = [];
  AS.settings = {
    defaults: function () { return clone(DEFAULTS); },
    get: function (k) { return clone(current[k]); },
    all: function () { return clone(current); },
    set: function (k, v) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) throw new Error('Bilinmeyen ayar: ' + k);
      if (typeof v !== typeof DEFAULTS[k]) throw new Error('Ayar türü yanlış: ' + k);
      current[k] = clone(v);
      memory[k] = clone(v);
      try { if (store) store.setItem(KEY, JSON.stringify(current)); } catch (e) { /* dolu/kapalı */ }
      for (var i = 0; i < changeFns.length; i++) { try { changeFns[i](k, clone(v)); } catch (e) {} }
      AS.bus.emit('settings', { key: k, value: clone(v) });
    },
    reset: function () {
      for (var k in DEFAULTS) AS.settings.set(k, clone(DEFAULTS[k]));
    },
    onChange: function (fn) { changeFns.push(fn); return fn; }
  };

  /* ---------- yardımcılar ---------- */
  AS.util = {
    /** Güvenli DOM üretici: metin her zaman textContent ile eklenir, innerHTML kullanılmaz.
     *  attrs: {class, id, text, title, on: {click: fn}, style: {..}, dataset: {..}, ...diğer öznitelikler} */
    el: function (tag, attrs) {
      var doc = root.document;
      var node = doc.createElement(tag);
      attrs = attrs || {};
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = String(v);
        else if (k === 'on') { for (var e in v) node.addEventListener(e, v[e]); }
        else if (k === 'style') { for (var s in v) node.style[s] = v[s]; }
        else if (k === 'dataset') { for (var d in v) node.dataset[d] = v[d]; }
        else if (/^on/i.test(k)) throw new Error('Satır içi olay özniteliği yasak: ' + k);
        else if (k === 'innerHTML' || k === 'outerHTML') throw new Error('innerHTML yasak');
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, String(v));
      }
      for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
      return node;
    },
    clear: function (node) { while (node && node.firstChild) node.removeChild(node.firstChild); },
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    clamp: function (v, a, b) { return Math.max(a, Math.min(b, v)); },
    now: function () { return (root.performance && performance.now) ? performance.now() : new Date().getTime(); },
    fmtBytes: function (n) {
      if (!(n >= 0)) return '?';
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
      if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
      return (n / 1073741824).toFixed(2) + ' GB';
    },
    /** Test kancaları yalnızca yerel sunucuda (localhost/127.0.0.1) ve ?test=1 ile etkin olur. */
    testParams: function () {
      try {
        var loc = root.location;
        if (!loc) return null;
        var host = loc.hostname;
        if (host !== 'localhost' && host !== '127.0.0.1') return null;
        var p = new URLSearchParams(loc.search);
        if (p.get('test') !== '1') return null;
        var out = {};
        p.forEach(function (v, k) { out[k] = v; });
        return out;
      } catch (e) { return null; }
    },
    /** Desteklenen kaynak diller (Türkçe etiket). Hedef her zaman Türkçe (tr). */
    LANGS: [
      ['auto', 'Otomatik algıla'], ['en', 'İngilizce'], ['de', 'Almanca'], ['fr', 'Fransızca'],
      ['es', 'İspanyolca'], ['it', 'İtalyanca'], ['pt', 'Portekizce'], ['ru', 'Rusça'],
      ['ar', 'Arapça'], ['ja', 'Japonca'], ['ko', 'Korece'], ['zh', 'Çince'], ['nl', 'Felemenkçe'],
      ['pl', 'Lehçe'], ['hi', 'Hintçe']
    ],
    browser: function () {
      var ua = (root.navigator && navigator.userAgent) || '';
      var isEdge = /Edg\//.test(ua);
      var isChrome = !isEdge && /Chrome\//.test(ua) && !/OPR\//.test(ua);
      var isFirefox = /Firefox\//.test(ua);
      var isSafari = /Safari\//.test(ua) && !/Chrome\//.test(ua) && !/Chromium\//.test(ua);
      var isMac = /Macintosh|Mac OS X/.test(ua);
      return {
        chromium: isChrome || isEdge || /Chromium\//.test(ua),
        chrome: isChrome, edge: isEdge, firefox: isFirefox, safari: isSafari, mac: isMac,
        tabAudio: !!(root.navigator && navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && (isChrome || isEdge || /Chromium\//.test(ua)),
        displayMedia: !!(root.navigator && navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
        docPip: 'documentPictureInPicture' in root,
        webgpu: !!(root.navigator && navigator.gpu),
        onDeviceTranslator: 'Translator' in root
      };
    }
  };
  function append(node, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { for (var i = 0; i < child.length; i++) append(node, child[i]); return; }
    if (typeof child === 'string' || typeof child === 'number') node.appendChild(root.document.createTextNode(String(child)));
    else node.appendChild(child);
  }

  /* Modlar buraya kaydolur: AS.modes.live / AS.modes.file / AS.modes.youtube
   * Her mod: { title, mount(panelEl), unmount() } */
  AS.modes = AS.modes || {};
})(typeof window !== 'undefined' ? window : globalThis);

/* Altyazı Şefi Web: cihaz kilidi → AS.lock
 *
 * Site her tarayıcıda bir kez rastgele bir CİHAZ KODU üretir (40 bit, Crockford base32, "K7F3-9QX2" gibi) ve saklar.
 * Kullanıcı bu kodu site sahibine gönderir; sahibi kendi telefonundaki kod üretici sayfayla o cihaza özel bir
 * ETKİNLEŞTİRME KODU üretir. Kod, imzalı bir yüktür:
 *   yük (8 bayt) = [sürüm 1][cihaz kodu 5 bayt][bitiş günü 2 bayt, büyük uçlu; 0 = süresiz, 1 = 2026-01-01]
 *   kod = "AS1." + base64url(yük + ECDSA P-256 / SHA-256 imzası (64 bayt, r||s))
 * Özel anahtar yalnızca kod üreticide durur; burada yalnızca açık anahtar var. Doğrulama tamamen cihazda
 * (Web Crypto) yapılır, internet gerekmez. Kod başka bir cihaz koduna aitse kabul edilmez.
 * Sınır: tarayıcıda çalışan kod okunup değiştirilebilir; bu kilit sıradan izinsiz kullanımı engeller,
 * kodu bilerek değiştiren birini durduramaz. Tarayıcı verileri silinirse yeni cihaz kodu oluşur, yeni kod gerekir.
 *
 * Kullanım: app.js açılışta AS.lock.gate(start) çağırır. Geçerli kod varsa start hemen çalışır; yoksa #as-root'a
 * kilit ekranı çizilir, doğru kod girilince ekran kaldırılıp start çağrılır.
 * Yerel sunucu (localhost / 127.0.0.1; geliştirme ve testler): kilit atlanır. ?lock=1 kilidi açar,
 * &lockKey=<x.y base64url> test anahtarını kullandırır. Yayındaki sitede (https://…github.io) ikisi de etkisizdir. */
(function (root) {
  'use strict';
  var AS = root.AS = root.AS || {};
  var doc = root.document;

  var PUBLIC_KEY = {
    kty: 'EC', crv: 'P-256',
    x: 'J97ivMlgxgO5Y0GKoJO9zT_wAzSAf23SQXRR_wf6Has',
    y: 'mUA74qREwC_UWhe95awz841Tjl4i1gdVGSYGWaVKLu4'
  };
  /* Onay sunucusu (altyazi-sefi-sunucu/worker.js): Serkan Şefi Kod'da kod üretince kod buraya bırakılır, kilit ekranı
   * birkaç saniyede bir sorar ve kodu alıp burada doğrular. Sunucuya ulaşılamazsa kod yine elle yapıştırılır.
   * Yerel sunucuda ?onay=<adres> başka bir adres kullandırır (testler). index.html CSP connect-src bu adresi içermeli. */
  var ONAY_URL = 'https://altyazi-sefi-onay.blue737526.workers.dev';
  var LS_DEVICE = 'as.lock.device';
  var LS_CODE = 'as.lock.code';
  var PREFIX = 'AS1.';
  var CODE_CHARS = 96;   // 72 bayt base64url (dolgusuz)
  var EPOCH = Date.UTC(2026, 0, 1);   // bitiş günü 1 = 2026-01-01
  var DAY = 86400000;
  var B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford: I, L, O, U yok

  /* ---------------- saf yardımcılar ---------------- */
  /** 5 bayt → 8 karakter */
  function b32encode(bytes) {
    var bits = 0, val = 0, out = '';
    for (var i = 0; i < bytes.length; i++) {
      val = (val << 8) | bytes[i]; bits += 8;
      while (bits >= 5) { out += B32.charAt((val >>> (bits - 5)) & 31); bits -= 5; }
    }
    if (bits > 0) out += B32.charAt((val << (5 - bits)) & 31);
    return out;
  }
  /** Kullanıcının yazdığı cihaz kodu → 8 karakterlik kanonik biçim ya da null (O→0, I/L→1, boşluk ve tire atılır) */
  function normDevice(s) {
    var t = String(s || '').toUpperCase().replace(/[\s\-_.]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(t)) return null;
    return t;
  }
  function b32decode(s) {
    var bits = 0, val = 0, out = [];
    for (var i = 0; i < s.length; i++) {
      var v = B32.indexOf(s.charAt(i));
      if (v < 0) return null;
      val = (val << 5) | v; bits += 5;
      if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
    }
    return new Uint8Array(out);
  }
  function fmtDevice(d) { return d.slice(0, 4) + '-' + d.slice(4); }
  function b64urlDecode(s) {
    if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
    var b = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    try {
      var bin = root.atob(b);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) { return null; }
  }
  /** Etkinleştirme kodu → {payload, sig, device, expDay} ya da null. Kopyalarken araya giren boşluk/satır sonu yok sayılır. */
  function parseCode(code) {
    var raw = String(code || '');
    if (raw.length > 2000) return null;
    var t;
    var at = raw.toUpperCase().indexOf(PREFIX);
    if (at >= 0) {
      // WhatsApp iletisinin tamamı yapıştırılmış olabilir: "AS1."ten sonraki 96 kod karakteri alınır
      // (aradaki boşluk ve satır sonları atlanır, sonrasındaki yazı yok sayılır).
      t = '';
      for (var i = at + PREFIX.length; i < raw.length && t.length < CODE_CHARS; i++) {
        var ch = raw.charAt(i);
        if (/[A-Za-z0-9_-]/.test(ch)) t += ch;
        else if (!/\s/.test(ch)) break;
      }
    } else {
      t = raw.replace(/\s+/g, '');
    }
    if (t.length !== CODE_CHARS) return null;
    var bytes = b64urlDecode(t);
    if (!bytes || bytes.length !== 72 || bytes[0] !== 1) return null;
    return {
      canon: PREFIX + t,
      payload: bytes.slice(0, 8),
      sig: bytes.slice(8),
      device: b32encode(bytes.slice(1, 6)),
      expDay: (bytes[6] << 8) | bytes[7]
    };
  }
  function expiryDate(expDay) { return expDay ? new Date(EPOCH + (expDay - 1) * DAY) : null; }
  /** Bitiş günü geçtiyse true (o günün sonuna kadar geçerli) */
  function expired(expDay, now) {
    if (!expDay) return false;
    return (now || Date.now()) >= EPOCH + expDay * DAY;
  }

  /** Yerel sunucudaysa adres parametreleri, değilse null */
  function localParams() {
    try {
      var loc = root.location;
      if (!loc || (loc.hostname !== 'localhost' && loc.hostname !== '127.0.0.1')) return null;
      var out = {};
      new URLSearchParams(loc.search).forEach(function (v, k) { out[k] = v; });
      return out;
    } catch (e) { return null; }
  }

  /* ---------------- depolama ---------------- */
  function lsGet(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { root.localStorage.setItem(k, v); return true; } catch (e) { return false; } }

  /** Bu tarayıcının cihaz kodu (yoksa üretilip saklanır). */
  function deviceCode() {
    var d = normDevice(lsGet(LS_DEVICE));
    if (d) return d;
    var r = new Uint8Array(5);
    root.crypto.getRandomValues(r);
    d = b32encode(r);
    lsSet(LS_DEVICE, d);
    return d;
  }

  /* ---------------- doğrulama ---------------- */
  var keyPromise = null;
  function publicKey() {
    if (keyPromise) return keyPromise;
    var jwk = PUBLIC_KEY;
    var tp = localParams();
    if (tp && tp.lockKey) {
      var parts = String(tp.lockKey).split('.');
      jwk = { kty: 'EC', crv: 'P-256', x: parts[0], y: parts[1] };
    }
    keyPromise = root.crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return keyPromise;
  }

  /** Kodu bu cihaz için denetler → Promise<{ok, reason, expDay}>; reason: 'format'|'signature'|'device'|'expired'|'crypto' */
  function check(code, device) {
    var p = parseCode(code);
    if (!p) return Promise.resolve({ ok: false, reason: 'format' });
    if (!root.crypto || !root.crypto.subtle) return Promise.resolve({ ok: false, reason: 'crypto' });
    return publicKey().then(function (key) {
      return root.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, p.sig, p.payload);
    }).then(function (good) {
      if (!good) return { ok: false, reason: 'signature' };
      if (p.device !== (device || deviceCode())) return { ok: false, reason: 'device', expDay: p.expDay };
      if (expired(p.expDay)) return { ok: false, reason: 'expired', expDay: p.expDay };
      return { ok: true, expDay: p.expDay, code: p.canon };
    }, function () { return { ok: false, reason: 'crypto' }; });
  }

  var MESSAGES = {
    format: 'Bu bir etkinleştirme kodu değil. Gelen kodun tamamını kopyalayıp yapıştırın.',
    signature: 'Kod geçersiz. Bir harfi eksik ya da değişmiş olabilir; kodun tamamını yeniden kopyalayın.',
    device: 'Bu kod başka bir bilgisayar için üretilmiş. Yukarıdaki cihaz kodunu gönderip bu bilgisayara özel kod isteyin.',
    expired: 'Bu kodun süresi dolmuş. Yeni bir kod isteyin.',
    crypto: 'Bu tarayıcı kodu doğrulayamıyor. Chrome, Edge ya da Safari\'nin güncel sürümünü kullanın.',
    stale: 'Bu bilgisayarın kodunun süresi dolmuş ya da kod artık geçerli değil. Yeni bir kod isteyin.'
  };

  /* ---------------- onay sunucusu ---------------- */
  function onayBase() {
    var tp = localParams();
    var u = (tp && tp.onay) || ONAY_URL;
    return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(u) || (tp && /^http:\/\/127\.0\.0\.1:\d+$/.test(u)) ? u : null;
  }
  /** Kilit ekranı açıkken sunucuya sorar; geçerli kod gelince onCode(kod) bir kez çağrılır. Dönen işlev durdurur.
   *  Sayfa görünmezken sormaz; zamanla ve hata olursa seyrekleşir (en çok dakikada bir). */
  function watchOnay(device, onCode) {
    var base = onayBase();
    if (!base || typeof root.fetch !== 'function') return function () {};
    var stopped = false, timer = null, wait = 3000, t0 = Date.now();
    // ilk 10 dk 3 sn'de bir, sonra 15 sn, 1 saatten sonra dakikada bir (sunucunun ücretsiz kotası için)
    function base3() { var e = Date.now() - t0; return e < 600000 ? 3000 : e < 3600000 ? 15000 : 60000; }
    function next(ms) { if (!stopped) timer = setTimeout(tick, Math.max(ms, base3())); }
    function tick() {
      timer = null;
      if (stopped) return;
      if (doc.visibilityState === 'hidden') { next(1500); return; }
      root.fetch(base + '/onay/' + device, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
        .then(function (r) {
          if (!r.ok) throw new Error('durum ' + r.status);
          wait = base3();
          return r.json();
        })
        .then(function (j) {
          if (stopped) return;
          if (j && typeof j.code === 'string' && j.code.length < 300) {
            return check(j.code, device).then(function (res) {
              if (stopped) return;
              if (res.ok) { stopped = true; onCode(res); return; }
              next(wait);
            });
          }
          next(wait);
        })
        .catch(function () { wait = Math.min(60000, Math.max(wait, base3()) * 2); next(wait); });
    }
    next(1000);
    return function () { stopped = true; if (timer) clearTimeout(timer); };
  }

  /* ---------------- kilit ekranı ---------------- */
  function el() { return AS.util.el.apply(null, arguments); }

  /** Cihaz kodunun karekodu ("ASD1:" + 8 karakter): Serkan'ın telefonundaki Şefi Kod ekranın fotoğrafından bunu okur.
   *  lib/qrcode/qrcode.js yüklenemezse null (kilit ekranı karekodsuz çalışmaya devam eder). */
  function qrNode(device) {
    var Q = root.qrcode;
    if (typeof Q !== 'function') return null;
    try {
      var q = Q(0, 'M');
      q.addData('ASD1:' + device, 'Alphanumeric');
      q.make();
      var n = q.getModuleCount(), qz = 4, size = n + 2 * qz, d = '';
      for (var r = 0; r < n; r++) {
        for (var c = 0; c < n; c++) if (q.isDark(r, c)) d += 'M' + (c + qz) + ' ' + (r + qz) + 'h1v1h-1z';
      }
      var NS = 'http://www.w3.org/2000/svg';
      var svg = doc.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
      svg.setAttribute('shape-rendering', 'crispEdges');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', 'Bu bilgisayarın kodunun karekodu');
      var bg = doc.createElementNS(NS, 'rect');
      bg.setAttribute('width', String(size));
      bg.setAttribute('height', String(size));
      bg.setAttribute('fill', '#fff');
      var path = doc.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', '#000');
      svg.appendChild(bg);
      svg.appendChild(path);
      return svg;
    } catch (e) {
      return null;
    }
  }

  function render(rootEl, device, onOk, firstMsg) {
    AS.util.clear(rootEl);
    var msg = el('div', { 'aria-live': 'polite', 'data-role': 'lock-msg' });
    function note(level, text) {
      AS.util.clear(msg);
      if (text) msg.appendChild(el('div', { class: 'as-note as-note--' + level, role: level === 'error' ? 'alert' : null }, text));
    }
    var copyBtn = el('button', { class: 'as-btn as-btn--sm', type: 'button', 'data-role': 'lock-copy' }, 'Kopyala');
    copyBtn.addEventListener('click', function () {
      var txt = fmtDevice(device);
      var done = function () { copyBtn.textContent = 'Kopyalandı'; setTimeout(function () { copyBtn.textContent = 'Kopyala'; }, 1800); };
      try {
        if (root.navigator.clipboard && root.navigator.clipboard.writeText) root.navigator.clipboard.writeText(txt).then(done, function () { selectText(devEl); });
        else selectText(devEl);
      } catch (e) { selectText(devEl); }
    });
    var devEl = el('div', { class: 'as-lock__device', 'data-role': 'lock-device' }, fmtDevice(device));
    var input = el('textarea', {
      class: 'as-input as-lock__input', id: 'as-lock-code', rows: '3', spellcheck: 'false', autocomplete: 'off',
      autocapitalize: 'off', 'data-role': 'lock-input', placeholder: 'AS1.…'
    });
    var go = el('button', { class: 'as-btn as-btn--primary', type: 'button', 'data-role': 'lock-go' }, 'Etkinleştir');
    var busy = false;
    var stopWatch = function () {};
    function done(r) {
      stopWatch();
      lsSet(LS_CODE, r.code);
      note('ok', 'Etkinleştirildi.');
      onOk(r);
    }
    function submit() {
      if (busy) return;
      var v = input.value;
      if (!String(v).trim()) { note('warn', 'Önce etkinleştirme kodunu yapıştırın.'); input.focus(); return; }
      busy = true; go.disabled = true;
      check(v, device).then(function (r) {
        if (!r.ok) { busy = false; go.disabled = false; note('error', MESSAGES[r.reason] || MESSAGES.signature); return; }
        // başarıda düğme kilitli kalır: art arda basış uygulamayı iki kez başlatmasın
        done(r);
      });
    }
    go.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });

    var devCol = el('div', { class: 'as-lock__devcol' },
      el('div', { class: 'as-row' }, devEl, copyBtn),
      el('div', { class: 'as-hint' }, 'Bu kodu Serkan\'a gönderin (WhatsApp, mesaj).'));
    var qr = qrNode(device);
    var devRow = !qr ? devCol : el('div', { class: 'as-lock__devrow' }, devCol,
      el('figure', { class: 'as-lock__qr', 'data-role': 'lock-qr', 'data-qr': 'ASD1:' + device }, qr,
        el('figcaption', null, 'Ya da bu ekranın fotoğrafını gönderin')));
    var card = el('section', { class: 'as-card as-lock', 'data-role': 'lock', 'aria-labelledby': 'as-lock-title' },
      el('div', { class: 'as-lock__brand' },
        el('img', { src: 'icons/logo.svg', alt: '', width: '56', height: '56' }),
        el('div', null,
          el('h1', { id: 'as-lock-title', class: 'as-lock__title' }, 'Altyazı Şefi'),
          el('div', { class: 'as-hint' }, 'Bu site izinle kullanılır. Bu bilgisayarda bir kez etkinleştirmeniz yeterli.'))),
      el('ol', { class: 'as-lock__steps' },
        el('li', null,
          el('div', { class: 'as-lock__label' }, 'Bu bilgisayarın kodu'),
          devRow,
          onayBase() ? el('div', { class: 'as-hint as-lock__wait', 'data-role': 'lock-wait' },
            'Serkan onaylayınca bu sayfa birkaç saniye içinde kendiliğinden açılır. Açık bırakın.') : null),
        el('li', null,
          el('label', { class: 'as-lock__label', for: 'as-lock-code' }, 'Gelen etkinleştirme kodunu yapıştırın'),
          input,
          el('div', { class: 'as-row' }, go),
          msg)),
      el('p', { class: 'as-hint as-lock__foot' },
        'Kod yalnızca bu bilgisayarda ve bu tarayıcıda çalışır. Tarayıcı verilerini silerseniz yeni bir kod gerekir. Etkinleştirdikten sonra internet olmadan da açılır.'));
    rootEl.appendChild(el('div', { class: 'as-lock-wrap' }, card));
    if (firstMsg) note('warn', firstMsg);
    stopWatch = watchOnay(device, function (r) {
      if (busy) return;
      busy = true; go.disabled = true;
      done(r);
    });
    try { input.focus({ preventScroll: true }); } catch (e) { /* */ }
  }
  function selectText(node) {
    try {
      var r = doc.createRange(); r.selectNodeContents(node);
      var s = root.getSelection(); s.removeAllRanges(); s.addRange(r);
    } catch (e) { /* */ }
  }

  var state = { unlocked: false, expDay: 0 };

  /** Geçerli kod varsa start(); yoksa kilit ekranı. */
  function gate(start) {
    var tp = localParams();
    if (tp && tp.lock !== '1') { state.unlocked = true; start(); return; }
    var rootEl = doc.getElementById('as-root') || doc.body;
    var device;
    try { device = deviceCode(); } catch (e) { device = null; }
    if (!device) {
      AS.util.clear(rootEl);
      rootEl.appendChild(el('div', { class: 'as-lock-wrap' }, el('div', { class: 'as-note as-note--error', role: 'alert' }, MESSAGES.crypto)));
      return;
    }
    var saved = lsGet(LS_CODE);
    var started = false;
    var proceed = function (r) {
      if (started) return;
      started = true;
      state.unlocked = true;
      if (r && r.expDay) state.expDay = r.expDay;
      start();
    };
    if (!saved) { render(rootEl, device, proceed); return; }
    check(saved, device).then(function (r) {
      if (r.ok) { proceed(r); return; }
      render(rootEl, device, proceed, MESSAGES.stale);
    });
  }

  AS.lock = {
    gate: gate,
    device: function () { return fmtDevice(deviceCode()); },
    unlocked: function () { return state.unlocked; },
    expires: function () { return expiryDate(state.expDay); },
    /* saf işlevler (Node testleri) */
    _parseCode: parseCode, _normDevice: normDevice, _b32encode: b32encode, _b32decode: b32decode, _expired: expired, _check: check, _onayBase: onayBase
  };
})(typeof window !== 'undefined' ? window : globalThis);

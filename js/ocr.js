/* Altyazı Şefi Web: ekrandan alt yazı okuma (OCR) → AS.ocr
 *
 * Satır bulma, Android sürümündeki OcrEngine.java'nın (v3.1 Instagram düzeltmeleri dahil) birebir
 * uyarlamasıdır: önce yazı renginde (beyaz / açık / koyu) piksellerden bir maske çıkarılır, maskedeki
 * 8-komşulu bağlı parçalardan harf boyutunda olanlar satırlara dizilir, en iyi satır bloğu seçilir ve
 * yalnızca bu satırların temiz maskesi (gürültüsüz, beyaz zemin üstünde siyah yazı) Tesseract'a verilir.
 * Böylece videonun kendi görüntüsü harf diye okunmaz.
 *
 * Android'den farklar (yalnızca platforma özgü kısımlar):
 *  - Blok tek parça (PSM 6) yerine satır satır (PSM 7) okunur, en fazla 4 satır; kelime süzgeci ve
 *    "metne benziyor mu" denetimi Android'deki gibi tüm blok metnine uygulanır.
 *  - Okuyucu (Reader), yatay denetimleri (ortalanmış mı, sağ kenardaki simge, %96 genişlik) seçilen
 *    bölgeye göre yapar; bölge tam genişlikteyse bu Android ile aynıdır. Harf yüksekliği sınırları
 *    Android'deki gibi tüm görüntünün yüksekliğine göredir.
 *  - Çok büyük kaynaklar (4K ekran) en fazla ~1920×1080 piksele küçültülerek işlenir.
 *
 * findLines / prepareLine saf işlevlerdir (DOM yok, Node'da da çalışır). Reader tarayıcıda
 * tesseract.js v6 ile çalışır (lib/tesseract, lib/tessdata; CDN yok, workerBlobURL:false).
 */
(function (root) {
  'use strict';
  var AS = root.AS = root.AS || {};

  /* ---------- Android OcrEngine.java sabitleri ---------- */
  var MIN_WORD_CONF = 60;
  var MIN_MEAN_CONF = 70;
  var MAX_COMPONENTS = 1500;
  var TARGET_HEIGHT = 110;
  var PASS_NAMES = ['white', 'light', 'dark'];
  // Android kara listesi "|_~^`{}<>\\@#*=" idi. LSTM motoru tırnaksız büyük "I" harfini "|" okur; "|"
  // yasaklanınca güveni 0 olan "l" döndürüp kelimeyi düşürüyor. Bu yüzden "|" serbest, fixBars() ile harfe çevrilir.
  var CHAR_BLACKLIST = '_~^`{}<>\\@#*=';

  /* ---------- web sürümüne özgü sınırlar ---------- */
  var MAX_LINES = 4;                    // bir okumada en fazla bu kadar satır tanınır
  var MAX_FRAME_PIXELS = 1920 * 1080;   // daha büyük kaynaklar bu boyuta küçültülür
  var FP_W = 64, FP_H = 16;             // parmak izi ızgarası (Android: 48×12)
  var FP_MEAN = 3, FP_MAX = 24;         // ortalama fark < 3 (Android) ve en büyük hücre farkı < 24 ise "aynı"
  var RECOGNIZE_TIMEOUT_MS = 20000;
  // tesseract.js dil verisini IndexedDB'de bu anahtarla saklar; lib/tessdata/eng.traineddata.gz değişirse artırın.
  var TESS_CACHE_PATH = 'altyazi-sefi-tessdata-4.0.0-best-int';
  var CREATE_TIMEOUT_MS = 300000;

  var f32 = Math.fround;
  var F_001 = f32(0.010), F_007 = f32(0.07), F_3 = f32(3.0), F_004 = f32(0.04), F_012 = f32(0.12);
  var F_05 = f32(0.5), F_35 = f32(3.5), F_12 = f32(1.2), F_078 = f32(0.78), F_006 = f32(0.06);
  var F_025 = f32(0.25), F_096 = f32(0.96), F_24 = f32(2.4), F_06 = f32(0.6), F_16 = f32(1.6), F_045 = f32(0.45);

  /* ---------- yeniden kullanılan çalışma tamponları (findLines eşzamanlıdır) ---------- */
  var inkBuf = new Uint8Array(0);
  var labelBuf = new Int32Array(0);
  var parentBuf = new Int32Array(0);

  function ensureBuffers(n) {
    if (inkBuf.length < n) {
      inkBuf = new Uint8Array(n);
      labelBuf = new Int32Array(n);
    }
    var pn = (n >> 1) + 2;
    if (parentBuf.length < pn) parentBuf = new Int32Array(pn);
  }

  function checkImage(img) {
    if (!img || !(img.width > 0) || !(img.height > 0) || !img.data) throw new Error('Geçersiz görüntü');
    var w = img.width | 0, h = img.height | 0;
    if (img.data.length < w * h * 4) throw new Error('Görüntü verisi eksik');
    return { w: w, h: h };
  }

  /** Yazı maskesi; Android extractLine()'daki eşiklerin aynısı. Açık piksel sayısını döndürür. */
  function computeInk(data, n, pass, ink) {
    var count = 0, i, p, r, g, b, lum, max, min, on;
    if (pass === 0) {
      for (i = 0, p = 0; i < n; i++, p += 4) {
        r = data[p]; g = data[p + 1]; b = data[p + 2];
        lum = ((r * 299 + g * 587 + b * 114) / 1000) | 0;
        if (lum > 195) {
          max = r > g ? (r > b ? r : b) : (g > b ? g : b);
          min = r < g ? (r < b ? r : b) : (g < b ? g : b);
          // Beyaz yazı + vurgulanmış (camgöbeği/sarı gibi parlak, doygun) kelimeler
          on = (lum > 235 && max - min < 80) || (max >= 235 && max - min >= 70);
        } else {
          on = false;
        }
        if (on) { ink[i] = 1; count++; } else ink[i] = 0;
      }
    } else if (pass === 1) {
      for (i = 0, p = 0; i < n; i++, p += 4) {
        lum = ((data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000) | 0;
        if (lum > 205) { ink[i] = 1; count++; } else ink[i] = 0;
      }
    } else {
      for (i = 0, p = 0; i < n; i++, p += 4) {
        lum = ((data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000) | 0;
        if (lum < 60) { ink[i] = 1; count++; } else ink[i] = 0;
      }
    }
    return count;
  }

  function find(parent, x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  function union(parent, a, b) {
    var ra = find(parent, a), rb = find(parent, b);
    if (ra === rb) return;
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  }

  /** 8 komşuluklu bağlı parça etiketleme (iki geçişli birleştir-bul). Etiket sayısını döndürür;
   *  aşırı parçalı (gürültü) görüntüde 0 döner. Android label() ile aynı. */
  function label(w, h, ink, labels, parent) {
    var next = 1;
    var limit = ((w * h) >> 1) + 1;
    var x, y, i, a, b, c, d, m;
    for (y = 0, i = 0; y < h; y++) {
      for (x = 0; x < w; x++, i++) {
        if (ink[i] === 0) { labels[i] = 0; continue; }
        a = x > 0 ? labels[i - 1] : 0;
        b = y > 0 ? labels[i - w] : 0;
        c = (y > 0 && x > 0) ? labels[i - w - 1] : 0;
        d = (y > 0 && x < w - 1) ? labels[i - w + 1] : 0;
        m = 0;
        if (a !== 0) m = a;
        if (b !== 0 && (m === 0 || b < m)) m = b;
        if (c !== 0 && (m === 0 || c < m)) m = c;
        if (d !== 0 && (m === 0 || d < m)) m = d;
        if (m === 0) {
          if (next >= limit) return 0;
          parent[next] = next;
          labels[i] = next++;
        } else {
          labels[i] = m;
          if (a !== 0) union(parent, m, a);
          if (b !== 0) union(parent, m, b);
          if (c !== 0) union(parent, m, c);
          if (d !== 0) union(parent, m, d);
        }
      }
    }
    var remap = new Int32Array(next);
    var count = 0, id;
    for (id = 1; id < next; id++) {
      if (find(parent, id) === id) remap[id] = ++count;
    }
    for (id = 1; id < next; id++) remap[id] = remap[find(parent, id)];
    for (i = 0; i < w * h; i++) {
      if (labels[i] !== 0) labels[i] = remap[labels[i]];
    }
    return count;
  }

  /* ---------- satır (Android Line sınıfı) ---------- */
  function Group() {
    this.comps = [];
    this.cy = 0;
    this.h = 0;
    this._sum = 0;
    this._hs = [];
  }
  Group.prototype.add = function (c) {
    this.comps.push(c);
    this._sum = f32(this._sum + c.cy);
    var hs = this._hs, v = c.b - c.t, lo = 0, hi = hs.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (hs[mid] <= v) lo = mid + 1; else hi = mid; }
    hs.splice(lo, 0, v);
    this.cy = f32(this._sum / hs.length);
    this.h = hs[hs.length >> 1];
  };

  function byLeft(a, b) { return a.l - b.l; }
  function byCy(a, b) { return a.cy - b.cy; }

  /**
   * Bir eşik geçişinde (0 beyaz, 1 açık, 2 koyu) alt yazı satırlarını bulur. Android extractLine()'ın
   * bulma kısmı; bulunan blok satırlarını (en fazla MAX_LINES) temiz maskeleriyle döndürür.
   */
  function findPass(img, w, h, pass, screenW, screenH, regionLeft) {
    var n = w * h;
    ensureBuffers(n);
    var ink = inkBuf, labels = labelBuf, parent = parentBuf;
    var count = computeInk(img.data, n, pass, ink);
    var ratio = count / n;
    if (ratio < 0.0003 || ratio > 0.45) return [];

    var nLabels = label(w, h, ink, labels, parent);
    if (nLabels === 0) return [];

    // Bağlı parçaların sınır kutuları
    var bl = new Int32Array(nLabels + 1).fill(0x7fffffff), bt = new Int32Array(nLabels + 1).fill(0x7fffffff);
    var br = new Int32Array(nLabels + 1).fill(-1), bb = new Int32Array(nLabels + 1).fill(-1);
    var area = new Int32Array(nLabels + 1);
    var x, y, i, id;
    for (y = 0, i = 0; y < h; y++) {
      for (x = 0; x < w; x++, i++) {
        id = labels[i];
        if (id === 0) continue;
        if (x < bl[id]) bl[id] = x;
        if (x > br[id]) br[id] = x;
        if (y < bt[id]) bt[id] = y;
        if (y > bb[id]) bb[id] = y;
        area[id]++;
      }
    }

    // Alt yazı harfleri ekran yüksekliğinin kabaca %1 - %7'si kadardır.
    var minH = Math.max(8, Math.trunc(f32(f32(screenH) * F_001)));
    var maxH = Math.trunc(f32(f32(screenH) * F_007));
    var comps = [];
    for (id = 1; id <= nLabels; id++) {
      var cw = br[id] - bl[id] + 1, chh = bb[id] - bt[id] + 1;
      if (chh < minH || chh > maxH) continue;
      var asp = f32(cw / chh);
      if (asp > F_3 || asp < F_004) continue;
      if (f32(area[id] / (cw * chh)) < F_012) continue;
      var t0 = bt[id], b0 = bb[id] + 1;
      comps.push({ l: bl[id], t: t0, r: br[id] + 1, b: b0, id: id, cy: f32((t0 + b0) / 2) });
      if (comps.length > MAX_COMPONENTS) return []; // çok gürültülü: yazı değil
    }
    if (comps.length < 4) return [];

    comps.sort(byCy);
    var lines = [], k, L, c;
    for (i = 0; i < comps.length; i++) {
      c = comps[i];
      var ch = c.b - c.t;
      var home = null;
      for (k = 0; k < lines.length; k++) {
        L = lines[k];
        var ratioH = f32(ch / L.h);
        if (Math.abs(f32(c.cy - L.cy)) < f32(F_05 * Math.max(ch, L.h)) && ratioH > 0.5 && ratioH < 2) {
          home = L;
          break;
        }
      }
      if (home === null) {
        home = new Group();
        lines.push(home);
      }
      home.add(c);
    }

    // Aynı satırda uzakta duran parçaları (Instagram'ın sağdaki beğeni/paylaş sayıları gibi)
    // ayrı kümelere böl; alt yazı en kalabalık kümedir.
    var split = [];
    for (k = 0; k < lines.length; k++) {
      L = lines[k];
      if (L.comps.length < 4) continue;
      var sorted = L.comps.slice().sort(byLeft);
      var cur = new Group();
      var edge = sorted[0].r;
      var gapLimit = f32(L.h * F_35);
      for (i = 0; i < sorted.length; i++) {
        c = sorted[i];
        if (cur.comps.length > 0 && c.l - edge > gapLimit) {
          split.push(cur);
          cur = new Group();
        }
        cur.add(c);
        edge = Math.max(edge, c.r);
      }
      split.push(cur);
    }
    // Sağ kenardaki tekil sayı/simge (Reels'te paylaş sayısı) küme içinde kalmışsa çıkar.
    for (k = 0; k < split.length; k++) {
      L = split[k];
      if (L.comps.length <= 4 || screenW <= 0) continue;
      var last = L.comps[0];
      for (i = 0; i < L.comps.length; i++) if (L.comps[i].l > last.l) last = L.comps[i];
      var edge2 = 0;
      for (i = 0; i < L.comps.length; i++) if (L.comps[i] !== last) edge2 = Math.max(edge2, L.comps[i].r);
      var cx = f32(regionLeft + f32((last.l + last.r) / 2));
      if (last.l - edge2 > f32(L.h * F_12) && cx > f32(f32(screenW) * F_078)) {
        var nl = new Group();
        for (i = 0; i < L.comps.length; i++) if (L.comps[i] !== last) nl.add(L.comps[i]);
        split[k] = nl;
      }
    }
    lines = split;

    var best = null, good = [];
    for (k = 0; k < lines.length; k++) {
      L = lines[k];
      if (L.comps.length < 4) continue;
      var l = 0x7fffffff, r = 0, sumW = 0;
      for (i = 0; i < L.comps.length; i++) {
        c = L.comps[i];
        l = Math.min(l, c.l);
        r = Math.max(r, c.r);
        sumW += c.r - c.l;
      }
      var span = r - l;
      if (span < f32(w * F_006)) continue;
      if (f32(sumW / span) < F_025) continue;
      // Cümle içinde çok geniş boşluk varsa (yan yana düğmeler/menüler) alt yazı değildir.
      var byX = L.comps.slice().sort(byLeft);
      var maxGap = 0, e3 = byX[0].r;
      for (i = 0; i < byX.length; i++) {
        maxGap = Math.max(maxGap, byX[i].l - e3);
        e3 = Math.max(e3, byX[i].r);
      }
      if (maxGap > f32(L.h * F_35)) continue;
      // Alt yazılar ortalanır; sola dayalı başlık/yorum/menü yazıları elenir.
      var center = f32(regionLeft + f32((l + r) / 2));
      if (screenW > 0 && Math.abs(f32(center - f32(screenW / 2))) > f32(f32(screenW) * F_012)) continue;
      if (screenW > 0 && span > f32(f32(screenW) * F_096)) continue;
      L._l = l; L._r = r;
      good.push(L);
      if (best === null || L.comps.length > best.comps.length) best = L;
    }
    if (best === null) return [];

    var block = [best];
    for (k = 0; k < good.length; k++) {
      L = good[k];
      if (L === best) continue;
      var rel = f32(L.h / best.h);
      if (Math.abs(f32(L.cy - best.cy)) < f32(best.h * F_24) && rel > F_06 && rel < F_16) block.push(L);
    }
    if (block.length > MAX_LINES) {
      // En iyi satır + ona en yakın satırlar
      block.sort(function (a, b2) {
        if (a === best) return -1;
        if (b2 === best) return 1;
        return Math.abs(a.cy - best.cy) - Math.abs(b2.cy - best.cy);
      });
      block.length = MAX_LINES;
    }

    // Satır kutuları: blok kenar boşluğu Android'deki gibi en iyi satırın yüksekliğinin %60'ı.
    var pad = Math.trunc(f32(best.h * F_06));
    var owner = new Int32Array(nLabels + 1); // harf parçası → satır sırası+1
    var boxes = [];
    for (k = 0; k < block.length; k++) {
      L = block[k];
      var bl0 = 0x7fffffff, bt0 = 0x7fffffff, br0 = 0, bb0 = 0;
      for (i = 0; i < L.comps.length; i++) {
        c = L.comps[i];
        bl0 = Math.min(bl0, c.l); bt0 = Math.min(bt0, c.t);
        br0 = Math.max(br0, c.r); bb0 = Math.max(bb0, c.b);
        owner[c.id] = k + 1;
      }
      boxes.push({
        g: L, t: bt0, b: bb0,
        L0: Math.max(0, bl0 - pad), T0: Math.max(0, bt0 - pad),
        R0: Math.min(w, br0 + pad), B0: Math.min(h, bb0 + pad)
      });
    }

    // Temiz maske: satırın harfleri + küçük parçalar (nokta, virgül, kesme); büyük gürültü atılır.
    var smallLimit = f32(F_045 * best.h);
    var out = [];
    for (k = 0; k < boxes.length; k++) {
      var bx = boxes[k];
      var W0 = bx.R0 - bx.L0, H0 = bx.B0 - bx.T0;
      if (W0 < 8 || H0 < 8) continue;
      var keep = new Uint8Array(W0 * H0);
      var lineId = k + 1;
      for (y = bx.T0; y < bx.B0; y++) {
        var row = y * w, orow = (y - bx.T0) * W0;
        for (x = bx.L0; x < bx.R0; x++) {
          id = labels[row + x];
          if (id === 0) continue;
          var o = owner[id];
          var kp = o === lineId;
          if (!kp && o === 0) {
            var bh = bb[id] - bt[id] + 1;
            if (bh < smallLimit) {
              var cxm = (bl[id] + br[id]) / 2, cym = (bt[id] + bb[id]) / 2;
              kp = cxm >= bx.L0 && cxm <= bx.R0 && cym >= bx.T0 && cym <= bx.B0 &&
                nearestLine(boxes, cym) === k;
            }
          }
          if (kp) keep[orow + x - bx.L0] = 1;
        }
      }
      var line = {
        x: bx.L0, y: bx.T0, w: W0, h: H0,
        mask: PASS_NAMES[pass],
        lineH: bx.g.h,
        cy: bx.g.cy,
        n: bx.g.comps.length,
        best: bx.g === best
      };
      Object.defineProperty(line, '_keep', { value: keep, enumerable: false });
      Object.defineProperty(line, '_src', { value: img.data, enumerable: false });
      out.push(line);
    }
    out.sort(function (a, b2) { return (a.cy - b2.cy) || (a.x - b2.x); });
    return out;
  }

  /** Küçük parçanın (nokta, virgül) dikeyde en yakın olduğu satır. */
  function nearestLine(boxes, cy) {
    if (boxes.length === 1) return 0;
    var best = 0, bestD = Infinity;
    for (var k = 0; k < boxes.length; k++) {
      var d = cy < boxes[k].t ? boxes[k].t - cy : (cy > boxes[k].b ? cy - boxes[k].b : 0);
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  }

  function passIndex(p) {
    if (p === 0 || p === 1 || p === 2) return p;
    var i = PASS_NAMES.indexOf(p);
    if (i < 0) throw new Error('Bilinmeyen geçiş: ' + p);
    return i;
  }

  /**
   * findLines(img, opts?) → Line[]
   * img  = {width, height, data: RGBA}
   * opts = {screenW, screenH, regionLeft, passes}
   *   screenW/screenH: görüntünün alındığı ekranın (kaynağın) piksel boyutu; varsayılan img boyutu.
   *   regionLeft: img'nin ekrandaki sol kenarı (px). passes: denenecek geçişler, varsayılan
   *   ['white','light','dark']; satır bulunan ilk geçişin satırları döner.
   * Line = {x, y, w, h, mask, lineH, cy, n, best} (img pikseli; mask = geçiş adı)
   */
  function findLines(img, opts) {
    var d = checkImage(img);
    opts = opts || {};
    var screenW = opts.screenW > 0 ? Math.round(opts.screenW) : d.w;
    var screenH = opts.screenH > 0 ? Math.round(opts.screenH) : d.h;
    var regionLeft = opts.regionLeft > 0 ? Math.round(opts.regionLeft) : 0;
    var passes = opts.passes || PASS_NAMES;
    for (var i = 0; i < passes.length; i++) {
      var lines = findPass(img, d.w, d.h, passIndex(passes[i]), screenW, screenH, regionLeft);
      if (lines.length) return lines;
    }
    return [];
  }

  /** Satırın maskesi yoksa (elle verilen kutu) kutuyu geçiş eşiğiyle ikili yapar. */
  function fallbackMask(img, line, w) {
    var cw = line.w, ch = line.h;
    var keep = new Uint8Array(cw * ch);
    var pass = passIndex(line.mask || 'white');
    var tmp = new Uint8Array(cw);
    var rowData = new Uint8ClampedArray(cw * 4);
    for (var y = 0; y < ch; y++) {
      var src = ((line.y + y) * w + line.x) * 4;
      for (var j = 0; j < cw * 4; j++) rowData[j] = img.data[src + j];
      computeInk(rowData, cw, pass, tmp);
      keep.set(tmp, y * cw);
    }
    return keep;
  }

  /** Satırı Tesseract'a hazırlar: gri (0 siyah yazı, 255 beyaz zemin), ölçekli, 20 px beyaz çerçeveli. */
  function prepareGrey(img, line) {
    var d = checkImage(img);
    if (!line || !(line.w > 0) || !(line.h > 0)) throw new Error('Geçersiz satır');
    var lx = Math.max(0, line.x | 0), ly = Math.max(0, line.y | 0);
    var cw = Math.min(line.w | 0, d.w - lx), ch = Math.min(line.h | 0, d.h - ly);
    if (cw <= 0 || ch <= 0) throw new Error('Satır görüntünün dışında');
    var keep = line._keep;
    if (!keep || line._src !== img.data || keep.length !== cw * ch || cw !== line.w || ch !== line.h || lx !== line.x || ly !== line.y) {
      keep = fallbackMask(img, { x: lx, y: ly, w: cw, h: ch, mask: line.mask }, d.w);
    }
    // Satır yüksekliğini Tesseract'ın sevdiği boyuta getir (Android TARGET_HEIGHT) ve beyaz çerçeve ekle.
    var scale = ch < TARGET_HEIGHT ? Math.min(3, Math.max(0.5, f32(TARGET_HEIGHT / ch))) : 1;
    var sw = Math.max(1, Math.round(f32(cw * scale))), sh = Math.max(1, Math.round(f32(ch * scale)));
    var W = sw + 40, H = sh + 40;
    var grey = new Uint8Array(W * H);
    grey.fill(255);
    var x, y;
    if (sw === cw && sh === ch) {
      for (y = 0; y < ch; y++) {
        for (x = 0; x < cw; x++) if (keep[y * cw + x]) grey[(y + 20) * W + x + 20] = 0;
      }
    } else {
      // Çift doğrusal ölçekleme (Android createScaledBitmap(filter=true) gibi; piksel merkezleri)
      var x0 = new Int32Array(sw), x1 = new Int32Array(sw), fx = new Float32Array(sw);
      for (x = 0; x < sw; x++) {
        var sx = (x + 0.5) * cw / sw - 0.5;
        if (sx < 0) sx = 0;
        var ix = Math.floor(sx);
        if (ix > cw - 1) ix = cw - 1;
        x0[x] = ix; x1[x] = Math.min(cw - 1, ix + 1); fx[x] = sx - ix;
      }
      for (y = 0; y < sh; y++) {
        var sy = (y + 0.5) * ch / sh - 0.5;
        if (sy < 0) sy = 0;
        var iy = Math.floor(sy);
        if (iy > ch - 1) iy = ch - 1;
        var iy1 = Math.min(ch - 1, iy + 1), fy = sy - iy;
        var r0 = iy * cw, r1 = iy1 * cw, o = (y + 20) * W + 20;
        for (x = 0; x < sw; x++) {
          var a = keep[r0 + x0[x]], b = keep[r0 + x1[x]], c = keep[r1 + x0[x]], e = keep[r1 + x1[x]];
          if ((a | b | c | e) === 0) continue;
          var top = a + (b - a) * fx[x], bot = c + (e - c) * fx[x];
          var cov = top + (bot - top) * fy;
          grey[o + x] = 255 - Math.round(cov * 255);
        }
      }
    }
    return { width: W, height: H, grey: grey };
  }

  /** prepareLine(img, line) → {width, height, data: RGBA} (siyah yazı, beyaz zemin). */
  function prepareLine(img, line) {
    var g = prepareGrey(img, line);
    var n = g.width * g.height;
    var out = new Uint8ClampedArray(n * 4);
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      var v = g.grey[i];
      out[p] = v; out[p + 1] = v; out[p + 2] = v; out[p + 3] = 255;
    }
    return { width: g.width, height: g.height, data: out };
  }

  /** Gri görüntüyü PGM (P5) baytlarına çevirir; Tesseract (Leptonica) doğrudan okur. */
  function toPGM(g) {
    var w = g.width, h = g.height, grey = g.grey;
    if (!grey) {
      grey = new Uint8Array(w * h);
      for (var i = 0, p = 0; i < w * h; i++, p += 4) {
        grey[i] = ((g.data[p] * 299 + g.data[p + 1] * 587 + g.data[p + 2] * 114) / 1000) | 0;
      }
    }
    var head = 'P5\n' + w + ' ' + h + '\n255\n';
    var out = new Uint8Array(head.length + w * h);
    for (var j = 0; j < head.length; j++) out[j] = head.charCodeAt(j);
    out.set(grey.subarray(0, w * h), head.length);
    return out;
  }

  /* ---------- metin süzgeçleri (Android recognize / looksLikeText / isWordLike) ---------- */
  var RE_LETTER = /\p{L}/u, RE_LOWER = /\p{Ll}/u, RE_UPPER = /\p{Lu}/u, RE_DIGIT = /\p{Nd}/u;
  function isLetter(ch) { return RE_LETTER.test(ch); }

  function letterCount(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) if (isLetter(s.charAt(i))) n++;
    return n;
  }

  function isWordLike(w) {
    w = String(w || '').trim();
    if (!w) return false;
    var letters = letterCount(w);
    return letters > 0 && letters * 2 >= w.length;
  }

  /** Gerçek cümleye benzemeyen çıktıları (gürültüden okunan "unhahnn IUIV Fircf" gibi) eler. */
  function looksLikeText(s) {
    var toks = String(s).split(/[ \t\n\x0B\f\r]+/);
    while (toks.length > 1 && toks[toks.length - 1] === '') toks.pop(); // Java split gibi
    if (toks.length === 0) return false;
    var weird = 0, shortTok = 0;
    for (var k = 0; k < toks.length; k++) {
      var t = toks[k];
      if (letterCount(t) < 2) shortTok++;
      var bad = false;
      for (var i = 1; i < t.length; i++) {
        var a = t.charAt(i - 1), b = t.charAt(i);
        var aL = isLetter(a), bL = isLetter(b);
        if (RE_LOWER.test(a) && RE_UPPER.test(b)) bad = true;
        if (aL && (b === '/' || b === '\\' || b === '|' || (b === ':' && i < t.length - 1))) bad = true;
        if ((aL && RE_DIGIT.test(b)) || (RE_DIGIT.test(a) && bL)) bad = true;
      }
      if (bad) weird++;
    }
    if (toks.length >= 4 && shortTok * 2 > toks.length) return false;
    return weird * 4 <= toks.length;
  }

  /** "|" çubuğunu harfe çevirir: kelime başında ya da büyük harften sonra "I", aksi halde "l". */
  function fixBars(w) {
    if (w.indexOf('|') < 0) return w;
    var out = '';
    for (var i = 0; i < w.length; i++) {
      var ch = w.charAt(i);
      if (ch !== '|') { out += ch; continue; }
      var prev = out.charAt(out.length - 1), next = w.charAt(i + 1);
      if (!prev || !isLetter(prev)) out += 'I';
      else if (RE_UPPER.test(prev) && !(next && RE_LOWER.test(next))) out += 'I';
      else out += 'l';
    }
    return out;
  }

  /** Tesseract TSV çıktısından kelimeler (düzey 5). */
  function parseTsv(tsv) {
    var words = [];
    if (!tsv) return words;
    var rows = String(tsv).split('\n');
    for (var i = 0; i < rows.length; i++) {
      var f = rows[i].split('\t');
      if (f.length < 12 || f[0] !== '5') continue;
      var text = f.slice(11).join('\t').replace(/\r$/, '');
      var conf = parseFloat(f[10]);
      if (!text.trim()) continue;
      words.push({ text: fixBars(text), conf: isFinite(conf) ? conf : 0 });
    }
    return words;
  }

  /**
   * Satır satır kelimelerden blok metnini kurar; Android recognize() süzgeçlerinin aynısı:
   * kelime güveni ≥ 60 ve kelimeye benziyor; blokta en az 3 harf, ortalama güven ≥ 70, metne benziyor.
   * lineWords: [[{text, conf}], ...] → {text, conf, lines: [string]}
   */
  function assemble(lineWords) {
    var all = [], perLine = [], confSum = 0, confN = 0;
    for (var k = 0; k < lineWords.length; k++) {
      var lp = [];
      var words = lineWords[k] || [];
      for (var i = 0; i < words.length; i++) {
        var wd = words[i];
        if (wd && wd.text != null && wd.conf >= MIN_WORD_CONF && isWordLike(wd.text)) {
          lp.push(String(wd.text).trim());
          confSum = Math.trunc(confSum + wd.conf);
          confN++;
        }
      }
      perLine.push(lp.join(' '));
      for (var j = 0; j < lp.length; j++) all.push(lp[j]);
    }
    var s = all.join(' ').trim();
    var mean = confN > 0 ? Math.trunc(confSum / confN) : 0;
    if (letterCount(s) < 3 || mean < MIN_MEAN_CONF || !looksLikeText(s)) {
      return { text: '', conf: mean, lines: perLine };
    }
    return { text: s, conf: mean, lines: perLine };
  }

  /* ---------- parmak izi (Android signature/diff; ızgara kutu ortalaması) ---------- */
  function fingerprint(img) {
    var w = img.width, h = img.height, data = img.data;
    var sum = new Float64Array(FP_W * FP_H), cnt = new Float64Array(FP_W * FP_H);
    var colCell = new Int32Array(w);
    for (var x = 0; x < w; x++) colCell[x] = Math.min(FP_W - 1, Math.floor(x * FP_W / w));
    // Büyük görüntülerde her 2. satır/sütun yeterli (hız).
    var step = w * h > 600000 ? 2 : 1;
    for (var y = 0; y < h; y += step) {
      var rowCell = Math.min(FP_H - 1, Math.floor(y * FP_H / h)) * FP_W;
      for (x = 0; x < w; x += step) {
        var p = (y * w + x) * 4;
        var idx = rowCell + colCell[x];
        sum[idx] += (data[p] + data[p + 1] + data[p + 2]) / 3;
        cnt[idx]++;
      }
    }
    var out = new Uint8Array(FP_W * FP_H);
    for (var i = 0; i < out.length; i++) out[i] = cnt[i] ? Math.round(sum[i] / cnt[i]) : 0;
    return out;
  }

  function fpSame(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    var total = 0, max = 0;
    for (var i = 0; i < a.length; i++) {
      var d = a[i] > b[i] ? a[i] - b[i] : b[i] - a[i];
      total += d;
      if (d > max) max = d;
    }
    return total / a.length < FP_MEAN && max < FP_MAX;
  }

  function hashGrey(g) {
    var h = 2166136261 >>> 0;
    h = Math.imul(h ^ g.width, 16777619) >>> 0;
    h = Math.imul(h ^ g.height, 16777619) >>> 0;
    var a = g.grey;
    for (var i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 16777619) >>> 0;
    return g.width + 'x' + g.height + ':' + h.toString(16);
  }

  /* ---------- tarayıcı yardımcıları ---------- */
  function sourceSize(src) {
    if (!src) return null;
    var w = 0, h = 0;
    if (typeof src.videoWidth === 'number') {
      if (src.readyState < 2) return null; // HAVE_CURRENT_DATA yok
      w = src.videoWidth; h = src.videoHeight;
    } else if (typeof src.displayWidth === 'number') { // VideoFrame
      w = src.displayWidth; h = src.displayHeight;
    } else if (typeof src.naturalWidth === 'number' && src.naturalWidth > 0) {
      w = src.naturalWidth; h = src.naturalHeight;
    } else {
      w = src.width; h = src.height;
    }
    if (!(w > 0 && h > 0)) return null;
    return { w: w | 0, h: h | 0 };
  }

  function normRegion(r) {
    if (!r && AS.settings) { try { r = AS.settings.get('ocrRegion'); } catch (e) { r = null; } }
    r = r || { x: 0, y: 0.62, w: 1, h: 0.38 };
    var num = function (v, d) { v = Number(v); return isFinite(v) ? v : d; };
    var x = Math.min(1, Math.max(0, num(r.x, 0))), y = Math.min(1, Math.max(0, num(r.y, 0.62)));
    var w = Math.min(1 - x, Math.max(0, num(r.w, 1))), h = Math.min(1 - y, Math.max(0, num(r.h, 0.38)));
    return { x: x, y: y, w: w, h: h };
  }

  function makeCanvas(w, h) {
    if (typeof root.OffscreenCanvas === 'function') {
      try {
        var oc = new root.OffscreenCanvas(w, h);
        var octx = oc.getContext('2d', { willReadFrequently: true, alpha: false });
        if (octx) return { canvas: oc, ctx: octx };
      } catch (e) { /* Safari < 16.4: düz canvas */ }
    }
    if (root.document && root.document.createElement) {
      var c = root.document.createElement('canvas');
      c.width = w; c.height = h;
      var ctx = c.getContext('2d', { willReadFrequently: true, alpha: false });
      if (ctx) return { canvas: c, ctx: ctx };
    }
    throw new Error('Tarayıcı tuval (canvas) desteklemiyor');
  }

  /** Ham {width,height,data} kaynaktan bölge kırpar; gerekirse alan ortalamasıyla küçültür. */
  function cropRaw(src, sx, sy, sw, sh, dw, dh) {
    var out = new Uint8ClampedArray(dw * dh * 4), W = src.width, data = src.data;
    var x, y, s, o;
    if (dw === sw && dh === sh) {
      for (y = 0; y < dh; y++) {
        out.set(data.subarray(((sy + y) * W + sx) * 4, ((sy + y) * W + sx + sw) * 4), y * dw * 4);
      }
      for (o = 3; o < out.length; o += 4) out[o] = 255;
      return { width: dw, height: dh, data: out };
    }
    // Ayrılabilir kutu süzgeci: her hedef pikseli kapladığı kaynak alanının ağırlıklı ortalaması.
    var kx = sw / dw, ky = sh / dh;
    var rowAcc = new Float64Array(dw * 3);
    var acc = new Float64Array(dw * 3);
    for (y = 0; y < dh; y++) {
      var y0 = y * ky, y1 = y0 + ky;
      acc.fill(0);
      for (var yy = Math.floor(y0); yy < Math.min(sh, Math.ceil(y1)); yy++) {
        var wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        if (wy <= 0) continue;
        rowAcc.fill(0);
        var base = ((sy + yy) * W + sx) * 4;
        for (x = 0; x < dw; x++) {
          var x0 = x * kx, x1 = x0 + kx, r = 0, g = 0, b = 0;
          for (var xx = Math.floor(x0); xx < Math.min(sw, Math.ceil(x1)); xx++) {
            var wx = Math.min(x1, xx + 1) - Math.max(x0, xx);
            if (wx <= 0) continue;
            s = base + xx * 4;
            r += data[s] * wx; g += data[s + 1] * wx; b += data[s + 2] * wx;
          }
          rowAcc[x * 3] = r; rowAcc[x * 3 + 1] = g; rowAcc[x * 3 + 2] = b;
        }
        for (x = 0; x < dw * 3; x++) acc[x] += rowAcc[x] * wy;
      }
      var norm = 1 / (kx * ky);
      for (x = 0; x < dw; x++) {
        o = (y * dw + x) * 4;
        out[o] = acc[x * 3] * norm; out[o + 1] = acc[x * 3 + 1] * norm; out[o + 2] = acc[x * 3 + 2] * norm; out[o + 3] = 255;
      }
    }
    return { width: dw, height: dh, data: out };
  }

  function withTimeout(promise, ms, msg) {
    var timer;
    return Promise.race([
      promise,
      new Promise(function (_, reject) { timer = setTimeout(function () { reject(new Error(msg)); }, ms); })
    ]).then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); throw e; });
  }

  function errText(e) {
    if (!e) return 'bilinmeyen hata';
    if (typeof e === 'string') return e;
    return e.message || String(e);
  }

  function absUrl(p) {
    var base = (root.document && root.document.baseURI) || (root.location && root.location.href);
    return new URL(p, base).href;
  }

  var STAGES = {
    'loading tesseract core': [0, 0.3, 'OCR motoru yükleniyor'],
    'initializing tesseract': [0.3, 0.35, 'OCR motoru başlatılıyor'],
    'loading language traineddata': [0.35, 0.9, 'OCR dil verisi yükleniyor'],
    'initializing api': [0.9, 1, 'OCR hazırlanıyor']
  };

  /** tesseract.js işçisi oluşturur (tek dil: İngilizce/Latin; LSTM; PSM 7). */
  function spawnWorker(onProgress) {
    var T = root.Tesseract;
    if (!T || typeof T.createWorker !== 'function') {
      return Promise.reject(new Error('OCR kütüphanesi yüklenemedi (lib/tesseract). Sayfayı yenileyin.'));
    }
    if (typeof root.WebAssembly !== 'object' || typeof root.Worker !== 'function') {
      return Promise.reject(new Error('Bu tarayıcı ekran okumayı (WebAssembly/Worker) desteklemiyor.'));
    }
    var lastFrac = -1;
    function progress(m) {
      if (!m || !STAGES[m.status]) return;
      var st = STAGES[m.status];
      var p = Math.max(0, Math.min(1, Number(m.progress) || 0));
      var frac = st[0] + (st[1] - st[0]) * p;
      if (frac < lastFrac) frac = lastFrac;
      lastFrac = frac;
      var info = { status: m.status, label: st[2], progress: frac };
      if (typeof onProgress === 'function') { try { onProgress(info); } catch (e) { /* çağıranın hatası */ } }
      if (AS.bus) AS.bus.emit('progress', { what: 'ocr-model', label: st[2], loaded: Math.round(frac * 100), total: 100, done: false });
    }
    var created = null;
    var settle;
    var errorWait = new Promise(function (_, reject) { settle = reject; });
    var opts = {
      workerPath: absUrl('lib/tesseract/worker.min.js'),
      corePath: absUrl('lib/tesseract/core'),
      langPath: absUrl('lib/tessdata'),
      cachePath: TESS_CACHE_PATH,
      workerBlobURL: false,
      gzip: true,
      logger: progress,
      // Verilmezse tesseract.js hatayı onmessage içinde fırlatır (yakalanmamış hata). Kurulumdan sonraki
      // tanıma hataları zaten recognize() sözünü reddeder; burada yalnızca kurulum hatası beklenir.
      errorHandler: function (e) {
        if (!created) settle(new Error(errText(e)));
      }
    };
    // tesseract.js işçiyi createWorker() içinde eşzamanlı kurar ve dışarı vermez; kurulum başarısız olursa
    // (çevrimdışı, dosya yok) işçi açık kalır. Kapatabilmek için yalnızca bu çağrı süresince yakalanır.
    var spawned = null;
    var NativeWorker = root.Worker;
    var p;
    try {
      try {
        var Capture = function (url, o) { var wk = new NativeWorker(url, o); spawned = wk; return wk; };
        Capture.prototype = NativeWorker.prototype;
        root.Worker = Capture;
      } catch (e) { /* Worker değiştirilemiyor: yakalamadan devam */ }
      p = T.createWorker('eng', 1, opts);
    } catch (e) {
      if (spawned) { try { spawned.terminate(); } catch (x) {} }
      return Promise.reject(e);
    } finally {
      try { if (root.Worker !== NativeWorker) root.Worker = NativeWorker; } catch (e) {}
    }
    errorWait.catch(function () {});
    return withTimeout(Promise.race([p, errorWait]), CREATE_TIMEOUT_MS, 'zaman aşımı').then(function (worker) {
      created = worker;
      return worker.setParameters({
        tessedit_pageseg_mode: (T.PSM && T.PSM.SINGLE_LINE) || '7',
        tessedit_char_blacklist: CHAR_BLACKLIST,
        tessedit_do_invert: '0',
        user_defined_dpi: '300'
      }).then(function () {
        if (AS.bus) AS.bus.emit('progress', { what: 'ocr-model', label: 'OCR hazır', loaded: 100, total: 100, done: true });
        if (typeof onProgress === 'function') { try { onProgress({ status: 'ready', label: 'OCR hazır', progress: 1 }); } catch (e) {} }
        return worker;
      });
    }, function (e) {
      // Yarım kalmış işçiyi kapat (yoksa iş parçacığı ve wasm belleği açık kalır)
      if (spawned) { try { spawned.terminate(); } catch (x) {} }
      if (AS.bus) AS.bus.emit('progress', { what: 'ocr-model', label: 'OCR yüklenemedi', loaded: 0, total: 100, done: true });
      p.then(function (w) { try { w.terminate(); } catch (x) {} }, function () {});
      var m = errText(e);
      if (/network|fetch|404|Failed to load|NetworkError/i.test(m)) {
        throw new Error('OCR dosyaları indirilemedi. İnternet bağlantısını kontrol edip tekrar deneyin.');
      }
      if (m === 'zaman aşımı') throw new Error('OCR motoru yüklenemedi (zaman aşımı). Tekrar deneyin.');
      if (!e || m === 'bilinmeyen hata' || m === 'undefined') {
        throw new Error('OCR motoru başlatılamadı (işçi yüklenemedi). Sayfayı yenileyip tekrar deneyin.');
      }
      throw new Error('OCR motoru yüklenemedi: ' + m);
    });
  }

  /* ---------- Reader ---------- */
  function Reader(worker, opts) {
    this._worker = worker;
    this._opts = opts || {};
    this._busy = false;
    this._closed = false;
    this._broken = false;
    this._fp = null;
    this._fpKey = '';
    this._surface = null;
    this._last = { text: '', conf: 0, lines: [], box: null, pass: null };
    this.debug = null;
    // terminate() bekleyen tanımayı hemen sonlandırsın (tesseract.js kapatılan işçinin işini hiç bitirmez).
    var self = this;
    this._closedP = new Promise(function (_, reject) { self._rejectClosed = reject; });
    this._closedP.catch(function () {});
  }

  /** Reader.create({onProgress, debug}) → Promise<Reader> */
  Reader.create = function (opts) {
    opts = opts || {};
    return spawnWorker(opts.onProgress).then(function (worker) { return new Reader(worker, opts); });
  };

  Reader.prototype._ensureWorker = function () {
    var self = this;
    if (this._worker && !this._broken) return Promise.resolve(this._worker);
    this._broken = false;
    return spawnWorker(this._opts.onProgress).then(function (w) {
      if (self._closed) { try { w.terminate(); } catch (e) {} throw new Error('OCR kapatıldı.'); }
      self._worker = w;
      return w;
    });
  };

  /** Parmak izini unut (bir sonraki okuma kesin OCR yapar). */
  Reader.prototype.reset = function () {
    this._fp = null;
    this._fpKey = '';
  };

  Reader.prototype._sameResult = function (busy) {
    var l = this._last;
    var r = { same: true, text: l.text, conf: l.conf, lines: l.lines, box: l.box, pass: l.pass };
    if (busy) r.busy = true;
    return r;
  };

  /**
   * read(source, region) → Promise<{text, conf, lines, box, pass, ms} | {same:true, ...}>
   * source: HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap | HTMLImageElement |
   *         VideoFrame | {width, height, data(RGBA)}; region: {x,y,w,h} kesirler (varsayılan ayar ocrRegion).
   * Görüntü değişmediyse OCR yapmadan {same:true, ...son sonuç} döner; okuma sürerken çağrılırsa
   * {same:true, busy:true, ...} döner.
   * lines: [{text, conf, mask, x, y, w, h}] (kaynağa göre kesir); box: tüm satırların kutusu (kesir).
   */
  Reader.prototype.read = function (source, region) {
    if (this._closed) return Promise.reject(new Error('OCR kapatıldı.'));
    if (this._busy) return Promise.resolve(this._sameResult(true));
    var self = this;
    this._busy = true;
    var p;
    try { p = this._read(source, region); } catch (e) { p = Promise.reject(e); }
    return p.then(function (r) { self._busy = false; return r; }, function (e) {
      self._busy = false;
      self.reset(); // aynı kare bir sonraki çağrıda yeniden okunsun
      throw e;
    });
  };

  Reader.prototype._grab = function (source, sx, sy, sw, sh, dw, dh) {
    if (source && source.data && typeof source.getContext !== 'function' && typeof source.width === 'number') {
      return cropRaw(source, sx, sy, sw, sh, dw, dh);
    }
    var s = this._surface;
    if (!s) s = this._surface = makeCanvas(dw, dh);
    if (s.canvas.width !== dw || s.canvas.height !== dh) {
      s.canvas.width = dw;
      s.canvas.height = dh;
    }
    var ctx = s.ctx;
    ctx.imageSmoothingEnabled = true;
    try { ctx.imageSmoothingQuality = 'medium'; } catch (e) { /* eski tarayıcı */ }
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh);
    try {
      return ctx.getImageData(0, 0, dw, dh);
    } catch (e) {
      throw new Error('Bu görüntü güvenlik nedeniyle okunamıyor.');
    }
  };

  Reader.prototype._read = async function (source, region) {
    var t0 = AS.util && AS.util.now ? AS.util.now() : Date.now();
    var size = sourceSize(source);
    if (!size) return { text: '', conf: 0, lines: [], box: null, pass: null, ms: 0, empty: true };
    var r = normRegion(region);
    var W = size.w, H = size.h;
    var l = Math.min(W - 1, Math.max(0, Math.floor(r.x * W)));
    var t = Math.min(H - 1, Math.max(0, Math.floor(r.y * H)));
    var rr = Math.min(W, Math.max(l + 1, Math.floor((r.x + r.w) * W)));
    var bb = Math.min(H, Math.max(t + 1, Math.floor((r.y + r.h) * H)));
    var s = Math.min(1, Math.sqrt(MAX_FRAME_PIXELS / (W * H)));
    var cw = Math.max(1, Math.round((rr - l) * s)), ch = Math.max(1, Math.round((bb - t) * s));
    var img = this._grab(source, l, t, rr - l, bb - t, cw, ch);

    // Görüntü değişmediyse tekrar okumaya gerek yok.
    var key = W + 'x' + H + '|' + l + ',' + t + ',' + rr + ',' + bb;
    var fp = fingerprint(img);
    var same = key === this._fpKey && fpSame(fp, this._fp);
    this._fp = fp;
    this._fpKey = key;
    if (same) {
      var sr = this._sameResult(false);
      sr.ms = Math.round((AS.util && AS.util.now ? AS.util.now() : Date.now()) - t0);
      return sr;
    }

    var worker = await this._ensureWorker();
    // Yatay denetimler bölgeye göre (tam genişlikte bölge = Android ile aynı), harf boyu kaynağa göre.
    var findOpts = { screenW: cw, screenH: Math.round(H * s), regionLeft: 0 };
    var budget = MAX_LINES;
    var seen = Object.create(null);
    var result = null, firstConf = 0;
    var debugImgs = this._opts.debug ? [] : null;

    for (var pi = 0; pi < PASS_NAMES.length && budget > 0; pi++) {
      findOpts.passes = [PASS_NAMES[pi]];
      var lines = findLines(img, findOpts);
      if (!lines.length) continue;
      if (lines.length > budget) lines = lines.filter(function (x) { return x.best; }).concat(lines.filter(function (x) { return !x.best; })).slice(0, budget).sort(function (a, b) { return a.cy - b.cy; });
      var words = [], fresh = false;
      for (var li = 0; li < lines.length; li++) {
        var g = prepareGrey(img, lines[li]);
        var h = hashGrey(g);
        if (debugImgs) debugImgs.push({ pass: PASS_NAMES[pi], width: g.width, height: g.height, grey: g.grey });
        if (!seen[h]) {
          fresh = true;
          budget--;
          seen[h] = await this._recognize(worker, g);
        }
        words.push(seen[h]);
      }
      if (!fresh) continue; // bu geçiş öncekiyle aynı görüntüyü verdi
      var res = assemble(words);
      if (!firstConf) firstConf = res.conf;
      if (res.text) {
        result = { res: res, lines: lines, pass: PASS_NAMES[pi] };
        break;
      }
    }
    if (debugImgs) this.debug = { images: debugImgs };

    var out;
    if (!result) {
      out = { text: '', conf: firstConf, lines: [], box: null, pass: null };
    } else {
      var outLines = [], ux0 = Infinity, uy0 = Infinity, ux1 = -Infinity, uy1 = -Infinity;
      for (var k = 0; k < result.lines.length; k++) {
        var ln = result.lines[k];
        var fx = (l + ln.x / s) / W, fy = (t + ln.y / s) / H, fw = ln.w / s / W, fh = ln.h / s / H;
        ux0 = Math.min(ux0, fx); uy0 = Math.min(uy0, fy); ux1 = Math.max(ux1, fx + fw); uy1 = Math.max(uy1, fy + fh);
        outLines.push({ text: result.res.lines[k] || '', conf: result.res.conf, mask: ln.mask, x: fx, y: fy, w: fw, h: fh });
      }
      out = {
        text: result.res.text, conf: result.res.conf, lines: outLines, pass: result.pass,
        box: { x: ux0, y: uy0, w: ux1 - ux0, h: uy1 - uy0 }
      };
    }
    out.ms = Math.round((AS.util && AS.util.now ? AS.util.now() : Date.now()) - t0);
    this._last = { text: out.text, conf: out.conf, lines: out.lines, box: out.box, pass: out.pass };
    return out;
  };

  Reader.prototype._recognize = async function (worker, g) {
    try {
      var job = worker.recognize(toPGM(g), {}, { text: false, tsv: true });
      var r = await withTimeout(Promise.race([job, this._closedP]), RECOGNIZE_TIMEOUT_MS, 'timeout');
      return parseTsv(r && r.data && r.data.tsv);
    } catch (e) {
      if (this._closed) throw new Error('OCR kapatıldı.');
      if (errText(e) === 'timeout') {
        // İşçi takıldı: kapat, bir sonraki okumada yeniden kurulur.
        this._broken = true;
        try { worker.terminate(); } catch (x) {}
        this._worker = null;
        throw new Error('OCR yanıt vermedi; yeniden başlatılıyor.');
      }
      return []; // tek satırlık okuma hatası: bu satırı boş say
    }
  };

  /** İşçiyi kapatır; sonraki read() çağrıları hata verir. */
  Reader.prototype.terminate = async function () {
    this._closed = true;
    this._rejectClosed(new Error('OCR kapatıldı.'));
    var w = this._worker;
    this._worker = null;
    this._surface = null;
    if (w) {
      try { await w.terminate(); } catch (e) { /* zaten kapalı */ }
    }
  };

  /** Tarayıcı OCR'yi çalıştırabilir mi (kütüphane + WebAssembly + Worker)? */
  function supported() {
    return !!(root.Tesseract && typeof root.Tesseract.createWorker === 'function' &&
      typeof root.WebAssembly === 'object' && typeof root.Worker === 'function');
  }

  AS.ocr = {
    findLines: findLines,
    prepareLine: prepareLine,
    Reader: Reader,
    supported: supported,
    /* testler ve hata ayıklama için */
    util: {
      fingerprint: fingerprint,
      fpSame: fpSame,
      toPGM: toPGM,
      prepareGrey: prepareGrey,
      parseTsv: parseTsv,
      fixBars: fixBars,
      cropRaw: cropRaw,
      assemble: assemble,
      looksLikeText: looksLikeText,
      isWordLike: isWordLike,
      letterCount: letterCount,
      normRegion: normRegion,
      PASSES: PASS_NAMES.slice(),
      MAX_LINES: MAX_LINES
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);

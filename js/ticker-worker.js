/* Altyazı Şefi Web: arka planda kısılmayan saat (klasik, ayrılmış Web Worker).
 * Ana sayfa gizliyken (kullanıcı videonun sekmesine geçince) tarayıcı ana iş parçacığındaki
 * setTimeout/setInterval'i en az 1 sn'ye, 5 dk sonra dakikada bire kadar kısar. Ayrılmış worker'ların
 * zamanlayıcıları ve worker'dan gelen iletiler kısılmaz; canlı çeviri ekran okuma döngüsünü buradan sürer.
 * Gelen:  {type:'start', interval}  {type:'interval', interval}  {type:'stop'}
 * Giden:  {type:'tick', n, t}  (n: sıra, t: worker saatine göre ms) */
'use strict';

var timer = null;
var interval = 400;
var n = 0;

function clampInterval(v) {
  v = Number(v);
  if (!isFinite(v)) return 400;
  return Math.max(50, Math.min(10000, Math.round(v)));
}

function arm() {
  if (timer !== null) clearInterval(timer);
  timer = setInterval(function () {
    n++;
    self.postMessage({ type: 'tick', n: n, t: self.performance ? self.performance.now() : Date.now() });
  }, interval);
}

self.onmessage = function (e) {
  var d = e && e.data;
  if (!d || typeof d !== 'object') return;
  if (d.type === 'start') {
    interval = clampInterval(d.interval);
    arm();
  } else if (d.type === 'interval') {
    interval = clampInterval(d.interval);
    if (timer !== null) arm();
  } else if (d.type === 'stop') {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }
};

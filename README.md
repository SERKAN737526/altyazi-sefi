# Altyazı Şefi Web

Yabancı altyazıyı ve konuşmayı anında Türkçeye çeviren bilgisayar sürümü. Program kurulmaz, tarayıcıda açılır.
Windows, Mac ve Linux'ta çalışır.

## Hangi tarayıcı?

| Tarayıcı | Ne çalışır |
|---|---|
| **Chrome / Edge** (önerilen) | Her şey: başka sekmedeki dizinin yazısını ve sesini çevirme, her zaman üstte duran altyazı penceresi, video dosyası, YouTube |
| Safari / Firefox | Ekrandaki yazıyı okuma ve altyazılı video dosyası. Başka sekmenin **sesi** bu tarayıcılarda paylaşılamadığı için konuşma çevirisi yalnızca video dosyasında çalışır |

## Üç mod

1. **Canlı çeviri**: Diziyi açtığın sekmeyi seçersin ("Sekme sesini de paylaş" işaretli kalsın). Uygulama ekrandaki
   altyazıyı okur ve konuşmayı dinler, Türkçesini gösterir. "Altyazı penceresini aç" düğmesi, diğer sekmenin üstünde
   duran küçük bir altyazı penceresi açar.
2. **Video dosyası**: Bilgisayarındaki videoyu aç. Yanında .srt/.vtt altyazı varsa onu çevirir. Yoksa konuşmadan
   altyazı çıkarır. Türkçe SRT dosyasını indirebilirsin.
3. **YouTube**: Bağlantıyı yapıştır. Video sayfada açılır, altına Türkçe altyazı gelir. Bunun için videonun sesinden
   altyazı çıkarır ya da bir SRT dosyası kullanır. Bu gömülü oynatıcının içindeki reklamlara bir web sitesi dokunamaz;
   reklamsız izlemek için aşağıdaki yer imi düğmesini YouTube'un kendi sayfasında kullan.

**YouTube yer imi düğmesi:** YouTube bölümündeki turuncu "Altyazı Şefi (YouTube)" düğmesini bir kez yer imleri
çubuğuna sürükle (Ctrl+Shift+B / Mac: Cmd+Shift+B çubuğu açar). YouTube'da bir video açıp bu yer imine tıklayınca
videonun kendi altyazısı (hangi dilde olursa) alınır, Türkçesi videonun üstünde gösterilir. Türkçe altyazı varsa çevrilmez.
Reklamlar da atlanır (telefon uygulamasındaki yöntemle: reklam alanları gizlenir, sonraki videoların reklam planı
silinir, yine de reklam başlarsa sesi kısılıp sona sarılır ve "Atla"ya basılır). Sağ üstteki panelden dil seçilir,
Türkçe SRT indirilir, reklam atlama kapatılabilir. Safari'de sürükleme yerine "Kodu kopyala" ile yeni bir yer
iminin adresine yapıştır. Bir web sitesi YouTube'un verisini doğrudan okuyamadığı için bu iş YouTube sayfasının içinde,
yer imiyle yapılır; dışarıdan kod yüklenmez, dışarı yalnızca çevrilecek altyazı metni gider.

## İnternetsiz kullanım

İlk açılışta "Çevrimdışı için hazırla" düğmesine bas. Uygulama dosyaları (~17 MB) ve konuşma modeli iner, Chrome'da
cihaz içi çeviri paketi de indirilir. Ondan sonra ekran okuma, konuşma tanıma ve (Chrome'da) çeviri internetsiz çalışır.
Cihaz içi çeviri yoksa çeviri için internet gerekir. Bu durumda metin Google Çeviri'ye, o da çalışmazsa MyMemory'ye
gönderilir. Bunu Ayarlar'dan kapatabilirsin.

## Yayınlama (siteyi açmak için bir kez yapılır)

Site sıradan statik dosyalardan oluşur ve **https** ile sunulmalıdır. Dosyayı çift tıklayıp `file://` ile açınca
çalışmaz, çünkü tarayıcı bu durumda gerekli parçaları engeller.

**A) GitHub Pages (kalıcı, ücretsiz):** GitHub'da boş bir depo aç, bu klasörün içeriğini yükle
(`tests/` klasörü gerekmez), sonra Settings → Pages → "Deploy from a branch" → `main` / `(root)` seç.
Birkaç dakika içinde `https://KULLANICIADI.github.io/DEPOADI/` adresinde açılır.

**B) Netlify Drop (en hızlı):** https://app.netlify.com/drop adresine git, ücretsiz hesapla giriş yap,
bu klasörü sayfaya sürükle. Sana hemen bir `https://....netlify.app` adresi verir.

## Gizlilik ve güvenlik

- Görüntü ve ses bilgisayarından çıkmaz. Ekran okuma ve konuşma tanıma tarayıcının içinde çalışır.
- Dışarı giden tek şey çevrilecek metindir, o da yalnızca cihaz içi çeviri yoksa ve Ayarlar'da izin verildiyse gider.
  Konuşma modeli ilk seferde Hugging Face'ten indirilir.
- Sayfa sıkı bir İçerik Güvenlik Politikası (CSP) ile gelir. Altyazı dosyalarındaki ve ekrandan okunan metinler hiçbir zaman
  kod olarak çalıştırılmaz.
- Hesap, çerez ya da takip yoktur. Ayarlar yalnızca bu tarayıcıda saklanır.

## Geliştirici notları

- Mimari ve modül sözleşmesi: `ARCHITECTURE.md`.
- Testler: `bash tests/run-all.sh` (Node 22 ve Playwright Chromium gerekir).
- Kullanılan açık kaynak kütüphaneler `lib/` altında, lisanslarıyla birlikte: tesseract.js 6.0.1 (Apache-2.0),
  tesseract.js-core 6.0.0 (Apache-2.0), İngilizce dil verisi tessdata 4.0.0_best_int (Apache-2.0),
  @huggingface/transformers 3.7.5 + onnxruntime-web (Apache-2.0 / MIT). Konuşma modelleri: OpenAI Whisper
  (MIT), onnx-community dönüşümleri.

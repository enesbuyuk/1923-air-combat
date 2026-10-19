<div align="center">

<img src="web/img/logo.png" alt="1923 Air Combat" width="320" />

# 1923 Air Combat

[English](README.md) | **Türkçe**

**İstanbul semalarında tarayıcıda oynanan uçuş ve it dalaşı oyunu**

Türk Hava Üssü'nden (LTBX) kalk, düşman dalgalarını düşür ve piste sağ salim geri in.

[![Canlı Demo](https://img.shields.io/badge/Canl%C4%B1%20Demo-Hemen%20oyna-2ea44f?style=for-the-badge)](https://1923-air-combat.enesbuyuk.com)

[![Lisans: MIT](https://img.shields.io/badge/Lisans-MIT-yellow.svg)](LICENSE)
![Rust](https://img.shields.io/badge/Rust-WebAssembly-orange?logo=rust)
![Three.js](https://img.shields.io/badge/Three.js-0.160-black?logo=three.js)
![WebAudio](https://img.shields.io/badge/Audio-WebAudio-blue)
![Dependencies](https://img.shields.io/badge/WASM%20dependencies-0-brightgreen)
[![GitHub stars](https://img.shields.io/github/stars/enesbuyuk/1923-air-combat?style=social)](https://github.com/enesbuyuk/1923-air-combat)

**[Tarayıcıda oyna →](https://1923-air-combat.enesbuyuk.com)** · [Hata bildir](https://github.com/enesbuyuk/1923-air-combat/issues) · [Özellik iste](https://github.com/enesbuyuk/1923-air-combat/issues)

</div>

---

## İçindekiler

- [Ekran Görüntüleri](#ekran-görüntüleri)
- [Özellikler](#özellikler)
- [Uçaklar](#uçaklar)
- [Hızlı Başlangıç](#hızlı-başlangıç)
- [Kontroller](#kontroller)
- [Oyun Modları](#oyun-modlari)
- [Hayatta Kalma İpuçları](#hayatta-kalma)
- [İniş Rehberi](#inis-rehberi)
- [3D Modeller](#3d-modeller)
- [Şehir](#şehir)
- [Proje Yapısı](#proje-yapısı)
- [Emeği Geçenler ve Lisanslar](#emeği-geçenler-ve-lisanslar)
- [Lisans](#lisans)

## Ekran Görüntüleri

Yerelde çalışan oyundan alındı. Tam boyutunu görmek için görsele tıkla.

| Uçak seçimi | İstanbul üzerinde KAAN |
|:---:|:---:|
| [![Pist 36 üzerindeki KAAN MMU ile uçak seçim menüsü](docs/screenshots/aircraft-selection.jpg)](docs/screenshots/aircraft-selection.jpg) | [![Takip kamerası ve uçuş göstergeleriyle İstanbul üzerinde dönüş yapan KAAN](docs/screenshots/kaan-flight.jpg)](docs/screenshots/kaan-flight.jpg) |

| Escort modunda F-22 tırmanışı | Kokpit ve uçuş göstergeleri |
|:---:|:---:|
| [![Escort modunda şehir üzerinde tırmanan F-22 Raptor](docs/screenshots/f22-takeoff.jpg)](docs/screenshots/f22-takeoff.jpg) | [![Hız, irtifa, mühimmat, yakıt ve radar göstergeleriyle F-22 kokpit görünümü](docs/screenshots/cockpit-hud.jpg)](docs/screenshots/cockpit-hud.jpg) |

## Özellikler

- **Rust → WebAssembly oyun çekirdeği:** uçuş fiziği, kalkış/iniş, stall, bot yapay zekâsı, top mermisi, güdümlü füze ve kilitlenme, flare, çarpışma, dalga sistemi ve görevler. Dış bağımlılık yok, ~80 KB.
- **Uçuş fiziği:** hücum açısı ve yan kayması olan gerçek bir hız vektörü; taşıma ve sürükleme ISA hava yoğunluğu ve hızın karesiyle ölçeklenir, dönüşler hız (corner speed) ve uçağa özgü G limitiyle sınırlanır, sert çekişler indüklenmiş sürüklemeyle enerji kaybettirir. Mach 1 civarında transonik sürükleme artışı, irtifayla azalan itki, motor gecikmesi, yer etkisi, hamleli rüzgar ve alçak irtifa türbülansı.
- **Altı serbestlik dereceli katı cisim:** aerodinamik momentler (statik kararlılık, yunuslama / yatış / sapma sönümü, dihedral, kumanda yüzeyleri, stall kırılması, kanat düşmesi ve otorotasyon) ve eylemsizlik momentlerinin jiroskopik eşleşmesi (Euler denklemleri) gövdeyi döndürür. Hücum açısı / G sınırlayıcılı, otomatik trimli, koordineli dönüş yapan ve uçuş yolu etrafında yatan fly-by-wire uçuş kontrol bilgisayarı, hız sınırlı kumanda yüzeylerini stall olmamış gövde modelinin dinamik ters çevrimiyle sürer; yavaş ya da stall olmuş uçak kumanda otoritesini kendiliğinden kaybeder. Her şey 120 Hz dördüncü derece Runge-Kutta ile ilerler.
- **Yakıt ve ağırlık:** afterburner'da yakıt tüketimi hızla artar; dolu depo uçağı ağırlaştırır (daha yüksek stall hızı, daha yavaş tırmanış), boş depo motoru durdurur.
- **Enerji ve limitler:** kontroller yüksek hızda sertleşir; uçak en iyi azami hızda değil, corner speed civarında döner ve yatar. Sert çekerken yatış daha yavaştır. Rudder'lı stall'da stick geride tutulursa uçak spine girer (çıkmak için stick ileri ve ters rudder); yapısal hız sınırını aşan dalış gövdeye hasar verir (OVERSPEED).
- **Gerçek performans zarfı:** itki/ağırlık oranı gerçek uçaklara yakın (F-16 ~1.1, B-2 ~0.4); itki irtifayla düşer ve tropopozun üstünde daha hızlı düşer (her uçağın bir servis tavanı vardır); afterburner itkisi Mach ile artar, afterburner yakılınca yakıt tüketimi sıçrar. Top mermileri sürüklenmeyle yavaşlar ve saçılır; füzeler beş saniye yanar, en yakın geçişte patlar ve ıska mesafesi arttıkça daha az hasar verir; modern arayıcılar flare'lerin çoğunu ayırt eder; havada çarpışan iki uçak da kaybolur.
- **Realism ayarı (Arcade / Simulator):** Simulator top nişan yardımını ve büyütülmüş isabet kutularını kaldırır, gerçek mühimmat yükler (F-16: 511 mermi, yaklaşık beş saniyelik atış; B-2 havadan havaya silah taşımaz), iniş limitlerini sıkılaştırır (6 m/s üstü alçalma veya 20 dereceden fazla yatışta iniş takımı kırılır, fazla hızlı temasta lastik patlar), alan sınırındaki görünmez dönüşü kaldırır (geri dönmek için 30 s, yoksa uçak kaybedilir), yer ekibi 90 s sürer ve düşman füzesi isabeti öldürücüdür.
- **Sistem hasarı:** isabetler gövde hasarının yanında motoru (daha az itki), uçuş kontrollerini (ağır pitch ve roll) ya da yakıt deposunu (sızıntı) vurabilir.
- **Yer ekibi:** havalimanındaki beş hangardan birine taksi yap, dur ve gazı rölantiye al; ekip birkaç saniyede mühimmatı, yakıtı ve hasarı yeniler. Hangar dışında ikmal yok.
- **Düşmanlar aynı uçuş modelini uçar:** bot yapay zekâsı sadece stick ve gazı oynatır; düşmanlar dönüşte enerji kaybeder, stall olabilir ve yere dikkat etmek zorundadır. Taktikler: devriye, lead / pure / lag takip, kuyruktaki saldırgana karşı maksimum G kırış, flare ile füzeden kaçış, alçak veya yavaşken toparlanma.
- **Gerçek enerjili füzeler:** orantılı seyrüsefer (PN) güdümü, birkaç saniye yanıp sonra süzülen roket motoru, hava yoğunluğuyla artan sürükleme, yavaşlayınca etkisini kaybeden kanatçıklar ve seeker gimbal limiti. Geç ve yavaşlamış bir füze dönüşle atlatılabilir; uzaktaki kaçan bir hedefe yetişemez.
- **Karşı tedbir ve radar ikaz:** düşman avcıları ikinci dalgadan itibaren kilitlenip füze atar; RWR sesi, HUD ve radar kilitleri ve gelen füzeleri yönüyle gösterir. Flare füzeyi aldatabilir; sıcak egzoza kuyruktan bakan seeker en zor kandırılanıdır, gazı kes ve dön.
- **Görevler:** sonsuz *Waves*, *Strike* (her hedef bölgesindeki SAM sahalarını yok et; radar ufkunun üstündeki her şeye ateş ederler, alçak uç), *Escort* (dost bir B-2'yi rotası boyunca koru) ve *Free* (düşman yok, sadece uç).
- **Kill cam:** düşürüldükten sonra son saniyeler ağır çekimde tekrar oynatılır.
- **Sabit adımlı simülasyon:** çekirdek kare hızından bağımsız olarak her adımda 1/60 sn ilerler, görüntü adımlar arasında interpolasyon yapar.
- **Gamepad ve dokunmatik:** standart eşlemeli gamepad'ler doğrudan çalışır; dokunmatik ekranlarda ekran üstü stick, gaz ve butonlar çıkar.
- **Gerçek dünya:** Esri World Imagery uydu karoları (3 zoom seviyesi); pistler, apronlar ve helipadler OpenStreetMap geometrisinden (18/36 ana pist 1415 m, 04/22 çapraz pist).
- **Sonsuz prosedürel şehir:** uçtukça etrafında açılan, her oyunda farklı İstanbul silueti.
- **Kilitlenmeli füzeler ve otomatik nişanlı top**
- **Pilot kariyeri:** her düşürülen uçak tarayıcıda saklanan toplam kill sayısına eklenir; Cadet (0) rütbesinden başlayıp Second Lieutenant (5), First Lieutenant (15), Captain (30), Major (60), Lieutenant Colonel (100), Colonel (175), Brigadier General (275), Major General (400) ve Lieutenant General (600) üzerinden General (900) rütbesine terfi edersin.
- **Sentezlenmiş ses:** motor, silah ve patlama sesleri WebAudio ile anlık üretiliyor. Tek kayıtlı ses "Pull up, pull up" alçak irtifa sesli uyarısı (`web/audio/pull_up.mp3`).
- **Kurulum yok:** tarayıcıda açılıyor.

## Uçaklar

| Uçak | Karakter |
|---|---|
| **F-16 Fighting Falcon** | Dengeli, çevik |
| **F-22 Raptor** | En hızlı ve en çevik |
| **B-2 Spirit** | Yavaş, hantal, çok dayanıklı, 16 füze |
| **KAAN MMU** | Hızlı, çevik, 8 füze |

Düşmanlar aynı modellerin kırmızı tonlu versiyonlarıdır. 3. dalgadan itibaren her dalgada bir **B-2** bulunur (500 puan).

## Hızlı Başlangıç

Oynamak için kurulum gerekmez: **[1923-air-combat.enesbuyuk.com](https://1923-air-combat.enesbuyuk.com)** adresini aç.

Yerelde çalıştırmak için:

**Gereksinimler:** [Rust](https://rustup.rs) (`rustup`), Python 3

```bash
git clone https://github.com/enesbuyuk/1923-air-combat.git
cd 1923-air-combat
./build.sh serve        # wasm'ı derler, http://localhost:8080 adresini açar
```

- Sadece derlemek için: `./build.sh`
- 8080 doluysa betik bir sonraki boş portu bulur; elle seçmek için: `PORT=3000 ./build.sh serve`

> [!NOTE]
> WASM `fetch` ile yüklendiği için `index.html` dosyasını `file://` üzerinden açmak çalışmaz; bir HTTP sunucusu gerekir.

## Kontroller

| Tuş | İşlev |
|---|---|
| `S` / `↓` | Burun yukarı (kalkışta Vr hızında bas) |
| `W` / `↑` | Burun aşağı |
| `A` `D` / `←` `→` | Yatış (roll) |
| `Q` `E` | Dümen (yerde burun tekerleği) |
| `Shift` / `R` | Gaz artır |
| Sol `Ctrl` / `F` | Gaz azalt (tam ekranda `Ctrl+W` sekmeyi kapatmaz) |
| `Space` / sol tık | Top, burnun ~10° yakınındaki hedeflere otomatik nişan alır |
| `X` / sağ tık | Füze, kilitlenmek için hedefi ~0.6 sn boyunca 30° koni içinde tut |
| `C` | Flare (basılı tutunca atmaya devam eder) |
| `B` | Yerde tekerlek freni, havada hava freni |
| `V` | Kamera (kokpit / takip) |
| `H` | Kontrol listesini göster / gizle |
| Fare tekerleği | Takip kamerası yakınlaştırma |
| Orta tuşla sürükleme | Etrafa bakma (kokpit) / uçağın çevresinde dönme (takip) |
| `I` | Pitch eksenini ters çevir |
| `M` | Sesi aç / kapat |
| `Esc` | Duraklat |

**Gamepad** (standart eşleme): sol stick pitch ve roll, sağ stick dümen, `RT` / `LT` gaz artır / azalt, `A` top, `B` füze, `X` veya `RB` flare, `LB` fren, `Y` kamera, `Start` duraklat.

**Dokunmatik ekranlar:** uçarken ekran üstü stick (sol alt), gaz kaydırıcısı ve silah butonları (sağ alt) görünür.

<a id="oyun-modlari"></a>

## Oyun Modları

Modu menüden veya duraklatma ekranından seç.

| Mod | Hedef |
|---|---|
| **Waves** | Sonsuz düşman dalgaları. Düşman avcıları ilk dalgada füze taşımaz, sonra en fazla iki (kolayda bir) taşır. |
| **Strike** | Hedef bölgedeki tüm SAM sahalarını top veya füzeyle yok et (uçaklar gibi kilitlenirler). Her saha 7 km içinde ~120 m üstündeki uçağa kilitlenip ateş eder; daha alçak uçmak seni radarından saklar. Temizlenen bölge bonus kazandırır, ardından daha büyük bir bölge gelir. Küçük düşman dalgaları koruma yapar. |
| **Escort** | Dost bir B-2 (HUD ve radarda mavi) üs çevresinde bir tur uçar. Düşman avcıları onu hedefler; sekiz ayağı tamamlatırsan bonus kazanırsın. |
| **Free** | Düşman, SAM sahası veya hedef yok. Şehrin üstünde serbestçe uç. |

<a id="hayatta-kalma"></a>

## Hayatta Kalma İpuçları

- Radar halkası ve yükselen cıvıltı bir düşman radarının sana kilitlendiğini gösterir; hızlı ötüş ve radardaki kırmızı çizgi havada bir füze olduğunu gösterir.
- Füzeye karşı: flare at (`C`), gazı geri çek ve füzenin yolunu keserek sert dön. Motoru bitince füze enerji kaybeder, geç ve yavaş bir füze dönüşle atlatılabilir.
- Yakıt göstergesini izle: `BINGO FUEL` eve dönme zamanı demek. İn, bir hangara taksi yap, `B` ile dur ve rölantide bekle; yer ekibi yakıtı, mühimmatı, flare'leri, gövdeyi ve sistemleri yeniler.

<a id="inis-rehberi"></a>

## İniş Rehberi

1. `Ctrl` ile gazı kes, `B` ile hava frenini aç.
2. ~300-350 km/s hıza düş ve burun hafif aşağıda süzül.
3. Son 25 m'de yer etkisi alçalmayı yumuşatır; `S` ile burnu hafifçe kaldır (flare).
4. İniş takımları alçak ve yavaşken otomatik açılır. Pistte gaz geri çekiliyken spoyler'ler taşımayı keser; teker değerken flare'i tutmak uçağı tekrar havaya sektirmez.

| Limit (Arcade) | Değer |
|---|---|
| Dikey hız | < 22 m/s (10 m/s üzeri gövdeye hasar verir ama uçağı yok etmez) |
| Yatış | < ~45° |
| Burun | < ~20° aşağı |

Daha sert inişler veya dik dalışlar patlamayla biter. İki pistin yaklaşma koridorlarındaki binalar 1:40 eğimli engel yüzeyinin altında tutulur; normal bir süzülüş bunların üzerinden geçer.

## 3D Modeller

Dört uçağın GLB modelleri `web/models/` altında. Bir dosya eksikse oyun o uçak için kendi prosedürel modelini üretir. Değiştirmek için aynı isimle bir dosya koyman yeterli:

```
web/models/f16.glb
web/models/f22.glb
web/models/b2.glb
web/models/kaan.glb
```

- Modelde `landingOn`/`landingOff` (veya `gearDown`/`gearUp`) isimli parçalar varsa iniş takımları otomatik açılıp kapanır ve tekerlekler piste oturur.
- Ölçek otomatiktir: model uçağın gerçek uzunluğuna göre normalize edilir (örn. F-16 → 15 m). Burun `-Z` yönüne bakmalı.
- Yanlış yöne bakan bir model `web/models/models.json` ile düzeltilir:

```json
{
  "f16": { "rotation": [0, 180, 0], "scale": 1 },
  "kaan": { "rotation": [0, 90, 0], "lengthAxis": "z" }
}
```

Kullandığın modellerin lisanslarına dikkat et (CC-BY atıf gerektirir).

## Şehir

Havalimanının çevresinde (~6 km) **gerçek binalar** var: OpenStreetMap'ten çekilen bina tabanları kat/yükseklik verilerine göre yükseltilir (`web/js/buildings.js`, veri `web/data/buildings.json` içinde). Veriyi yenilemek veya yarıçapı değiştirmek için:

```bash
uv run python3 tools/fetch_osm_buildings.py 6000   # metre cinsinden yarıçap
```

Bina verisi © [OpenStreetMap](https://www.openstreetmap.org/copyright) katkıcıları, ODbL.

Bu alanın ötesinde rastgele bir şehir devam eder. Binalar ve ağaçlar Kenney'nin [City Kit (Commercial)](https://kenney.nl/assets/city-kit-commercial) ve [City Kit (Suburban)](https://kenney.nl/assets/city-kit-suburban) paketlerinden (CC0) geliyor, `web/models/city/` altında.

`web/js/city.js` dünyayı 500 m'lik parçalara böler. Oyuncu uçtukça yakındaki parçalar tohumlu rastgelelikle doldurulur:

- **Şehir merkezi** → ofisler ve gökdelenler
- **Banliyö** → evler
- **Kırsal** → ağaçlar

Yakın parçalar detaylı, uzaktakiler düşük detaylı modellerle çizilir. Her açılışta yeni bir tohum → yeni bir şehir; aynı oturumda bir bölgeye geri dönünce aynı binalar görünür.

## Proje Yapısı

```
wasm/src/lib.rs                WASM dışa aktarımları (Rust → wasm32-unknown-unknown)
wasm/src/config.rs             uçak performansı, zorluk, fizik ve pist sabitleri
wasm/src/layout.rs             JS ile paylaşılan çıktı tampon düzeni
wasm/src/math.rs               vektörler, kuaterniyonlar, RNG
wasm/src/entities.rs           ortak gövde durumu, oyuncu, bot, mermi, füze, flare, SAM sahası verileri
wasm/src/game/aero.rs          oyuncu ve botların ortak uçuş modeli (taşıma, sürükleme, itki, yakıt, kütle, 6DOF katı cisim, fly-by-wire)
wasm/src/game/flight.rs        oyuncu: yer koşusu, teker koyma, yer ekibi, silahlar, flare, kilitlenme
wasm/src/game/bots.rs          düşman dalgaları, bot taktikleri ve otopilot
wasm/src/game/projectiles.rs   top mermileri, füze güdümü ve enerjisi, flare
wasm/src/game/missions.rs      oyun modları: waves, strike (SAM sahaları), escort, free
wasm/src/game/                 ayrıca oyun durumu (mod.rs), atmosfer/hava (air.rs), testler (cargo test)
web/index.html                 menü + katmanlar
web/js/main.js                 açılış, oyun durumu, oyun döngüsü, olay işleme
web/js/sim.js                  wasm yükleme + tamponları isimli alanlara çözme
web/js/layout.js               layout.rs'nin JS karşılığı
web/js/aircraft.js             uçak listesi (isim, uzunluk, kokpit göz noktası, egzozlar, füzeler, G limiti)
web/js/actors.js               sahnedeki oyuncu/bot uçakları: alevler, iniş takımı
web/js/camera.js               menü, kokpit, takip, enkaz ve kill cam kameraları
web/js/airflow.js              hava akışı çizgileri ve sarsıntı seviyesi (hamle, türbülans, yüksek hücum açısı)
web/js/vortex.js               kanat ucu girdap ipleri (sirkülasyon, alçalma, sarılma, yer etkisi, çekirdek büyümesi)
web/js/vapor.js                sert çekişte kanat üstü buharı, ses hızı civarında buhar konisi
web/js/atmosphere.js           gökyüzü, gökyüzünden ortam aydınlatması, irtifaya bağlı pus
web/js/clouds.js               kamera çevresinde cumulus bulutları, bulut içinde beyazlama
web/js/post.js                 son işleme: ısı dalgalanması, bulut beyazlaması, bloom, ton eşleme
web/js/flyby.js                yakındaki uçakların sesi (Doppler, yön) ve sonic boom
web/js/wing.js                 her modelin mesh'inden ölçülen kanat ucu ve kök veter
web/js/input.js                klavye / fare / gamepad kontrolleri
web/js/touch.js                ekran üstü dokunmatik kontroller
web/js/replay.js               kill cam kaydı ve ağır çekim tekrar
web/js/ground.js               SAM sahası modelleri (strike modu)
web/js/gforce.js               G kararması / G-LOC efekti
web/js/menu.js                 uçak seçim menüsü
web/js/settings.js             gerçekçilik / oyun modu / zorluk / düşman yoğunluğu ayarları
web/js/collision.js            bina çarpışma testleri
web/js/models.js               prosedürel uçak + GLB yükleyici
web/js/world.js                uydu zemini, pistler, gökyüzü
web/js/buildings.js            OSM'den gerçek binalar (havalimanı çevresi)
web/js/city.js                 akışlı prosedürel şehir (Kenney modelleri)
web/js/effects.js              izli mermiler, füzeler, flare, patlamalar, duman
web/js/hud.js                  HUD (pitch merdiveni, hız/irtifa, radar ve RWR, hedef kutuları, yakıt, sistemler, görev)
web/js/audio.js                sentezlenmiş sesler + pull up sesli uyarısı
web/audio/pull_up.mp3          "Pull up, pull up" ses kaydı
tools/fetch_osm_buildings.py   OSM bina tabanlarını oyun koordinatlarına çeviren yardımcı betik
build.sh                       derleme + yerel sunucu
```

### JS ↔ WASM arayüzü

```
init(aircraft, seed)   set_input(...)   set_mode(mode)   step(dt)
```

Durum doğrusal bellekten `Float32Array` olarak okunur: `player_ptr`, `bots_ptr`, `bullets_ptr`, `missiles_ptr`, `flares_ptr`, `ground_ptr`, `events_ptr`, `stats_ptr`. JS döngüsü `step`i her zaman sabit 1/60 sn adımla çağırır. Alan sırası `wasm/src/layout.rs` içinde tanımlı ve `web/js/layout.js` içinde aynısı var; ikisini birlikte değiştir.

## Emeği Geçenler ve Lisanslar

| Varlık | Kaynak | Lisans |
|---|---|---|
| F-16 modeli | ["F-16 Fighting Falcon - Fighter Jet - Free"](https://sketchfab.com/3d-models/f-16-fighting-falcon-fighter-jet-free-f0b00989e5634764848ef2c235c64db5), bohmerang | CC-BY-NC-SA-4.0 (ticari kullanım yok) |
| F-22 modeli | ["F-22 Raptor - Fighter Jet - Free"](https://sketchfab.com/bohmerang), bohmerang | CC-BY-NC-SA-4.0 (ticari kullanım yok) |
| KAAN modeli | "KAAN - Milli Muharip Uçak - KAAN 3D MODEL", [Özcan Özaltın](https://sketchfab.com/ozcan_36) | CC-BY-4.0 |
| B-2 modeli | "B-2 spirit", [hilos run](https://sketchfab.com/josue.santiagorm22) | CC-BY-4.0 |
| Hangar modeli | ["Rebel Hangar Version 1"](https://sketchfab.com/3d-models/rebel-hangar-version-1-2dfef17c8737459e95af621034acb00b), [MichaelEGA](https://sketchfab.com/MichaelEGA) | CC-BY-4.0 |
| Şehir modelleri | [Kenney](https://kenney.nl) City Kit | CC0 |
| Uydu görüntüsü | © Esri, Maxar, Earthstar Geographics | - |
| Pist verisi | © OpenStreetMap katkıcıları | ODbL |
| Mini harita karoları | © Esri, HERE, Garmin, © OpenStreetMap katkıcıları | - |

> [!IMPORTANT]
> F-16 ve F-22 modelleri ticari olmayan lisanslar altındadır; proje bu modellerle birlikte ticari amaçla dağıtılamaz.

## Lisans

Bu projenin kaynak kodu (Rust, JavaScript, HTML, CSS, Python ve shell betikleri) [MIT Lisansı](LICENSE) ile yayınlanmıştır.

Üçüncü taraf varlıklar (3D modeller, uydu görüntüleri ve harita verileri) MIT Lisansı kapsamında **değildir**; [Emeği Geçenler ve Lisanslar](#emeği-geçenler-ve-lisanslar) bölümünde listelenen kendi lisanslarına tabidir.

---

<div align="center">

Geliştiren: [Enes Buyuk](https://github.com/enesbuyuk) · [Canlı Demo](https://1923-air-combat.enesbuyuk.com) · [Kaynak Kod](https://github.com/enesbuyuk/1923-air-combat)

</div>

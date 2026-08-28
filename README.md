# Benim Meram — Senkronizasyon Sunucusu

Bu, HTML uygulamasını (`benim-meram-standalone.html`) birden fazla kişinin
aynı verilerle (aynı ilanlar, teklifler, mesajlar) kullanabilmesini sağlayan
küçük ve basit bir sunucudur.

## 1) Sunucuyu yayına alma (en kolay yol: Render.com)

1. [render.com](https://render.com) üzerinde ücretsiz bir hesap açın
2. "New +" → "Web Service" seçin
3. Bu klasörü bir GitHub reposuna yükleyip Render'a bağlayın (veya "Deploy from a Git repo" ile)
4. Build komutu: `npm install`
5. Start komutu: `npm start`
6. Deploy edince Render size bir adres verir, örneğin:
   `https://benim-meram-sync.onrender.com`

## 2) HTML dosyasını bu sunucuya bağlama

`benim-meram-standalone.html` dosyasını bir metin düzenleyicide açın,
en üstteki `window.storage` bölümünde şu satırı bulun:

```js
var API_BASE_URL = "BURAYA_SUNUCU_ADRESINIZI_YAZIN";
```

Değerini az önce aldığınız adresle değiştirin:

```js
var API_BASE_URL = "https://benim-meram-sync.onrender.com";
```

Kaydedin. Artık bu HTML dosyasını kim açarsa açsın (siz, arkadaşınız,
herkes) aynı ilanları, teklifleri ve mesajları görecek.

## Önemli notlar

- Bu basit sürüm verileri tek bir `data.json` dosyasında tutar. Küçük/orta
  ölçekli test ve demo için yeterlidir; Render'ın ücretsiz katmanında disk
  kalıcı olmayabilir (sunucu yeniden başlarsa veriler sıfırlanabilir).
  Gerçek, kalıcı ve ölçeklenebilir bir kuruluş için daha önce teslim edilen
  PostgreSQL tabanlı backend'e (`benim-meram-backend.zip`) geçilmesi önerilir.
- Bu sunucuda kimlik doğrulama/güvenlik katmanı yoktur — herkes `/kv/set`
  uç noktasına yazabilir. Bu, hızlı bir prototip/demo sunucusudur, üretim
  için değildir.

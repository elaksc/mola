# Mola

Kişisel iPhone hatırlatma uygulaması: su, yürüyüş, adım, kendi hedeflerin ve namaz vakitleri.

- Uygulama: GitHub Pages (`index.html`, `app.js`, `style.css`, `sw.js`)
- Saatlik hatırlatmalar: `.github/workflows/reminders.yml` + `scripts/send.mjs`
- Namaz vakitleri: `.github/workflows/prayer.yml` + `scripts/prayer.mjs`
- Ayarlar: `config.json`
- Bildirim anahtarı: GitHub secret `PUSH_CONFIG`

## Klasör düzeni

```
index.html  app.js  style.css  sw.js  manifest.webmanifest
config.json  prayer-times.json  package.json  package-lock.json  .nojekyll
icons/       icon-180.png  icon-192.png  icon-512.png
scripts/     send.mjs  prayer.mjs
.github/workflows/  reminders.yml  prayer.yml
```

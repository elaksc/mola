// GitHub Actions tarafından her çalıştırmada çağrılır; sırası gelen bildirimi gönderir.
import { readFileSync } from 'node:fs';
import webpush from 'web-push';

// Workflow'daki cron satırı -> bildirim türü
const SLOTS = {
  '2 * * * *': 'walk',
  '32 * * * *': 'water',
  '17 * * * *': 'motivation',
};

const TITLES = { walk: '🚶 Yürüyüş molası', water: '💧 Su zamanı', motivation: '✨ Günün notu' };

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const manual = (process.env.MANUAL_SLOT || '').trim();
const auto = (process.env.AUTO_SLOT || '').trim(); // cron-job.org'dan gelen zamanlı çalıştırma
const slot = manual || auto || SLOTS[(process.env.SCHEDULE || '').trim()];
if (!slot || !TITLES[slot]) {
  console.log(`Bilinmeyen zamanlama: "${process.env.SCHEDULE}". Çıkılıyor.`);
  process.exit(0);
}

// Yerel saat ve gün
const tz = config.timezone || 'Europe/Istanbul';
const parts = Object.fromEntries(
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(new Date()).map((p) => [p.type, p.value])
);
const hour = Number(parts.hour);
const weekend = parts.weekday === 'Sat' || parts.weekday === 'Sun';

// Gönderilecek bildirimleri topla
const outbox = [];
const pickMsg = (list) => list[Math.floor(Math.random() * list.length)];
if (manual) {
  outbox.push({ title: TITLES[slot], body: pickMsg(config.messages[slot]), tag: `mola-${slot}`, url: `./?from=${slot}` });
} else {
  if (config.skipWeekends && weekend) { console.log('Hafta sonu, bildirim yok.'); process.exit(0); }
  const section = config[slot] || {};
  const { start, end } = config.activeHours;
  if (slot === 'motivation') {
    if (section.enabled && section.hours.includes(hour)) {
      outbox.push({ title: TITLES.motivation, body: pickMsg(config.messages.motivation), tag: 'mola-motivation', url: './' });
    }
    // Uygulamada eklenen özel hedeflerin hatırlatmaları
    for (const c of config.custom || []) {
      if ((c.hours || []).includes(hour)) outbox.push({ title: c.title, body: c.body, tag: `mola-${c.id}`, url: `./?from=custom&id=${encodeURIComponent(c.id)}` });
    }
  } else if (section.enabled && hour >= start && hour <= end) {
    outbox.push({ title: TITLES[slot], body: pickMsg(config.messages[slot]), tag: `mola-${slot}`, url: `./?from=${slot}` });
  }
  if (!outbox.length) { console.log(`Saat ${hour}: bu saatte gönderilecek bildirim yok (${slot}).`); process.exit(0); }
}

// Anahtar ve abonelik
let push;
try {
  push = JSON.parse(process.env.PUSH_CONFIG || '');
} catch {
  console.error('PUSH_CONFIG secret bulunamadı ya da bozuk. Uygulamadan kopyalayıp GitHub secret olarak kaydet.');
  process.exit(1);
}
const { publicKey, privateKey, subscription } = push;
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:mola@example.com', publicKey, privateKey);

let failed = false;
for (const n of outbox) {
  try {
    const res = await webpush.sendNotification(subscription, JSON.stringify(n), { TTL: 1200, urgency: 'normal' });
    console.log(`Gönderildi (saat ${hour}): ${n.title} — ${n.body} [HTTP ${res.statusCode}]`);
  } catch (err) {
    failed = true;
    console.error(`Gönderilemedi: HTTP ${err.statusCode || '?'} ${err.body || err.message}`);
    if (err.statusCode === 404 || err.statusCode === 410) {
      console.error('Abonelik artık geçerli değil. Uygulamada "Bildirim aboneliğini sıfırla" deyip yeni anahtarı PUSH_CONFIG olarak kaydet.');
      break;
    }
  }
}
if (failed) process.exit(1);

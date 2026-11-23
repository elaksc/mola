// Namaz vakti bildirimleri. GitHub Actions her 10 dakikada bir çalıştırır.
// Vakit yaklaştıysa vaktin girmesini bekler ve bildirimi gönderir; aynı vakit için iki kez göndermez.
process.env.TZ = 'Europe/Istanbul';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import webpush from 'web-push';
import * as adhan from 'adhan';

const root = new URL('../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('config.json', root), 'utf8'));
const P = {
  enabled: true,
  place: 'Üsküdar, İstanbul',
  lat: 41.0226,
  lng: 29.0155,
  times: { imsak: true, gunes: false, ogle: true, ikindi: true, aksam: true, yatsi: true },
  minutesBefore: 0,
  ...(config.prayer || {}),
};
P.times = { imsak: true, gunes: false, ogle: true, ikindi: true, aksam: true, yatsi: true, ...((config.prayer || {}).times || {}) };

const LOOKAHEAD_MIN = 21; // bu kadar dakika içinde girecek vakti bekleyip gönder
const CATCHUP_MIN = 45;   // gecikmiş bir çalıştırma, en fazla bu kadar geç kalmış vakti yine bildirir

const VAKIT = {
  imsak:  { key: 'fajr',    name: 'İmsak',  title: '🌙 Sabah namazı vakti', body: (t) => `İmsak vakti girdi, sabah namazı vakti başladı (${t}).` },
  gunes:  { key: 'sunrise', name: 'Güneş',  title: '☀️ Güneş doğdu',        body: (t) => `Sabah namazının vakti çıktı (${t}).` },
  ogle:   { key: 'dhuhr',   name: 'Öğle',   title: '🕌 Öğle vakti',         body: (t) => `Öğle namazı vakti girdi (${t}).` },
  ikindi: { key: 'asr',     name: 'İkindi', title: '🕌 İkindi vakti',       body: (t) => `İkindi namazı vakti girdi (${t}).` },
  aksam:  { key: 'maghrib', name: 'Akşam',  title: '🌆 Akşam vakti',        body: (t) => `Akşam namazı vakti girdi (${t}).` },
  yatsi:  { key: 'isha',    name: 'Yatsı',  title: '🌌 Yatsı vakti',        body: (t) => `Yatsı namazı vakti girdi (${t}).` },
};

// Diyanet yöntemi + küçük pay: hesap, Diyanet'in yayınladığı vakitten asla erken çıkmasın.
function timesFor(date) {
  const params = adhan.CalculationMethod.Turkey();
  params.adjustments = { fajr: 1, sunrise: 0, dhuhr: 0, asr: 1, maghrib: 2, isha: 1 };
  const t = new adhan.PrayerTimes(new adhan.Coordinates(P.lat, P.lng), date, params);
  return Object.fromEntries(Object.entries(VAKIT).map(([id, v]) => [id, t[v.key]]));
}
const hm = (d) => d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', hour12: false });
const dayKey = (d) => d.toLocaleDateString('sv-SE');

// ---------- uygulama için 30 günlük vakit tablosu ----------
const now = process.env.NOW ? new Date(process.env.NOW) : new Date(); // NOW: yalnızca test için
const clockOffset = now - Date.now();
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const tablePath = new URL('prayer-times.json', root);
let table = existsSync(tablePath) ? JSON.parse(readFileSync(tablePath, 'utf8')) : null;
if (!table || !table.days || !table.days[dayKey(today)] || table.place !== P.place) {
  const days = {};
  for (let i = 0; i < 30; i++) {
    const d = new Date(today); d.setDate(d.getDate() + i);
    days[dayKey(d)] = Object.fromEntries(Object.entries(timesFor(d)).map(([id, t]) => [id, hm(t)]));
  }
  table = { place: P.place, method: 'Diyanet', updated: now.toISOString(), days };
  writeFileSync(tablePath, JSON.stringify(table, null, 1) + '\n');
  console.log('prayer-times.json güncellendi.');
}

if (!P.enabled) { console.log('Namaz bildirimleri kapalı.'); process.exit(0); }

// ---------- gönderilecekleri bul ----------
const statePath = new URL('.github/prayer-state.json', root);
let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
if (state.date !== dayKey(today)) state = { date: dayKey(today), sent: [] };

const test = process.env.TEST === 'true';
const todays = timesFor(today);
const queue = [];
for (const [id, at] of Object.entries(todays)) {
  if (!P.times[id]) continue;
  const v = VAKIT[id];
  queue.push({ uid: id, at, title: v.title, body: v.body(hm(at)) });
  if (P.minutesBefore > 0 && id !== 'gunes') {
    queue.push({
      uid: `${id}-once`, at: new Date(at.getTime() - P.minutesBefore * 60000),
      title: `⏳ ${v.name} vaktine ${P.minutesBefore} dakika`, body: `${v.name} vakti ${hm(at)}'de girecek.`,
    });
  }
}
queue.sort((a, b) => a.at - b.at);

let due = queue.filter((n) => !state.sent.includes(n.uid)
  && n.at - now <= LOOKAHEAD_MIN * 60000 && now - n.at <= CATCHUP_MIN * 60000);

if (test) {
  const next = queue.find((n) => n.at > now) || queue[0];
  due = [{ ...next, at: now, uid: null, title: `${next.title} (deneme)` }];
}
if (!due.length) {
  const next = queue.find((n) => n.at > now && !state.sent.includes(n.uid));
  console.log(`Şimdilik bildirim yok. Sıradaki: ${next ? `${next.title} ${hm(next.at)}` : 'yarın'}.`);
  process.exit(0);
}

// ---------- gönder ----------
let push;
try { push = JSON.parse(process.env.PUSH_CONFIG || ''); } catch {
  console.error('PUSH_CONFIG secret bulunamadı ya da bozuk.'); process.exit(1);
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:mola@example.com', push.publicKey, push.privateKey);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
for (const n of due) {
  const wait = n.at - (Date.now() + clockOffset);
  if (wait > 0) { console.log(`${n.title} için ${Math.ceil(wait / 1000)} sn bekleniyor…`); await sleep(wait); }
  try {
    const res = await webpush.sendNotification(push.subscription,
      JSON.stringify({ title: n.title, body: n.body, tag: `mola-namaz-${n.uid || 'test'}`, url: './' }),
      { TTL: 900, urgency: 'high' });
    console.log(`Gönderildi: ${n.title} — ${n.body} [HTTP ${res.statusCode}]`);
    if (n.uid) {
      state.sent.push(n.uid);
      writeFileSync(statePath, JSON.stringify(state) + '\n'); // her gönderimden hemen sonra kaydet
    }
  } catch (err) {
    failed = true;
    console.error(`Gönderilemedi: HTTP ${err.statusCode || '?'} ${err.body || err.message}`);
    if (err.statusCode === 404 || err.statusCode === 410) break;
  }
}
if (failed) process.exit(1);

// Mola: günlük su ve yürüyüş takibi + bildirim kurulumu.
(() => {
  const $ = (id) => document.getElementById(id);
  const KEYS_STORE = 'mola.vapid';
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const pushSupported = 'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let registration = null;
  let config = {
    activeHours: { start: 9, end: 21 },
    walk: { enabled: true }, water: { enabled: true },
    motivation: { enabled: true, hours: [10, 14, 18] },
    skipWeekends: false, messages: { motivation: [] },
  };

  // ---------- yardımcılar ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fromB64url = (s) => Uint8Array.from(atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const dayKey = (d = new Date()) => d.toLocaleDateString('sv-SE');
  const two = (n) => String(n).padStart(2, '0');
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const DAY_NAMES = ['Pz', 'Pt', 'Sa', 'Ça', 'Pe', 'Cu', 'Ct'];

  // ---------- veri ----------
  let goals = { water: 8, walk: 6, steps: 8000, ...store.get('mola.goals', {}) };
  let customs = store.get('mola.custom', []);
  const saveCustoms = () => store.set('mola.custom', customs);
  let history = store.get('mola.history', {});
  // Eski sürümden kalan sayaçları taşı
  const old = store.get('mola.counts', null);
  if (old && old.date && !history[old.date]) {
    history[old.date] = { water: old.water || 0, walks: Array(old.walk || 0).fill(-1) };
    store.set('mola.history', history);
  }
  store.del('mola.counts');

  const day = (k = dayKey()) => ({ water: 0, walks: [], steps: 0, custom: {}, ...(history[k] || {}) });
  const fmt = (n) => Number(n).toLocaleString('tr-TR');
  const save = () => store.set('mola.history', history);
  const met = (d) => d.water >= goals.water || d.walks.length >= goals.walk || (d.steps || 0) >= goals.steps;

  // ---------- çizim ----------
  function renderGlass(d) {
    const frac = Math.min(d.water / goals.water, 1);
    const y = frac === 0 ? 216 : 206 - frac * 194;
    $('water-level').style.transform = `translateY(${y}px)`;
    $('water-pct').textContent = `%${Math.round((d.water / goals.water) * 100)}`;
  }

  function renderRing(d) {
    const frac = Math.min(d.walks.length / goals.walk, 1);
    $('ring-fill').setAttribute('stroke-dasharray', `${(frac * 100).toFixed(1)} 100`);
    $('ring-fill').classList.toggle('empty', frac === 0);
  }

  function waterMessage(n) {
    const rest = goals.water - n;
    if (n === 0) return 'Güne bir bardak suyla başla.';
    if (rest <= 0) return n > goals.water ? `Hedefi ${n - goals.water} bardak aştın. Harika gidiyorsun!` : 'Bugünün su hedefi tamam. 🎉';
    if (n >= goals.water / 2) return `Yarıyı geçtin! ${rest} bardak daha.`;
    return `İyi başlangıç. ${rest} bardak kaldı.`;
  }

  function renderHours(d) {
    const { start, end } = config.activeHours;
    const now = new Date().getHours();
    let html = ''; let missed = 0;
    for (let h = start; h <= end; h++) {
      const done = d.walks.includes(h);
      if (!done && h < now) missed++;
      const cls = ['hour', done && 'done', h === now && 'now', h > now && 'future'].filter(Boolean).join(' ');
      html += `<div class="${cls}" role="listitem" aria-label="${two(h)}:00${done ? ', yürüdün' : ''}"><i>${done ? '✓' : h === now ? '•' : ''}</i>${two(h)}</div>`;
    }
    $('hours').innerHTML = html;
    $('hours-sum').textContent = d.walks.length ? `${d.walks.length} mola` : 'Henüz mola yok';
    const cur = $('hours').querySelector('.now');
    if (cur && !renderHours.scrolled) { cur.scrollIntoView({ inline: 'center', block: 'nearest' }); renderHours.scrolled = true; }
  }

  function renderStreak() {
    let n = 0;
    const d = new Date();
    const todayMet = met(day(dayKey(d)));
    if (!todayMet) d.setDate(d.getDate() - 1); // bugün henüz bitmedi; seriyi bozmaz
    while (met(day(dayKey(d)))) { n++; d.setDate(d.getDate() - 1); }
    $('streak-n').textContent = n;
    document.querySelector('.c-streak').classList.toggle('hot', n > 0);
    $('streak-msg').textContent = n === 0 ? 'Bugün bir hedefe ulaş, seri başlasın.'
      : todayMet ? 'Bugün de tamam. Böyle devam!' : 'Bugün hedefe ulaşırsan seri büyür.';
  }

  function renderWeek() {
    let html = ''; let hit = 0;
    for (let i = 6; i >= 0; i--) {
      const dt = new Date(); dt.setDate(dt.getDate() - i);
      const d = day(dayKey(dt));
      const frac = Math.min(d.water / goals.water, 1);
      if (met(d)) hit++;
      html += `<div class="day ${i === 0 ? 'today' : ''}">
        <div class="bar ${frac >= 1 ? 'full' : ''}"><span style="height:${Math.round(frac * 100)}%"></span></div>
        <span class="dot ${d.walks.length >= goals.walk ? 'on' : ''}"></span>
        ${DAY_NAMES[dt.getDay()]}</div>`;
    }
    $('week').innerHTML = html;
    $('week-sum').textContent = `${hit}/7 gün hedefte`;
  }

  function renderNext() {
    const now = new Date();
    const { start, end } = config.activeHours;
    const isWeekend = [0, 6].includes(now.getDay());
    const mins = now.getHours() * 60 + now.getMinutes();
    const items = []; // [dakika, etiket]
    if (!(config.skipWeekends && isWeekend)) {
      for (let h = start; h <= end; h++) {
        if (config.walk.enabled) items.push([h * 60, '🚶 yürüyüş']);
        if (config.water.enabled) items.push([h * 60 + 30, '💧 su']);
      }
      if (config.motivation.enabled) config.motivation.hours.forEach((h) => items.push([h * 60 + 15, '✨ motivasyon']));
      (config.custom || []).forEach((c) => (c.hours || []).forEach((h) => items.push([h * 60 + 15, c.title])));
    }
    // Namaz vakitleri (hafta sonu da gelir)
    const pt = prayerTable && prayerTable.days && prayerTable.days[dayKey()];
    if (pt) {
      const on = { imsak: true, gunes: false, ogle: true, ikindi: true, aksam: true, yatsi: true, ...((config.prayer || {}).times || {}) };
      if ((config.prayer || {}).enabled !== false) {
        PV.forEach(([k, l]) => { if (on[k]) items.push([toMin(pt[k]), `🕌 ${l}`]); });
      }
    }
    const next = items.filter(([t]) => t > mins).sort((a, b) => a[0] - b[0])[0];
    $('next').textContent = next
      ? `Sıradaki: ${next[1]} · ${two(Math.floor(next[0] / 60))}:${two(next[0] % 60)}`
      : 'Bugünlük bu kadar. Yarın görüşürüz.';
    // Uygulamada hatırlatma verilmiş ama GitHub'a eklenmemiş hedef var mı?
    const have = new Set((config.custom || []).map((c) => c.id + ':' + (c.hours || []).join(',')));
    const pending = customs.filter((g) => g.remind != null && !have.has(g.id + ':' + g.remind));
    $('sync-banner').hidden = !pending.length;
    if (pending.length) $('sync-banner').textContent = ghToken()
      ? `${pending.map((g) => g.emoji + ' ' + g.name).join(', ')} bildirimi eşitlenmedi. Tekrar denemek için dokun.`
      : `${pending.map((g) => g.emoji + ' ' + g.name).join(', ')} bildirimi henüz kurulmadı. Kurmak için dokun.`;
  }

  function renderHeader() {
    const h = new Date().getHours();
    $('greeting').textContent = h < 5 ? 'İyi geceler' : h < 12 ? 'Günaydın' : h < 18 ? 'İyi günler' : h < 22 ? 'İyi akşamlar' : 'İyi geceler';
    $('date').textContent = new Date().toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  function render() {
    const d = day();
    $('water-n').textContent = d.water;
    $('water-goal').textContent = goals.water;
    $('water-msg').textContent = waterMessage(d.water);
    $('walk-n').textContent = d.walks.length;
    $('walk-goal').textContent = goals.walk;
    $('g-water').textContent = goals.water;
    $('g-walk').textContent = goals.walk;
    $('g-steps').textContent = fmt(goals.steps);
    renderPrayer();
    renderGlass(d); renderRing(d); renderSteps(d); renderCustoms(); renderHours(d); renderStreak(); renderWeek(); renderNext(); renderHeader();
  }

  // ---------- namaz vakitleri ----------
  let prayerTable = null;
  const PV = [['imsak', 'İmsak'], ['gunes', 'Güneş'], ['ogle', 'Öğle'], ['ikindi', 'İkindi'], ['aksam', 'Akşam'], ['yatsi', 'Yatsı']];
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  async function loadPrayer() {
    try {
      const r = await fetch('prayer-times.json', { cache: 'no-store' });
      if (r.ok) prayerTable = await r.json();
    } catch (e) { /* çevrimdışı */ }
    render();
  }
  function renderPrayer() {
    const card = $('prayer-card');
    const t = prayerTable && prayerTable.days && prayerTable.days[dayKey()];
    if (!t) { card.hidden = true; return; }
    card.hidden = false;
    $('prayer-place').textContent = prayerTable.place.split(',')[0];
    const now = new Date(); const mins = now.getHours() * 60 + now.getMinutes();
    let cur = -1; PV.forEach(([k], i) => { if (toMin(t[k]) <= mins) cur = i; });
    let nextLabel; let nextAt; let nextIdx = cur + 1;
    if (nextIdx < PV.length) { nextLabel = PV[nextIdx][1]; nextAt = toMin(t[PV[nextIdx][0]]) - mins; }
    else {
      const tm = new Date(now); tm.setDate(tm.getDate() + 1);
      const tt = prayerTable.days[dayKey(tm)];
      nextLabel = 'İmsak'; nextAt = tt ? 24 * 60 - mins + toMin(tt.imsak) : null; nextIdx = -1;
    }
    const left = nextAt == null ? '' : nextAt >= 60 ? `${Math.floor(nextAt / 60)} sa ${nextAt % 60} dk` : `${nextAt} dk`;
    const suffix = { 'İmsak': "a", 'Güneş': "e", 'Öğle': "ye", 'İkindi': "ye", 'Akşam': "a", 'Yatsı': "ya" }[nextLabel];
    $('prayer-next').innerHTML = nextAt == null ? 'Bugünkü vakitler' : `${nextLabel}'${suffix} ${left}<small>${nextIdx === -1 ? 'yarın ' : ''}${nextIdx === -1 ? (prayerTable.days[dayKey(new Date(Date.now() + 864e5))] || {}).imsak || '' : t[PV[nextIdx][0]]}</small>`;
    $('prayer-grid').innerHTML = PV.map(([k, l], i) => `<div class="pv ${i < cur ? 'past' : ''} ${i === cur ? 'current' : ''} ${i === nextIdx ? 'pv-next' : ''}">${l}<b>${t[k]}</b></div>`).join('');
  }

  // ---------- adımlar ----------
  function renderSteps(d) {
    $('steps-n').textContent = fmt(d.steps || 0);
    $('steps-goal').textContent = fmt(goals.steps);
    $('steps-bar').style.width = `${Math.min((d.steps || 0) / goals.steps, 1) * 100}%`;
    $('steps-time').hidden = !d.stepsAt;
    if (d.stepsAt) $('steps-time').textContent = d.stepsAt;
  }

  function parseSteps(text) {
    const t = String(text || '').trim().replace(/\s/g, '');
    const m = t.match(/\d[\d.,]*/);
    if (!m) return null;
    let n = m[0];
    if (/^\d{1,3}([.,]\d{3})+$/.test(n)) n = n.replace(/[.,]/g, ''); // 8.423 veya 8,423
    else n = n.replace(',', '.');
    const v = Math.round(parseFloat(n));
    return Number.isFinite(v) && v >= 0 && v < 200000 ? v : null;
  }

  function setSteps(v) {
    const key = dayKey(); const d = day(key);
    snapshot(key);
    const before = d.steps || 0;
    const now = new Date();
    history[key] = { ...d, steps: v, stepsAt: `${two(now.getHours())}:${two(now.getMinutes())}` }; save(); render();
    if (before < goals.steps && v >= goals.steps) { burst(); toast('Adım hedefi tamam! 🎉', true); }
    else toast(`👟 ${fmt(v)} adım kaydedildi`, true);
  }

  $('paste-steps').addEventListener('click', async () => {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch (e) { text = ''; }
    const v = parseSteps(text);
    if (v === null) {
      const typed = prompt('Panoda adım sayısı bulunamadı. Bugünkü adım sayını yaz:');
      if (typed === null) return;
      const t = parseSteps(typed);
      if (t === null) { toast('Bir sayı yazmalısın', false); return; }
      setSteps(t);
    } else setSteps(v);
  });
  $('steps-n').addEventListener('click', () => {
    const typed = prompt('Bugünkü adım sayın:', day().steps || '');
    if (typed === null) return;
    const t = parseSteps(typed);
    if (t === null) { toast('Bir sayı yazmalısın', false); return; }
    setSteps(t);
  });

  // ---------- özel hedefler ----------
  const TYPE_LABEL = { daily: 'Her gün', weekly: 'Bu hafta', finish: 'Bitirme hedefi' };
  const weekStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };
  function progressOf(g) {
    if (g.type === 'finish') return g.progress || 0;
    if (g.type === 'daily') return day().custom[g.id] || 0;
    let sum = 0; const d = weekStart();
    for (let i = 0; i < 7; i++) { sum += day(dayKey(d)).custom[g.id] || 0; d.setDate(d.getDate() + 1); }
    return sum;
  }
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function renderCustoms() {
    $('custom-cards').innerHTML = customs.map((g) => {
      const p = progressOf(g); const done = p >= g.target;
      const label = done ? (g.type === 'finish' ? 'Tamamlandı ✓' : 'Hedef tamam ✓') : `+${fmt(g.step)} ${esc(g.unit)}`;
      return `<section class="card c-goal ${done ? 'complete' : ''}" data-color="${g.color}">
        <button class="goal-top" data-edit="${g.id}" aria-label="${esc(g.name)} hedefini düzenle">
          <span class="goal-emoji">${esc(g.emoji)}</span>
          <span class="goal-name">${esc(g.name)}</span>
          <span class="goal-type">${TYPE_LABEL[g.type]}</span>
          <p class="goal-val">${fmt(p)}<small> / ${fmt(g.target)} ${esc(g.unit)}</small></p>
        </button>
        <div class="pbar"><span style="width:${Math.min(p / g.target, 1) * 100}%"></span></div>
        <button class="pill" data-add="${g.id}" ${done && g.type === 'finish' ? 'disabled' : ''}>${label}</button>
      </section>`;
    }).join('');
    renderSnippet();
  }

  function addCustom(id) {
    const g = customs.find((x) => x.id === id); if (!g) return;
    const key = dayKey(); snapshot(key);
    const before = progressOf(g);
    if (g.type === 'finish') {
      g.progress = Math.min(g.target, (g.progress || 0) + g.step); saveCustoms();
    } else {
      const d = day(key);
      history[key] = { ...d, custom: { ...d.custom, [g.id]: (d.custom[g.id] || 0) + g.step } }; save();
    }
    render();
    if (navigator.vibrate) navigator.vibrate(12);
    const after = progressOf(g);
    if (before < g.target && after >= g.target) { burst(); toast(g.type === 'finish' ? `${g.emoji} ${g.name} bitti! 🎉` : `${g.emoji} Hedef tamam! 🎉`, true); }
    else toast(`${g.emoji} +${fmt(g.step)} ${g.unit}`, true);
  }

  $('custom-cards').addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]'); if (add) return addCustom(add.dataset.add);
    const ed = e.target.closest('[data-edit]'); if (ed) openEditor(ed.dataset.edit);
  });
  $('add-goal').addEventListener('click', () => openEditor(null));

  // düzenleyici
  const EMOJIS = ['📖', '🎬', '🧘', '🏃', '✍️', '🎸', '🥗', '😴', '💊', '🧠', '🌱', '🎨', '📚', '🏋️', '🚴', '🙏'];
  const TYPE_HINT = {
    daily: 'Her gün sıfırlanır. Örnek: her gün 20 sayfa.',
    weekly: 'Her pazartesi sıfırlanır. Örnek: haftada 3 antrenman.',
    finish: 'Sıfırlanmaz, bitince tamamlanır. Örnek: diziyi bitir, 10 bölüm.',
  };
  let editing = null; let form = {};
  for (let h = 7; h <= 23; h++) $('f-remind').insertAdjacentHTML('beforeend', `<option value="${h}">Her gün ${two(h)}:15</option>`);
  function paintEditor() {
    $('emoji-row').innerHTML = EMOJIS.map((e) => `<button type="button" role="radio" aria-checked="${e === form.emoji}" data-emoji="${e}">${e}</button>`).join('');
    document.querySelectorAll('#f-type button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.type === form.type)));
    document.querySelectorAll('#f-color button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.color === form.color)));
    $('type-hint').textContent = TYPE_HINT[form.type];
  }
  function openEditor(id) {
    editing = id ? customs.find((g) => g.id === id) : null;
    form = editing ? { ...editing } : { emoji: '📖', type: 'daily', color: 'quote' };
    $('goal-editor-title').textContent = editing ? 'Hedefi düzenle' : 'Yeni hedef';
    $('f-name').value = editing ? editing.name : '';
    $('f-target').value = editing ? editing.target : 20;
    $('f-unit').value = editing ? editing.unit : 'sayfa';
    $('f-step').value = editing ? editing.step : 5;
    $('f-remind').value = editing ? (editing.remind != null ? String(editing.remind) : '') : '20';
    $('goal-delete').hidden = !editing;
    paintEditor();
    openSheet('goal-editor');
  }
  $('emoji-row').addEventListener('click', (e) => { const b = e.target.closest('[data-emoji]'); if (b) { form.emoji = b.dataset.emoji; paintEditor(); } });
  $('f-type').addEventListener('click', (e) => { const b = e.target.closest('[data-type]'); if (b) { form.type = b.dataset.type; paintEditor(); } });
  $('f-color').addEventListener('click', (e) => { const b = e.target.closest('[data-color]'); if (b) { form.color = b.dataset.color; paintEditor(); } });
  $('goal-close').addEventListener('click', () => $('goal-editor').close());
  $('goal-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('f-name').value.trim(); if (!name) return;
    const g = {
      id: editing ? editing.id : 'g' + Date.now().toString(36),
      emoji: form.emoji, name, type: form.type, color: form.color,
      target: Math.max(1, parseInt($('f-target').value, 10) || 1),
      unit: $('f-unit').value.trim() || 'kez',
      step: Math.max(1, parseInt($('f-step').value, 10) || 1),
      remind: $('f-remind').value === '' ? null : Number($('f-remind').value),
      progress: editing ? editing.progress || 0 : 0,
    };
    customs = editing ? customs.map((x) => (x.id === g.id ? g : x)) : [...customs, g];
    saveCustoms(); $('goal-editor').close(); render();
    toast(editing ? 'Hedef güncellendi' : `${g.emoji} ${g.name} eklendi`, false);
    syncCustoms(true);
  });
  $('goal-delete').addEventListener('click', () => {
    if (!editing || !confirm(`"${editing.name}" silinsin mi?`)) return;
    customs = customs.filter((g) => g.id !== editing.id); saveCustoms();
    $('goal-editor').close(); render();
    syncCustoms(true);
  });

  // bildirim satırı (config.json için)
  // ---------- hedef bildirimlerini GitHub'a otomatik yaz ----------
  const GH_KEY = 'mola.gh';
  const repo = (() => {
    const owner = location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : null;
    const name = location.pathname.split('/').filter(Boolean)[0];
    return owner && name ? { owner, name } : null;
  })();
  const ghToken = () => { try { return localStorage.getItem(GH_KEY) || ''; } catch (e) { return ''; } };
  const b64dec = (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
  const b64enc = (str) => { const bytes = new TextEncoder().encode(str); let bin = ''; bytes.forEach((x) => { bin += String.fromCharCode(x); }); return btoa(bin); };

  function wantedCustom() {
    return customs.filter((g) => g.remind != null).map((g) => ({
      id: g.id, title: `${g.emoji} ${g.name}`,
      body: g.type === 'daily' ? `Bugünkü hedefin: ${g.target} ${g.unit}.` : g.type === 'weekly' ? `Bu haftaki hedefin: ${g.target} ${g.unit}.` : `Biraz ilerleme zamanı: ${g.progress || 0}/${g.target} ${g.unit}.`,
      hours: [g.remind],
    }));
  }
  const sameCustom = (a, b) => JSON.stringify((a || []).map((c) => [c.id, c.title, c.hours])) === JSON.stringify((b || []).map((c) => [c.id, c.title, c.hours]));

  async function gh(path, opts = {}) {
    const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${ghToken()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) },
    });
    return res;
  }

  let syncing = false;
  async function syncCustoms(showToast = true) {
    if (!repo || !ghToken() || syncing) return false;
    syncing = true; $('gh-state').textContent = 'Eşitleniyor…';
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await gh('contents/config.json?ref=main', { cache: 'no-store' });
        if (r.status === 401) throw new Error('Anahtar geçersiz ya da süresi dolmuş.');
        if (!r.ok) throw new Error(`config.json okunamadı (HTTP ${r.status}). Anahtarın bu depo için "Contents: Read and write" izni olmalı.`);
        const file = await r.json();
        const cfg = JSON.parse(b64dec(file.content));
        const want = wantedCustom();
        if (sameCustom(cfg.custom, want)) { config.custom = cfg.custom || []; break; }
        cfg.custom = want;
        const put = await gh('contents/config.json', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Hedef hatırlatmaları güncellendi', content: b64enc(JSON.stringify(cfg, null, 2) + '\n'), sha: file.sha, branch: 'main' }),
        });
        if (put.status === 409 || put.status === 422) continue; // arada başka bir değişiklik olduysa bir kez daha dene
        if (!put.ok) throw new Error(`config.json yazılamadı (HTTP ${put.status}). Anahtarın "Contents: Read and write" izni olmalı.`);
        config.custom = want;
        if (showToast) toast('🔔 Hedef bildirimleri güncellendi', false);
        break;
      }
      renderGh(); renderNext(); renderSchedule();
      return true;
    } catch (e) {
      $('gh-state').textContent = '⚠️ ' + e.message;
      return false;
    } finally { syncing = false; }
  }

  function renderGh() {
    const on = !!ghToken();
    $('gh-form').hidden = on; $('gh-sync').hidden = !on; $('gh-remove').hidden = !on;
    if (!repo) { $('gh-state').textContent = 'Bu özellik uygulama GitHub Pages üzerinden açıldığında çalışır.'; return; }
    const synced = sameCustom(config.custom, wantedCustom());
    $('gh-state').textContent = !on
      ? 'Bağlarsan, hatırlatma saati verdiğin her hedefin bildirimi otomatik kurulur. Anahtar sadece bu telefonda saklanır.'
      : synced ? '✅ Bağlı. Hedef bildirimlerin güncel.' : 'Bağlı. Değişiklikler eşitlenecek…';
  }
  const renderSnippet = renderGh; // eski çağrılarla uyum

  $('gh-save').addEventListener('click', async () => {
    const t = $('gh-token').value.trim();
    if (!t) { $('gh-state').textContent = 'Önce anahtarı yapıştır.'; return; }
    try { localStorage.setItem(GH_KEY, t); } catch (e) {}
    $('gh-token').value = '';
    const ok = await syncCustoms(false);
    if (ok) toast('GitHub bağlandı ✅', false);
    else { try { localStorage.removeItem(GH_KEY); } catch (e) {} renderGh(); $('gh-form').hidden = false; }
  });
  $('gh-sync').addEventListener('click', () => syncCustoms(true));
  $('gh-remove').addEventListener('click', () => {
    if (!confirm('GitHub bağlantısı kaldırılsın mı? Mevcut hedef bildirimlerin çalışmaya devam eder, sadece yeni değişiklikler otomatik eşitlenmez.')) return;
    try { localStorage.removeItem(GH_KEY); } catch (e) {}
    renderGh();
  });

  // Alt sayfayı aç; iOS'ta ilk butona otomatik odak çerçevesi çıkmasın
  function openSheet(id) {
    const dlg = $(id); dlg.showModal();
    const a = document.activeElement; if (a && dlg.contains(a) && a.blur) a.blur();
  }

  // ---------- tema ----------
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('mola.theme', t); } catch (e) {}
    document.querySelectorAll('[data-theme-pick]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themePick === t)));
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    document.querySelector('meta[name="theme-color"]').setAttribute('content', bg);
  }
  document.querySelectorAll('[data-theme-pick]').forEach((b) => b.addEventListener('click', () => applyTheme(b.dataset.themePick)));

  // ---------- kutlama ve geri alma ----------
  function burst() {
    if (reduceMotion) return;
    const el = $('burst'); el.innerHTML = '';
    for (let i = 0; i < 16; i++) {
      const a = (Math.PI * 2 * i) / 16; const r = 70 + Math.random() * 40;
      const p = document.createElement('i');
      p.style.setProperty('--x', `${Math.cos(a) * r}px`);
      p.style.setProperty('--y', `${Math.sin(a) * r}px`);
      el.appendChild(p);
    }
    setTimeout(() => { el.innerHTML = ''; }, 1000);
  }

  let toastTimer = null; let undoState = null;
  function toast(text, canUndo) {
    $('toast-text').textContent = text;
    $('toast-undo').hidden = !canUndo;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; undoState = null; }, 4000);
  }
  function snapshot(key) {
    undoState = { key, prev: history[key] ? JSON.parse(JSON.stringify(history[key])) : null, customs: JSON.parse(JSON.stringify(customs)) };
  }
  $('toast-undo').addEventListener('click', () => {
    if (!undoState) return;
    if (undoState.prev) history[undoState.key] = undoState.prev; else delete history[undoState.key];
    customs = undoState.customs; save(); saveCustoms(); render();
    undoState = null; $('toast').hidden = true;
  });

  function logWater() {
    const key = dayKey(); const d = day(key);
    snapshot(key);
    const before = d.water;
    history[key] = { ...d, water: d.water + 1 }; save(); render();
    if (navigator.vibrate) navigator.vibrate(12);
    if (before < goals.water && before + 1 >= goals.water) { burst(); toast('Su hedefi tamam! 🎉', true); }
    else toast(`💧 ${before + 1}. bardak kaydedildi`, true);
  }

  function logWalk() {
    const key = dayKey(); const d = day(key); const h = new Date().getHours();
    if (d.walks.includes(h)) { toast('Bu saatin yürüyüşü zaten kayıtlı 👍', false); return; }
    snapshot(key);
    const before = d.walks.length;
    history[key] = { ...d, walks: [...d.walks, h] }; save(); render();
    if (navigator.vibrate) navigator.vibrate(12);
    if (before < goals.walk && before + 1 >= goals.walk) { burst(); toast('Hareket hedefi tamam! 🎉', true); }
    else toast('🚶 Yürüyüş kaydedildi', true);
  }

  $('glass').addEventListener('click', logWater);
  $('add-water').addEventListener('click', logWater);
  $('add-walk').addEventListener('click', logWalk);
  $('ring').addEventListener('click', logWalk);

  // ---------- bildirimden gelince sor ----------
  const params = new URLSearchParams(location.search);
  const from = params.get('from');
  if (from) window.history.replaceState(null, '', location.pathname);
  const askGoal = from === 'custom' && customs.find((g) => g.id === params.get('id'));
  if (askGoal && progressOf(askGoal) < askGoal.target) {
    $('ask-emoji').textContent = askGoal.emoji;
    $('ask-title').textContent = `${askGoal.name}: +${fmt(askGoal.step)} ${askGoal.unit} ekleyeyim mi?`;
    $('ask-yes').textContent = 'Ekle';
    $('ask-yes').className = 'pill pill-dark';
    $('ask-yes').onclick = () => { $('ask').close(); addCustom(askGoal.id); };
    $('ask-no').onclick = () => $('ask').close();
    setTimeout(() => openSheet('ask'), 150);
  }
  if (from === 'water' || from === 'walk') {
    $('ask-emoji').textContent = from === 'water' ? '💧' : '🚶';
    $('ask-title').textContent = from === 'water' ? 'Bir bardak su içtin mi?' : '5 dakika yürüdün mü?';
    $('ask-yes').textContent = from === 'water' ? 'İçtim' : 'Yürüdüm';
    $('ask-yes').className = 'pill ' + (from === 'water' ? 'pill-water' : 'pill-walk');
    $('ask-yes').onclick = () => { $('ask').close(); from === 'water' ? logWater() : logWalk(); };
    $('ask-no').onclick = () => $('ask').close();
    setTimeout(() => openSheet('ask'), 150);
  }

  // ---------- ayarlar ----------
  $('btn-settings').addEventListener('click', () => openSheet('settings'));
  $('settings-close').addEventListener('click', () => $('settings').close());
  $('sync-banner').addEventListener('click', (e) => {
    e.preventDefault();
    if (ghToken()) { syncCustoms(true); return; }
    openSheet('settings'); setTimeout(() => $('gh-state').scrollIntoView({ block: 'center' }), 250);
  });
  $('setup-banner').addEventListener('click', (e) => { e.preventDefault(); openSheet('settings'); });
  document.querySelectorAll('dialog').forEach((dlg) => dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }));
  document.querySelectorAll('[data-goal]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.goal;
    const lim = { water: [3, 20, 1], walk: [1, 14, 1], steps: [1000, 40000, 500] }[k];
    goals = { ...goals, [k]: Math.min(lim[1], Math.max(lim[0], goals[k] + Number(b.dataset.d) * lim[2])) };
    store.set('mola.goals', goals); render();
  }));

  function renderSchedule() {
    const a = config.activeHours; const range = `${two(a.start)}:00–${two(a.end)}:59`;
    const items = [];
    if (config.walk.enabled) items.push(`🚶 Her saat başı yürüyüş (${range})`);
    if (config.water.enabled) items.push(`💧 Her saat buçukta su (${range})`);
    if (config.motivation.enabled) items.push(`✨ Motivasyon: ${config.motivation.hours.map((h) => two(h) + ':15').join(', ')}`);
    (config.custom || []).forEach((c) => items.push(`${esc(c.title)}: ${c.hours.map((h) => two(h) + ':15').join(', ')}`));
    if ((config.prayer || {}).enabled !== false) items.push('🕌 Namaz vakitleri (imsak, öğle, ikindi, akşam, yatsı)');
    if (config.skipWeekends) items.push('Hafta sonları bildirim yok');
    $('schedule').innerHTML = items.map((t) => `<li>${t}</li>`).join('') || '<li>Tüm bildirimler kapalı.</li>';
  }

  async function loadConfig() {
    try {
      const c = await (await fetch('config.json', { cache: 'no-store' })).json();
      config = { ...config, ...c };
    } catch (e) { /* varsayılanlar kalır */ }
    renderSchedule();
    const m = config.messages && config.messages.motivation;
    if (m && m.length) $('quote').textContent = pick(m);
    render();
    // Bağlıysa ve telefondaki hedefler GitHub'dakinden farklıysa sessizce eşitle
    if (ghToken() && !sameCustom(config.custom, wantedCustom())) syncCustoms(false);
  }

  // ---------- bildirim kurulumu ----------
  function setPermState() {
    const keys = store.get(KEYS_STORE, null);
    const ready = pushSupported && Notification.permission === 'granted' && keys;
    $('setup-banner').hidden = !!ready;
    if (isIOS && !isStandalone) {
      $('not-installed').hidden = false;
      $('setup-banner').textContent = 'Bildirimler için uygulamayı ana ekrana ekle. Nasıl yapılır? Dokun.';
      $('perm-state').textContent = 'Uygulama ana ekrandan açılmadı.';
      $('btn-enable').disabled = true; return;
    }
    if (!pushSupported) {
      $('perm-state').textContent = 'Bu tarayıcı bildirimleri desteklemiyor (iPhone\'da iOS 16.4+ gerekli).';
      $('btn-enable').disabled = true; $('setup-banner').hidden = true; return;
    }
    const p = Notification.permission;
    $('perm-state').textContent = p === 'granted' ? (keys ? '✅ Bildirimler açık.' : 'İzin var, anahtar henüz oluşturulmadı.')
      : p === 'denied' ? '⛔ İzin reddedildi. Ayarlar > Bildirimler > Mola\'dan aç.' : 'Bildirim izni henüz verilmedi.';
    $('btn-enable').textContent = ready ? 'Anahtarı tekrar göster' : 'Bildirimleri aç';
  }

  async function getOrCreateKeys() {
    let keys = store.get(KEYS_STORE, null);
    if (keys && keys.publicKey && keys.privateKey) return keys;
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    keys = { publicKey: b64url(await crypto.subtle.exportKey('raw', kp.publicKey)), privateKey: (await crypto.subtle.exportKey('jwk', kp.privateKey)).d };
    store.set(KEYS_STORE, keys);
    return keys;
  }

  async function subscribe() {
    const keys = await getOrCreateKeys();
    let sub = await registration.pushManager.getSubscription();
    const existing = sub && sub.options && sub.options.applicationServerKey;
    if (sub && existing && b64url(existing) !== keys.publicKey) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(keys.publicKey) });
    return { publicKey: keys.publicKey, privateKey: keys.privateKey, subscription: sub.toJSON() };
  }

  $('btn-enable').addEventListener('click', async () => {
    $('btn-enable').disabled = true;
    try {
      const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (perm !== 'granted') return;
      registration = registration || await navigator.serviceWorker.ready;
      $('push-config').value = JSON.stringify(await subscribe());
      $('step-copy').hidden = false;
    } catch (e) {
      $('perm-state').textContent = 'Hata: ' + (e && e.message || e);
    } finally { $('btn-enable').disabled = false; setPermState(); }
  });

  $('btn-copy').addEventListener('click', async () => {
    const ta = $('push-config');
    try { await navigator.clipboard.writeText(ta.value); }
    catch (e) { ta.focus(); ta.select(); document.execCommand && document.execCommand('copy'); }
    $('copy-state').textContent = 'Kopyalandı. GitHub\'a yapıştırabilirsin.';
  });

  $('btn-test').addEventListener('click', async () => {
    if (!pushSupported || Notification.permission !== 'granted') { alert('Önce bildirim iznini ver.'); return; }
    registration = registration || await navigator.serviceWorker.ready;
    registration.showNotification('Mola test 👋', { body: 'Bildirimler bu telefonda çalışıyor.', icon: 'icons/icon-192.png', tag: 'mola-test' });
  });

  $('btn-reset').addEventListener('click', async () => {
    if (!confirm('Abonelik ve anahtar silinsin mi? Sonra yeni anahtarı GitHub\'a tekrar kaydetmen gerekecek.')) return;
    registration = registration || await navigator.serviceWorker.ready;
    const sub = await registration.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
    store.del(KEYS_STORE);
    $('push-config').value = ''; $('step-copy').hidden = true;
    setPermState();
  });

  // ---------- başlat ----------
  let savedTheme = 'auto'; try { savedTheme = localStorage.getItem('mola.theme') || 'auto'; } catch (e) {}
  applyTheme(savedTheme);
  render();
  loadConfig();
  loadPrayer();
  setPermState();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then((r) => { registration = r; }).catch(() => {});
  }
  // Uygulamaya geri dönünce (ya da gün değişince) tazele
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
  setInterval(render, 60 * 1000);
})();

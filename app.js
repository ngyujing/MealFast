(() => {
  'use strict';

  const HOUR = 3600e3;
  const DAY = 86400e3;
  const KG_PER_LB = 0.45359237;
  const LB_PER_KG = 1 / KG_PER_LB;
  const DEFAULTS = { goalHours: 16, unit: 'kg', calorieTarget: 2000, activeFast: null };
  const COLORS = {
    accent: '#2f855a',
    blue: '#3182ce',
    orange: '#dd6b20',
    red: '#c53030',
    muted: '#a0aec0',
    yellow: '#d69e2e',
  };

  const data = { meals: [], weights: [], fasts: [], settings: {} };
  const charts = {};
  let objectUrls = [];

  // ---------- small helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const pad = (n) => String(n).padStart(2, '0');
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // datetime-local strings are local time without an offset
  function localInputValue(ms) {
    const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
  }
  const parseLocalInput = (v) => new Date(v).getTime();
  const dayKey = (ms) => localInputValue(ms).slice(0, 10);
  const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const fmtShortDay = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const fmtHours = (h) => `${h.toFixed(1)} h`;
  const fmtHM = (ms) => `${Math.floor(ms / HOUR)}h ${pad(Math.floor((ms % HOUR) / 60000))}m`;
  const fmtClock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  };
  const signed = (n) => `${n > 0 ? '+' : ''}${n.toFixed(1)}`;
  const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

  // ---------- IndexedDB ----------
  let dbPromise;
  function openDb() {
    dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open('mealfast', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('meals', { keyPath: 'id' });
        req.result.createObjectStore('weights', { keyPath: 'id' });
        req.result.createObjectStore('fasts', { keyPath: 'id' });
        req.result.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(store, mode, op) {
    const database = await openDb();
    return new Promise((resolve, reject) => {
      const t = database.transaction(store, mode);
      const req = op(t.objectStore(store));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const getAll = (store) => tx(store, 'readonly', (s) => s.getAll());
  const put = (store, value) => tx(store, 'readwrite', (s) => s.put(value));
  const remove = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));

  async function load() {
    const [meals, weights, fasts, settingRows] = await Promise.all([
      getAll('meals'), getAll('weights'), getAll('fasts'), getAll('settings'),
    ]);
    data.meals = meals.sort((a, b) => b.when - a.when);
    data.weights = weights.sort((a, b) => a.when - b.when);
    data.fasts = fasts.sort((a, b) => a.start - b.start);
    data.settings = Object.fromEntries(settingRows.map((r) => [r.key, r.value]));
  }

  const setting = (key) => data.settings[key] ?? DEFAULTS[key];
  async function saveSetting(key, value) {
    data.settings[key] = value;
    await put('settings', { key, value });
  }

  async function refresh() {
    await load();
    renderAll();
  }

  async function removeRecord(store, id, label) {
    if (!confirm(`Delete this ${label}?`)) return;
    await remove(store, id);
    await refresh();
  }

  function safe(fn) {
    return async (...args) => {
      try {
        await fn(...args);
      } catch (err) {
        alert(`Something went wrong: ${err.message}`);
      }
    };
  }

  // ---------- tabs ----------
  function showTab(name) {
    $$('.tab').forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    $$('.panel').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
    if (name === 'analysis') renderAnalysis();
  }

  // ---------- fasting ----------
  function renderFast() {
    const active = setting('activeFast');
    $('#fast-idle').hidden = Boolean(active);
    $('#fast-active').hidden = !active;
    $('#fast-status').textContent = active ? `Fasting since ${fmtDate(active)}` : 'Not fasting';
    renderFastList();
    tickFast();
  }

  const RING_C = 2 * Math.PI * 90;

  function setRing(fraction) {
    $('#fast-ring').style.strokeDashoffset = String(RING_C * (1 - Math.min(1, Math.max(0, fraction))));
  }

  function tickFast() {
    const goalHours = setting('goalHours');
    const goalMs = goalHours * HOUR;
    const start = setting('activeFast');
    if (!start) {
      $('#fast-elapsed').textContent = '--:--:--';
      setRing(0);
      $('#fast-goal').textContent = `Goal: ${goalHours} h`;
      return;
    }
    const elapsed = Date.now() - start;
    $('#fast-elapsed').textContent = fmtClock(elapsed);
    setRing(elapsed / goalMs);
    $('#fast-goal').textContent = elapsed >= goalMs
      ? `Goal of ${goalHours} h reached`
      : `${fmtClock(goalMs - elapsed)} to go for ${goalHours} h`;
  }

  function renderFastList() {
    const list = $('#fast-list');
    list.replaceChildren();
    const goalMs = setting('goalHours') * HOUR;
    if (!data.fasts.length) {
      list.append(el('li', 'muted small', 'No completed fasts yet.'));
      return;
    }
    for (const f of [...data.fasts].reverse()) {
      const duration = f.end - f.start;
      const body = el('div', 'item-body');
      body.append(
        el('strong', duration >= goalMs ? 'good' : null, `${fmtHM(duration)}${duration >= goalMs ? ' · goal met' : ''}`),
        el('div', 'muted small', `${fmtDate(f.start)} → ${fmtDate(f.end)}`),
      );
      const del = el('button', 'ghost small', 'Delete');
      del.onclick = () => removeRecord('fasts', f.id, 'fast');
      const li = el('li', 'item');
      li.append(body, del);
      list.append(li);
    }
  }

  $('#btn-start-fast').onclick = safe(async () => {
    const v = $('#fast-start-input').value;
    const start = v ? parseLocalInput(v) : Date.now();
    if (start > Date.now()) return alert('The start time is in the future.');
    await saveSetting('activeFast', start);
    $('#fast-start-input').value = '';
    renderAll();
  });

  $('#btn-end-fast').onclick = safe(async () => {
    const start = setting('activeFast');
    const v = $('#fast-end-input').value;
    const end = v ? parseLocalInput(v) : Date.now();
    if (end > Date.now()) return alert('The eating time is in the future.');
    if (end <= start) return alert('Eating time must be after the fast started.');
    await put('fasts', { id: uid(), start, end });
    await saveSetting('activeFast', null);
    $('#fast-end-input').value = '';
    await refresh();
  });

  $('#btn-cancel-fast').onclick = safe(async () => {
    if (!confirm('Cancel this fast without saving it?')) return;
    await saveSetting('activeFast', null);
    renderAll();
  });

  // ---------- meals ----------
  function shrinkImage(file, maxSide = 1024) {
    return createImageBitmap(file).then((bitmap) => {
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close?.();
      return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
    });
  }

  function sumMacros(meals) {
    return meals.reduce((t, m) => ({
      kcal: t.kcal + (m.kcal || 0),
      protein: t.protein + (m.protein || 0),
      carbs: t.carbs + (m.carbs || 0),
      fat: t.fat + (m.fat || 0),
    }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  }

  function macroLine(m) {
    const v = (x, unit = '') => (x == null ? '–' : `${Math.round(x * 10) / 10}${unit}`);
    return `${v(m.kcal, ' kcal')} · P ${v(m.protein, 'g')} · C ${v(m.carbs, 'g')} · F ${v(m.fat, 'g')}`;
  }

  function renderMeals() {
    for (const u of objectUrls) URL.revokeObjectURL(u);
    objectUrls = [];

    const today = dayKey(Date.now());
    const todays = data.meals.filter((m) => dayKey(m.when) === today);
    const t = sumMacros(todays);
    $('#today-totals').textContent = todays.length
      ? `Today (${todays.length} meals): ${Math.round(t.kcal)} kcal · P ${Math.round(t.protein)} g · C ${Math.round(t.carbs)} g · F ${Math.round(t.fat)} g`
      : 'Nothing logged today yet.';

    const list = $('#meal-list');
    list.replaceChildren();
    if (!data.meals.length) list.append(el('li', 'muted small', 'No meals logged yet.'));

    for (const m of data.meals) {
      const body = el('div', 'item-body');
      body.append(el('strong', null, m.name), el('div', 'muted small', fmtDate(m.when)), el('div', null, macroLine(m)));
      if (m.notes) body.append(el('div', 'muted small', m.notes));

      const li = el('li', 'item');
      if (m.photo) {
        const url = URL.createObjectURL(m.photo);
        objectUrls.push(url);
        const img = el('img', 'thumb');
        img.src = url;
        img.alt = m.name;
        li.append(img);
      }
      const del = el('button', 'ghost small', 'Delete');
      del.onclick = () => removeRecord('meals', m.id, 'meal');
      li.append(body, del);
      list.append(li);
    }
  }

  $('#meal-form').onsubmit = safe(async (e) => {
    e.preventDefault();
    const f = e.target;
    const when = f.when.value ? parseLocalInput(f.when.value) : Date.now();
    const file = f.photo.files[0];
    const photo = file ? await shrinkImage(file) : null;
    await put('meals', {
      id: uid(),
      when,
      name: f.mealName.value.trim(),
      kcal: numOrNull(f.kcal.value),
      protein: numOrNull(f.protein.value),
      carbs: numOrNull(f.carbs.value),
      fat: numOrNull(f.fat.value),
      notes: f.notes.value.trim(),
      photo,
    });
    f.reset();
    await refresh();
  });

  // ---------- weight ----------
  const toUnit = (kg) => (setting('unit') === 'lb' ? kg * LB_PER_KG : kg);

  function renderWeights() {
    $('#weight-unit').textContent = `(${setting('unit')})`;
    const list = $('#weight-list');
    list.replaceChildren();
    if (!data.weights.length) list.append(el('li', 'muted small', 'No weigh-ins yet.'));

    for (const w of [...data.weights].reverse()) {
      const body = el('div', 'item-body');
      body.append(
        el('strong', null, `${toUnit(w.kg).toFixed(1)} ${setting('unit')}`),
        el('div', 'muted small', fmtDate(w.when)),
      );
      const del = el('button', 'ghost small', 'Delete');
      del.onclick = () => removeRecord('weights', w.id, 'weigh-in');
      const li = el('li', 'item');
      li.append(body, del);
      list.append(li);
    }
  }

  $('#weight-form').onsubmit = safe(async (e) => {
    e.preventDefault();
    const f = e.target;
    const value = Number(f.weight.value);
    const kg = setting('unit') === 'lb' ? value * KG_PER_LB : value;
    const when = f.when.value ? parseLocalInput(f.when.value) : Date.now();
    await put('weights', { id: uid(), when, kg });
    f.reset();
    await refresh();
  });

  // ---------- analysis ----------
  function inRange(items, field) {
    const days = Number($('#range').value);
    if (!days) return items;
    const cutoff = Date.now() - days * DAY;
    return items.filter((x) => x[field] >= cutoff);
  }

  // Least-squares slope of value over time, returned per week
  function slopePerWeek(points) {
    if (points.length < 2) return null;
    const mt = avg(points.map((p) => p.t));
    const mv = avg(points.map((p) => p.v));
    let num = 0;
    let den = 0;
    for (const p of points) {
      num += (p.t - mt) * (p.v - mv);
      den += (p.t - mt) ** 2;
    }
    return den ? (num / den) * 7 * DAY : null;
  }

  function movingAvg(values, n) {
    return values.map((_, i) => avg(values.slice(Math.max(0, i - n + 1), i + 1)));
  }

  function drawChart(id, config) {
    charts[id]?.destroy();
    charts[id] = new window.Chart($(`#${id}`), config);
  }

  function renderStats(items) {
    const box = $('#stats');
    box.replaceChildren();
    for (const [label, value] of items) {
      const card = el('div', 'stat');
      card.append(el('div', 'stat-label', label), el('div', 'stat-value', String(value)));
      box.append(card);
    }
  }

  function renderAnalysis() {
    if (!window.Chart) {
      $('#stats').replaceChildren(el('p', 'muted', 'Charts could not load. Check your connection and reload.'));
      return;
    }
    const unit = setting('unit');
    const goal = setting('goalHours');
    const target = setting('calorieTarget');
    const stats = [];
    const insights = [];

    Chart.defaults.color = matchMedia('(prefers-color-scheme: dark)').matches ? '#c9d1d9' : '#4a5568';
    Chart.defaults.borderColor = matchMedia('(prefers-color-scheme: dark)').matches ? '#2d3748' : '#e2e8f0';

    // Fasting
    const fasts = inRange(data.fasts, 'end');
    const fastHours = fasts.map((f) => (f.end - f.start) / HOUR);
    if (fasts.length) {
      const hit = fastHours.filter((h) => h >= goal).length;
      stats.push(
        ['Fasts logged', fasts.length],
        ['Avg fast', fmtHours(avg(fastHours))],
        ['Longest fast', fmtHours(Math.max(...fastHours))],
        ['Goal hit', `${Math.round((hit / fasts.length) * 100)}%`],
      );
      insights.push(`You reached your ${goal} h fasting goal in ${hit} of ${fasts.length} fasts.`);
    } else {
      stats.push(['Fasts logged', 0]);
    }
    drawChart('chart-fasts', {
      type: 'bar',
      data: {
        labels: fasts.map((f) => fmtShortDay(f.end)),
        datasets: [
          {
            label: 'Fast (h)',
            data: fastHours.map((h) => +h.toFixed(1)),
            backgroundColor: fastHours.map((h) => (h >= goal ? COLORS.accent : COLORS.muted)),
          },
          {
            type: 'line',
            label: `Goal (${goal} h)`,
            data: fasts.map(() => goal),
            borderColor: COLORS.red,
            borderDash: [6, 6],
            pointRadius: 0,
          },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } },
    });

    // Weight
    const weights = inRange(data.weights, 'when');
    const byDay = {};
    for (const w of weights) (byDay[dayKey(w.when)] ??= []).push(toUnit(w.kg));
    const wDays = Object.keys(byDay).sort();
    const wDaily = wDays.map((d) => +avg(byDay[d]).toFixed(2));
    if (weights.length >= 2) {
      const first = weights[0];
      const last = weights.at(-1);
      const change = toUnit(last.kg - first.kg);
      stats.push(['Weight change', `${signed(change)} ${unit}`]);
      const perWeek = slopePerWeek(weights.map((w) => ({ t: w.when, v: toUnit(w.kg) })));
      if (last.when - first.when >= 7 * DAY && perWeek != null) {
        stats.push(['Trend / week', `${signed(perWeek)} ${unit}`]);
        const threshold = unit === 'lb' ? 0.2 : 0.1;
        const direction = Math.abs(perWeek) < threshold ? 'stable' : perWeek < 0 ? 'down' : 'up';
        insights.push(`Your weight trend is ${direction}${direction === 'stable' ? '' : ` (${signed(perWeek)} ${unit} per week)`}. The trend is a straight-line fit, so a few unusual weigh-ins can shift it.`);
      }
    }
    drawChart('chart-weight', {
      type: 'line',
      data: {
        labels: wDays.map((d) => fmtShortDay(new Date(`${d}T00:00`).getTime())),
        datasets: [
          { label: `Daily avg (${unit})`, data: wDaily, borderColor: COLORS.blue, backgroundColor: COLORS.blue, tension: 0.2 },
          { label: '7-day average', data: movingAvg(wDaily, 7).map((v) => +v.toFixed(2)), borderColor: COLORS.orange, borderDash: [4, 4], pointRadius: 0, tension: 0.3 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: false } } },
    });

    // Nutrition
    const meals = inRange(data.meals, 'when');
    const perDay = {};
    for (const m of meals) {
      const d = (perDay[dayKey(m.when)] ??= { kcal: 0, protein: 0, carbs: 0, fat: 0 });
      d.kcal += m.kcal || 0;
      d.protein += m.protein || 0;
      d.carbs += m.carbs || 0;
      d.fat += m.fat || 0;
    }
    const nDays = Object.keys(perDay).sort();
    const days = nDays.map((k) => perDay[k]);
    if (days.length) {
      stats.push(
        ['Avg kcal / day', Math.round(avg(days.map((d) => d.kcal)))],
        ['Avg protein / day', `${Math.round(avg(days.map((d) => d.protein)))} g`],
      );
      const over = days.filter((d) => d.kcal > target).length;
      insights.push(`${over} of ${days.length} logged days were above your ${target} kcal target.`);
    }
    const missingKcal = meals.filter((m) => m.kcal == null).length;
    if (missingKcal) {
      insights.push(`${missingKcal} meal(s) have no calories entered, so calorie averages are too low.`);
    }
    drawChart('chart-calories', {
      type: 'bar',
      data: {
        labels: nDays.map((k) => fmtShortDay(new Date(`${k}T00:00`).getTime())),
        datasets: [
          { label: 'kcal', data: days.map((d) => Math.round(d.kcal)), backgroundColor: COLORS.blue },
          { type: 'line', label: 'Target', data: nDays.map(() => target), borderColor: COLORS.orange, borderDash: [6, 6], pointRadius: 0 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } },
    });
    drawChart('chart-macros', {
      type: 'bar',
      data: {
        labels: nDays.map((k) => fmtShortDay(new Date(`${k}T00:00`).getTime())),
        datasets: [
          { label: 'Protein', data: days.map((d) => Math.round(d.protein)), backgroundColor: COLORS.accent },
          { label: 'Carbs', data: days.map((d) => Math.round(d.carbs)), backgroundColor: COLORS.blue },
          { label: 'Fat', data: days.map((d) => Math.round(d.fat)), backgroundColor: COLORS.yellow },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } },
      },
    });

    renderStats(stats);
    const list = $('#insights');
    list.replaceChildren(...(insights.length
      ? insights.map((text) => el('li', null, text))
      : [el('li', 'muted', 'Log a few fasts, meals and weigh-ins to see insights here.')]));
  }

  // ---------- settings & backup ----------
  function renderSettings() {
    $('#set-goal').value = String(setting('goalHours'));
    $('#set-calories').value = setting('calorieTarget');
    $('#set-unit').value = setting('unit');
  }

  async function renderStorage() {
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
    const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
    const usage = est ? ` · ${(est.usage / 1e6).toFixed(1)} MB used` : '';
    $('#storage-status').textContent = `${persisted ? 'Storage: persistent' : 'Storage: may be cleared by browser'}${usage}`;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  const exportData = safe(async () => {
    const meals = await Promise.all(data.meals.map(async (m) => ({
      ...m,
      photo: m.photo ? await blobToDataUrl(m.photo) : null,
    })));
    const payload = {
      app: 'mealfast',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: {
        goalHours: setting('goalHours'),
        unit: setting('unit'),
        calorieTarget: setting('calorieTarget'),
      },
      meals,
      weights: data.weights,
      fasts: data.fasts,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    const a = el('a');
    a.href = url;
    a.download = `mealfast-${dayKey(Date.now())}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  const importData = safe(async (file) => {
    if (!file) return;
    const payload = JSON.parse(await file.text());
    if (payload.app !== 'mealfast') throw new Error('This is not a MealFast backup file.');
    for (const m of payload.meals ?? []) {
      const photo = m.photo ? await (await fetch(m.photo)).blob() : null;
      await put('meals', { ...m, id: m.id ?? uid(), photo });
    }
    for (const w of payload.weights ?? []) await put('weights', { ...w, id: w.id ?? uid() });
    for (const f of payload.fasts ?? []) await put('fasts', { ...f, id: f.id ?? uid() });
    for (const key of ['goalHours', 'unit', 'calorieTarget']) {
      if (payload.settings?.[key] != null) await saveSetting(key, payload.settings[key]);
    }
    alert(`Restored ${payload.meals?.length ?? 0} meals, ${payload.weights?.length ?? 0} weigh-ins and ${payload.fasts?.length ?? 0} fasts.`);
    await refresh();
  });

  const clearAll = safe(async () => {
    if (!confirm('Delete ALL MealFast data in this browser? Export a backup first.')) return;
    for (const store of ['meals', 'weights', 'fasts', 'settings']) {
      await tx(store, 'readwrite', (s) => s.clear());
    }
    await refresh();
  });

  // ---------- wiring ----------
  function renderAll() {
    renderFast();
    renderMeals();
    renderWeights();
    renderSettings();
    if (!$('#tab-analysis').hidden) renderAnalysis();
  }

  function bindSettings() {
    $('#set-goal').onchange = safe(async (e) => { await saveSetting('goalHours', Number(e.target.value)); renderAll(); });
    $('#set-unit').onchange = safe(async (e) => { await saveSetting('unit', e.target.value); renderAll(); });
    $('#set-calories').onchange = safe(async (e) => { await saveSetting('calorieTarget', Number(e.target.value) || 0); renderAll(); });
    $('#btn-export').onclick = exportData;
    $('#import-file').onchange = (e) => importData(e.target.files[0]);
    $('#btn-clear').onclick = clearAll;
  }

  async function init() {
    $$('.tab').forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.tab)));
    $('#range').onchange = renderAnalysis;
    bindSettings();
    await refresh();
    setInterval(tickFast, 1000);
    await navigator.storage?.persist?.();
    renderStorage();
  }

  init().catch((err) => alert(`MealFast could not open its storage: ${err.message}`));
})();

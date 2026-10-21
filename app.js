(() => {
  'use strict';

  const HOUR = 3600e3;
  const DAY = 86400e3;
  const KG_PER_LB = 0.45359237;
  const LB_PER_KG = 1 / KG_PER_LB;
  const APP_VERSION = '15';
  const AI_MODEL = 'claude-sonnet-5-5';
  const ESTIMATE_PROMPT = [
    'Estimate the nutrition of the meal in this photo.',
    'Identify the foods, judge the portion sizes, and total the calories and macros for the whole plate.',
    'Reply with only a JSON object, no other text, in this shape:',
    '{"name": string, "kcal": number, "protein_g": number, "carbs_g": number, "fat_g": number, "confidence": "low" | "medium" | "high", "notes": string}',
    'Keep notes to one short sentence about the main assumptions.',
  ].join(' '); // bump with each release; also bump ?v= in index.html
  const PULL_THRESHOLD = 70;
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
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const fmtDay = (key) => new Date(`${key}T00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
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
  const DIAL = 24 * HOUR; // the ring is a 24 h dial; longer fasts wrap around it

  function setRing(fraction) {
    $('#fast-ring').style.strokeDashoffset = String(RING_C * (1 - Math.min(1, Math.max(0, fraction))));
  }

  function tickFast() {
    const goalHours = setting('goalHours');
    const goalMs = goalHours * HOUR;
    const start = setting('activeFast');
    $('#fast-goal-tick').style.transform = `rotate(${(goalMs / DIAL) * 360}deg)`;
    if (!start) {
      $('#fast-elapsed').textContent = '--:--:--';
      setRing(0);
      $('#fast-goal').textContent = `Goal: ${goalHours} h`;
      return;
    }
    const elapsed = Date.now() - start;
    const dialPos = elapsed % DIAL;
    setRing(dialPos === 0 && elapsed > 0 ? 1 : dialPos / DIAL);
    $('#fast-elapsed').textContent = fmtClock(elapsed);
    $('#fast-goal').textContent = elapsed >= goalMs
      ? `Goal of ${goalHours} h reached · +${fmtHM(elapsed - goalMs)}`
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
    openMealForm(end);
  });

  // After breaking a fast, go straight to logging what was eaten
  function openMealForm(when) {
    const f = $('#meal-form');
    f.when.value = localInputValue(when);
    $('#meal-prompt').hidden = false;
    showTab('meals');
    f.mealName.focus();
    f.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

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

    renderDiary();
  }

  // Day-by-day timeline: meals and fasts in the order they happened, newest day first
  function renderDiary() {
    const box = $('#diary');
    box.replaceChildren();
    const events = [
      ...data.meals.map((m) => ({ type: 'meal', t: m.when, item: m })),
      ...data.fasts.map((f) => ({ type: 'fast', t: f.start, item: f })),
    ].sort((a, b) => b.t - a.t); // newest first

    if (!events.length) {
      box.append(el('p', 'muted small', 'Nothing logged yet. Log a meal or finish a fast to start your diary.'));
      return;
    }

    const days = new Map();
    for (const e of events) {
      const key = dayKey(e.t);
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(e);
    }

    for (const [day, evs] of days) {
      const meals = evs.filter((e) => e.type === 'meal').map((e) => e.item);
      const totals = sumMacros(meals);
      const head = el('div', 'day-head');
      head.append(
        el('strong', null, fmtDay(day)),
        el('span', 'muted small', `${meals.length} meal${meals.length === 1 ? '' : 's'} · ${Math.round(totals.kcal)} kcal`),
      );
      const timeline = el('ol', 'timeline');
      for (const e of evs) timeline.append(e.type === 'meal' ? mealRow(e.item) : fastRow(e.item));
      const section = el('section', 'day');
      section.append(head, timeline);
      box.append(section);
    }
  }

  function mealRow(m) {
    const body = el('div', 'entry-body');
    body.append(el('strong', null, m.name), el('div', 'muted small', macroLine(m)));
    if (m.notes) body.append(el('div', 'muted small', m.notes));
    if (m.items?.length) body.append(el('div', 'muted small', m.items.map((i) => `${i.name} ${i.grams} g${i.method && i.method !== 'Plain' ? ` (${i.method})` : ''}`).join(' · ')));
    if (m.photo) {
      const url = URL.createObjectURL(m.photo);
      objectUrls.push(url);
      const img = el('img', 'thumb');
      img.src = url;
      img.alt = m.name;
      body.append(img);
    }
    const del = el('button', 'ghost small icon-btn', '×');
    del.setAttribute('aria-label', 'Delete meal');
    del.onclick = () => removeRecord('meals', m.id, 'meal');
    const li = el('li', 'entry meal');
    li.append(el('span', 'entry-time', fmtTime(m.when)), body, del);
    return li;
  }

  function fastRow(f) {
    const body = el('div', 'entry-body');
    body.append(el('strong', null, `Fasted ${fmtHM(f.end - f.start)}`), el('div', 'muted small', `until ${fmtTime(f.end)}`));
    const del = el('button', 'ghost small icon-btn', '×');
    del.setAttribute('aria-label', 'Delete fast');
    del.onclick = () => removeRecord('fasts', f.id, 'fast');
    const li = el('li', 'entry fast');
    li.append(el('span', 'entry-time', fmtTime(f.start)), body, del);
    return li;
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
      items: mealItems.map(({ food, grams, method }) => ({ name: food.name, grams, method: cookingLabel(method) })),
    });
    f.reset();
    mealItems = [];
    itemsDriveFields = false;
    renderItems();
    $('#meal-prompt').hidden = true;
    await refresh();
  });

  // ---------- meal library and suggestions ----------
  // Library = saved meals ("My meals") plus each distinct past meal name, newest values first.
  function savedMeals() {
    return data.settings.savedMeals || [];
  }

  function mealLibrary() {
    const saved = savedMeals().map((m) => ({ ...m, source: 'saved' }));
    const seen = new Set(saved.map((m) => m.name.toLowerCase()));
    const logged = [];
    for (const m of data.meals) { // data.meals is newest first
      const key = m.name.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      logged.push({ name: m.name, kcal: m.kcal, protein: m.protein, carbs: m.carbs, fat: m.fat, source: 'logged' });
    }
    return [...saved, ...logged];
  }

  function fillMealForm(item) {
    const f = $('#meal-form');
    f.mealName.value = item.name;
    if (!mealItems.length) { // with ingredients, the macros come from them
      f.kcal.value = item.kcal ?? '';
      f.protein.value = item.protein ?? '';
      f.carbs.value = item.carbs ?? '';
      f.fat.value = item.fat ?? '';
    }
    $('#meal-suggest').hidden = true;
    f.mealName.focus();
  }

  function renderSuggestions() {
    const box = $('#meal-suggest');
    const q = $('#meal-form').mealName.value.trim().toLowerCase();
    box.replaceChildren();
    const hits = q ? mealLibrary().filter((m) => m.name.toLowerCase().includes(q)).slice(0, 6) : [];
    box.hidden = !hits.length;
    for (const item of hits) {
      const btn = el('button', 'suggest-item');
      btn.type = 'button';
      btn.append(
        el('span', null, item.name),
        el('small', null, `${item.source === 'saved' ? 'My meal' : 'Logged'} · ${macroLine(item)}`),
      );
      btn.onclick = () => fillMealForm(item);
      box.append(btn);
    }
  }

  function renderLibrary() {
    const list = $('#library-list');
    list.replaceChildren();
    const items = mealLibrary();
    if (!items.length) list.append(el('li', 'muted small', 'Saved and past meals will appear here.'));
    for (const item of items) {
      const body = el('div', 'item-body');
      const title = el('strong', null, item.name);
      if (item.source === 'saved') title.append(el('span', 'tag', 'My meal'));
      body.append(title, el('div', 'muted small', macroLine(item)));
      const li = el('li', 'item');
      li.append(body);
      li.onclick = () => fillMealForm(item);
      if (item.source === 'saved') {
        const del = el('button', 'ghost small icon-btn', '×');
        del.setAttribute('aria-label', 'Delete saved meal');
        del.onclick = safe(async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete "${item.name}" from My meals?`)) return;
          await saveSetting('savedMeals', savedMeals().filter((m) => m.id !== item.id));
          renderAll();
        });
        li.append(del);
      }
      list.append(li);
    }
    renderSuggestions();
  }

  $('#meal-form').mealName.oninput = renderSuggestions;

  $('#btn-clear-meal').onclick = () => {
    $('#meal-form').reset(); // also clears the photo and the time
    mealItems = [];
    itemsDriveFields = false;
    renderItems();
    $('#meal-prompt').hidden = true;
    $('#meal-suggest').hidden = true;
    $('#template-status').textContent = '';
    $('#estimate-status').textContent = '';
    refreshEstimateUi();
  };

  $('#btn-save-template').onclick = safe(async () => {
    const f = $('#meal-form');
    const name = f.mealName.value.trim();
    if (!name) return alert('Type a meal name first.');
    const item = {
      id: uid(),
      name,
      kcal: numOrNull(f.kcal.value),
      protein: numOrNull(f.protein.value),
      carbs: numOrNull(f.carbs.value),
      fat: numOrNull(f.fat.value),
    };
    const others = savedMeals().filter((m) => m.name.toLowerCase() !== name.toLowerCase());
    await saveSetting('savedMeals', [...others, item]);
    $('#template-status').textContent = `"${name}" saved to My meals.`;
    renderAll();
  });

  // ---------- ingredients (preset foods by weight) ----------
  const FOODS = FOOD_PRESETS.map(([name, group, kcal, protein, carbs, fat]) => ({ name, group, kcal, protein, carbs, fat }));
  let mealItems = []; // [{ food, grams }] for the meal being entered
  let itemsDriveFields = false; // true while the macro fields show item totals

  // Cooking styles add an estimated amount of cooking oil (grams per 100 g of food).
  // Oil is 884 kcal per 100 g and all fat. Rough estimates, not measured values.
  const COOKING = [
    { key: 'plain', label: 'Plain', oil: 0 },
    { key: 'boiled', label: 'Boiled / steamed', oil: 0 },
    { key: 'poached', label: 'Poached', oil: 0 },
    { key: 'stewed', label: 'Stewed / braised', oil: 0.5 },
    { key: 'smoked', label: 'Smoked', oil: 0 },
    { key: 'grilled', label: 'Grilled', oil: 1 },
    { key: 'airfried', label: 'Air-fried', oil: 1 },
    { key: 'roasted', label: 'Roasted (with oil)', oil: 2 },
    { key: 'baked', label: 'Baked', oil: 0.5 },
    { key: 'toasted', label: 'Toasted', oil: 0 },
    { key: 'microwaved', label: 'Microwaved', oil: 0 },
    { key: 'blanched', label: 'Blanched', oil: 0 },
    { key: 'pressure', label: 'Pressure-cooked', oil: 0 },
    { key: 'slowcooked', label: 'Slow-cooked', oil: 0 },
    { key: 'sousvide', label: 'Sous vide', oil: 0 },
    { key: 'barbecued', label: 'Barbecued', oil: 1 },
    { key: 'seared', label: 'Seared', oil: 3 },
    { key: 'sauteed', label: 'Sautéed', oil: 4 },
    { key: 'stirfried', label: 'Stir-fried', oil: 5 },
    { key: 'fried', label: 'Fried (shallow)', oil: 7 },
    { key: 'deepfried', label: 'Deep-fried', oil: 12 },
    { key: 'confit', label: 'Confit (cooked in fat)', oil: 15 },
  ];
  const cookingOil = (key) => COOKING.find((c) => c.key === key)?.oil ?? 0;
  const cookingLabel = (key) => COOKING.find((c) => c.key === key)?.label ?? 'Plain';

  const round1 = (x) => Math.round(x * 10) / 10;

  function itemTotals(items) {
    return items.reduce((t, { food, grams, method }) => {
      const r = grams / 100;
      const oil = cookingOil(method);
      return {
        kcal: t.kcal + (food.kcal + oil * 8.84) * r,
        protein: t.protein + food.protein * r,
        carbs: t.carbs + food.carbs * r,
        fat: t.fat + (food.fat + oil) * r,
      };
    }, { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  }

  function renderItems() {
    const list = $('#item-list');
    list.replaceChildren();
    mealItems.forEach((it, i) => {
      const t = itemTotals([it]);
      const body = el('div', 'item-body');
      body.append(
        el('strong', null, `${it.food.name} · ${cookingLabel(it.method)} · ${it.grams} g`),
        el('div', 'muted small', `${Math.round(t.kcal)} kcal · P ${round1(t.protein)} g · C ${round1(t.carbs)} g · F ${round1(t.fat)} g`),
      );
      const remove = el('button', 'ghost small', 'Remove');
      remove.onclick = () => {
        mealItems.splice(i, 1);
        renderItems();
      };
      const li = el('li', 'item');
      li.append(body, remove);
      list.append(li);
    });

    // with items, calories and macros are their totals and locked;
    // without items they are typed in by hand
    const f = $('#meal-form');
    const locked = mealItems.length > 0;
    for (const name of ['kcal', 'protein', 'carbs', 'fat']) f[name].readOnly = locked;
    $('#macro-hint').textContent = locked
      ? 'Calories and macros add up from your ingredients.'
      : 'No ingredients: type calories and macros by hand, or add ingredients above.';
    if (locked) {
      const t = itemTotals(mealItems);
      f.kcal.value = Math.round(t.kcal);
      f.protein.value = round1(t.protein);
      f.carbs.value = round1(t.carbs);
      f.fat.value = round1(t.fat);
      itemsDriveFields = true;
    } else if (itemsDriveFields) {
      f.kcal.value = '';
      f.protein.value = '';
      f.carbs.value = '';
      f.fat.value = '';
      itemsDriveFields = false;
    }
    refreshEstimateUi();
  }

  function populateMethodSelect() {
    const select = $('#item-method');
    for (const c of COOKING) select.append(new Option(c.label, c.key));
  }

  // Type to search; tap a match to select it, then enter grams and Add
  function renderItemSuggest() {
    const box = $('#item-suggest');
    const q = $('#item-search').value.trim().toLowerCase();
    box.replaceChildren();
    const starts = (f) => f.name.toLowerCase().startsWith(q);
    const hits = q
      ? FOODS.filter((f) => f.name.toLowerCase().includes(q)).sort((a, b) => Number(starts(b)) - Number(starts(a))).slice(0, 8)
      : [];
    box.hidden = !hits.length;
    for (const food of hits) {
      const btn = el('button', 'suggest-item');
      btn.type = 'button';
      btn.append(el('span', null, food.name), el('small', null, `${food.group} · ${food.kcal} kcal per 100 g`));
      btn.onclick = () => {
        $('#item-search').value = food.name;
        box.hidden = true;
        $('#item-grams').focus();
      };
      box.append(btn);
    }
  }

  $('#item-search').oninput = renderItemSuggest;
  populateMethodSelect();

  $('#btn-add-item').onclick = () => {
    const typed = $('#item-search').value.trim().toLowerCase();
    const food = FOODS.find((x) => x.name.toLowerCase() === typed);
    const grams = Number($('#item-grams').value);
    if (!food) return alert('Pick a food from the list.');
    if (!(grams > 0)) return alert('Enter how many grams.');
    mealItems.push({ food, grams, method: $('#item-method').value });
    $('#item-search').value = '';
    $('#item-grams').value = '';
    $('#item-suggest').hidden = true;
    renderItems();
    $('#item-search').focus();
  };

  // ---------- AI photo estimate ----------
  // The key lives in this browser only; the request goes straight to Anthropic.
  function aiKey() {
    try { return localStorage.getItem('mealfast-ai-key') || ''; } catch { return ''; }
  }

  function setAiKey(value) {
    try {
      if (value) localStorage.setItem('mealfast-ai-key', value);
      else localStorage.removeItem('mealfast-ai-key');
    } catch { /* storage blocked */ }
  }

  async function estimateMeal(file) {
    const blob = await shrinkImage(file, 768);
    const data = (await blobToDataUrl(blob)).split(',')[1];
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': aiKey(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
            { type: 'text', text: ESTIMATE_PROMPT },
          ],
        }],
      }),
    });
    if (res.status === 401) throw new Error('The API key was rejected. Check it in Settings.');
    if (!res.ok) throw new Error(`The estimate failed (error ${res.status}).`);
    const body = await res.json();
    const text = body.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('The estimate could not be read. Try a clearer photo.');
    return JSON.parse(match[0]);
  }

  function refreshEstimateUi() {
    const f = $('#meal-form');
    const hasPhoto = Boolean(f.photo.files[0]);
    $('#btn-estimate').hidden = !(hasPhoto && aiKey() && !mealItems.length);
    $('#ai-status').textContent = aiKey()
      ? 'A key is saved in this browser.'
      : 'No key saved. Photo estimates are off.';
  }

  $('#meal-form').photo.onchange = refreshEstimateUi;

  $('#btn-estimate').onclick = safe(async () => {
    const f = $('#meal-form');
    const file = f.photo.files[0];
    if (!file) return;
    $('#btn-estimate').disabled = true;
    $('#estimate-status').textContent = 'Estimating...';
    try {
      const est = await estimateMeal(file);
      if (!f.mealName.value.trim() && est.name) f.mealName.value = est.name;
      f.kcal.value = Math.round(est.kcal);
      f.protein.value = Math.round(est.protein_g * 10) / 10;
      f.carbs.value = Math.round(est.carbs_g * 10) / 10;
      f.fat.value = Math.round(est.fat_g * 10) / 10;
      const label = `AI estimate, ${est.confidence} confidence${est.notes ? `: ${est.notes}` : ''}`;
      f.notes.value = [f.notes.value.trim(), label].filter(Boolean).join(' · ');
      $('#estimate-status').textContent = 'Filled in. Check the numbers before saving.';
    } catch (err) {
      $('#estimate-status').textContent = err.message;
    } finally {
      $('#btn-estimate').disabled = false;
    }
  });

  $('#btn-ai-save').onclick = safe(async () => {
    const value = $('#ai-key').value.trim();
    if (!value) return alert('Paste your API key first.');
    setAiKey(value);
    $('#ai-key').value = '';
    refreshEstimateUi();
  });

  $('#btn-ai-clear').onclick = () => {
    if (!confirm('Remove the saved API key from this browser?')) return;
    setAiKey('');
    refreshEstimateUi();
  };

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

    Chart.defaults.color = isDarkTheme() ? '#c9d1d9' : '#4a5568';
    Chart.defaults.borderColor = isDarkTheme() ? '#2d3748' : '#e2e8f0';

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

  // ---------- theme ----------
  // An explicit choice is stored in localStorage; without one the system setting applies.
  function isDarkTheme() {
    const explicit = document.documentElement.dataset.theme;
    return explicit ? explicit === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function bindTheme() {
    const btn = $('#btn-theme');
    const paint = () => {
      const dark = isDarkTheme();
      btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
      btn.querySelector('.icon-sun').hidden = !dark;
      btn.querySelector('.icon-moon').hidden = dark;
      $('meta[name="theme-color"]').content = dark ? '#0c1210' : '#2f855a';
    };
    btn.onclick = () => {
      const mode = isDarkTheme() ? 'light' : 'dark';
      document.documentElement.dataset.theme = mode;
      try { localStorage.setItem('mealfast-theme', mode); } catch { /* storage blocked */ }
      paint();
      if (!$('#tab-analysis').hidden) renderAnalysis(); // chart colours follow the theme
    };
    paint();
  }

  // ---------- refresh ----------
  // Reloads the app after asking the service worker to check for a new version.
  // Stored data lives in IndexedDB and survives the reload.
  async function reloadApp() {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      await reg?.update();
    } catch {
      // offline: reload will use the cached copy
    }
    location.reload();
  }

  // iPhone home-screen apps have no pull-to-refresh, so provide one
  function bindPullToRefresh() {
    const ptr = $('#ptr');
    const HIDDEN = -56;
    let startY = null;
    let dy = 0;

    const place = (y, animate) => {
      ptr.style.transition = animate ? 'transform 0.2s ease' : 'none';
      ptr.style.transform = `translate(-50%, ${y}px)`;
    };

    window.addEventListener('touchstart', (e) => {
      startY = window.scrollY <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null;
      dy = 0;
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (startY == null) return;
      dy = Math.max(0, e.touches[0].clientY - startY);
      if (dy === 0) return;
      place(HIDDEN + Math.min(dy, 120) * 0.5, false);
      ptr.textContent = dy > PULL_THRESHOLD ? 'Release to refresh' : 'Pull to refresh';
    }, { passive: true });

    window.addEventListener('touchend', () => {
      if (startY != null && dy > PULL_THRESHOLD) {
        ptr.textContent = 'Refreshing…';
        place(0, true);
        reloadApp();
      } else {
        place(HIDDEN, true);
      }
      startY = null;
      dy = 0;
    }, { passive: true });
  }

  // ---------- wiring ----------
  function renderAll() {
    renderFast();
    renderMeals();
    renderLibrary();
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
    $('#btn-refresh').onclick = reloadApp;
    bindTheme();
    bindPullToRefresh();
    $('#app-version').textContent = APP_VERSION;
    refreshEstimateUi();
    renderItems();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    await refresh();
    setInterval(tickFast, 1000);
    await navigator.storage?.persist?.();
    renderStorage();
  }

  init().catch((err) => alert(`MealFast could not open its storage: ${err.message}`));
})();

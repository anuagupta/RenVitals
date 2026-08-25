'use strict';
/* =========================================================================
   Vitals — app.js
   Offline-first health log: fluid intake, urine output, blood pressure,
   sugar, and customizable medicine alarms. All data lives in localStorage
   on this device first; Google Drive (drive.js) is an optional backup.
   ========================================================================= */

/* ---------------------------------------------------------------------
   Storage layer
   --------------------------------------------------------------------- */
const DB = {
  _get(key, fallback){
    try{ const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch(e){ console.warn('Vitals: failed to read', key, e); return fallback; }
  },
  _set(key, value){
    try{ localStorage.setItem(key, JSON.stringify(value)); }
    catch(e){ console.warn('Vitals: failed to save', key, e); }
  },
  getEntries(){ return this._get('vitals:entries', []); },
  saveEntries(list){ this._set('vitals:entries', list); },
  getAlarms(){ return this._get('vitals:alarms', []); },
  saveAlarms(list){ this._set('vitals:alarms', list); },
  getCustomMetrics(){ return this._get('vitals:customMetrics', []); },
  saveCustomMetrics(list){ this._set('vitals:customMetrics', list); },
  getColorOverrides(){ return this._get('vitals:colorOverrides', {}); },
  saveColorOverrides(o){ this._set('vitals:colorOverrides', o); },
  getSettings(){ return this._get('vitals:settings', {
    pinHash:null, pinSalt:null, theme:'auto', bioEnabled:false, bioCredId:null, onboarded:false
  }); },
  saveSettings(s){ this._set('vitals:settings', s); },
  getFiredLog(){ return this._get('vitals:firedLog', {}); },
  saveFiredLog(log){ this._set('vitals:firedLog', log); }
};

/* ---------------------------------------------------------------------
   Small utilities
   --------------------------------------------------------------------- */
function genId(){
  if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}
function $(sel, root){ return (root||document).querySelector(sel); }
function $all(sel, root){ return Array.from((root||document).querySelectorAll(sel)); }
function escapeHtml(str){
  return String(str==null?'':str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function pad2(n){ return String(n).padStart(2,'0'); }
function formatTime(ts){
  return new Date(ts).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
}
function formatDateHeader(d){
  return d.toLocaleDateString([], {weekday:'long', day:'numeric', month:'long'});
}
function startOfDay(ts){ const d = new Date(ts); d.setHours(0,0,0,0); return d.getTime(); }
function isToday(ts){ return startOfDay(ts) === startOfDay(Date.now()); }
function sameDay(ts, dateObj){ return startOfDay(ts) === startOfDay(dateObj.getTime()); }
function toTimeInputValue(ts){ const d = new Date(ts); return pad2(d.getHours())+':'+pad2(d.getMinutes()); }
function toDateInputValue(ts){ const d = new Date(ts); return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
function combineWithTime(baseTs, timeStr){
  const d = new Date(baseTs);
  const parts = (timeStr||'').split(':');
  const h = parseInt(parts[0],10), m = parseInt(parts[1],10);
  if(!isNaN(h)) d.setHours(h, isNaN(m)?0:m, 0, 0);
  return d.getTime();
}
// Lets an entry be backdated to any date, not just today — combines a
// `<input type=date>` value with a `<input type=time>` value into one
// timestamp, falling back to the given timestamp's own time-of-day if no
// time was entered (shouldn't normally happen since the time field always
// has a value, but keeps this safe either way).
function combineDateTime(dateStr, timeStr, fallbackTs){
  const d = dateStr ? new Date(dateStr+'T00:00:00') : new Date(fallbackTs);
  const parts = (timeStr||'').split(':');
  const h = parseInt(parts[0],10), m = parseInt(parts[1],10);
  if(!isNaN(h)) d.setHours(h, isNaN(m)?0:m, 0, 0);
  else { const f = new Date(fallbackTs); d.setHours(f.getHours(), f.getMinutes(), 0, 0); }
  return d.getTime();
}
function avg(arr){ return arr.reduce((s,v)=>s+v,0) / (arr.length||1); }
function lastNDates(n){
  const out = [];
  for(let i=n-1;i>=0;i--){
    const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-i);
    out.push(d);
  }
  return out;
}

/* ---------------------------------------------------------------------
   Type metadata (icons, labels, colors)
   --------------------------------------------------------------------- */
const ICONS = {
  liquid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3s6 6.5 6 11a6 6 0 1 1-12 0c0-4.5 6-11 6-11Z"/></svg>',
  urine:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 3h6l1 4H8l1-4Z"/><path d="M8 7h8l1.2 11.2A2 2 0 0 1 15.2 20H8.8a2 2 0 0 1-2-2.2L8 7Z"/></svg>',
  bp:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 12h3l2 6 4-14 2 8h5"/></svg>',
  sugar:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>',
  custom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 3h6M10 3v6.5L5.5 17a2 2 0 0 0 1.7 3h9.6a2 2 0 0 0 1.7-3L14 9.5V3"/><path d="M8.5 14h7"/></svg>'
};
const TYPE_META = {
  liquid: {label:'Fluid Intake', sheetNoun:'fluid intake', colorClass:'blue',   colorVar:'--blue',   icon:ICONS.liquid, unit:'mL'},
  urine:  {label:'Urine output', sheetNoun:'urine output',  colorClass:'yellow',colorVar:'--yellow', icon:ICONS.urine,  unit:'mL'},
  bp:     {label:'Blood pressure', sheetNoun:'blood pressure', colorClass:'red', colorVar:'--red',  icon:ICONS.bp,     unit:'mmHg'},
  sugar:  {label:'Sugar', sheetNoun:'sugar reading', colorClass:'green', colorVar:'--green', icon:ICONS.sugar, unit:'mg/dL'}
};
const PRESET_AMOUNTS = [100,150,200,250,300,350];
const DRINK_TYPES = ['Water','Tea','Coffee','Juice','Other'];
const TONES = [['chime','Chime'],['bell','Bell'],['beep','Beep'],['silent','Silent']];
const SUGAR_CONTEXTS = [['fasting','Fasting'],['before','Before meal'],['after','After meal']];
function sugarContextLabel(key){
  const found = SUGAR_CONTEXTS.find(c=>c[0]===key);
  return found ? found[1] : 'Fasting';
}
function sugarKeyFromLabel(label){
  const found = SUGAR_CONTEXTS.find(c=>c[1]===label);
  return found ? found[0] : 'fasting';
}

// Colors available for user-defined parameters (kidney panel values like
// creatinine/eGFR, or anything else) — kept distinct from the four built-in
// metric colors above.
const METRIC_COLORS = [
  ['orange','Orange','--orange'],
  ['purple','Purple','--purple'],
  ['pink','Pink','--pink'],
  ['teal','Teal','--teal']
];
// A couple of one-tap starting points for the kidney-transplant panel the
// user asked about — still fully editable before saving.
const METRIC_SUGGESTIONS = [
  {name:'Serum creatinine', unit:'mg/dL', colorClass:'orange'},
  {name:'eGFR', unit:'mL/min/1.73m²', colorClass:'purple'},
  {name:'Tacrolimus level', unit:'ng/mL', colorClass:'teal'}
];
// Every color available anywhere a tab/metric color can be picked — the four
// built-in tab colors plus the four extra ones offered for custom metrics.
// Used for the Settings "Tab colors" picker so any tab (built-in or custom)
// can be recolored to any of the eight.
const ALL_COLORS = [
  ['blue','Blue','--blue'], ['yellow','Yellow','--yellow'],
  ['red','Red','--red'],    ['green','Green','--green'],
  ['orange','Orange','--orange'], ['purple','Purple','--purple'],
  ['pink','Pink','--pink'], ['teal','Teal','--teal']
];

function getMetricMeta(type){
  const overrides = DB.getColorOverrides();
  if(TYPE_META[type]){
    const base = TYPE_META[type];
    const entry = overrides[type] && ALL_COLORS.find(c=>c[0]===overrides[type]);
    return entry ? Object.assign({}, base, {colorClass: entry[0], colorVar: entry[2]}) : base;
  }
  const m = DB.getCustomMetrics().find(x=>x.id===type);
  if(!m) return null;
  const colorKey = overrides[type] || m.colorClass;
  const colorEntry = ALL_COLORS.find(c=>c[0]===colorKey) || ALL_COLORS[0];
  return {
    label: m.name, sheetNoun: m.name.toLowerCase(), colorClass: colorEntry[0],
    colorVar: colorEntry[2], icon: ICONS.custom, unit: m.unit, isCustom: true
  };
}
function setTabColor(type, colorKey){
  const overrides = DB.getColorOverrides();
  overrides[type] = colorKey;
  DB.saveColorOverrides(overrides);
  renderAll();
  renderSettingsPanel();
}
function allMetricTypes(){
  return Object.keys(TYPE_META).concat(DB.getCustomMetrics().map(m=>m.id));
}

/* ---------------------------------------------------------------------
   Local custom-metric de-duplication (offline-safe cleanup)

   This runs once per app start, entirely locally — it does not require
   Google Drive to be connected. It exists because older buggy versions
   (and the two-device sync itself, before it converges) could leave a
   phone with more than one custom metric definition sharing the same
   name ("Serum Creatinine" / "serum creatinine" / duplicate IDs created
   while offline). Rather than just deleting the extras, every entry
   pointing at a duplicate's ID is first rewritten to point at the one
   canonical ID that survives, so no health data is lost — only the
   duplicate tile disappears. If Drive is connected, the now-orphaned
   duplicate definitions are also tombstoned remotely so they don't come
   back on the next sync.
   --------------------------------------------------------------------- */
function normalizeMetricNameKey(name){
  return String(name == null ? '' : name).trim().replace(/\s+/g,' ').toLowerCase();
}
function dedupeLocalCustomMetrics(){
  const metrics = DB.getCustomMetrics();
  if(!metrics.length) return;

  const groups = new Map();
  metrics.forEach(m=>{
    if(!m || !m.name) return;
    const key = normalizeMetricNameKey(m.name);
    if(!key) return;
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  });

  const hasDuplicates = Array.from(groups.values()).some(list => list.length > 1);
  if(!hasDuplicates) return;

  const canonicalMetrics = [];
  const idRemap = new Map();
  const removedIds = [];

  for(const list of groups.values()){
    if(list.length === 1){ canonicalMetrics.push(list[0]); continue; }

    // Newest updatedAt wins; ties broken by the lexicographically smallest
    // id so every device converges on the same choice independently.
    const sorted = list.slice().sort((a,b)=>{
      const diff = (Number(b.updatedAt)||0) - (Number(a.updatedAt)||0);
      if(diff) return diff;
      return String(a.id).localeCompare(String(b.id));
    });
    const winner = Object.assign({}, sorted[0]);
    canonicalMetrics.push(winner);
    sorted.forEach(m=>{ if(m.id !== winner.id){ idRemap.set(m.id, winner.id); removedIds.push(m.id); } });
  }

  if(!idRemap.size) return;

  DB.saveCustomMetrics(canonicalMetrics);

  let entries = DB.getEntries();
  let entriesChanged = false;
  entries = entries.map(e=>{
    if(e && e.type && idRemap.has(e.type)){
      entriesChanged = true;
      return Object.assign({}, e, { type: idRemap.get(e.type), updatedAt: Date.now() });
    }
    return e;
  });
  if(entriesChanged) DB.saveEntries(entries);

  // Also clear any per-tab color override recorded against a duplicate id —
  // it no longer refers to anything and would otherwise sit there unused.
  const overrides = DB.getColorOverrides();
  let overridesChanged = false;
  removedIds.forEach(id=>{ if(overrides[id] !== undefined){ delete overrides[id]; overridesChanged = true; } });
  if(overridesChanged) DB.saveColorOverrides(overrides);

  if(window.VitalsDrive && window.VitalsDrive.queueMetricDelete){
    removedIds.forEach(id => window.VitalsDrive.queueMetricDelete(id, Date.now()));
  }

  console.log('Vitals: merged duplicate custom metric definitions', removedIds);
}

/* ---------------------------------------------------------------------
   State
   --------------------------------------------------------------------- */
let currentSheetKind = null;
let currentEditId = null;
let currentDetailType = null;
let currentDetailDate = null;
let currentTrendRange = 7;
let alarmCheckInterval = null;
let pendingUnlockAction = null;
let pinBuffer = '';
let pinFirstEntry = '';

/* =========================================================================
   RENDERING — Home
   ========================================================================= */
function computeHomeAggregate(type){
  const entries = DB.getEntries().filter(e => e.type === type);
  if(!entries.length) return {valueHtml:'—', timeText:'No entries yet'};
  const sorted = entries.slice().sort((a,b)=>b.ts-a.ts);
  const last = sorted[0];

  if(type === 'liquid' || type === 'urine'){
    const total = entries.filter(e=>isToday(e.ts)).reduce((s,e)=>s+e.amount,0);
    return {
      valueHtml: `${total.toLocaleString()}<small>mL today</small>`,
      timeText: `Last · ${last.amount} mL · ${formatTime(last.ts)}`
    };
  }
  if(type === 'bp'){
    return {
      valueHtml: `${last.systolic}<small>/ ${last.diastolic} mmHg</small>`,
      timeText: (last.pulse ? `Pulse ${last.pulse} · ` : '') + formatTime(last.ts)
    };
  }
  if(type === 'sugar'){
    return {
      valueHtml: `${last.value}<small>mg/dL</small>`,
      timeText: `${sugarContextLabel(last.context)} · ${formatTime(last.ts)}`
    };
  }
  const meta = getMetricMeta(type);
  return {
    valueHtml: `${last.value}<small>${escapeHtml(meta ? meta.unit : '')}</small>`,
    timeText: formatTime(last.ts)
  };
}

function renderHomeGrid(){
  const grid = $('#home-grid');
  grid.innerHTML = allMetricTypes().map(type=>{
    const meta = getMetricMeta(type);
    if(!meta) return '';
    const agg = computeHomeAggregate(type);
    return `
      <div class="card ${meta.colorClass}">
        <button class="card-top" data-open-sheet="${type}">
          <div class="card-icon">${meta.icon}</div>
          <span class="card-plus" aria-hidden="true">+</span>
        </button>
        <button class="card-bottom" data-open-detail="${type}">
          <div class="card-label">${meta.label}</div>
          <div class="card-value">${agg.valueHtml}</div>
          <div class="card-time">${agg.timeText}</div>
        </button>
      </div>`;
  }).join('');
}

function renderHomeAlarmsPreview(){
  const box = $('#home-alarms-preview');
  const alarms = DB.getAlarms().filter(a=>a.enabled).slice(0,3);
  if(!alarms.length){
    box.innerHTML = '<p class="empty-hint">No alarms yet. Add one from the Alarms tab.</p>';
    return;
  }
  box.innerHTML = alarms.map(a=>`
    <div class="alarm-row">
      <div class="alarm-dot"></div>
      <div class="alarm-info"><div class="alarm-label">${escapeHtml(a.label)}</div><div class="alarm-sub">${alarmRepeatText(a)}</div></div>
      <div class="alarm-time">${formatAlarmTime(a.time)}</div>
    </div>`).join('');
}

function formatAlarmTime(hhmm){
  const [h,m] = hhmm.split(':').map(Number);
  const d = new Date(); d.setHours(h,m,0,0);
  return formatTime(d.getTime());
}
function alarmRepeatText(a){
  if(a.days === 'daily') return 'Daily';
  if(!a.days || !a.days.length) return 'Once';
  const names = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return a.days.slice().sort().map(d=>names[d]).join(', ');
}

function renderHeader(){
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  $('#greeting').textContent = greeting;
  $('#today-date').textContent = formatDateHeader(new Date());
}

function renderAll(){
  renderHeader();
  renderHomeGrid();
  renderHomeAlarmsPreview();
  renderTrends();
  renderAlarmsList();
  if(currentDetailType && $('#detail').classList.contains('show')){
    openDetail(currentDetailType, currentDetailDate);
  }
}

/* =========================================================================
   NAVIGATION
   ========================================================================= */
function showPanel(name){
  $all('.panel').forEach(p=>p.classList.remove('active'));
  $('#panel-'+name).classList.add('active');
  $all('.tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===name));
}

/* =========================================================================
   ADD / EDIT SHEET
   ========================================================================= */
function fieldsHtmlFor(kind, existing){
  if(kind === 'alarm'){
    const timeVal = existing ? existing.time : nextRoundHour();
    const days = existing ? existing.days : 'daily';
    const dayLabels = ['S','M','T','W','T','F','S'];
    const dayChips = dayLabels.map((d,i)=>{
      const active = days === 'daily' || (Array.isArray(days) && days.includes(i));
      return `<div class="chip${active?' selected':''}" data-day="${i}">${d}</div>`;
    }).join('');
    const tone = existing ? (existing.tone || 'chime') : 'chime';
    const toneChips = TONES.map(([key,label])=>
      `<div class="chip${tone===key?' selected':''}" data-chip data-tone="${key}">${label}</div>`).join('');
    return `
      <div class="field-label">Label</div>
      <div class="input-row"><input type="text" id="alarm-label" placeholder="e.g. Metformin" value="${existing?escapeHtml(existing.label):''}"></div>
      <div class="field-label">Time</div>
      <div class="input-row"><input type="time" id="alarm-time" value="${timeVal}"></div>
      <div class="field-label">Repeat on</div>
      <div class="chips" id="alarm-days">${dayChips}</div>
      <div class="field-label">Alarm tone <span style="text-transform:none;font-weight:400;">(tap to preview)</span></div>
      <div class="chips" id="alarm-tone-chips">${toneChips}</div>`;
  }

  if(kind === 'new-metric'){
    const colorClass = existing ? existing.colorClass : METRIC_COLORS[0][0];
    const colorChips = METRIC_COLORS.map(([key,label,cssVar])=>
      `<div class="chip${colorClass===key?' selected':''}" data-chip data-color="${key}"><span class="color-dot" style="background:var(${cssVar});"></span>${label}</div>`).join('');
    const suggestions = !existing ? `
      <div class="field-label">Quick start</div>
      <div class="chips" id="metric-suggestion-chips">${METRIC_SUGGESTIONS.map((s,i)=>
        `<div class="chip" data-suggest="${i}">${escapeHtml(s.name)}</div>`).join('')}</div>` : '';
    return `
      ${suggestions}
      <div class="field-label">Name</div>
      <div class="input-row"><input type="text" id="metric-name" placeholder="e.g. Serum creatinine" value="${existing?escapeHtml(existing.name):''}"></div>
      <div class="field-label">Unit</div>
      <div class="input-row"><input type="text" id="metric-unit" placeholder="e.g. mg/dL" value="${existing?escapeHtml(existing.unit):''}"></div>
      <div class="field-label">Color</div>
      <div class="chips" id="metric-color-chips">${colorChips}</div>`;
  }

  const timeVal = existing ? toTimeInputValue(existing.ts) : toTimeInputValue(Date.now());
  const dateVal = existing ? toDateInputValue(existing.ts) : toDateInputValue(Date.now());
  const timeField = `
      <div class="field-label">When <span style="text-transform:none;font-weight:400;">(any past date works)</span></div>
      <div class="when-row">
        <div class="input-row"><input type="date" id="entry-date" value="${dateVal}" max="${toDateInputValue(Date.now())}"></div>
        <div class="input-row"><input type="time" id="entry-time" value="${timeVal}"></div>
      </div>`;

  if(kind === 'bp'){
    return `
      <div class="field-label">Systolic</div>
      <div class="input-row"><input type="number" id="bp-sys" placeholder="120" inputmode="numeric" value="${existing?existing.systolic:''}"><span class="unit">mmHg</span></div>
      <div class="field-label">Diastolic</div>
      <div class="input-row"><input type="number" id="bp-dia" placeholder="80" inputmode="numeric" value="${existing?existing.diastolic:''}"><span class="unit">mmHg</span></div>
      <div class="field-label">Pulse <span style="text-transform:none;font-weight:400;">(optional)</span></div>
      <div class="input-row"><input type="number" id="bp-pulse" placeholder="72" inputmode="numeric" value="${existing&&existing.pulse?existing.pulse:''}"><span class="unit">bpm</span></div>
      ${timeField}`;
  }
     if(kind === 'sugar'){
    return `
      <div class="field-label">Glucose</div>
      <div class="input-row"><input type="number" id="sugar-val" placeholder="100" inputmode="numeric" value="${existing?existing.value:''}"><span class="unit">mg/dL</span></div>
      <div class="field-label">When (meal)</div>
      <div class="chips" id="sugar-chips">${SUGAR_CONTEXTS.map(([k,label])=>
        `<div class="chip${(existing?existing.context===k:k==='fasting')?' selected':''}" data-chip>${label}</div>`).join('')}</div>
      ${timeField}`;
  }

  if(kind === 'liquid' || kind === 'urine'){
    const defaultAmt = existing ? existing.amount : (kind==='liquid'?250:200);
    const drinkField = kind === 'liquid' ? `
      <div class="field-label">What did you drink? <span style="text-transform:none;font-weight:400;">(optional)</span></div>
      <div class="chips" id="liquid-type-chips">${DRINK_TYPES.map(d=>
        `<div class="chip${(existing?existing.drink===d:d==='Water')?' selected':''}" data-chip>${d}</div>`).join('')}</div>` : '';
    return `
      <div class="field-label">Quick add</div>
      <div class="chips" id="chip-row">${PRESET_AMOUNTS.map(amt=>
        `<div class="chip${amt===defaultAmt?' selected':''}" data-chip>${amt} mL</div>`).join('')}</div>
      <div class="field-label">Custom amount</div>
      <div class="input-row"><input type="number" id="custom-amt" value="${defaultAmt}" inputmode="numeric"><span class="unit">mL</span></div>
      ${drinkField}
      ${timeField}`;
  }

  const meta = getMetricMeta(kind) || {unit:''};
  return `
    <div class="field-label">Value</div>
    <div class="input-row"><input type="number" step="0.01" id="metric-val" placeholder="0" inputmode="decimal" value="${existing?existing.value:''}"><span class="unit">${escapeHtml(meta.unit)}</span></div>
    ${timeField}`;
}
function nextRoundHour(){
  const d = new Date(); d.setMinutes(0,0,0); d.setHours(d.getHours()+1);
  return pad2(d.getHours())+':00';
}

function openSheet(kind, editId){
  currentSheetKind = kind;
  currentEditId = editId || null;
  const isAlarm = kind === 'alarm';
  const isNewMetric = kind === 'new-metric';
  const isEdit = !!currentEditId;

  let existing = null;
  if(isEdit){
    existing = isAlarm ? DB.getAlarms().find(a=>a.id===currentEditId)
      : isNewMetric ? DB.getCustomMetrics().find(m=>m.id===currentEditId)
      : DB.getEntries().find(e=>e.id===currentEditId);
  }

  const meta = isNewMetric ? null : getMetricMeta(kind);
  $('#sheet-title').textContent = isAlarm
    ? (isEdit ? 'Edit alarm' : 'New alarm')
    : isNewMetric
      ? (isEdit ? 'Edit health parameter' : 'New health parameter')
      : (isEdit ? `Edit ${meta.sheetNoun}` : `Log ${meta.sheetNoun}`);
  $('#sheet-sub').textContent = isAlarm ? 'Repeats on the days you choose'
    : isNewMetric ? 'Shows up as its own card on Home and Trends'
    : ('Now · ' + formatTime(Date.now()));
  $('#sheet-fields').innerHTML = fieldsHtmlFor(kind, existing);

  const noteLabel = $('#note-field-label'), noteInput = $('#sheet-note');
  if(isAlarm || isNewMetric){
    noteLabel.style.display = 'none'; noteInput.style.display = 'none';
  } else {
    noteLabel.style.display = ''; noteInput.style.display = '';
    noteInput.value = (isEdit && existing && existing.note) ? existing.note : '';
  }

  $('#sheet-delete-btn').style.display = isEdit ? '' : 'none';
  $('#sheet-save-btn').textContent = isAlarm ? (isEdit ? 'Save alarm' : 'Add alarm') : 'Done';

  attachCustomAmountSync();

  $('#scrim').classList.add('show');
  $('#sheet').classList.add('show');
}
function closeSheet(){
  $('#scrim').classList.remove('show');
  $('#sheet').classList.remove('show');
  currentSheetKind = null;
  currentEditId = null;
}
function attachCustomAmountSync(){
  const customInput = $('#custom-amt');
  if(!customInput) return;
  customInput.addEventListener('input', () => {
    $all('#chip-row .chip').forEach(c=>c.classList.remove('selected'));
  });
}

function wireSheetFieldsDelegation(){
  $('#sheet-fields').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if(!chip) return;

    if(chip.dataset.day !== undefined){
      chip.classList.toggle('selected');
      return;
    }

    if(chip.dataset.suggest !== undefined){
      const s = METRIC_SUGGESTIONS[parseInt(chip.dataset.suggest, 10)];
      if(s){
        $('#metric-name').value = s.name;
        $('#metric-unit').value = s.unit;
        const colorChip = $(`#metric-color-chips .chip[data-color="${s.colorClass}"]`);
        if(colorChip){
          $all('.chip', colorChip.parentElement).forEach(c=>c.classList.remove('selected'));
          colorChip.classList.add('selected');
        }
      }
      return;
    }

    const group = chip.parentElement;
    $all('.chip', group).forEach(c=>c.classList.remove('selected'));
    chip.classList.add('selected');

    if(group.id === 'chip-row'){
      const amt = parseInt(chip.textContent, 10);
      const customInput = $('#custom-amt');
      if(customInput && !isNaN(amt)) customInput.value = amt;
    }
    if(group.id === 'alarm-tone-chips'){
      playTone(chip.dataset.tone);
    }
  });
}

function saveEntry(){
  if(currentSheetKind === 'alarm'){ saveAlarmFromSheet(); return; }
  if(currentSheetKind === 'new-metric'){ saveMetricFromSheet(); return; }

  const note = $('#sheet-note').value.trim();
  const dateInput = $('#entry-date');
  const timeInput = $('#entry-time');
  const existing = currentEditId ? DB.getEntries().find(e=>e.id===currentEditId) : null;
  const baseTs = existing ? existing.ts : Date.now();
  let ts = baseTs;
  if(dateInput && dateInput.value) ts = combineDateTime(dateInput.value, timeInput ? timeInput.value : '', baseTs);
  else if(timeInput && timeInput.value) ts = combineWithTime(baseTs, timeInput.value);

  let entry = { id: currentEditId || genId(), type: currentSheetKind, ts, note, updatedAt: Date.now() };

  if(currentSheetKind === 'liquid' || currentSheetKind === 'urine'){
    const amt = parseInt($('#custom-amt').value, 10);
    if(!amt || amt <= 0){ flashSheetError('Enter an amount'); return; }
    entry.amount = amt;
    if(currentSheetKind === 'liquid'){
      const dchip = $('#liquid-type-chips .chip.selected');
      entry.drink = dchip ? dchip.textContent : '';
    }
  } else if(currentSheetKind === 'bp'){
    const sys = parseInt($('#bp-sys').value, 10);
    const dia = parseInt($('#bp-dia').value, 10);
    const pulseVal = $('#bp-pulse').value;
    if(!sys || !dia){ flashSheetError('Enter systolic and diastolic'); return; }
    entry.systolic = sys; entry.diastolic = dia; entry.pulse = pulseVal ? parseInt(pulseVal,10) : null;
  } else if(currentSheetKind === 'sugar'){
    const val = parseInt($('#sugar-val').value, 10);
    if(!val){ flashSheetError('Enter a glucose value'); return; }
    entry.value = val;
    const cchip = $('#sugar-chips .chip.selected');
    entry.context = cchip ? sugarKeyFromLabel(cchip.textContent) : 'fasting';
  } else {
    const val = parseFloat($('#metric-val').value);
    if(isNaN(val)){ flashSheetError('Enter a value'); return; }
    entry.value = val;
  }

  let entries = DB.getEntries();
  const idx = entries.findIndex(e=>e.id===entry.id);
  if(idx >= 0) entries[idx] = entry; else entries.push(entry);
  DB.saveEntries(entries);

  if(window.VitalsDrive) window.VitalsDrive.queueUpsert(entry);

  closeSheet();
  renderAll();
}
function flashSheetError(msg){
  const sub = $('#sheet-sub');
  const original = sub.textContent;
  sub.textContent = msg;
  sub.style.color = 'var(--danger)';
  setTimeout(()=>{ sub.textContent = original; sub.style.color = ''; }, 1600);
}

function saveAlarmFromSheet(){
  const label = $('#alarm-label').value.trim() || 'Reminder';
  const time = $('#alarm-time').value;
  if(!time){ flashSheetError('Pick a time'); return; }
  const dayChips = $all('#alarm-days .chip');
  const selectedDays = dayChips.filter(c=>c.classList.contains('selected')).map(c=>parseInt(c.dataset.day,10));
  const days = selectedDays.length === 7 ? 'daily' : selectedDays;
  const toneChip = $('#alarm-tone-chips .chip.selected');
  const tone = toneChip ? toneChip.dataset.tone : 'chime';

  let alarms = DB.getAlarms();
  const idx = alarms.findIndex(a=>a.id===currentEditId);
  const alarm = { id: currentEditId || genId(), label, time, days, tone, enabled: idx>=0 ? alarms[idx].enabled : true, updatedAt: Date.now() };
  if(idx >= 0) alarms[idx] = alarm; else alarms.push(alarm);
  DB.saveAlarms(alarms);

  if(window.VitalsDrive && window.VitalsDrive.queueAlarmUpsert) window.VitalsDrive.queueAlarmUpsert(alarm);

  closeSheet();
  renderAlarmsList();
  renderHomeAlarmsPreview();
  scheduleAllAlarms();
}

function saveMetricFromSheet(){
  const name = $('#metric-name').value.trim();
  const unit = $('#metric-unit').value.trim();

  if(!name){
    flashSheetError('Give it a name');
    return;
  }

  if(!unit){
    flashSheetError('Give it a unit, e.g. mg/dL');
    return;
  }

  const colorChip =
    $('#metric-color-chips .chip.selected');

  const colorClass =
    colorChip
      ? colorChip.dataset.color
      : METRIC_COLORS[0][0];

  let metrics =
    DB.getCustomMetrics();

  /*
   * Prevent duplicate metric names.
   *
   * Serum Creatinine, serum creatinine and
   * SERUM CREATININE are treated as the same metric.
   */
  const normalizedName =
    name
      .trim()
      .replace(/\s+/g,' ')
      .toLowerCase();

  const duplicateIndex =
    metrics.findIndex(m =>
      m.id !== currentEditId &&
      String(m.name || '')
        .trim()
        .replace(/\s+/g,' ')
        .toLowerCase() === normalizedName
    );

  if(duplicateIndex >= 0){
    flashSheetError(
      'A parameter with this name already exists'
    );
    return;
  }

  const existing =
    currentEditId
      ? metrics.find(m => m.id === currentEditId)
      : null;

  const metric = {
    id:
      currentEditId || genId(),

    name,

    unit,

    colorClass,

    updatedAt:
      Date.now()
  };

  const idx =
    metrics.findIndex(
      m => m.id === metric.id
    );

  if(idx >= 0){
    metrics[idx] = metric;
  }else{
    metrics.push(metric);
  }

  DB.saveCustomMetrics(metrics);

  /*
   * Push this metric definition (e.g. a newly created "Weight") to Drive
   * right away rather than waiting for the next periodic full sync — this
   * is what makes a metric created on one device show up promptly on the
   * other, instead of only after up to a minute's delay.
   */
  if(window.VitalsDrive && window.VitalsDrive.queueMetricUpsert){
    window.VitalsDrive.queueMetricUpsert(metric);
  }

  closeSheet();

  renderAll();

  renderSettingsPanel();

  /*
   * Tell Drive that the local dataset changed.
   */
  window.dispatchEvent(
    new CustomEvent(
      'vitals-local-data-changed'
    )
  );
}

function deleteCurrent(){
  if(!currentEditId){ closeSheet(); return; }
  if(currentSheetKind === 'alarm'){
    const id = currentEditId;
    DB.saveAlarms(DB.getAlarms().filter(a=>a.id!==id));
    if(window.VitalsDrive && window.VitalsDrive.queueAlarmDelete) window.VitalsDrive.queueAlarmDelete(id, Date.now());
    renderAlarmsList();
    renderHomeAlarmsPreview();
    scheduleAllAlarms();
  } else if(currentSheetKind === 'new-metric'){
    const id = currentEditId;
    DB.saveCustomMetrics(DB.getCustomMetrics().filter(m=>m.id!==id));
    if(window.VitalsDrive && window.VitalsDrive.queueMetricDelete) window.VitalsDrive.queueMetricDelete(id, Date.now());
    renderAll();
    renderSettingsPanel();
  } else {
    const id = currentEditId;
    DB.saveEntries(DB.getEntries().filter(e=>e.id!==id));
    if(window.VitalsDrive) window.VitalsDrive.queueDelete(id);
    renderAll();
  }
  closeSheet();
}

/* =========================================================================
   DETAIL DRILL-DOWN
   ========================================================================= */
function xPositionsByTime(entries){
  const n = entries.length;
  if(n <= 1) return [150];
  const pad = 20;
  const mins = entries.map(e=>{ const d = new Date(e.ts); return d.getHours()*60 + d.getMinutes(); });
  const lo = Math.min(...mins), hi = Math.max(...mins);
  const span = (hi - lo) || 1;
  return mins.map(m => pad + ((m-lo)/span) * (300 - pad*2));
}
function emptyChartSvg(msg){
  return `<text x="150" y="60" text-anchor="middle" fill="var(--text-dim)" font-size="13" font-family="var(--font-body)">${escapeHtml(msg)}</text>`;
}
function buildBarChart(entries, colorVar, emptyMsg){
  if(!entries.length) return emptyChartSvg(emptyMsg || 'No entries logged today');
  const xs = xPositionsByTime(entries);
  const max = Math.max(...entries.map(e=>e.amount), 1);
  const baseline = 90, top = 8;
  const minGap = xs.length > 1 ? Math.min(...xs.slice(1).map((x,i)=>x-xs[i])) : 300;
  const w = Math.max(10, Math.min(34, minGap*0.6));
  let out = '';
  entries.forEach((e,i)=>{
    const h = Math.max(6, (e.amount/max) * (baseline-top));
    const x = xs[i] - w/2, y = baseline - h;
    out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="6" fill="var(${colorVar})"/>`;
    out += `<text x="${xs[i].toFixed(1)}" y="106" class="time-label" text-anchor="middle">${formatTime(e.ts).replace(' ','').toLowerCase()}</text>`;
  });
  return out;
}
function pointsToPath(points){
  return 'M' + points.map(p => p[0].toFixed(1)+','+p[1].toFixed(1)).join(' L');
}
function buildBpChart(entries, colorVar, emptyMsg){
  colorVar = colorVar || '--red';
  if(!entries.length) return emptyChartSvg(emptyMsg || 'No readings logged today');
  const xs = xPositionsByTime(entries);
  const sysVals = entries.map(e=>e.systolic), diaVals = entries.map(e=>e.diastolic);
  const all = sysVals.concat(diaVals);
  const lo = Math.min(...all) - 5, hi = Math.max(...all) + 5;
  const scale = v => 90 - ((v-lo)/((hi-lo)||1)) * 78;
  const sysPts = xs.map((x,i)=>[x, scale(sysVals[i])]);
  const diaPts = xs.map((x,i)=>[x, scale(diaVals[i])]);
  let out = '';
  if(entries.length > 1){
    out += `<path d="${pointsToPath(sysPts)}" fill="none" stroke="var(${colorVar})" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    out += `<path d="${pointsToPath(diaPts)}" fill="none" stroke="var(${colorVar})" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1 6" opacity="0.55"/>`;
  }
  sysPts.forEach(p=> out += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4.5" fill="var(${colorVar})"/>`);
  diaPts.forEach(p=> out += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4.5" fill="var(${colorVar})" opacity="0.55"/>`);
  entries.forEach((e,i)=> out += `<text x="${xs[i].toFixed(1)}" y="106" class="time-label" text-anchor="middle">${formatTime(e.ts).replace(' ','').toLowerCase()}</text>`);
  return out;
}
function buildSugarChart(entries, colorVar, emptyMsg){
  colorVar = colorVar || '--green';
  if(!entries.length) return emptyChartSvg(emptyMsg || 'No readings logged today');
  const xs = xPositionsByTime(entries);
  const vals = entries.map(e=>e.value);
  const lo = Math.min(...vals) - 10, hi = Math.max(...vals) + 10;
  const scale = v => 90 - ((v-lo)/((hi-lo)||1)) * 78;
  const pts = xs.map((x,i)=>[x, scale(vals[i])]);
  let out = '';
  if(entries.length > 1) out += `<path d="${pointsToPath(pts)}" fill="none" stroke="var(${colorVar})" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  pts.forEach(p=> out += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4.5" fill="var(${colorVar})"/>`);
  entries.forEach((e,i)=> out += `<text x="${xs[i].toFixed(1)}" y="106" class="time-label" text-anchor="middle">${formatTime(e.ts).replace(' ','').toLowerCase()}</text>`);
  return out;
}

function detailEntryRow(type, e){
  const meta = getMetricMeta(type);
  let amt, note;
  if(type==='liquid' || type==='urine'){ amt = `${e.amount} mL`; note = [e.drink, e.note].filter(Boolean).join(' · '); }
  else if(type==='bp'){ amt = `${e.systolic} / ${e.diastolic} mmHg`; note = [e.pulse?`Pulse ${e.pulse}`:'', e.note].filter(Boolean).join(' · '); }
  else if(type==='sugar'){ amt = `${e.value} mg/dL`; note = [sugarContextLabel(e.context), e.note].filter(Boolean).join(' · '); }
  else { amt = `${e.value} ${meta ? meta.unit : ''}`.trim(); note = e.note || ''; }
  return `
    <div class="detail-entry" data-entry-id="${e.id}">
      <div class="dot" style="background:var(${meta.colorVar});"></div>
      <div class="info"><div class="amt">${escapeHtml(amt)}</div>${note?`<div class="note">${escapeHtml(note)}</div>`:''}</div>
      <div class="time">${formatTime(e.ts)}</div>
    </div>`;
}

function dayNavLabel(ts){
  if(isToday(ts)) return 'Today';
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1);
  if(sameDay(ts, yesterday)) return 'Yesterday';
  return new Date(ts).toLocaleDateString([], {weekday:'short', day:'numeric', month:'short'});
}
  function openDetail(type, dateTs){
  currentDetailType = type;
  currentDetailDate = startOfDay(dateTs != null ? dateTs : Date.now());
  const meta = getMetricMeta(type);
  if(!meta) return;
  const onToday = isToday(currentDetailDate);
  const dayDate = new Date(currentDetailDate);
  const dayEntries = DB.getEntries().filter(e=>e.type===type && sameDay(e.ts, dayDate)).sort((a,b)=>a.ts-b.ts);

  $('#detail-cat').textContent = meta.label;
  $('#detail-val').textContent = detailHeaderValue(type, dayEntries, meta, onToday);
  $('#detail-day-label').textContent = dayNavLabel(currentDetailDate);
  const dateInput = $('#detail-date-input');
  dateInput.max = toDateInputValue(Date.now());
  dateInput.value = toDateInputValue(currentDetailDate);
  $('#detail-next-day').disabled = onToday;
  $('#detail-list-title').textContent = onToday ? "Today's entries" : `${dayNavLabel(currentDetailDate)}'s entries`;

  const emptyMsg = onToday ? undefined : 'No entries logged on this day';
  let chartSvg;
  if(type==='liquid' || type==='urine') chartSvg = buildBarChart(dayEntries, meta.colorVar, emptyMsg);
  else if(type==='bp') chartSvg = buildBpChart(dayEntries, meta.colorVar, emptyMsg);
  else chartSvg = buildSugarChart(dayEntries, meta.colorVar, emptyMsg);
  $('#detail-chart').innerHTML = chartSvg;

  $('#detail-entries').innerHTML = dayEntries.length
    ? dayEntries.slice().reverse().map(e=>detailEntryRow(type,e)).join('')
    : `<p class="empty-hint">No entries logged ${onToday ? 'today' : 'on this day'}.</p>`;

  $('#detail').classList.add('show');
}
function detailHeaderValue(type, dayEntries, meta, onToday){
  if(!dayEntries.length) return onToday ? 'No entries today' : 'No entries';
  if(type==='liquid' || type==='urine'){
    const total = dayEntries.reduce((s,e)=>s+e.amount,0);
    return `${total.toLocaleString()} mL` + (onToday ? ' today' : '');
  }
  const last = dayEntries[dayEntries.length-1];
  if(type==='bp') return `${last.systolic} / ${last.diastolic} mmHg` + (last.pulse?` · pulse ${last.pulse}`:'');
  if(type==='sugar') return `${last.value} mg/dL · ${sugarContextLabel(last.context)}`;
  return `${last.value} ${meta ? meta.unit : ''}`.trim();
}
function shiftDetailDay(deltaDays){
  const d = new Date(currentDetailDate);
  d.setDate(d.getDate() + deltaDays);
  if(startOfDay(d.getTime()) > startOfDay(Date.now())) return;
  openDetail(currentDetailType, d.getTime());
}
function closeDetail(){
  $('#detail').classList.remove('show');
  currentDetailType = null;
  currentDetailDate = null;
}

/* =========================================================================
   TRENDS
   ========================================================================= */
function buildSparkline(values, colorVar){
  const n = values.length;
  const presentIdx = [];
  values.forEach((v,i)=>{ if(v !== null && v !== undefined) presentIdx.push(i); });
  if(!presentIdx.length) return {svg: emptyChartSvg64('No data yet'), current:'—'};
  const present = presentIdx.map(i=>values[i]);
  const xs = n<=1 ? presentIdx.map(()=>150) : presentIdx.map(i => i*(300/(n-1)));
  const min = Math.min(...present), max = Math.max(...present);
  const range = (max-min) || 1;
  const ys = present.map(v => 56 - ((v-min)/range)*48 - 4);
  const pts = xs.map((x,i)=> [x, ys[i]]);
  let svg = '';
  if(pts.length > 1){
    const pathD = pointsToPath(pts);
    const areaD = pathD + ` L${xs[xs.length-1].toFixed(1)},64 L${xs[0].toFixed(1)},64 Z`;
    svg += `<path d="${pathD}" fill="none" stroke="var(${colorVar})" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    svg += `<path d="${areaD}" fill="var(${colorVar})" opacity="0.08"/>`;
  }
  pts.forEach(p=> svg += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="var(${colorVar})"/>`);
  return {svg, current: present[present.length-1]};
}
function emptyChartSvg64(msg){
  return `<text x="150" y="34" text-anchor="middle" fill="var(--text-dim)" font-size="12" font-family="var(--font-body)">${escapeHtml(msg)}</text>`;
}

function dailySeriesFor(type, dates, list){
  if(type==='liquid' || type==='urine'){
    return dates.map(d => list.filter(e=>sameDay(e.ts,d)).reduce((s,e)=>s+e.amount,0));
  }
  if(type==='bp'){
    return dates.map(d=>{
      const day = list.filter(e=>sameDay(e.ts,d));
      return day.length ? Math.round(avg(day.map(e=>e.systolic))) : null;
    });
  }
  return dates.map(d=>{
    const day = list.filter(e=>sameDay(e.ts,d));
    return day.length ? Math.round(avg(day.map(e=>e.value))) : null;
  });
}
function trendCardHtml(type, dates, allEntries){
  const meta = getMetricMeta(type);
  if(!meta) return '';
  const list = allEntries.filter(e=>e.type===type);
  const isVolume = (type==='liquid' || type==='urine');
  const daily = dailySeriesFor(type, dates, list);
  const spark = buildSparkline(isVolume ? daily.map(v=>v||null) : daily, meta.colorVar);
  const present = isVolume ? daily.filter(v=>v>0) : daily.filter(v=>v!==null);
  const latest = list.slice().sort((a,b)=>b.ts-a.ts)[0];
  const dim = 'font-size:13px;color:var(--text-dim);font-family:var(--font-body);';

  let rangeText, currentHtml;
  if(isVolume){
    const today = list.filter(e=>isToday(e.ts)).reduce((s,e)=>s+e.amount,0);
    rangeText = present.length ? `${currentTrendRange}d avg ${Math.round(avg(present)).toLocaleString()} mL` : 'No data yet';
    currentHtml = `${today.toLocaleString()}<span style="${dim}"> mL today</span>`;
  } else if(type==='bp'){
    rangeText = present.length ? `${currentTrendRange}d avg sys ${Math.round(avg(present))}` : 'No data yet';
    currentHtml = latest ? `${latest.systolic}<span style="${dim}"> / ${latest.diastolic} mmHg</span>` : '—';
  } else if(type==='sugar'){
    rangeText = present.length ? `${currentTrendRange}d avg ${Math.round(avg(present))} mg/dL` : 'No data yet';
    currentHtml = latest ? `${latest.value}<span style="${dim}"> mg/dL · ${sugarContextLabel(latest.context)}</span>` : '—';
  } else {
    rangeText = present.length ? `${currentTrendRange}d avg ${Math.round(avg(present))} ${escapeHtml(meta.unit)}` : 'No data yet';
    currentHtml = latest ? `${latest.value}<span style="${dim}"> ${escapeHtml(meta.unit)}</span>` : '—';
  }

  return `
    <div class="trend-card">
      <div class="trend-head">
        <span class="trend-name" style="color:var(${meta.colorVar});">${escapeHtml(meta.label)}</span>
        <span class="trend-range">${rangeText}</span>
      </div>
      <div class="trend-current">${currentHtml}</div>
      <svg class="spark" viewBox="0 0 300 64" preserveAspectRatio="none">${spark.svg}</svg>
    </div>`;
}
function renderTrends(){
  const dates = lastNDates(currentTrendRange);
  const entries = DB.getEntries();
  $('#trend-range-toggle').textContent = `Last ${currentTrendRange} days`;
  $('#trend-cards').innerHTML = allMetricTypes().map(type => trendCardHtml(type, dates, entries)).join('');
}

/* =========================================================================
   ALARMS + NOTIFICATIONS
   ========================================================================= */
function renderAlarmsList(){
  const alarms = DB.getAlarms();
  const box = $('#alarms-list');
  if(!alarms.length){
    box.innerHTML = '<p class="empty-hint">No alarms yet.</p>';
  } else {
    box.innerHTML = alarms.map(a=>`
      <div class="alarm-row">
        <div class="switch${a.enabled?' on':''}" data-toggle-alarm="${a.id}"><div class="switch-knob"></div></div>
        <div class="alarm-info" data-edit-alarm="${a.id}"><div class="alarm-label">${escapeHtml(a.label)}</div><div class="alarm-sub">${alarmRepeatText(a)}</div></div>
        <div class="alarm-time" data-edit-alarm="${a.id}">${formatAlarmTime(a.time)}</div>
      </div>`).join('');
  }
  const hint = $('#notif-hint');
  if(!('Notification' in window)){
    hint.textContent = 'This browser doesn’t support notifications — alarms will still show here when you open the app.';
  } else if(Notification.permission === 'denied'){
    hint.textContent = 'Notifications are blocked for this app in your browser settings — alarms will still show in this list, but won’t pop up a notification.';
  } else {
    hint.textContent = 'Alarms notify you while Vitals is installed and has been opened recently. For best results, keep it installed to your home screen and avoid force-closing it.';
  }
}
function matchesToday(alarm, date){
  if(alarm.days === 'daily') return true;
  return Array.isArray(alarm.days) && alarm.days.includes(date.getDay());
}
function todayKey(){ const d=new Date(); return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
function isFiredToday(alarm){
  const log = DB.getFiredLog();
  return !!log[alarm.id+'|'+todayKey()];
}
function markFired(alarm){
  const log = DB.getFiredLog();
  log[alarm.id+'|'+todayKey()] = true;
  const keep = {};
  Object.keys(log).forEach(k=>{ if(k.endsWith(todayKey())) keep[k]=true; });
  keep[alarm.id+'|'+todayKey()] = true;
  DB.saveFiredLog(keep);
}
function playTone(name){
  if(!name || name === 'silent') return;
  try{
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if(!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const notesByTone = { chime: [880, 1174.66], bell: [1318.51], beep: [1000] };
    const freqs = notesByTone[name] || notesByTone.chime;
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = name === 'beep' ? 'square' : 'sine';
      osc.frequency.value = f;
      const start = now + i*0.18;
      const dur = name === 'bell' ? 1.1 : 0.22;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start+0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start+dur);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(start); osc.stop(start+dur+0.05);
    });
    setTimeout(()=>ctx.close().catch(()=>{}), 1600);
  } catch(e){ console.warn('Vitals: tone playback failed', e); }
}
function fireAlarm(alarm){
  markFired(alarm);
  const tone = alarm.tone || 'chime';

  if(document.visibilityState === 'visible') playTone(tone);

  if(!('Notification' in window) || Notification.permission !== 'granted') return;
  const show = (reg) => {
    const opts = {
      body: 'Time to log this in Vitals.', tag: 'vitals-alarm-'+alarm.id,
      icon:'icons/icon-192.png', badge:'icons/icon-192.png', silent: tone === 'silent'
    };
    if(reg && reg.showNotification) reg.showNotification(alarm.label, opts);
    else new Notification(alarm.label, opts);
  };
  if(navigator.serviceWorker && navigator.serviceWorker.ready){
    navigator.serviceWorker.ready.then(show).catch(()=>show(null));
  } else show(null);
}
function checkAlarmsTick(){
  const now = new Date();
  DB.getAlarms().filter(a=>a.enabled).forEach(a=>{
    if(!matchesToday(a, now)) return;
    if(isFiredToday(a)) return;
    const [h,m] = a.time.split(':').map(Number);
    const sched = new Date(now); sched.setHours(h,m,0,0);
    const diffMs = now - sched;
    if(diffMs >= 0 && diffMs < 15*60*1000) fireAlarm(a);
  });
}
function scheduleAllAlarms(){
  if(alarmCheckInterval) clearInterval(alarmCheckInterval);
  checkAlarmsTick();
  alarmCheckInterval = setInterval(checkAlarmsTick, 20000);
}
async function ensureNotificationPermission(){
  if(!('Notification' in window)) return 'unsupported';
  if(Notification.permission === 'granted') return 'granted';
  if(Notification.permission === 'denied') return 'denied';
  try{ return await Notification.requestPermission(); }
  catch(e){ return 'denied'; }
}

/* =========================================================================
   PIN LOCK + BIOMETRIC
   ========================================================================= */
async function sha256Hex(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function randomHex(len){
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function updatePinDots(count, errorState){
  $all('#dots .dot').forEach((dot,i)=>{
    dot.classList.toggle('filled', i < count);
    dot.classList.toggle('err', !!errorState);
  });
}
function startLockFlow(){
  const settings = DB.getSettings();
  pinBuffer = ''; pinFirstEntry = '';
  updatePinDots(0,false);
  if(!settings.pinHash){
    pendingUnlockAction = 'setup-first';
    $('#lock-sub').textContent = 'Create a passcode';
  } else {
    pendingUnlockAction = 'unlock';
    $('#lock-sub').textContent = 'Use fingerprint or enter your passcode';
  }
  $('#lock').classList.remove('hidden');
  updateBiometricKeyVisibility();
  if(pendingUnlockAction === 'unlock' && settings.bioEnabled && settings.bioCredId && window.PublicKeyCredential && navigator.credentials){
    setTimeout(()=>tryBiometricUnlock(true), 300);
  }
}
function updateBiometricKeyVisibility(){
  const settings = DB.getSettings();
  const show = pendingUnlockAction === 'unlock' && settings.bioEnabled && settings.bioCredId;
  $('#biometric-key').style.visibility = show ? 'visible' : 'hidden';
}
function onKeypadPress(k){
  if(pinBuffer.length >= 4) return;
  pinBuffer += k;
  updatePinDots(pinBuffer.length, false);
  if(pinBuffer.length === 4) handlePinComplete();
}
function onBackspace(){
  pinBuffer = pinBuffer.slice(0,-1);
  updatePinDots(pinBuffer.length, false);
}
async function handlePinComplete(){
  const settings = DB.getSettings();
  if(pendingUnlockAction === 'setup-first'){
    pinFirstEntry = pinBuffer;
    pinBuffer = '';
    pendingUnlockAction = 'setup-confirm';
    $('#lock-sub').textContent = 'Confirm your passcode';
    setTimeout(()=>updatePinDots(0,false), 150);
    return;
  }
  if(pendingUnlockAction === 'setup-confirm'){
    if(pinBuffer !== pinFirstEntry){
      $('#lock-sub').textContent = "Passcodes didn't match — try again";
      updatePinDots(4, true);
      setTimeout(()=>{ pinBuffer=''; pinFirstEntry=''; pendingUnlockAction='setup-first'; $('#lock-sub').textContent='Create a passcode'; updatePinDots(0,false); }, 900);
      return;
    }
    const salt = randomHex(16);
    const hash = await sha256Hex(pinBuffer + salt);
    const settings2 = DB.getSettings();
    settings2.pinHash = hash; settings2.pinSalt = salt; settings2.onboarded = true;
    DB.saveSettings(settings2);
    unlockApp();
    return;
  }

  const hash = await sha256Hex(pinBuffer + settings.pinSalt);
  if(hash === settings.pinHash){
    unlockApp();
  } else {
    $('#lock-sub').textContent = 'Incorrect passcode — try again';
    updatePinDots(4, true);
    setTimeout(()=>{ pinBuffer=''; updatePinDots(0,false); $('#lock-sub').textContent='Enter your passcode'; }, 700);
  }
}
function unlockApp(){
  $('#lock').classList.add('hidden');
  pinBuffer = ''; pinFirstEntry = '';
  renderSettingsPanel();
}
function lockAppNow(){
  startLockFlow();
}

function b64urlToBytes(b64url){
  const b64 = b64url.replace(/-/g,'+').replace(/_/g,'/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToB64url(bytes){
  let bin = '';
  bytes.forEach(b=> bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function enableBiometric(){
  if(!window.PublicKeyCredential){
    alert("This browser doesn't support Face/Fingerprint unlock.");
    return false;
  }
  try{
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'Vitals' },
        user: { id: userId, name: 'vitals-user', displayName: 'Vitals' },
        pubKeyCredParams: [{alg:-7, type:'public-key'}, {alg:-257, type:'public-key'}],
        authenticatorSelection: { authenticatorAttachment:'platform', userVerification:'required' },
        timeout: 60000
      }
    });
    if(!cred) return false;
    const settings = DB.getSettings();
    settings.bioEnabled = true;
    settings.bioCredId = bytesToB64url(new Uint8Array(cred.rawId));
    DB.saveSettings(settings);
    return true;
  } catch(e){
    console.warn('Vitals: biometric setup failed', e);
    return false;
  }
}
async function tryBiometricUnlock(autoStart = false){
  const settings = DB.getSettings();
  if(!settings.bioEnabled || !settings.bioCredId) return false;
  let timer = null;
  try{
    const controller = new AbortController();
    const timeout = autoStart ? 5000 : 60000;
    timer = setTimeout(()=>controller.abort(), timeout);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ id: b64urlToBytes(settings.bioCredId), type:'public-key' }],
        userVerification: 'required',
        timeout,
        signal: controller.signal
      }
    });
    clearTimeout(timer);
    if(cred){ unlockApp(); return true; }
  } catch(e){
    if(timer) clearTimeout(timer);
    console.log('Vitals: biometric unavailable/cancelled; passcode remains available.');
  }
  return false;
}

/* =========================================================================
   SETTINGS PANEL
   ========================================================================= */
function applyTheme(theme){
  if(theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}
function renderSettingsPanel(){
  const settings = DB.getSettings();
  $('#theme-select').value = settings.theme || 'auto';
  $('#pin-status-sub').textContent = settings.pinHash ? 'Passcode required to open' : 'No passcode set';
  const bioSupported = !!window.PublicKeyCredential;
  $('#bio-toggle').classList.toggle('on', !!settings.bioEnabled);
  $('#bio-status-sub').textContent = !bioSupported ? 'Not supported on this browser'
    : settings.bioEnabled ? 'Enabled' : 'Not set up';

  const driveState = window.VitalsDrive && window.VitalsDrive.getState ? window.VitalsDrive.getState() : null;

  if(window.VitalsDrive && window.VitalsDrive.isConnected()){
    $('#drive-status-label').textContent = 'Connected';
    $('#drive-status-sub').textContent = driveState === 'syncing' ? 'Syncing…' : 'New entries back up automatically';
    $('#drive-connect-btn').textContent = 'Disconnect';
    const url = window.VitalsDrive.getSheetUrl();
    if(url){
      $('#drive-sheet-row').style.display = '';
      $('#drive-sheet-link').href = url;
    }
  } else {
    $('#drive-status-label').textContent = driveState === 'authenticating' ? 'Connecting…' : 'Not connected';
    $('#drive-status-sub').textContent = 'Sign in to back up your log to a Google Sheet';
    $('#drive-connect-btn').textContent = 'Connect';
    $('#drive-sheet-row').style.display = 'none';
  }

  $('#tab-colors-list').innerHTML = allMetricTypes().map(type=>{
    const meta = getMetricMeta(type);
    if(!meta) return '';
    const swatches = ALL_COLORS.map(([key,label,cssVar])=>
      `<button class="swatch${key===meta.colorClass?' selected':''}" data-recolor="${type}" data-color="${key}" style="background:var(${cssVar});" aria-label="${label}"></button>`
    ).join('');
    return `
      <div class="tabcolor-row">
        <div class="settings-label">${escapeHtml(meta.label)}</div>
        <div class="swatch-row">${swatches}</div>
      </div>`;
  }).join('');

  const metrics = DB.getCustomMetrics();
  $('#custom-metrics-list').innerHTML = metrics.length
    ? metrics.map(m=>{
        const meta = getMetricMeta(m.id);
        return `
          <div class="settings-row" data-edit-metric="${m.id}" style="cursor:pointer;">
            <div class="settings-info">
              <div class="settings-label"><span class="color-dot" style="background:var(${meta.colorVar});"></span>${escapeHtml(m.name)}</div>
              <div class="settings-sub">Unit: ${escapeHtml(m.unit)}</div>
            </div>
            <span class="link">Edit</span>
          </div>`;
      }).join('')
    : '<p class="empty-hint">No custom parameters yet — add serum creatinine, eGFR, or anything else you want to track.</p>';
}
function exportCsv(){
  const entries = DB.getEntries().slice().sort((a,b)=>a.ts-b.ts);
  const header = ['Type','Date','Time','Amount (mL)','Drink','Systolic','Diastolic','Pulse','Sugar (mg/dL)','Context','Custom value','Custom unit','Note'];
  const rows = entries.map(e=>{
    const meta = getMetricMeta(e.type) || {label: e.type, unit: ''};
    const isCustom = !TYPE_META[e.type];
    const d = new Date(e.ts);
    const dateStr = d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());
    const timeStr = pad2(d.getHours())+':'+pad2(d.getMinutes());
    return [
      meta.label, dateStr, timeStr,
      (e.type==='liquid'||e.type==='urine') ? e.amount : '',
      e.type==='liquid' ? (e.drink||'') : '',
      e.type==='bp' ? e.systolic : '', e.type==='bp' ? e.diastolic : '', e.type==='bp' ? (e.pulse||'') : '',
      e.type==='sugar' ? e.value : '', e.type==='sugar' ? sugarContextLabel(e.context) : '',
      isCustom ? e.value : '', isCustom ? meta.unit : '',
      e.note||''
    ];
  });
  const csv = [header].concat(rows).map(r => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'vitals-export.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function csvCell(v){
  const s = String(v==null?'':v);
  return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
}

/* =========================================================================
   EVENT WIRING
   ========================================================================= */
function wireEvents(){
  wireSheetFieldsDelegation();

  $all('.key[data-k]').forEach(btn=>{
    btn.addEventListener('click', ()=> onKeypadPress(btn.dataset.k));
  });
  $('#backspace-key').addEventListener('click', onBackspace);
  $('#biometric-key').addEventListener('click', ()=> tryBiometricUnlock(false));

  $('#lock-now-btn').addEventListener('click', lockAppNow);
  $('#settings-btn').addEventListener('click', ()=> showPanel('settings'));

  $all('.tab').forEach(tab=> tab.addEventListener('click', ()=> showPanel(tab.dataset.tab)));

  $('#home-grid').addEventListener('click', (e)=>{
    const openSheetBtn = e.target.closest('[data-open-sheet]');
    if(openSheetBtn){ openSheet(openSheetBtn.dataset.openSheet); return; }
    const openDetailBtn = e.target.closest('[data-open-detail]');
    if(openDetailBtn){ openDetail(openDetailBtn.dataset.openDetail); }
  });

  $all('[data-nav]').forEach(el=> el.addEventListener('click', ()=> showPanel(el.dataset.nav)));

  $('#detail-back').addEventListener('click', closeDetail);
  $('#detail-entries').addEventListener('click', (e)=>{
    const row = e.target.closest('[data-entry-id]');
    if(row) openSheet(currentDetailType, row.dataset.entryId);
  });
  $('#detail-prev-day').addEventListener('click', ()=> shiftDetailDay(-1));
  $('#detail-next-day').addEventListener('click', ()=> shiftDetailDay(1));
  $('#detail-calendar-btn').addEventListener('click', ()=>{
    const input = $('#detail-date-input');
    if(input.showPicker){ try{ input.showPicker(); } catch(e){ input.focus(); } }
    else { input.focus(); input.click(); }
  });
  $('#detail-date-input').addEventListener('change', (e)=>{
    if(!e.target.value) return;
    openDetail(currentDetailType, new Date(e.target.value+'T00:00:00').getTime());
  });

  $('#scrim').addEventListener('click', closeSheet);
  $('#sheet-save-btn').addEventListener('click', saveEntry);
  $('#sheet-delete-btn').addEventListener('click', deleteCurrent);

  $('#trend-range-toggle').addEventListener('click', ()=>{
    currentTrendRange = currentTrendRange === 7 ? 30 : 7;
    renderTrends();
  });

  $('#new-alarm-btn').addEventListener('click', async ()=>{
    const perm = await ensureNotificationPermission();
    if(perm !== 'granted') { }
    openSheet('alarm');
  });
  $('#alarms-list').addEventListener('click', (e)=>{
    const toggle = e.target.closest('[data-toggle-alarm]');
    if(toggle){
      const id = toggle.dataset.toggleAlarm;
      const alarms = DB.getAlarms();
      const a = alarms.find(x=>x.id===id);
      if(a){
        a.enabled = !a.enabled;
        a.updatedAt = Date.now();
        DB.saveAlarms(alarms);
        if(window.VitalsDrive && window.VitalsDrive.queueAlarmUpsert) window.VitalsDrive.queueAlarmUpsert(a);
        renderAlarmsList(); renderHomeAlarmsPreview(); scheduleAllAlarms();
      }
      return;
    }
    const edit = e.target.closest('[data-edit-alarm]');
    if(edit) openSheet('alarm', edit.dataset.editAlarm);
  });

  $('#theme-select').addEventListener('change', (e)=>{
    const settings = DB.getSettings();
    settings.theme = e.target.value;
    DB.saveSettings(settings);
    applyTheme(settings.theme);
  });
  $('#change-pin-btn').addEventListener('click', ()=>{
    const settings = DB.getSettings();
    settings.pinHash = null; settings.pinSalt = null;
    DB.saveSettings(settings);
    startLockFlow();
  });
  $('#bio-toggle').addEventListener('click', async ()=>{
    const settings = DB.getSettings();
    if(settings.bioEnabled){
      settings.bioEnabled = false; settings.bioCredId = null;
      DB.saveSettings(settings);
      renderSettingsPanel();
    } else {
      const ok = await enableBiometric();
      if(ok) renderSettingsPanel();
    }
  });
  $('#drive-connect-btn').addEventListener('click', ()=>{
    if(!window.VitalsDrive){ alert('Drive sync module did not load.'); return; }
    if(window.VitalsDrive.isConnected()){
      window.VitalsDrive.disconnect();
      renderSettingsPanel();
    } else {
      // The ONLY place app.js asks drive.js to authenticate — a direct,
      // explicit tap on this button. Nothing else (refresh, visibility,
      // connectivity change) is allowed to call signIn().
      window.VitalsDrive.signIn();
    }
  });
  // Optional manual "Sync now" control — wired only if index.html defines
  // it, so this stays a no-op on markup that doesn't have it yet. Kept
  // conceptually separate from Connect: this only asks for a data sync,
  // never for authentication.
  const driveSyncBtn = $('#drive-sync-btn');
  if(driveSyncBtn){
    driveSyncBtn.addEventListener('click', ()=>{
      if(!window.VitalsDrive) return;
      window.VitalsDrive.syncNow(true);
    });
  }
  $('#export-btn').addEventListener('click', exportCsv);

  $('#new-metric-btn').addEventListener('click', ()=> openSheet('new-metric'));
  $('#custom-metrics-list').addEventListener('click', (e)=>{
    const row = e.target.closest('[data-edit-metric]');
    if(row) openSheet('new-metric', row.dataset.editMetric);
  });

  $('#tab-colors-list').addEventListener('click', (e)=>{
    const swatch = e.target.closest('[data-recolor]');
    if(swatch) setTabColor(swatch.dataset.recolor, swatch.dataset.color);
  });

  window.addEventListener('vitals-drive-status', renderSettingsPanel);

  window.addEventListener('vitals-drive-data-changed', ()=>{
    renderAll();
    renderSettingsPanel();
    // Alarms may have been added/edited/removed by the other device.
    scheduleAllAlarms();
  });

  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState === 'visible'){
      checkAlarmsTick();
      if(window.VitalsDrive){
        if(window.VitalsDrive.syncNow) window.VitalsDrive.syncNow();
        if(window.VitalsDrive.flushQueue) window.VitalsDrive.flushQueue();
      }
    }
  });

  window.addEventListener('online', ()=>{
    if(window.VitalsDrive){
      if(window.VitalsDrive.syncNow) window.VitalsDrive.syncNow();
      if(window.VitalsDrive.flushQueue) window.VitalsDrive.flushQueue();
    }
  });
}

/* =========================================================================
   INIT
   ========================================================================= */
function init(){
  const settings = DB.getSettings();
  applyTheme(settings.theme || 'auto');

  // Local-only cleanup, before the first render, before Drive is touched
  // at all: merge any duplicate custom-metric definitions already sitting
  // in this device's storage (see dedupeLocalCustomMetrics above).
  dedupeLocalCustomMetrics();

  wireEvents();
  renderAll();
  renderSettingsPanel();
  startLockFlow();
  scheduleAllAlarms();

  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('service-worker.js').catch(e=>console.warn('Vitals: SW registration failed', e));
  }
  if(window.VitalsDrive) window.VitalsDrive.init();
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

'use strict';
/* =========================================================================
   Vitals — app.js
   Offline-first health log: fluid intake, urine output, blood pressure,
   sugar, and a medicine-adherence checklist with recurring reminders.
   All data lives in localStorage
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
  getMedicines(){ return this._get('vitals:medicines', []); },
  saveMedicines(list){ this._set('vitals:medicines', list); },
  getDoseLog(){ return this._get('vitals:doseLog', {}); },
  saveDoseLog(log){ this._set('vitals:doseLog', log); },
  getMedFiredLog(){ return this._get('vitals:medFiredLog', {}); },
  saveMedFiredLog(log){ this._set('vitals:medFiredLog', log); },
  getCustomMetrics(){ return this._get('vitals:customMetrics', []); },
  saveCustomMetrics(list){ this._set('vitals:customMetrics', list); },
  getColorOverrides(){ return this._get('vitals:colorOverrides', {}); },
  saveColorOverrides(o){ this._set('vitals:colorOverrides', o); },
  getSettings(){ return this._get('vitals:settings', {
    pinHash:null, pinSalt:null, theme:'auto', bioEnabled:false, bioCredId:null, onboarded:false
  }); },
  saveSettings(s){ this._set('vitals:settings', s); }
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
/*
 * Daily-average aggregation used to collapse to Math.round(), which turns
 * whole numbers only — so decimal readings like 1.55 / 1.6 / 1.7 (a common
 * precision for things like serum creatinine) all landed on the same
 * rounded dot in the Trends chart and looked like no change happened at
 * all. This keeps up to `decimals` places (2 by default) instead of
 * flattening to an integer, while still snapping away floating-point
 * noise from averaging (e.g. 1.5666666666666667 -> 1.57) so the display
 * stays clean rather than showing raw float artifacts.
 */
function roundSmart(value, decimals){
  if(value === null || value === undefined || Number.isNaN(value)) return value;
  const factor = Math.pow(10, decimals == null ? 2 : decimals);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
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
  custom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 3h6M10 3v6.5L5.5 17a2 2 0 0 0 1.7 3h9.6a2 2 0 0 0 1.7-3L14 9.5V3"/><path d="M8.5 14h7"/></svg>',
  weight:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5.5" width="17" height="15" rx="3"/><path d="M8.5 10.5a3.5 3.5 0 0 1 7 0"/><path d="M12 10.5v2.3l1.8 1.8"/></svg>',
  creatinine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6"/><path d="M9.5 3v9.5a4.5 4.5 0 1 0 5 0V3"/><path d="M9.3 14.5h5.4"/></svg>',
  egfr:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l3.5-6"/><path d="M4 17h2M18 17h2"/></svg>',
  tacrolimus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="9.5" width="16" height="7" rx="3.5" transform="rotate(-25 12 13)"/><path d="M9.3 10.3l2.2 5.6" transform="rotate(-25 12 13)"/></svg>'
};
// Approved (round 1) tile icons for the kidney-panel parameters, matched by
// name so any custom metric called e.g. "Serum Creatinine" or "creatinine"
// picks up its dedicated glyph instead of the generic flask — anything that
// doesn't match falls back to ICONS.custom.
function iconForCustomMetric(name){
  const n = (name || '').toLowerCase();
  if(n.includes('weight')) return ICONS.weight;
  if(n.includes('creatinine')) return ICONS.creatinine;
  if(n.includes('egfr') || n.includes('gfr')) return ICONS.egfr;
  if(n.includes('tacrolimus') || n.includes('tac level')) return ICONS.tacrolimus;
  return ICONS.custom;
}
const TYPE_META = {
  liquid: {label:'Fluid Intake', sheetNoun:'fluid intake', colorClass:'blue',   colorVar:'--blue',   icon:ICONS.liquid, unit:'mL'},
  urine:  {label:'Urine output', sheetNoun:'urine output',  colorClass:'yellow',colorVar:'--yellow', icon:ICONS.urine,  unit:'mL'},
  bp:     {label:'Blood pressure', sheetNoun:'blood pressure', colorClass:'red', colorVar:'--red',  icon:ICONS.bp,     unit:'mmHg'},
  sugar:  {label:'Sugar', sheetNoun:'sugar reading', colorClass:'white', colorVar:'--white', icon:ICONS.sugar, unit:'mg/dL'}
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
  {name:'Weight', unit:'kg', colorClass:'pink'},
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
  ['pink','Pink','--pink'], ['teal','Teal','--teal'],
  ['white','White','--white']
];

// White reads as a near-invisible line/dot on the app's white (light-mode)
// surface, so anything drawn with --white gets a thin halo/outline instead
// of being left to disappear. haloClass() goes on chart strokes & dots
// (SVG, via a soft drop-shadow outline); haloFillClass() goes on solid
// swatches/dots (plain elements, via an inset ring) — see .tone-white-line
// / .tone-white-fill in styles.css. Both are no-ops for every other color.
function haloClass(colorVar){ return colorVar === '--white' ? ' class="tone-white-line"' : ''; }
function haloFillClass(colorVar){ return colorVar === '--white' ? ' tone-white-fill' : ''; }
// Belt-and-suspenders for standalone dots/bars (circles, rects): on top of
// the drop-shadow halo above, these also get a real SVG stroke ring, so a
// single isolated white marker (e.g. one lone sugar reading, nothing to
// draw a line between) never reads as blank on a white card.
function haloRing(colorVar){ return colorVar === '--white' ? ' stroke="var(--white-halo)" stroke-width="1"' : ''; }
// Text set directly in an accent color (e.g. the Trends tab label) needs the
// same treatment — swap it for --text rather than rendering white-on-white.
function textSafeColorVar(meta){ return meta.colorClass === 'white' ? '--text' : meta.colorVar; }

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
    colorVar: colorEntry[2], icon: iconForCustomMetric(m.name), unit: m.unit, isCustom: true
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
function applyTabColorsCollapsed(){
  const panel = $('#tab-colors-list');
  const toggle = $('#tab-colors-toggle');
  const chevron = $('#tab-colors-chevron');
  if(!panel || !toggle) return;
  panel.classList.toggle('collapsed', tabColorsCollapsed);
  toggle.setAttribute('aria-expanded', tabColorsCollapsed ? 'false' : 'true');
  if(chevron) chevron.classList.toggle('rotated', !tabColorsCollapsed);
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
let medicineCheckInterval = null;
let pendingUnlockAction = null;
let pinBuffer = '';
let pinFirstEntry = '';

// Settings > Tab colors is collapsible and always starts collapsed each
// time you navigate INTO Settings (see showPanel below) — this flag just
// tracks whatever you've toggled it to since then, so re-rendering the
// rest of Settings (e.g. on a Drive status change) doesn't fight your tap.
let tabColorsCollapsed = true;
let autoLockTimer = null;
// How long the app can sit backgrounded (screen off, app switched away
// from, tab hidden) before it re-locks itself. A PIN/biometric gate that
// only ever locks when the app is manually closed or relaunched leaves a
// real window where someone else can pick up an unlocked phone.
const AUTO_LOCK_DELAY_MS = 2 * 60 * 1000;

// Trends > tap-to-expand chart state
let chartExpandType = null;
let chartZoomState = { scale:1, x:0, y:0 };
let chartZoomPointers = new Map();
let chartZoomStartDist = 0;
let chartZoomStartScale = 1;
let chartZoomPanStart = null;
const CHART_ZOOM_MIN = 1;
const CHART_ZOOM_MAX = 6;
// How many days back the expanded chart is currently plotting. Starts at
// whatever the Trends toggle (7d/30d) was showing when the chart was
// opened, and grows when the user keeps trying to zoom out past the
// natural "everything fits" scale of 1 — see tryExpandChartRange() below.
let chartExpandRangeDays = 7;
// Only one range expansion is allowed per continuous zoom-out gesture (a
// pinch held below scale 1, or a burst of wheel ticks) — otherwise a single
// gesture would fire dozens of expansions in a row. Re-armed when the
// gesture ends (all pointers lift, or wheel input goes quiet).
let chartRangeExpandArmed = true;
let chartWheelExpandTimer = null;

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

function formatHHMM(hhmm){
  const [h,m] = hhmm.split(':').map(Number);
  const d = new Date(); d.setHours(h,m,0,0);
  return formatTime(d.getTime());
}
function repeatDaysText(obj){
  if(obj.days === 'daily') return 'Daily';
  if(!obj.days || !obj.days.length) return 'Once';
  const names = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return obj.days.slice().sort().map(d=>names[d]).join(', ');
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
  renderTrends();
  renderTodayChecklist();
  renderMedicinesList();
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
  if(name === 'settings'){
    // Tab colors always starts collapsed on entering Settings, regardless
    // of whatever state you left it in last time.
    tabColorsCollapsed = true;
    applyTabColorsCollapsed();
  }
}

/* =========================================================================
   ADD / EDIT SHEET
   ========================================================================= */
function fieldsHtmlFor(kind, existing){
  if(kind === 'medicine'){
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
      <div class="field-label">Medicine name</div>
      <div class="input-row"><input type="text" id="medicine-name" placeholder="e.g. Tacrolimus" value="${existing?escapeHtml(existing.name):''}"></div>
      <div class="field-label">Dose <span style="text-transform:none;font-weight:400;">(optional)</span></div>
      <div class="input-row"><input type="text" id="medicine-dose" placeholder="e.g. 1 tablet, 2mg" value="${existing&&existing.dose?escapeHtml(existing.dose):''}"></div>
      <div class="field-label">Time</div>
      <div class="input-row"><input type="time" id="medicine-time" value="${timeVal}"></div>
      <div class="field-label">Repeat on</div>
      <div class="chips" id="medicine-days">${dayChips}</div>
      <div class="field-label">Reminder tone <span style="text-transform:none;font-weight:400;">(tap to preview)</span></div>
      <div class="chips" id="medicine-tone-chips">${toneChips}</div>`;
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
  const isMedicine = kind === 'medicine';
  const isNewMetric = kind === 'new-metric';
  const isEdit = !!currentEditId;

  let existing = null;
  if(isEdit){
    existing = isMedicine ? DB.getMedicines().find(m=>m.id===currentEditId)
      : isNewMetric ? DB.getCustomMetrics().find(m=>m.id===currentEditId)
      : DB.getEntries().find(e=>e.id===currentEditId);
  }

  const meta = isNewMetric ? null : getMetricMeta(kind);
  $('#sheet-title').textContent = isMedicine
    ? (isEdit ? 'Edit medicine' : 'New medicine')
    : isNewMetric
      ? (isEdit ? 'Edit health parameter' : 'New health parameter')
      : (isEdit ? `Edit ${meta.sheetNoun}` : `Log ${meta.sheetNoun}`);
  $('#sheet-sub').textContent = isMedicine ? 'Repeats on the days and times you choose'
    : isNewMetric ? 'Shows up as its own card on Home and Trends'
    : ('Now · ' + formatTime(Date.now()));
  $('#sheet-fields').innerHTML = fieldsHtmlFor(kind, existing);

  const noteLabel = $('#note-field-label'), noteInput = $('#sheet-note');
  if(isMedicine || isNewMetric){
    noteLabel.style.display = 'none'; noteInput.style.display = 'none';
  } else {
    noteLabel.style.display = ''; noteInput.style.display = '';
    noteInput.value = (isEdit && existing && existing.note) ? existing.note : '';
  }

  $('#sheet-delete-btn').style.display = isEdit ? '' : 'none';
  $('#sheet-save-btn').textContent = isMedicine ? (isEdit ? 'Save medicine' : 'Add medicine') : 'Done';

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
    if(group.id === 'medicine-tone-chips'){
      playTone(chip.dataset.tone);
    }
  });
}

function saveEntry(){
  if(currentSheetKind === 'medicine'){ saveMedicineFromSheet(); return; }
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

function saveMedicineFromSheet(){
  const name = $('#medicine-name').value.trim();
  if(!name){ flashSheetError('Give it a name'); return; }
  const dose = $('#medicine-dose').value.trim();
  const time = $('#medicine-time').value;
  if(!time){ flashSheetError('Pick a time'); return; }
  const dayChips = $all('#medicine-days .chip');
  const selectedDays = dayChips.filter(c=>c.classList.contains('selected')).map(c=>parseInt(c.dataset.day,10));
  const days = selectedDays.length === 7 ? 'daily' : selectedDays;
  const toneChip = $('#medicine-tone-chips .chip.selected');
  const tone = toneChip ? toneChip.dataset.tone : 'chime';

  let medicines = DB.getMedicines();
  const idx = medicines.findIndex(m=>m.id===currentEditId);
  const medicine = {
    id: currentEditId || genId(),
    name, dose, time, days, tone,
    enabled: idx>=0 ? medicines[idx].enabled : true,
    createdAt: idx>=0 ? (medicines[idx].createdAt || medicines[idx].updatedAt || Date.now()) : Date.now(),
    updatedAt: Date.now()
  };
  if(idx >= 0) medicines[idx] = medicine; else medicines.push(medicine);
  DB.saveMedicines(medicines);

  if(window.VitalsDrive && window.VitalsDrive.queueMedicineUpsert) window.VitalsDrive.queueMedicineUpsert(medicine);

  closeSheet();
  renderMedicinesList();
  renderTodayChecklist();
  scheduleAllMedicines();
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

/*
 * Styled in-app replacement for the browser's native confirm() dialog, used
 * for every delete action below. Native confirm() worked but looked jarring
 * next to the rest of the app's UI; this reuses the same overlay pattern as
 * the entry sheet (#confirm-scrim / #confirm-modal in index.html) so it
 * matches the app's own look, light/dark theme included. Resolves true if
 * the user tapped "Delete", false for Cancel or tapping the scrim.
 */
function showConfirmDialog(title, body){
  return new Promise(resolve=>{
    const scrim = $('#confirm-scrim');
    const modal = $('#confirm-modal');
    $('#confirm-modal-title').textContent = title;
    $('#confirm-modal-body').textContent = body;

    let settled = false;
    function finish(result){
      if(settled) return;
      settled = true;
      scrim.classList.remove('show');
      modal.classList.remove('show');
      $('#confirm-modal-confirm').removeEventListener('click', onConfirm);
      $('#confirm-modal-cancel').removeEventListener('click', onCancel);
      scrim.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onConfirm(){ finish(true); }
    function onCancel(){ finish(false); }

    $('#confirm-modal-confirm').addEventListener('click', onConfirm);
    $('#confirm-modal-cancel').addEventListener('click', onCancel);
    scrim.addEventListener('click', onCancel);

    scrim.classList.add('show');
    modal.classList.add('show');
  });
}

async function deleteCurrent(){
  if(!currentEditId){ closeSheet(); return; }

  // A stray tap here is permanent (and, once synced, propagates to every
  // other connected device) — always confirm first. Cancelling leaves the
  // sheet open exactly as it was.
  if(currentSheetKind === 'medicine'){
    const id = currentEditId;
    const medicine = DB.getMedicines().find(m=>m.id===id);
    const ok = await showConfirmDialog('Delete medicine?', `Delete "${medicine ? medicine.name : 'this medicine'}"?`);
    if(!ok) return;
    DB.saveMedicines(DB.getMedicines().filter(m=>m.id!==id));
    if(window.VitalsDrive && window.VitalsDrive.queueMedicineDelete) window.VitalsDrive.queueMedicineDelete(id, Date.now());
    renderMedicinesList();
    renderTodayChecklist();
    scheduleAllMedicines();
  } else if(currentSheetKind === 'new-metric'){
    const id = currentEditId;
    const metric = DB.getCustomMetrics().find(m=>m.id===id);
    const name = metric ? metric.name : 'this parameter';
    const ok = await showConfirmDialog(`Delete "${name}"?`, 'Its logged entries will no longer be shown, and this also removes it on your other synced devices.');
    if(!ok) return;
    DB.saveCustomMetrics(DB.getCustomMetrics().filter(m=>m.id!==id));
    if(window.VitalsDrive && window.VitalsDrive.queueMetricDelete) window.VitalsDrive.queueMetricDelete(id, Date.now());
    renderAll();
    renderSettingsPanel();
  } else {
    const ok = await showConfirmDialog('Delete this entry?', "This can't be undone.");
    if(!ok) return;
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
    out += `<rect${haloClass(colorVar)} x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="6" fill="var(${colorVar})"${haloRing(colorVar)}/>`;
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
    out += `<path${haloClass(colorVar)} d="${pointsToPath(sysPts)}" fill="none" stroke="var(${colorVar})" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    out += `<path${haloClass(colorVar)} d="${pointsToPath(diaPts)}" fill="none" stroke="var(${colorVar})" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1 6" opacity="0.55"/>`;
  }
  sysPts.forEach(p=> out += `<circle${haloClass(colorVar)} cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4.5" fill="var(${colorVar})"${haloRing(colorVar)}/>`);
  diaPts.forEach(p=> out += `<circle${haloClass(colorVar)} cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4.5" fill="var(${colorVar})" opacity="0.55"${haloRing(colorVar)}/>`);
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
  if(entries.length > 1) out += `<path${haloClass(colorVar)} d="${pointsToPath(pts)}" fill="none" stroke="var(${colorVar})" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  pts.forEach(p=> out += `<circle${haloClass(colorVar)} cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4.5" fill="var(${colorVar})"${haloRing(colorVar)}/>`);
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
      <div class="dot${haloFillClass(meta.colorVar)}" style="background:var(${meta.colorVar});"></div>
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
    svg += `<path${haloClass(colorVar)} d="${pathD}" fill="none" stroke="var(${colorVar})" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    svg += `<path d="${areaD}" fill="var(${colorVar})" opacity="0.08"/>`;
  }
  pts.forEach(p=> svg += `<circle${haloClass(colorVar)} cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="var(${colorVar})"${haloRing(colorVar)}/>`);
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
      return day.length ? roundSmart(avg(day.map(e=>e.systolic)), 2) : null;
    });
  }
  return dates.map(d=>{
    const day = list.filter(e=>sameDay(e.ts,d));
    return day.length ? roundSmart(avg(day.map(e=>e.value)), 2) : null;
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
    rangeText = present.length ? `${currentTrendRange}d avg ${roundSmart(avg(present), 2).toLocaleString(undefined, {maximumFractionDigits:2})} mL` : 'No data yet';
    currentHtml = `${today.toLocaleString()}<span style="${dim}"> mL today</span>`;
  } else if(type==='bp'){
    rangeText = present.length ? `${currentTrendRange}d avg sys ${roundSmart(avg(present), 2)}` : 'No data yet';
    currentHtml = latest ? `${latest.systolic}<span style="${dim}"> / ${latest.diastolic} mmHg</span>` : '—';
  } else if(type==='sugar'){
    rangeText = present.length ? `${currentTrendRange}d avg ${roundSmart(avg(present), 2)} mg/dL` : 'No data yet';
    currentHtml = latest ? `${latest.value}<span style="${dim}"> mg/dL · ${sugarContextLabel(latest.context)}</span>` : '—';
  } else {
    rangeText = present.length ? `${currentTrendRange}d avg ${roundSmart(avg(present), 2)} ${escapeHtml(meta.unit)}` : 'No data yet';
    currentHtml = latest ? `${latest.value}<span style="${dim}"> ${escapeHtml(meta.unit)}</span>` : '—';
  }

  return `
    <div class="trend-card" data-open-chart="${type}">
      <div class="trend-head">
        <span class="trend-name" style="color:var(${textSafeColorVar(meta)});">${escapeHtml(meta.label)}</span>
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
   TRENDS — tap-to-expand chart (full-screen, pinch/scroll zoom + pan)
   ========================================================================= */
function buildExpandedChartSvg(type, rangeDays){
  const meta = getMetricMeta(type);
  if(!meta) return '';
  const dates = lastNDates(rangeDays || currentTrendRange);
  const list = DB.getEntries().filter(e=>e.type===type);
  const isVolume = (type==='liquid' || type==='urine');
  const daily = dailySeriesFor(type, dates, list);
  const series = isVolume ? daily.map(v=>v||null) : daily;

  const n = series.length;
  const presentIdx = [];
  series.forEach((v,i)=>{ if(v !== null && v !== undefined) presentIdx.push(i); });

  // padT is taller than the plain date-axis version of this chart to leave
  // headroom for the per-point value labels drawn above each dot below.
  const W = 640, H = 260, padL = 16, padR = 16, padT = 28, padB = 30;

  if(!presentIdx.length){
    return `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="var(--text-dim)" font-size="14" font-family="var(--font-body)">No data in this range</text>`;
  }

  const present = presentIdx.map(i=>series[i]);
  const min = Math.min(...present), max = Math.max(...present);
  const range = (max-min) || 1;
  const xForIdx = i => n<=1 ? (padL+W-padR)/2 : padL + (i * ((W-padL-padR)/(n-1)));
  const xs = presentIdx.map(xForIdx);
  const ys = present.map(v => (H-padB) - ((v-min)/range)*(H-padT-padB));
  const pts = xs.map((x,i)=>[x, ys[i]]);

  let out = '';
  if(pts.length > 1){
    const pathD = pointsToPath(pts);
    const areaD = pathD + ` L${xs[xs.length-1].toFixed(1)},${H-padB} L${xs[0].toFixed(1)},${H-padB} Z`;
    out += `<path${haloClass(meta.colorVar)} d="${pathD}" fill="none" stroke="var(${meta.colorVar})" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    out += `<path d="${areaD}" fill="var(${meta.colorVar})" opacity="0.10"/>`;
  }
  pts.forEach(p=> out += `<circle${haloClass(meta.colorVar)} cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="5" fill="var(${meta.colorVar})"${haloRing(meta.colorVar)}/>`);

  // The value for each plotted day, right above its dot — the point of the
  // full-screen expand is to actually read numbers off the chart, not just
  // see its shape. Pinch/scroll zoom (already built into this view) is what
  // keeps this legible on a busy 30-day range instead of thinning labels out.
  pts.forEach((p,xIdx)=>{
    const val = present[xIdx];
    const label = isVolume ? val.toLocaleString() : String(val);
    const ly = Math.max(12, p[1] - 12);
    out += `<text x="${p[0].toFixed(1)}" y="${ly.toFixed(1)}" class="point-label" text-anchor="middle">${escapeHtml(label)}</text>`;
  });

  const labelEvery = n > 12 ? Math.ceil(n/8) : 1;
  const lastPresent = presentIdx[presentIdx.length-1];
  presentIdx.forEach((i, xIdx)=>{
    if(i % labelEvery !== 0 && i !== lastPresent) return;
    const label = dates[i].toLocaleDateString([], {day:'numeric', month:'short'});
    out += `<text x="${xs[xIdx].toFixed(1)}" y="${H-10}" class="time-label" text-anchor="middle">${escapeHtml(label)}</text>`;
  });

  return out;
}

function openChartExpand(type){
  const meta = getMetricMeta(type);
  if(!meta) return;
  chartExpandType = type;
  chartExpandRangeDays = currentTrendRange;
  chartRangeExpandArmed = true;
  const agg = computeHomeAggregate(type);
  const tmp = document.createElement('div');
  tmp.innerHTML = agg.valueHtml;
  $('#chart-expand-cat').textContent = meta.label;
  $('#chart-expand-val').textContent = tmp.textContent;
  renderExpandedChart();
  resetChartZoom();
  $('#chart-expand').classList.add('show');
}
function closeChartExpand(){
  $('#chart-expand').classList.remove('show');
  chartExpandType = null;
  clearTimeout(chartWheelExpandTimer);
}

function renderExpandedChart(){
  if(!chartExpandType) return;
  $('#chart-expand-svg').innerHTML = buildExpandedChartSvg(chartExpandType, chartExpandRangeDays);
}

/*
 * How far back this metric actually has data, in days — the ceiling on how
 * far "keep zooming out" is allowed to grow chartExpandRangeDays. Without
 * this, zooming out past the oldest real entry would just plot a lot of
 * empty days for no benefit.
 */
function maxChartRangeDaysFor(type){
  const list = DB.getEntries().filter(e=>e.type===type);
  if(!list.length) return chartExpandRangeDays;
  const oldest = Math.min(...list.map(e=>e.ts));
  const daysSinceOldest = Math.round((startOfDay(Date.now()) - startOfDay(oldest)) / 86400000) + 1;
  return Math.max(daysSinceOldest, currentTrendRange);
}

/*
 * The actual "zoom out reveals older data" behavior: called whenever a
 * pinch or scroll gesture tries to go past the natural scale-1 fit. Doubles
 * how many days back the chart plots (capped at the oldest entry that
 * exists for this metric), rebuilds it, and lands back at a clean scale-1
 * fit of that wider range — so, e.g., an entry from the 23rd that had
 * scrolled out of a 7-day view becomes visible again instead of staying
 * stuck just out of reach.
 */
function tryExpandChartRange(){
  if(!chartRangeExpandArmed || !chartExpandType) return;
  const cap = maxChartRangeDaysFor(chartExpandType);
  if(chartExpandRangeDays >= cap) return;
  chartExpandRangeDays = Math.min(cap, chartExpandRangeDays * 2);
  chartRangeExpandArmed = false;
  renderExpandedChart();
  chartZoomState = { scale:1, x:0, y:0 };
  chartZoomStartDist = 0;
  applyChartZoomTransform();
}

function applyChartZoomTransform(){
  const svg = $('#chart-expand-svg');
  if(!svg) return;
  svg.style.transform = `translate(${chartZoomState.x}px, ${chartZoomState.y}px) scale(${chartZoomState.scale})`;
}
/*
 * Returns true if the caller was trying to zoom out further than scale 1
 * (the "everything fits" point) allows — the signal tryExpandChartRange()
 * uses to grow the visible date range instead of just refusing the zoom.
 *
 * Panning is clamped to exactly the zoomed content's own overhang (no
 * added slack) so at scale 1 — where the content already fills the
 * viewport exactly — pan is forced to (0,0). Previously a constant 15%-of-
 * viewport pan allowance applied even at scale 1, which let part of the
 * chart (potentially including the newest or oldest plotted day) get
 * dragged out of the visible area with nothing to bring it back until the
 * sheet was closed and reopened.
 */
function clampChartZoom(){
  const wantsToZoomOutFurther = chartZoomState.scale < CHART_ZOOM_MIN;
  chartZoomState.scale = Math.min(CHART_ZOOM_MAX, Math.max(CHART_ZOOM_MIN, chartZoomState.scale));
  const viewport = $('#chart-zoom-viewport');
  if(viewport){
    const rect = viewport.getBoundingClientRect();
    const maxX = (rect.width * (chartZoomState.scale-1)) / 2;
    const maxY = (rect.height * (chartZoomState.scale-1)) / 2;
    chartZoomState.x = Math.min(maxX, Math.max(-maxX, chartZoomState.x));
    chartZoomState.y = Math.min(maxY, Math.max(-maxY, chartZoomState.y));
  }
  return wantsToZoomOutFurther;
}
function resetChartZoom(){
  chartZoomState = { scale:1, x:0, y:0 };
  chartZoomPointers = new Map();
  chartZoomStartDist = 0;
  chartZoomPanStart = null;
  applyChartZoomTransform();
}
function chartZoomDistance(p1, p2){ return Math.hypot(p1.x-p2.x, p1.y-p2.y); }

function wireChartZoomEvents(){
  const viewport = $('#chart-zoom-viewport');
  if(!viewport) return;

  viewport.addEventListener('pointerdown', (e)=>{
    try{ viewport.setPointerCapture(e.pointerId); }catch(err){}
    chartZoomPointers.set(e.pointerId, {x:e.clientX, y:e.clientY});
    if(chartZoomPointers.size === 2){
      const pts = Array.from(chartZoomPointers.values());
      chartZoomStartDist = chartZoomDistance(pts[0], pts[1]);
      chartZoomStartScale = chartZoomState.scale;
      chartZoomPanStart = null;
    } else if(chartZoomPointers.size === 1){
      chartZoomPanStart = { x:e.clientX, y:e.clientY, startTX:chartZoomState.x, startTY:chartZoomState.y };
    }
  });

  viewport.addEventListener('pointermove', (e)=>{
    if(!chartZoomPointers.has(e.pointerId)) return;
    chartZoomPointers.set(e.pointerId, {x:e.clientX, y:e.clientY});

    if(chartZoomPointers.size === 2){
      const pts = Array.from(chartZoomPointers.values());
      const dist = chartZoomDistance(pts[0], pts[1]);
      if(chartZoomStartDist > 0){
        chartZoomState.scale = chartZoomStartScale * (dist / chartZoomStartDist);
        const wantsMore = clampChartZoom();
        applyChartZoomTransform();
        if(wantsMore) tryExpandChartRange();
      }
    } else if(chartZoomPointers.size === 1 && chartZoomPanStart){
      const p = chartZoomPointers.get(e.pointerId);
      chartZoomState.x = chartZoomPanStart.startTX + (p.x - chartZoomPanStart.x);
      chartZoomState.y = chartZoomPanStart.startTY + (p.y - chartZoomPanStart.y);
      clampChartZoom();
      applyChartZoomTransform();
    }
  });

  function endPointer(e){
    chartZoomPointers.delete(e.pointerId);
    if(chartZoomPointers.size < 2) chartZoomStartDist = 0;
    if(chartZoomPointers.size === 1){
      const remaining = Array.from(chartZoomPointers.values())[0];
      chartZoomPanStart = { x:remaining.x, y:remaining.y, startTX:chartZoomState.x, startTY:chartZoomState.y };
    } else if(chartZoomPointers.size === 0){
      chartZoomPanStart = null;
      // Gesture fully released — the next pinch-out is allowed to expand
      // the range again (7 -> 14 -> 30 -> ... one step per gesture).
      chartRangeExpandArmed = true;
    }
  }
  viewport.addEventListener('pointerup', endPointer);
  viewport.addEventListener('pointercancel', endPointer);
  viewport.addEventListener('pointerleave', endPointer);

  viewport.addEventListener('wheel', (e)=>{
    e.preventDefault();
    const delta = -e.deltaY * 0.0015;
    chartZoomState.scale = chartZoomState.scale * (1 + delta);
    const wantsMore = clampChartZoom();
    applyChartZoomTransform();
    if(wantsMore) tryExpandChartRange();
    // A scroll wheel/trackpad sends a burst of small events for one
    // logical gesture — re-arm shortly after the input goes quiet instead
    // of on every single tick, or a mouse-wheel zoom-out would trigger a
    // range expansion many times over for what is really one "keep
    // pulling out" motion.
    clearTimeout(chartWheelExpandTimer);
    chartWheelExpandTimer = setTimeout(()=>{ chartRangeExpandArmed = true; }, 500);
  }, { passive:false });

  viewport.addEventListener('dblclick', resetChartZoom);
}

/* =========================================================================
   MEDICINES + NOTIFICATIONS

   Each medicine is a single (time, days) schedule — a medicine taken twice
   a day is two separate medicine entries, each independently editable,
   toggleable, and with its own history. Status per calendar day is
   icon-only everywhere it's shown: a tick for taken, a muted dash for
   skipped, and an empty ring (red once overdue) for still-pending — with
   the scheduled time shown as small fine print underneath the name.
   ========================================================================= */
const DOSE_CHECK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>';
const DOSE_DASH_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 12h12"/></svg>';

function dateKeyForDate(d){ return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
function todayKey(){ return dateKeyForDate(new Date()); }
function matchesTodayMed(medicine, date){
  if(medicine.days === 'daily') return true;
  return Array.isArray(medicine.days) && medicine.days.includes(date.getDay());
}
function doseKeyFor(medId, dateKey, time){ return medId+'|'+dateKey+'|'+time; }
function getDoseStatus(doseKey){
  const log = DB.getDoseLog();
  const entry = log[doseKey];
  return entry ? entry.status : 'pending';
}
function setDoseStatus(medId, time, status, dateKey){
  const log = DB.getDoseLog();
  dateKey = dateKey || todayKey();
  const key = doseKeyFor(medId, dateKey, time);
  const entry = { id:key, medicineId:medId, date:dateKey, time, status, updatedAt:Date.now() };
  log[key] = entry;
  DB.saveDoseLog(log);
  if(window.VitalsDrive && window.VitalsDrive.queueDoseLogUpsert) window.VitalsDrive.queueDoseLogUpsert(entry);
  window.dispatchEvent(new CustomEvent('vitals-local-data-changed'));
}
function clearDoseStatus(medId, time, dateKey){
  const log = DB.getDoseLog();
  dateKey = dateKey || todayKey();
  const key = doseKeyFor(medId, dateKey, time);
  if(log[key]){
    delete log[key];
    DB.saveDoseLog(log);
  }
  if(window.VitalsDrive && window.VitalsDrive.queueDoseLogDelete) window.VitalsDrive.queueDoseLogDelete(key, Date.now());

  // Re-arm the reminder loop immediately: undoing a "taken"/"skipped" mark
  // shouldn't leave an overdue dose silent until the 5-minute re-fire
  // window happens to elapse on its own — the next tick should be free to
  // notify right away. Only relevant for today's own fired-log, but
  // harmless (and a no-op) to check for a past date too.
  const firedLog = DB.getMedFiredLog();
  if(firedLog[key]){
    delete firedLog[key];
    DB.saveMedFiredLog(firedLog);
  }

  window.dispatchEvent(new CustomEvent('vitals-local-data-changed'));
}
/*
 * Every medicine scheduled for today, in chronological order, with its
 * current taken/skipped/pending status attached — the single source the
 * "Today" checklist on the Medicines tab renders from.
 */
function todaysDoseInstances(){
  const now = new Date();
  const dateKey = todayKey();
  const meds = DB.getMedicines().filter(m=>m.enabled).filter(m=>matchesTodayMed(m, now));
  const instances = meds.map(m=>{
    const parts = (m.time||'').split(':').map(Number);
    const h = parts[0], mi = parts[1];
    const sched = new Date(now);
    if(!isNaN(h)) sched.setHours(h, isNaN(mi)?0:mi, 0, 0);
    const status = getDoseStatus(doseKeyFor(m.id, dateKey, m.time));
    return { medicine:m, scheduledTs: sched.getTime(), status };
  });
  instances.sort((a,b)=>a.scheduledTs-b.scheduledTs);
  return instances;
}
/*
 * Collapsed to 4 states now that status is conveyed by icon, not a text
 * pill: 'taken' | 'skipped' | 'overdue' (still pending, 15+ min past its
 * scheduled time — this is the only state that gets red styling) |
 * 'pending' (not yet due, or due within the last 15 minutes' grace).
 */
function doseUrgency(inst, now){
  if(inst.status === 'taken') return 'taken';
  if(inst.status === 'skipped') return 'skipped';
  return (now - inst.scheduledTs) >= 15*60*1000 ? 'overdue' : 'pending';
}
function doseRowHtml(inst){
  const urgency = doseUrgency(inst, Date.now());
  const iconClass = urgency === 'pending' ? '' : ' '+urgency;
  const iconSvg = urgency === 'taken' ? DOSE_CHECK_ICON : urgency === 'skipped' ? DOSE_DASH_ICON : '';
  const doseKey = doseKeyFor(inst.medicine.id, todayKey(), inst.medicine.time);
  const skipLabel = inst.status === 'pending' ? 'Skip' : 'Undo';
  return `
    <div class="dose-row" data-dose-key="${doseKey}" data-med-id="${inst.medicine.id}" data-time="${inst.medicine.time}">
      <button class="dose-check${iconClass}" data-dose-take aria-label="Mark taken">${iconSvg}</button>
      <div class="alarm-info"><div class="alarm-label">${escapeHtml(inst.medicine.name)}${inst.medicine.dose?` <span style="font-weight:400;color:var(--text-dim);">· ${escapeHtml(inst.medicine.dose)}</span>`:''}</div><div class="alarm-sub">${formatHHMM(inst.medicine.time)}</div></div>
      <button class="dose-skip" data-dose-skip>${skipLabel}</button>
    </div>`;
}
function renderTodayChecklist(){
  const box = $('#medicines-today-list');
  if(!box) return;
  const instances = todaysDoseInstances();
  box.innerHTML = instances.length
    ? instances.map(doseRowHtml).join('')
    : '<p class="empty-hint">No medicines scheduled for today.</p>';
}
function wireDoseChecklistDelegation(container){
  if(!container) return;
  container.addEventListener('click', (e)=>{
    const row = e.target.closest('[data-dose-key]');
    if(!row) return;
    const medId = row.dataset.medId;
    const time = row.dataset.time;
    const key = doseKeyFor(medId, todayKey(), time);

    if(e.target.closest('[data-dose-take]')){
      if(getDoseStatus(key) === 'taken') clearDoseStatus(medId, time);
      else setDoseStatus(medId, time, 'taken');
      renderTodayChecklist();
      return;
    }
    if(e.target.closest('[data-dose-skip]')){
      if(getDoseStatus(key) === 'pending') setDoseStatus(medId, time, 'skipped');
      else clearDoseStatus(medId, time);
      renderTodayChecklist();
      return;
    }
  });
}
function renderMedicinesList(){
  const meds = DB.getMedicines();
  const box = $('#medicines-list');
  if(!box) return;
  if(!meds.length){
    box.innerHTML = '<p class="empty-hint">No medicines yet.</p>';
  } else {
    box.innerHTML = meds.map(m=>`
      <div class="alarm-row">
        <div class="switch${m.enabled?' on':''}" data-toggle-medicine="${m.id}"><div class="switch-knob"></div></div>
        <div class="alarm-info" data-edit-medicine="${m.id}"><div class="alarm-label">${escapeHtml(m.name)}${m.dose?` <span style="font-weight:400;color:var(--text-dim);">· ${escapeHtml(m.dose)}</span>`:''}</div><div class="alarm-sub">${repeatDaysText(m)} · ${formatHHMM(m.time)}</div></div>
        <button class="alarm-edit" data-med-history="${m.id}" aria-label="View history">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.5" y="5" width="17" height="16" rx="3"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></svg>
        </button>
      </div>`).join('');
  }
  const hint = $('#notif-hint');
  if(!('Notification' in window)){
    hint.textContent = 'This browser doesn’t support notifications — medicines will still show here when you open the app.';
  } else if(Notification.permission === 'denied'){
    hint.textContent = 'Notifications are blocked for this app in your browser settings — medicines will still show in this list, but won’t pop up a notification.';
  } else {
    hint.textContent = 'Medicines notify you every 5 minutes while a dose is overdue and Vitals has been opened recently, until you mark it taken or skipped. For best results, keep it installed to your home screen and avoid force-closing it.';
  }
}

/* =========================================================================
   MEDICINE HISTORY (day-by-day, per medicine)
   ========================================================================= */
let currentHistoryMedId = null;
let currentHistoryDate = null;
/*
 * A medicine's status for an ARBITRARY day (past, today, or — disallowed
 * by the UI, but harmless here — future): 'not-scheduled' if the medicine
 * didn't exist yet or its days-of-week don't include that date; otherwise
 * whatever DoseLog says ('taken'/'skipped'), or 'missed' for a past day
 * left unmarked, or the live 'pending'/'overdue' split for today.
 */
function doseStatusForDate(medicine, dateTs){
  const d = new Date(dateTs);
  if(medicine.createdAt && startOfDay(dateTs) < startOfDay(medicine.createdAt)) return 'not-scheduled';
  if(!matchesTodayMed(medicine, d)) return 'not-scheduled';

  const dateKey = dateKeyForDate(d);
  const key = doseKeyFor(medicine.id, dateKey, medicine.time);
  const log = DB.getDoseLog();
  const entry = log[key];
  if(entry) return entry.status;

  if(startOfDay(dateTs) < startOfDay(Date.now())) return 'missed';

  const parts = (medicine.time||'').split(':').map(Number);
  const h = parts[0], mi = parts[1];
  const sched = new Date(d);
  if(!isNaN(h)) sched.setHours(h, isNaN(mi)?0:mi, 0, 0);
  return (Date.now() - sched.getTime()) >= 15*60*1000 ? 'overdue' : 'pending';
}
function openMedicineHistory(medId){
  currentHistoryMedId = medId;
  currentHistoryDate = startOfDay(Date.now());
  renderMedicineHistoryDay();
  $('#medicine-history').classList.add('show');
}
function closeMedicineHistory(){
  $('#medicine-history').classList.remove('show');
  currentHistoryMedId = null;
  currentHistoryDate = null;
}
function renderMedicineHistoryDay(){
  if(!currentHistoryMedId) return;
  const medicine = DB.getMedicines().find(m=>m.id===currentHistoryMedId);
  if(!medicine){ closeMedicineHistory(); return; }

  $('#medicine-history-name').textContent = medicine.name;
  $('#medicine-history-dose').textContent = medicine.dose || '';
  $('#medicine-history-day-label').textContent = dayNavLabel(currentHistoryDate);
  const dateInput = $('#medicine-history-date-input');
  dateInput.max = toDateInputValue(Date.now());
  dateInput.value = toDateInputValue(currentHistoryDate);
  $('#medicine-history-next-day').disabled = isToday(currentHistoryDate);

  const status = doseStatusForDate(medicine, currentHistoryDate);
  const labelMap = {
    taken:'Taken', skipped:'Skipped', missed:'Missed — not marked',
    pending:'Not yet due', overdue:'Overdue — not marked',
    'not-scheduled': medicine.createdAt && startOfDay(currentHistoryDate) < startOfDay(medicine.createdAt)
      ? "This medicine hadn't been added yet"
      : 'Not scheduled this day'
  };
  const iconClass = status === 'taken' ? ' taken' : status === 'skipped' ? ' skipped' : (status === 'overdue' || status === 'missed') ? ' overdue' : '';
  const iconSvg = status === 'taken' ? DOSE_CHECK_ICON : (status === 'skipped' || status === 'missed') ? DOSE_DASH_ICON : '';
  const timeSub = status === 'not-scheduled' ? '' : formatHHMM(medicine.time);

  $('#medicine-history-status-card').innerHTML = `
    <div class="dose-row" style="border-bottom:none;">
      <div class="dose-check${iconClass}" style="cursor:default;">${iconSvg}</div>
      <div class="alarm-info"><div class="alarm-label">${escapeHtml(labelMap[status] || '')}</div><div class="alarm-sub">${timeSub}</div></div>
    </div>`;
}
function shiftMedicineHistoryDay(deltaDays){
  const d = new Date(currentHistoryDate);
  d.setDate(d.getDate() + deltaDays);
  if(startOfDay(d.getTime()) > startOfDay(Date.now())) return;
  currentHistoryDate = startOfDay(d.getTime());
  renderMedicineHistoryDay();
}

// ---------- Medicine schedule import (paste-in bulk add) ----------
// One line per dose time: "8:00 AM: Medicine one, Medicine two". Every
// medicine named on a line becomes its own daily medicine entry at that
// time (per the "separate entry per time" model), so a twice-daily drug
// just needs its name to appear on two different lines.
function parseImportTime(raw){
  raw = (raw||'').trim();
  let m = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if(m){
    let h = parseInt(m[1],10); const mi = m[2]; const ap = m[3].toUpperCase();
    if(h < 1 || h > 12) return null;
    if(ap === 'AM'){ if(h===12) h=0; } else if(h!==12) h+=12;
    return pad2(h)+':'+mi;
  }
  m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if(m){
    const h = parseInt(m[1],10);
    if(h < 0 || h > 23) return null;
    return pad2(h)+':'+m[2];
  }
  return null;
}
function normalizeImportText(text){
  return (text||'')
    // Mobile keyboards sometimes substitute a narrow/no-break space between
    // a time and "AM"/"PM", or a typographic dash/colon variant, when a
    // pasted block gets re-typeset by autocorrect — fold those back to the
    // plain ASCII the parser below matches against.
    .replace(/[   ⁠]/g, ' ')
    .replace(/[‐-―−]/g, '-')
    .replace(/[：]/g, ':');
}
function parseImportSchedule(text){
  const lines = normalizeImportText(text).split('\n');
  const parsed = []; const errors = [];
  lines.forEach((line, idx)=>{
    const raw = line.trim();
    if(!raw || raw.startsWith('#')) return;
    const m = raw.match(/^(\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*[:\-–]\s*(.+)$/i);
    if(!m){ errors.push(`Line ${idx+1}: couldn't find a time (expected e.g. "8:00 AM: Medicine name")`); return; }
    const time = parseImportTime(m[1]);
    if(!time){ errors.push(`Line ${idx+1}: couldn't understand the time "${m[1].trim()}"`); return; }
    const names = m[2].split(',').map(s=>s.trim()).filter(Boolean);
    if(!names.length){ errors.push(`Line ${idx+1}: no medicine name found after the time`); return; }
    names.forEach(name=>parsed.push({ name, time }));
  });
  return { parsed, errors };
}
function openMedicineImport(){
  const status = $('#medicine-import-status');
  status.textContent = '';
  status.className = 'settings-sub';
  $('#medicine-import').classList.add('show');
}
function closeMedicineImport(){
  $('#medicine-import').classList.remove('show');
}
function importMedicinesFromText(){
  const textarea = $('#medicine-import-text');
  const status = $('#medicine-import-status');
  const { parsed, errors } = parseImportSchedule(textarea.value);
  if(!parsed.length){
    status.textContent = errors.length ? errors.join(' · ') : 'Paste your schedule above first.';
    status.className = 'settings-sub err';
    return;
  }
  const medicines = DB.getMedicines();
  const now = Date.now();
  parsed.forEach((p, i)=>{
    const medicine = {
      id: genId(), name: p.name, dose: '', time: p.time, days: 'daily', tone: 'chime',
      enabled: true, createdAt: now + i, updatedAt: now + i
    };
    medicines.push(medicine);
    if(window.VitalsDrive && window.VitalsDrive.queueMedicineUpsert) window.VitalsDrive.queueMedicineUpsert(medicine);
  });
  DB.saveMedicines(medicines);
  renderMedicinesList();
  renderTodayChecklist();
  scheduleAllMedicines();
  const skipNote = errors.length ? ` (${errors.length} line${errors.length>1?'s':''} skipped — ${errors.join(' · ')})` : '';
  status.textContent = `Imported ${parsed.length} dose${parsed.length>1?'s':''}.${skipNote}`;
  status.className = errors.length ? 'settings-sub err' : 'settings-sub ok';
  textarea.value = '';
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
function lastMedFiredAt(doseKey){
  const log = DB.getMedFiredLog();
  return log[doseKey] || 0;
}
function markMedFired(doseKey){
  const log = DB.getMedFiredLog();
  const today = todayKey();
  const keep = {};
  Object.keys(log).forEach(k=>{ if(k.indexOf('|'+today+'|') !== -1) keep[k] = log[k]; });
  keep[doseKey] = Date.now();
  DB.saveMedFiredLog(keep);
}
function fireMedicineDose(medicine, time, doseKey){
  markMedFired(doseKey);
  const tone = medicine.tone || 'chime';

  if(document.visibilityState === 'visible') playTone(tone);

  if(!('Notification' in window) || Notification.permission !== 'granted') return;
  const body = medicine.dose ? `${medicine.dose} · due ${formatHHMM(time)}` : `Due ${formatHHMM(time)}`;
  const show = (reg) => {
    const opts = {
      body, tag: 'vitals-med-'+doseKey, renotify: true,
      icon:'icons/icon-192.png', badge:'icons/icon-192.png', silent: tone === 'silent'
    };
    if(reg && reg.showNotification) reg.showNotification(medicine.name, opts);
    else new Notification(medicine.name, opts);
  };
  if(navigator.serviceWorker && navigator.serviceWorker.ready){
    navigator.serviceWorker.ready.then(show).catch(()=>show(null));
  } else show(null);
}
/*
 * Unlike the old alarm loop (which fired once per day and then gave up
 * after a 15-minute window), a medicine dose keeps re-firing every 5
 * minutes for as long as it stays unmarked — for the entire day, until it
 * is struck off as taken/skipped or the date rolls over. This is a
 * deliberate, informed tradeoff the user asked for; see the "medicines
 * notify..." hint text in renderMedicinesList for the plain-language
 * explanation of its real limits (no notification if the app/browser is
 * fully closed or the device is off).
 */
function checkMedicinesTick(){
  const now = new Date();
  const nowMs = now.getTime();
  const dateKey = todayKey();
  DB.getMedicines().filter(m=>m.enabled).forEach(m=>{
    if(!matchesTodayMed(m, now)) return;
    const parts = (m.time||'').split(':').map(Number);
    const h = parts[0], mi = parts[1];
    if(isNaN(h)) return;
    const sched = new Date(now); sched.setHours(h, isNaN(mi)?0:mi, 0, 0);
    if(nowMs < sched.getTime()) return;
    const doseKey = doseKeyFor(m.id, dateKey, m.time);
    if(getDoseStatus(doseKey) !== 'pending') return;
    const last = lastMedFiredAt(doseKey);
    if(nowMs - last >= 5*60*1000) fireMedicineDose(m, m.time, doseKey);
  });
  renderTodayChecklist();
}
function scheduleAllMedicines(){
  if(medicineCheckInterval) clearInterval(medicineCheckInterval);
  checkMedicinesTick();
  medicineCheckInterval = setInterval(checkMedicinesTick, 20000);
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
  clearAutoLockTimer();
  renderSettingsPanel();

  // The one moment a fresh Drive authentication is allowed to happen
  // automatically: right on unlock, since it's a real user gesture and so
  // is far less likely to be blocked as a pop-up than a background timer.
  // If it fails, drive.js does not retry on its own — Settings will just
  // show "Not connected" with a manual Connect button.
  if(window.VitalsDrive && window.VitalsDrive.reconnectIfNeeded){
    window.VitalsDrive.reconnectIfNeeded().then(()=> renderSettingsPanel());
  }
}
function lockAppNow(){
  startLockFlow();
}
function isAppLocked(){
  return !$('#lock').classList.contains('hidden');
}
function armAutoLockTimer(){
  clearAutoLockTimer();
  const settings = DB.getSettings();
  if(!settings.pinHash) return; // nothing configured to lock behind
  if(isAppLocked()) return;
  autoLockTimer = setTimeout(()=>{
    autoLockTimer = null;
    // Belt-and-braces: only actually lock if we're still hidden and still
    // unlocked when the timer fires (the user may have come straight back).
    if(document.visibilityState === 'hidden' && !isAppLocked()){
      lockAppNow();
    }
  }, AUTO_LOCK_DELAY_MS);
}
function clearAutoLockTimer(){
  if(autoLockTimer){ clearTimeout(autoLockTimer); autoLockTimer = null; }
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
function updateOfflineBanner(){
  const banner = $('#offline-banner');
  if(!banner) return;
  banner.classList.toggle('show', !navigator.onLine);
}
function formatRelativeShort(ts){
  if(!ts) return '';
  const diffSec = Math.max(0, Math.floor((Date.now()-ts)/1000));
  if(diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec/60);
  if(diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin/60);
  if(diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr/24);
  return `${diffDay}d ago`;
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
  const driveSpinner = $('#drive-sync-spinner');
  if(driveSpinner) driveSpinner.hidden = driveState !== 'syncing';

  if(window.VitalsDrive && window.VitalsDrive.isConnected()){
    $('#drive-status-label').textContent = 'Connected';
    const lastSyncAt = window.VitalsDrive.getLastSyncTime ? window.VitalsDrive.getLastSyncTime() : 0;
    const lastSyncSuffix = lastSyncAt ? ` · Last synced ${formatRelativeShort(lastSyncAt)}` : '';
    $('#drive-status-sub').textContent = driveState === 'syncing' ? 'Syncing…' : `New entries back up automatically${lastSyncSuffix}`;
    $('#drive-connect-btn').textContent = 'Disconnect';
    const url = window.VitalsDrive.getSheetUrl();
    if(url){
      $('#drive-sheet-row').style.display = '';
      $('#drive-sheet-link').href = url;
    }
    $('#drive-link-row').style.display = '';
  } else {
    const everConnected = window.VitalsDrive && window.VitalsDrive.hasStoredAuthorization && window.VitalsDrive.hasStoredAuthorization();
    $('#drive-status-label').textContent = driveState === 'authenticating' ? 'Connecting…' : 'Not connected';
    $('#drive-status-sub').textContent = driveState === 'authenticating'
      ? 'Waiting for Google…'
      : everConnected
        ? 'Tap Connect to resume backup'
        : 'Sign in to back up your log to a Google Sheet';
    $('#drive-connect-btn').textContent = 'Connect';
    $('#drive-sheet-row').style.display = 'none';
    $('#drive-link-row').style.display = 'none';
    $('#drive-link-form').style.display = 'none';
  }

  applyTabColorsCollapsed();

  $('#tab-colors-list').innerHTML = allMetricTypes().map(type=>{
    const meta = getMetricMeta(type);
    if(!meta) return '';
    const swatches = ALL_COLORS.map(([key,label,cssVar])=>
      `<button class="swatch${key===meta.colorClass?' selected':''}${haloFillClass(cssVar)}" data-recolor="${type}" data-color="${key}" style="background:var(${cssVar});" aria-label="${label}"></button>`
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
              <div class="settings-label"><span class="color-dot${haloFillClass(meta.colorVar)}" style="background:var(${meta.colorVar});"></span>${escapeHtml(m.name)}</div>
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
  // A fast double-tap could otherwise fire saveEntry() twice before the
  // sheet's closing animation finishes — the first call already resets
  // currentSheetKind/currentEditId via closeSheet(), so a second call
  // landing in that gap would save a malformed/duplicate entry. A short
  // debounce (not tied to the sheet's own open/close lifecycle) blocks the
  // accidental second tap without affecting a deliberate re-tap after
  // fixing a validation error, which is what a tied-to-lifecycle guard
  // would otherwise get wrong.
  let lastSaveClickAt = 0;
  $('#sheet-save-btn').addEventListener('click', ()=>{
    const now = Date.now();
    if(now - lastSaveClickAt < 600) return;
    lastSaveClickAt = now;
    saveEntry();
  });
  $('#sheet-delete-btn').addEventListener('click', deleteCurrent);

  $('#trend-range-toggle').addEventListener('click', ()=>{
    currentTrendRange = currentTrendRange === 7 ? 30 : 7;
    renderTrends();
  });

  $('#trend-cards').addEventListener('click', (e)=>{
    const card = e.target.closest('[data-open-chart]');
    if(card) openChartExpand(card.dataset.openChart);
  });
  const chartExpandClose = $('#chart-expand-close');
  if(chartExpandClose) chartExpandClose.addEventListener('click', closeChartExpand);
  const chartExpandResetBtn = $('#chart-expand-reset-zoom');
  if(chartExpandResetBtn) chartExpandResetBtn.addEventListener('click', resetChartZoom);
  wireChartZoomEvents();

  const tabColorsToggle = $('#tab-colors-toggle');
  if(tabColorsToggle){
    tabColorsToggle.addEventListener('click', ()=>{
      tabColorsCollapsed = !tabColorsCollapsed;
      applyTabColorsCollapsed();
    });
  }

  $('#new-medicine-btn').addEventListener('click', async ()=>{
    const perm = await ensureNotificationPermission();
    if(perm !== 'granted') { }
    openSheet('medicine');
  });
  $('#medicines-list').addEventListener('click', (e)=>{
    const history = e.target.closest('[data-med-history]');
    if(history){ openMedicineHistory(history.dataset.medHistory); return; }
    const toggle = e.target.closest('[data-toggle-medicine]');
    if(toggle){
      const id = toggle.dataset.toggleMedicine;
      const meds = DB.getMedicines();
      const m = meds.find(x=>x.id===id);
      if(m){
        m.enabled = !m.enabled;
        m.updatedAt = Date.now();
        DB.saveMedicines(meds);
        if(window.VitalsDrive && window.VitalsDrive.queueMedicineUpsert) window.VitalsDrive.queueMedicineUpsert(m);
        renderMedicinesList(); renderTodayChecklist(); scheduleAllMedicines();
      }
      return;
    }
    const edit = e.target.closest('[data-edit-medicine]');
    if(edit) openSheet('medicine', edit.dataset.editMedicine);
  });
  wireDoseChecklistDelegation($('#medicines-today-list'));

  $('#medicine-history-back').addEventListener('click', closeMedicineHistory);
  $('#medicine-history-prev-day').addEventListener('click', ()=> shiftMedicineHistoryDay(-1));
  $('#medicine-history-next-day').addEventListener('click', ()=> shiftMedicineHistoryDay(1));
  $('#medicine-history-calendar-btn').addEventListener('click', ()=>{
    const input = $('#medicine-history-date-input');
    if(input.showPicker){ try{ input.showPicker(); } catch(e){ input.focus(); } }
    else { input.focus(); input.click(); }
  });
  $('#medicine-history-date-input').addEventListener('change', (e)=>{
    if(!e.target.value) return;
    const ts = new Date(e.target.value+'T00:00:00').getTime();
    if(startOfDay(ts) > startOfDay(Date.now())) return;
    currentHistoryDate = startOfDay(ts);
    renderMedicineHistoryDay();
  });

  $('#import-medicines-btn').addEventListener('click', openMedicineImport);
  $('#medicine-import-back').addEventListener('click', closeMedicineImport);
  $('#medicine-import-btn').addEventListener('click', importMedicinesFromText);

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

  // "Already using Vitals elsewhere?" — links this device to a spreadsheet
  // ID/URL pasted from another device's "Open your Sheet" link, for the
  // case where each device's narrow 'drive.file' authorization couldn't
  // find the other one's spreadsheet on its own (see linkToExistingSpreadsheet
  // in drive.js for the full explanation).
  $('#drive-link-btn').addEventListener('click', ()=>{
    $('#drive-link-form').style.display = '';
    $('#drive-link-status').textContent = '';
    $('#drive-link-status').className = 'settings-sub';
    $('#drive-link-input').value = '';
    $('#drive-link-input').focus();
  });
  $('#drive-link-cancel').addEventListener('click', ()=>{
    $('#drive-link-form').style.display = 'none';
  });
  $('#drive-link-confirm').addEventListener('click', async ()=>{
    if(!window.VitalsDrive || !window.VitalsDrive.linkToExistingSpreadsheet) return;
    const input = $('#drive-link-input').value;
    const statusEl = $('#drive-link-status');
    const confirmBtn = $('#drive-link-confirm');
    statusEl.className = 'settings-sub';
    statusEl.textContent = 'Linking…';
    confirmBtn.disabled = true;
    try{
      const result = await window.VitalsDrive.linkToExistingSpreadsheet(input);
      if(result.ok){
        statusEl.className = 'settings-sub ok';
        statusEl.textContent = `Linked to "${result.title || 'that sheet'}" — pulling in its data…`;
        renderAll();
        renderSettingsPanel();
        setTimeout(()=>{ $('#drive-link-form').style.display = 'none'; }, 1500);
      } else {
        statusEl.className = 'settings-sub err';
        statusEl.textContent = result.error || 'Could not link to that sheet.';
      }
    } finally {
      confirmBtn.disabled = false;
    }
  });
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
    // Medicines may have been added/edited/removed by the other device.
    scheduleAllMedicines();
  });

  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState === 'visible'){
      clearAutoLockTimer();
      checkMedicinesTick();
      if(window.VitalsDrive){
        if(window.VitalsDrive.syncNow) window.VitalsDrive.syncNow();
        if(window.VitalsDrive.flushQueue) window.VitalsDrive.flushQueue();
      }
    } else {
      // Screen off, app switched away from, or tab hidden — start the
      // auto-lock countdown (armAutoLockTimer no-ops if there's no PIN set
      // or the lock screen is already showing).
      armAutoLockTimer();
    }
  });

  window.addEventListener('online', ()=>{
    updateOfflineBanner();
    if(window.VitalsDrive){
      if(window.VitalsDrive.syncNow) window.VitalsDrive.syncNow();
      if(window.VitalsDrive.flushQueue) window.VitalsDrive.flushQueue();
    }
  });

  window.addEventListener('offline', updateOfflineBanner);
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
  updateOfflineBanner();
  startLockFlow();
  scheduleAllMedicines();

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

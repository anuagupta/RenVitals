'use strict';
/* =========================================================================
   Vitals — dashboard.js
   A read-only, passcode-gated view of the same data the phone app shows,
   built for sharing as a single link. No editing, no local storage of
   health data, no write access of any kind — it only ever reads from the
   public "anyone with the link can view" Google Sheet the app already
   backs up to.

   The passcode is a soft lock, not real security: this is a static page,
   so anyone who opened the browser dev tools could read the hash below or
   just call the sheet URL directly. It exists to keep a shared link from
   being casually opened by the wrong person, not to withstand someone
   determined. That's the tradeoff that was agreed on when this was built.
   ========================================================================= */

const SHEET_ID = '1uo5E1Zc-cNFA79WiO_IAtnG-cIKeYnGstyE21AkqpiM';
const SHEET_TAB = 'Sheet1';
const METRICS_TAB = 'Metrics';
// SHA-256 of the passcode. Never store the passcode itself in this file.
const PASSCODE_HASH = '0ee372d0a0fefa4431a2ece96d93c06f3984e8cb8d2d1c4003549e975413bf3e';
const UNLOCK_KEY = 'vitals-dash:unlocked';
const REFRESH_MS = 60000;

function csvUrl(tab){
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}&_=${Date.now()}`;
}

/* ---------------------------------------------------------------------
   Minimal CSV parser — handles quoted fields, embedded commas, embedded
   newlines, and "" escaped quotes, which Google's CSV export uses.
   --------------------------------------------------------------------- */
function parseCSV(text){
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for(let i=0;i<text.length;i++){
    const c = text[i], next = text[i+1];
    if(inQuotes){
      if(c === '"' && next === '"'){ field += '"'; i++; }
      else if(c === '"'){ inQuotes = false; }
      else field += c;
    } else {
      if(c === '"') inQuotes = true;
      else if(c === ','){ row.push(field); field = ''; }
      else if(c === '\n'){ row.push(field); rows.push(row); row = []; field = ''; }
      else if(c === '\r'){ /* skip, \n follows */ }
      else field += c;
    }
  }
  if(field !== '' || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r => r.length && !(r.length===1 && r[0]===''));
}

async function fetchTab(tab){
  const res = await fetch(csvUrl(tab), {cache:'no-store'});
  if(!res.ok) throw new Error('HTTP ' + res.status + ' for ' + tab);
  const text = await res.text();
  const rows = parseCSV(text);
  return rows.slice(1); // drop header row
}

/* ---------------------------------------------------------------------
   Row → entry / metric (mirrors drive.js's rowToEntry exactly, since
   that's the format this sheet is actually written in)
   --------------------------------------------------------------------- */
function rowToEntry(row){
  if(!row || !row[0]) return null;
  const id = row[0];
  const type = row[1] || '';
  const date = row[2] || '';
  const time = row[3] || '00:00';
  const parsedTs = Date.parse(`${date}T${time}:00`);
  const ts = isNaN(parsedTs) ? null : parsedTs;
  const deleted = String(row[13] || '').toUpperCase() === 'TRUE';
  if(deleted || ts === null) return null;

  const entry = {id, type, ts};
  if(type === 'liquid' || type === 'urine'){
    entry.amount = Number(row[4]) || 0;
    if(type === 'liquid') entry.drink = row[5] || '';
  } else if(type === 'bp'){
    entry.systolic = Number(row[6]) || 0;
    entry.diastolic = Number(row[7]) || 0;
    entry.pulse = row[8] === '' || row[8] == null ? null : Number(row[8]);
  } else if(type === 'sugar'){
    entry.value = Number(row[9]) || 0;
    const context = String(row[10] || '').toLowerCase();
    entry.context = context === 'before meal' ? 'before' : context === 'after meal' ? 'after' : 'fasting';
  } else if(type){
    // custom metric — Value column (O / index 14) is current format,
    // Note column (L / index 11) is the old fallback format.
    if(row[14] !== '' && row[14] != null && !isNaN(Number(row[14]))){
      entry.value = Number(row[14]);
    } else if(row[11] !== '' && row[11] != null && !isNaN(Number(row[11]))){
      entry.value = Number(row[11]);
    }
  }
  return entry;
}

function rowToMetric(row){
  if(!row || !row[0]) return null;
  const deleted = String(row[5] || '').toUpperCase() === 'TRUE';
  if(deleted) return null;
  return {id: row[0], name: row[1] || 'Custom metric', unit: row[2] || '', colorClass: row[3] || 'orange'};
}

/* ---------------------------------------------------------------------
   Same visual language as the app: icons, colors, halo-safe white
   --------------------------------------------------------------------- */
const ICONS = {
  liquid: '<path d="M12 3s6 6.5 6 11a6 6 0 1 1-12 0c0-4.5 6-11 6-11Z"/>',
  urine:  '<path d="M9 3h6l1 4H8l1-4Z"/><path d="M8 7h8l1.2 11.2A2 2 0 0 1 15.2 20H8.8a2 2 0 0 1-2-2.2L8 7Z"/>',
  bp:     '<path d="M4 12h3l2 6 4-14 2 8h5"/>',
  sugar:  '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  custom: '<path d="M9 3h6M10 3v6.5L5.5 17a2 2 0 0 0 1.7 3h9.6a2 2 0 0 0 1.7-3L14 9.5V3"/><path d="M8.5 14h7"/>',
  weight:     '<rect x="3.5" y="5.5" width="17" height="15" rx="3"/><path d="M8.5 10.5a3.5 3.5 0 0 1 7 0"/><path d="M12 10.5v2.3l1.8 1.8"/>',
  creatinine: '<path d="M9 3h6"/><path d="M9.5 3v9.5a4.5 4.5 0 1 0 5 0V3"/><path d="M9.3 14.5h5.4"/>',
  egfr:       '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l3.5-6"/><path d="M4 17h2M18 17h2"/>',
  tacrolimus: '<rect x="4" y="9.5" width="16" height="7" rx="3.5" transform="rotate(-25 12 13)"/><path d="M9.3 10.3l2.2 5.6" transform="rotate(-25 12 13)"/>'
};
function iconForCustomMetric(name){
  const n = (name || '').toLowerCase();
  if(n.includes('weight')) return ICONS.weight;
  if(n.includes('creatinine')) return ICONS.creatinine;
  if(n.includes('egfr') || n.includes('gfr')) return ICONS.egfr;
  if(n.includes('tacrolimus') || n.includes('tac level')) return ICONS.tacrolimus;
  return ICONS.custom;
}
const TYPE_META = {
  liquid: {label:'Fluid Intake', colorClass:'blue',   colorVar:'--blue',  icon:ICONS.liquid, unit:'mL'},
  urine:  {label:'Urine output', colorClass:'yellow', colorVar:'--yellow',icon:ICONS.urine,  unit:'mL'},
  bp:     {label:'Blood pressure', colorClass:'red',  colorVar:'--red',   icon:ICONS.bp,     unit:'mmHg'},
  sugar:  {label:'Sugar', colorClass:'white', colorVar:'--white', icon:ICONS.sugar, unit:'mg/dL'}
};
function haloClass(colorVar){ return colorVar === '--white' ? ' class="tone-white-line"' : ''; }
function haloRing(colorVar){ return colorVar === '--white' ? ' stroke="var(--white-halo)" stroke-width="1"' : ''; }
function textSafeColorVar(colorClass, colorVar){ return colorClass === 'white' ? '--text' : colorVar; }

function getMetricMeta(type, customMetrics){
  if(TYPE_META[type]) return TYPE_META[type];
  const m = customMetrics[type];
  if(!m) return null;
  return {label:m.name, colorClass:m.colorClass, colorVar:'--'+m.colorClass, icon:iconForCustomMetric(m.name), unit:m.unit, isCustom:true};
}
function allTypesInOrder(customMetrics){
  return ['liquid','urine','bp','sugar'].concat(Object.keys(customMetrics));
}

/* ---------------------------------------------------------------------
   Date helpers (local time, same rules as the app)
   --------------------------------------------------------------------- */
function startOfDay(ts){ const d = new Date(ts); d.setHours(0,0,0,0); return d.getTime(); }
function isToday(ts){ return startOfDay(ts) === startOfDay(Date.now()); }
function sameDay(ts, dateObj){ return startOfDay(ts) === startOfDay(dateObj.getTime()); }
function lastNDates(n){
  const out = [];
  for(let i=n-1;i>=0;i--){
    const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-i);
    out.push(d);
  }
  return out;
}
function formatTime(ts){ return new Date(ts).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}); }
function escapeHtml(str){
  return String(str==null?'':str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function avg(list){ return list.reduce((s,v)=>s+v,0) / list.length; }
function roundSmart(v, digits){
  if(Math.abs(v) >= 100) return Math.round(v);
  const f = Math.pow(10, digits);
  return Math.round(v*f)/f;
}
function pointsToPath(points){ return 'M' + points.map(p => p[0].toFixed(1)+','+p[1].toFixed(1)).join(' L'); }

/* ---------------------------------------------------------------------
   Tiles (Home-screen equivalent — today's summary per parameter)
   --------------------------------------------------------------------- */
function tileHtml(type, entries, customMetrics){
  const meta = getMetricMeta(type, customMetrics);
  if(!meta) return '';
  const list = entries.filter(e=>e.type===type);
  const today = list.filter(e=>isToday(e.ts));
  const latest = list.slice().sort((a,b)=>b.ts-a.ts)[0];

  let valueHtml, subHtml;
  if(type==='liquid' || type==='urine'){
    const total = today.reduce((s,e)=>s+e.amount,0);
    valueHtml = `${total.toLocaleString()}<small> mL today</small>`;
    subHtml = latest ? `Last · ${latest.amount} mL · ${formatTime(latest.ts)}` : 'No entries yet';
  } else if(type==='bp'){
    valueHtml = latest ? `${latest.systolic}<small> / ${latest.diastolic} mmHg</small>` : '—';
    subHtml = latest ? `Pulse ${latest.pulse ?? '—'} · ${formatTime(latest.ts)}` : 'No entries yet';
  } else if(type==='sugar'){
    const contextLabel = {fasting:'Fasting', before:'Before meal', after:'After meal'};
    valueHtml = latest ? `${latest.value}<small> mg/dL</small>` : '—';
    subHtml = latest ? `${contextLabel[latest.context]||'Fasting'} · ${formatTime(latest.ts)}` : 'No entries yet';
  } else {
    valueHtml = latest && latest.value != null ? `${latest.value}<small> ${escapeHtml(meta.unit)}</small>` : '—';
    subHtml = latest ? formatTime(latest.ts) : 'No entries yet';
  }

  return `
    <div class="card ${meta.colorClass}">
      <div class="card-top">
        <div class="card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${meta.icon}</svg></div>
      </div>
      <div class="card-bottom">
        <div class="card-label">${escapeHtml(meta.label)}</div>
        <div class="card-value">${valueHtml}</div>
        <div class="card-time">${subHtml}</div>
      </div>
    </div>`;
}

/* ---------------------------------------------------------------------
   Trends (sparkline cards)
   --------------------------------------------------------------------- */
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
function buildSparkline(values, colorVar){
  const n = values.length;
  const presentIdx = [];
  values.forEach((v,i)=>{ if(v !== null && v !== undefined) presentIdx.push(i); });
  if(!presentIdx.length) return '<text x="150" y="34" text-anchor="middle" fill="var(--text-dim)" font-size="12" font-family="var(--font-body)">No data yet</text>';
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
  return svg;
}
function trendHtml(type, dates, rangeDays, entries, customMetrics){
  const meta = getMetricMeta(type, customMetrics);
  if(!meta) return '';
  const list = entries.filter(e=>e.type===type);
  const isVolume = (type==='liquid' || type==='urine');
  const daily = dailySeriesFor(type, dates, list);
  const spark = buildSparkline(isVolume ? daily.map(v=>v||null) : daily, meta.colorVar);
  const present = isVolume ? daily.filter(v=>v>0) : daily.filter(v=>v!==null);
  const latest = list.slice().sort((a,b)=>b.ts-a.ts)[0];

  let rangeText, currentHtml;
  const dim = 'font-size:13px;color:var(--text-dim);font-family:var(--font-body);';
  if(isVolume){
    rangeText = present.length ? `${rangeDays}d avg ${roundSmart(avg(present), 2).toLocaleString(undefined,{maximumFractionDigits:2})} mL` : 'No data yet';
    const today = list.filter(e=>isToday(e.ts)).reduce((s,e)=>s+e.amount,0);
    currentHtml = `${today.toLocaleString()}<span style="${dim}"> mL today</span>`;
  } else if(type==='bp'){
    rangeText = present.length ? `${rangeDays}d avg sys ${roundSmart(avg(present), 2)}` : 'No data yet';
    currentHtml = latest ? `${latest.systolic}<span style="${dim}"> / ${latest.diastolic} mmHg</span>` : '—';
  } else if(type==='sugar'){
    rangeText = present.length ? `${rangeDays}d avg ${roundSmart(avg(present), 2)} mg/dL` : 'No data yet';
    currentHtml = latest ? `${latest.value}<span style="${dim}"> mg/dL</span>` : '—';
  } else {
    rangeText = present.length ? `${rangeDays}d avg ${roundSmart(avg(present), 2)} ${escapeHtml(meta.unit)}` : 'No data yet';
    currentHtml = latest && latest.value != null ? `${latest.value}<span style="${dim}"> ${escapeHtml(meta.unit)}</span>` : '—';
  }

  return `
    <div class="trend-card">
      <div class="trend-head">
        <span class="trend-name" style="color:var(${textSafeColorVar(meta.colorClass, meta.colorVar)});">${escapeHtml(meta.label)}</span>
        <span class="trend-range">${rangeText}</span>
      </div>
      <div class="trend-current">${currentHtml}</div>
      <svg class="spark" viewBox="0 0 300 64" preserveAspectRatio="none">${spark}</svg>
    </div>`;
}

/* ---------------------------------------------------------------------
   Page wiring
   --------------------------------------------------------------------- */
let ENTRIES = [], CUSTOM_METRICS = {};
let trendRange = 7;

async function sha256Hex(text){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

function render(){
  const types = allTypesInOrder(CUSTOM_METRICS);
  document.getElementById('tiles').innerHTML = types.map(t => tileHtml(t, ENTRIES, CUSTOM_METRICS)).join('');
  const dates = lastNDates(trendRange);
  document.getElementById('trends').innerHTML = types.map(t => trendHtml(t, dates, trendRange, ENTRIES, CUSTOM_METRICS)).join('');
  document.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('active', Number(b.dataset.range) === trendRange));
}

async function loadData(){
  const statusEl = document.getElementById('status');
  statusEl.textContent = 'Refreshing…';
  statusEl.classList.remove('err');
  try{
    const sheet1Rows = await fetchTab(SHEET_TAB);
    ENTRIES = sheet1Rows.map(rowToEntry).filter(Boolean);

    try{
      const metricRows = await fetchTab(METRICS_TAB);
      const map = {};
      metricRows.map(rowToMetric).filter(Boolean).forEach(m => { map[m.id] = m; });
      // Only keep metric definitions that actually have entries, and only
      // trust them if they look like real Metrics rows (a Name column).
      if(Object.values(map).some(m => m.name && m.name !== 'Custom metric')){
        CUSTOM_METRICS = map;
      }
    } catch(e){
      console.warn('Vitals dashboard: Metrics tab not read, falling back to generic labels', e);
    }
    // Any custom-metric type id seen in entries but missing from the
    // Metrics map still gets a tile, just with a generic label — so a
    // Metrics-tab hiccup never hides real data, it just labels it plainly.
    ENTRIES.forEach(e=>{
      if(!TYPE_META[e.type] && !CUSTOM_METRICS[e.type]){
        CUSTOM_METRICS[e.type] = {id:e.type, name:'Custom metric', unit:'', colorClass:'orange'};
      }
    });

    render();
    statusEl.textContent = 'Last updated ' + new Date().toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
  } catch(err){
    console.error(err);
    statusEl.textContent = 'Could not load data — the sheet may not be shared as "Anyone with the link can view," or the connection dropped. Will retry automatically.';
    statusEl.classList.add('err');
  }
}

function showDashboard(){
  document.getElementById('lock').classList.add('hidden');
  document.getElementById('dash').classList.remove('hidden');
  loadData();
  setInterval(loadData, REFRESH_MS);
}

function wireLock(){
  const input = document.getElementById('passcode-input');
  const btn = document.getElementById('passcode-submit');
  const err = document.getElementById('passcode-err');
  async function tryUnlock(){
    const val = input.value.trim();
    if(!val) return;
    const hash = await sha256Hex(val);
    if(hash === PASSCODE_HASH){
      sessionStorage.setItem(UNLOCK_KEY, '1');
      showDashboard();
    } else {
      err.textContent = 'Incorrect passcode';
      input.value = '';
      input.focus();
    }
  }
  btn.addEventListener('click', tryUnlock);
  input.addEventListener('keydown', e => { if(e.key === 'Enter') tryUnlock(); });
}

function wireControls(){
  document.getElementById('refresh-btn').addEventListener('click', loadData);
  document.querySelectorAll('.range-btn').forEach(b=>{
    b.addEventListener('click', ()=>{ trendRange = Number(b.dataset.range); render(); });
  });
}

document.addEventListener('DOMContentLoaded', ()=>{
  wireLock();
  wireControls();
  if(sessionStorage.getItem(UNLOCK_KEY) === '1'){
    showDashboard();
  }
});

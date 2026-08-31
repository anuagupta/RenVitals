'use strict';
/* =========================================================================
   Vitals — dashboard.js
   A read-only mirror of the app's own Home / Trends / Medicines screens,
   built for sharing as a single link that looks and navigates exactly like
   the app (tap a card for its day-by-day detail, tap a medicine for its
   history) but cannot write anything anywhere. It only ever reads — no
   passcode, no local storage of health data, and every control that could
   change data in the real app (add/edit/delete entries, toggle a dose,
   enable/disable a medicine, add a health parameter) simply doesn't exist
   here. The only interactive controls left are pure navigation: switching
   tabs, opening a detail screen, and stepping/jumping between days.

   Data comes straight from the public "anyone with the link can view" tabs
   of the same Google Sheet the app backs up to (Sheet1, Metrics, Medicines,
   DoseLog) — never from a browser's localStorage, since this page is meant
   to open identically on any device. rowToEntry/rowToMetric/rowToMedicine/
   rowToDoseLog mirror drive.js's own row parsers exactly, since that's the
   format this sheet is actually written in.
   ========================================================================= */

const SHEET_ID = '1uo5E1Zc-cNFA79WiO_IAtnG-cIKeYnGstyE21AkqpiM';
const SHEET_TAB = 'Sheet1';
const METRICS_TAB = 'Metrics';
const MEDICINES_TAB = 'Medicines';
const DOSELOG_TAB = 'DoseLog';
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
   Row → record (mirrors drive.js's own row parsers exactly)
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
    } else {
      entry.value = null;
    }
  }
  entry.note = row[11] || '';
  return entry;
}

function rowToMetric(row){
  if(!row || !row[0]) return null;
  const deleted = String(row[5] || '').toUpperCase() === 'TRUE';
  if(deleted) return null;
  return {id: row[0], name: row[1] || 'Custom metric', unit: row[2] || '', colorClass: row[3] || 'orange'};
}

function rowToMedicine(row){
  if(!row || !row[0]) return null;
  const name = String(row[1] || '').trim();
  const deleted = String(row[9] || '').toUpperCase() === 'TRUE';
  if(deleted || !name) return null;
  let days = 'daily';
  try{
    const parsed = JSON.parse(row[4]);
    if(parsed === 'daily' || Array.isArray(parsed)) days = parsed;
  } catch(e){ days = 'daily'; }
  return {
    id: String(row[0]), name,
    dose: row[2] || '',
    time: row[3] || '',
    days,
    enabled: String(row[6] || '').toUpperCase() === 'TRUE',
    createdAt: Number(row[7]) || 0,
    updatedAt: Number(row[8]) || 0
  };
}

function rowToDoseLog(row){
  if(!row || !row[0]) return null;
  const deleted = String(row[6] || '').toUpperCase() === 'TRUE';
  if(deleted) return null;
  return {
    id: String(row[0]),
    medicineId: row[1] || '',
    date: row[2] || '',
    time: row[3] || '',
    status: row[4] || '',
    updatedAt: Number(row[5]) || 0
  };
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
function haloFillClass(colorVar){ return colorVar === '--white' ? ' tone-white-fill' : ''; }
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
   Date / time helpers (local time, same rules as the app)
   --------------------------------------------------------------------- */
function pad2(n){ return String(n).padStart(2,'0'); }
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
function toDateInputValue(ts){ const d = new Date(ts); return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
function dateKeyForDate(d){ return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
function todayKey(){ return dateKeyForDate(new Date()); }
function formatTime(ts){ return new Date(ts).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}); }
function formatHHMM(hhmm){
  const parts = (hhmm||'0:0').split(':').map(Number);
  const d = new Date(); d.setHours(parts[0]||0, parts[1]||0, 0, 0);
  return formatTime(d.getTime());
}
function dayNavLabel(ts){
  if(isToday(ts)) return 'Today';
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1);
  if(sameDay(ts, yesterday)) return 'Yesterday';
  return new Date(ts).toLocaleDateString([], {weekday:'short', day:'numeric', month:'short'});
}
function escapeHtml(str){
  return String(str==null?'':str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function avg(list){ return list.reduce((s,v)=>s+v,0) / (list.length||1); }
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
    <div class="card ${meta.colorClass}" data-open-detail="${type}" role="button" tabindex="0" style="cursor:pointer;">
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
   Trends (sparkline cards — same as the app's Trends tab)
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
   Detail drill-down (day chart + entry list) — same charts the app's
   own detail screen draws, just with no tap-to-edit on the rows.
   --------------------------------------------------------------------- */
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
function detailEntryRow(type, e, meta){
  let amt, note;
  if(type==='liquid' || type==='urine'){ amt = `${e.amount} mL`; note = [e.drink, e.note].filter(Boolean).join(' · '); }
  else if(type==='bp'){ amt = `${e.systolic} / ${e.diastolic} mmHg`; note = [e.pulse?`Pulse ${e.pulse}`:'', e.note].filter(Boolean).join(' · '); }
  else if(type==='sugar'){
    const contextLabel = {fasting:'Fasting', before:'Before meal', after:'After meal'};
    amt = `${e.value} mg/dL`; note = [contextLabel[e.context]||'Fasting', e.note].filter(Boolean).join(' · ');
  } else { amt = `${e.value != null ? e.value : '—'} ${meta ? meta.unit : ''}`.trim(); note = e.note || ''; }
  return `
    <div class="detail-entry">
      <div class="dot${haloFillClass(meta.colorVar)}" style="background:var(${meta.colorVar});"></div>
      <div class="info"><div class="amt">${escapeHtml(amt)}</div>${note?`<div class="note">${escapeHtml(note)}</div>`:''}</div>
      <div class="time">${formatTime(e.ts)}</div>
    </div>`;
}
function detailHeaderValue(type, dayEntries, meta, onToday){
  if(!dayEntries.length) return onToday ? 'No entries today' : 'No entries';
  if(type==='liquid' || type==='urine'){
    const total = dayEntries.reduce((s,e)=>s+e.amount,0);
    return `${total.toLocaleString()} mL` + (onToday ? ' today' : '');
  }
  const last = dayEntries[dayEntries.length-1];
  if(type==='bp') return `${last.systolic} / ${last.diastolic} mmHg` + (last.pulse?` · pulse ${last.pulse}`:'');
  if(type==='sugar'){
    const contextLabel = {fasting:'Fasting', before:'Before meal', after:'After meal'};
    return `${last.value} mg/dL · ${contextLabel[last.context]||'Fasting'}`;
  }
  return `${last.value != null ? last.value : '—'} ${meta ? meta.unit : ''}`.trim();
}

let currentDetailType = null, currentDetailDate = null;

function openDetail(type, dateTs){
  currentDetailType = type;
  currentDetailDate = startOfDay(dateTs != null ? dateTs : Date.now());
  const meta = getMetricMeta(type, CUSTOM_METRICS);
  if(!meta) return;
  const onToday = isToday(currentDetailDate);
  const dayDate = new Date(currentDetailDate);
  const dayEntries = ENTRIES.filter(e=>e.type===type && sameDay(e.ts, dayDate)).sort((a,b)=>a.ts-b.ts);

  document.getElementById('detail-cat').textContent = meta.label;
  document.getElementById('detail-val').textContent = detailHeaderValue(type, dayEntries, meta, onToday);
  document.getElementById('detail-day-label').textContent = dayNavLabel(currentDetailDate);
  const dateInput = document.getElementById('detail-date-input');
  dateInput.max = toDateInputValue(Date.now());
  dateInput.value = toDateInputValue(currentDetailDate);
  document.getElementById('detail-next-day').disabled = onToday;
  document.getElementById('detail-list-title').textContent = onToday ? "Today's entries" : `${dayNavLabel(currentDetailDate)}'s entries`;

  const emptyMsg = onToday ? undefined : 'No entries logged on this day';
  let chartSvg;
  if(type==='liquid' || type==='urine') chartSvg = buildBarChart(dayEntries, meta.colorVar, emptyMsg);
  else if(type==='bp') chartSvg = buildBpChart(dayEntries, meta.colorVar, emptyMsg);
  else chartSvg = buildSugarChart(dayEntries, meta.colorVar, emptyMsg);
  document.getElementById('detail-chart').innerHTML = chartSvg;

  document.getElementById('detail-entries').innerHTML = dayEntries.length
    ? dayEntries.slice().reverse().map(e=>detailEntryRow(type,e,meta)).join('')
    : `<p class="empty-hint">No entries logged ${onToday ? 'today' : 'on this day'}.</p>`;

  document.getElementById('detail').classList.add('show');
}
function shiftDetailDay(deltaDays){
  const d = new Date(currentDetailDate);
  d.setDate(d.getDate() + deltaDays);
  if(startOfDay(d.getTime()) > startOfDay(Date.now())) return;
  openDetail(currentDetailType, d.getTime());
}
function closeDetail(){
  document.getElementById('detail').classList.remove('show');
  currentDetailType = null; currentDetailDate = null;
}

/* ---------------------------------------------------------------------
   Medicines — Today checklist (status only, nothing tappable) and All
   medicines (tap a row for its day-by-day history).
   --------------------------------------------------------------------- */
const DOSE_CHECK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>';
const DOSE_DASH_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 12h12"/></svg>';

function matchesTodayMed(medicine, date){
  if(medicine.days === 'daily') return true;
  return Array.isArray(medicine.days) && medicine.days.includes(date.getDay());
}
function doseKeyFor(medId, dateKey, time){ return medId+'|'+dateKey+'|'+time; }
function getDoseStatus(doseKey){
  const entry = DOSELOG[doseKey];
  return entry ? entry.status : 'pending';
}
function repeatDaysText(m){
  if(m.days === 'daily') return 'Daily';
  if(!m.days || !m.days.length) return 'Once';
  const names = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return m.days.slice().sort().map(d=>names[d]).join(', ');
}
function doseUrgency(inst, now){
  if(inst.status === 'taken') return 'taken';
  if(inst.status === 'skipped') return 'skipped';
  return (now - inst.scheduledTs) >= 15*60*1000 ? 'overdue' : 'pending';
}
function todaysDoseInstances(){
  const now = new Date();
  const dateKey = todayKey();
  const meds = MEDICINES.filter(m=>m.enabled).filter(m=>matchesTodayMed(m, now));
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
function doseRowHtml(inst){
  const urgency = doseUrgency(inst, Date.now());
  const iconClass = urgency === 'pending' ? '' : ' '+urgency;
  const iconSvg = urgency === 'taken' ? DOSE_CHECK_ICON : urgency === 'skipped' ? DOSE_DASH_ICON : '';
  const statusText = {taken:'Taken', skipped:'Skipped', overdue:'Overdue', pending:'Not yet due'}[urgency];
  return `
    <div class="dose-row">
      <div class="dose-check${iconClass}" style="cursor:default;">${iconSvg}</div>
      <div class="alarm-info"><div class="alarm-label">${escapeHtml(inst.medicine.name)}${inst.medicine.dose?` <span style="font-weight:400;color:var(--text-dim);">· ${escapeHtml(inst.medicine.dose)}</span>`:''}</div><div class="alarm-sub">${formatHHMM(inst.medicine.time)} · ${statusText}</div></div>
    </div>`;
}
function todaysDoseInstancesHtml(instances){
  let html = '';
  let lastLabel = null;
  instances.forEach(inst=>{
    const label = formatHHMM(inst.medicine.time);
    if(label !== lastLabel){
      html += `<div class="dose-time-header"><span>${label}</span></div>`;
      lastLabel = label;
    }
    html += doseRowHtml(inst);
  });
  return html;
}
function renderTodayChecklist(){
  const box = document.getElementById('medicines-today-list');
  if(!box) return;
  const instances = todaysDoseInstances();
  box.innerHTML = instances.length ? todaysDoseInstancesHtml(instances) : '<p class="empty-hint">No medicines scheduled for today.</p>';
}
function renderMedicinesList(){
  const box = document.getElementById('medicines-list');
  if(!box) return;
  if(!MEDICINES.length){
    box.innerHTML = '<p class="empty-hint">No medicines yet.</p>';
    return;
  }
  box.innerHTML = MEDICINES.map(m=>`
    <div class="alarm-row" data-med-history="${m.id}" style="cursor:pointer;">
      <div class="switch${m.enabled?' on':''}" style="pointer-events:none;"><div class="switch-knob"></div></div>
      <div class="alarm-info"><div class="alarm-label">${escapeHtml(m.name)}${m.dose?` <span style="font-weight:400;color:var(--text-dim);">· ${escapeHtml(m.dose)}</span>`:''}</div><div class="alarm-sub">${repeatDaysText(m)} · ${formatHHMM(m.time)}</div></div>
      <div class="alarm-edit" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.5" y="5" width="17" height="16" rx="3"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></svg>
      </div>
    </div>`).join('');
}
function applyMedicinesListCollapsed(){
  const panel = document.getElementById('medicines-list');
  const toggle = document.getElementById('medicines-list-toggle');
  const chevron = document.getElementById('medicines-list-chevron');
  if(!panel || !toggle) return;
  panel.classList.toggle('collapsed', medicinesListCollapsed);
  toggle.setAttribute('aria-expanded', medicinesListCollapsed ? 'false' : 'true');
  if(chevron) chevron.classList.toggle('rotated', !medicinesListCollapsed);
}

/* ---------------------------------------------------------------------
   Medicine history (day-by-day, per medicine — read-only)
   --------------------------------------------------------------------- */
let currentHistoryMedId = null, currentHistoryDate = null;

function doseStatusForDate(medicine, dateTs){
  const d = new Date(dateTs);
  if(medicine.createdAt && startOfDay(dateTs) < startOfDay(medicine.createdAt)) return 'not-scheduled';
  if(!matchesTodayMed(medicine, d)) return 'not-scheduled';

  const dateKey = dateKeyForDate(d);
  const entry = DOSELOG[doseKeyFor(medicine.id, dateKey, medicine.time)];
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
  document.getElementById('medicine-history').classList.add('show');
}
function closeMedicineHistory(){
  document.getElementById('medicine-history').classList.remove('show');
  currentHistoryMedId = null; currentHistoryDate = null;
}
function renderMedicineHistoryDay(){
  if(!currentHistoryMedId) return;
  const medicine = MEDICINES.find(m=>m.id===currentHistoryMedId);
  if(!medicine){ closeMedicineHistory(); return; }

  document.getElementById('medicine-history-name').textContent = medicine.name;
  document.getElementById('medicine-history-dose').textContent = medicine.dose || '';
  document.getElementById('medicine-history-day-label').textContent = dayNavLabel(currentHistoryDate);
  const dateInput = document.getElementById('medicine-history-date-input');
  dateInput.max = toDateInputValue(Date.now());
  dateInput.value = toDateInputValue(currentHistoryDate);
  document.getElementById('medicine-history-next-day').disabled = isToday(currentHistoryDate);

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

  document.getElementById('medicine-history-status-card').innerHTML = `
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

/* ---------------------------------------------------------------------
   Tab navigation
   --------------------------------------------------------------------- */
let medicinesListCollapsed = true;

function showPanel(name){
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('panel-'+name).classList.add('active');
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===name));
  if(name === 'medicines'){
    // Matches the app: "All medicines" always starts collapsed on entering
    // this tab, so the Today checklist is the first thing you see.
    medicinesListCollapsed = true;
    applyMedicinesListCollapsed();
  }
}

/* ---------------------------------------------------------------------
   Page-wide state + data loading
   --------------------------------------------------------------------- */
let ENTRIES = [], CUSTOM_METRICS = {}, MEDICINES = [], DOSELOG = {};
let trendRange = 7;

function renderHomeGrid(){
  const types = allTypesInOrder(CUSTOM_METRICS);
  document.getElementById('home-grid').innerHTML = types.map(t => tileHtml(t, ENTRIES, CUSTOM_METRICS)).join('');
}
function renderTrendsPanel(){
  document.getElementById('trend-range-toggle').textContent = `Last ${trendRange} days`;
  const dates = lastNDates(trendRange);
  const types = allTypesInOrder(CUSTOM_METRICS);
  document.getElementById('trend-cards').innerHTML = types.map(t => trendHtml(t, dates, trendRange, ENTRIES, CUSTOM_METRICS)).join('');
}
function renderAll(){
  renderHomeGrid();
  renderTrendsPanel();
  renderTodayChecklist();
  renderMedicinesList();
  applyMedicinesListCollapsed();
  if(currentDetailType && document.getElementById('detail').classList.contains('show')){
    openDetail(currentDetailType, currentDetailDate);
  }
  if(currentHistoryMedId && document.getElementById('medicine-history').classList.contains('show')){
    renderMedicineHistoryDay();
  }
}

async function loadData(){
  const statusEl = document.getElementById('dash-status');
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

    try{
      const medRows = await fetchTab(MEDICINES_TAB);
      const map = {};
      medRows.map(rowToMedicine).filter(Boolean).forEach(m=>{
        const existing = map[m.id];
        if(!existing || (m.updatedAt||0) >= (existing.updatedAt||0)) map[m.id] = m;
      });
      MEDICINES = Object.values(map).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
    } catch(e){
      console.warn('Vitals dashboard: Medicines tab not read', e);
      MEDICINES = [];
    }

    try{
      const doseRows = await fetchTab(DOSELOG_TAB);
      const map = {};
      doseRows.map(rowToDoseLog).filter(Boolean).forEach(entry=>{
        const existing = map[entry.id];
        if(!existing || (entry.updatedAt||0) >= (existing.updatedAt||0)) map[entry.id] = entry;
      });
      DOSELOG = map;
    } catch(e){
      console.warn('Vitals dashboard: DoseLog tab not read', e);
      DOSELOG = {};
    }

    renderAll();
    statusEl.textContent = 'Updated ' + new Date().toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
  } catch(err){
    console.error(err);
    statusEl.textContent = 'Could not load data — the sheet may not be shared as "Anyone with the link can view," or the connection dropped. Retrying automatically.';
    statusEl.classList.add('err');
  }
}

/* ---------------------------------------------------------------------
   Event wiring — every control left here is navigation, never input.
   --------------------------------------------------------------------- */
function wireEvents(){
  document.querySelectorAll('.tab').forEach(tab=> tab.addEventListener('click', ()=> showPanel(tab.dataset.tab)));
  document.getElementById('refresh-btn').addEventListener('click', loadData);

  document.getElementById('home-grid').addEventListener('click', (e)=>{
    const card = e.target.closest('[data-open-detail]');
    if(card) openDetail(card.dataset.openDetail);
  });
  document.getElementById('home-grid').addEventListener('keydown', (e)=>{
    if(e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('[data-open-detail]');
    if(card){ e.preventDefault(); openDetail(card.dataset.openDetail); }
  });

  document.getElementById('trend-range-toggle').addEventListener('click', ()=>{
    trendRange = trendRange === 7 ? 30 : 7;
    renderTrendsPanel();
  });

  document.getElementById('detail-back').addEventListener('click', closeDetail);
  document.getElementById('detail-prev-day').addEventListener('click', ()=> shiftDetailDay(-1));
  document.getElementById('detail-next-day').addEventListener('click', ()=> shiftDetailDay(1));
  document.getElementById('detail-calendar-btn').addEventListener('click', ()=>{
    const input = document.getElementById('detail-date-input');
    if(input.showPicker){ try{ input.showPicker(); } catch(e){ input.focus(); } }
    else { input.focus(); input.click(); }
  });
  document.getElementById('detail-date-input').addEventListener('change', (e)=>{
    if(!e.target.value) return;
    openDetail(currentDetailType, new Date(e.target.value+'T00:00:00').getTime());
  });

  document.getElementById('medicines-list-toggle').addEventListener('click', ()=>{
    medicinesListCollapsed = !medicinesListCollapsed;
    applyMedicinesListCollapsed();
  });
  document.getElementById('medicines-list').addEventListener('click', (e)=>{
    const row = e.target.closest('[data-med-history]');
    if(row) openMedicineHistory(row.dataset.medHistory);
  });
  document.getElementById('medicine-history-back').addEventListener('click', closeMedicineHistory);
  document.getElementById('medicine-history-prev-day').addEventListener('click', ()=> shiftMedicineHistoryDay(-1));
  document.getElementById('medicine-history-next-day').addEventListener('click', ()=> shiftMedicineHistoryDay(1));
  document.getElementById('medicine-history-calendar-btn').addEventListener('click', ()=>{
    const input = document.getElementById('medicine-history-date-input');
    if(input.showPicker){ try{ input.showPicker(); } catch(e){ input.focus(); } }
    else { input.focus(); input.click(); }
  });
  document.getElementById('medicine-history-date-input').addEventListener('change', (e)=>{
    if(!e.target.value) return;
    const ts = new Date(e.target.value+'T00:00:00').getTime();
    if(startOfDay(ts) > startOfDay(Date.now())) return;
    currentHistoryDate = startOfDay(ts);
    renderMedicineHistoryDay();
  });
}

document.addEventListener('DOMContentLoaded', ()=>{
  wireEvents();
  loadData();
  setInterval(loadData, REFRESH_MS);
});

'use strict';
/* =========================================================================
   Vitals — drive.js
   Optional one-way backup: every new/edited/deleted entry gets pushed to a
   Google Sheet in the signed-in user's own Drive. Local storage (app.js)
   is always the source of truth — this module never reads the sheet back.

   SETUP REQUIRED: paste your own Google OAuth Client ID below. See
   README.md for step-by-step instructions on creating one for free.
   ========================================================================= */

const DRIVE_CONFIG = {
  CLIENT_ID: '724605143169-61ikt0nqu8i0j0rev323itqetk9phl72.apps.googleusercontent.com,
  SCOPES: 'https://www.googleapis.com/auth/drive.file',
  SHEET_NAME: 'Vitals Health Log',
  SHEET_TAB: 'Sheet1'
};
const HEADER_ROW = ['ID','Type','Date','Time','Amount (mL)','Drink','Systolic','Diastolic','Pulse','Sugar (mg/dL)','Context','Note'];

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;
let spreadsheetId = localStorage.getItem('vitals:drive:spreadsheetId') || null;
let flushing = false;

function isConfigured(){
  return DRIVE_CONFIG.CLIENT_ID && !DRIVE_CONFIG.CLIENT_ID.includes('PASTE_YOUR');
}
function notifyStatus(){
  window.dispatchEvent(new CustomEvent('vitals-drive-status', {
    detail: { connected: !!accessToken, sheetUrl: getSheetUrl() }
  }));
}
function getSheetUrl(){
  return spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` : null;
}

function ensureTokenClient(){
  if(tokenClient) return true;
  if(!window.google || !window.google.accounts || !window.google.accounts.oauth2){
    console.warn('Vitals: Google Identity Services script has not loaded yet.');
    return false;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: DRIVE_CONFIG.CLIENT_ID,
    scope: DRIVE_CONFIG.SCOPES,
    callback: () => {} // overwritten per-call below
  });
  return true;
}

function requestToken(promptMode){
  return new Promise((resolve, reject) => {
    if(!ensureTokenClient()){ reject(new Error('Google Identity Services not ready')); return; }
    tokenClient.callback = (resp) => {
      if(resp.error){ reject(resp); return; }
      accessToken = resp.access_token;
      tokenExpiry = Date.now() + (resp.expires_in * 1000);
      resolve(accessToken);
    };
    tokenClient.requestAccessToken({ prompt: promptMode });
  });
}
async function ensureValidToken(){
  if(accessToken && Date.now() < tokenExpiry - 30000) return accessToken;
  return requestToken(accessToken ? '' : 'consent');
}

async function signIn(){
  if(!isConfigured()){
    alert('Google Drive sync needs a one-time setup step first. See the README for how to create a free Google Client ID, then paste it into drive.js.');
    return;
  }
  try{
    await requestToken('consent');
    await afterSignIn();
  } catch(e){
    console.warn('Vitals: Drive sign-in failed or was cancelled', e);
  }
}
function disconnect(){
  accessToken = null;
  notifyStatus();
}
async function afterSignIn(){
  if(!spreadsheetId){
    try{
      spreadsheetId = await findOrCreateSheet();
      localStorage.setItem('vitals:drive:spreadsheetId', spreadsheetId);
    } catch(e){
      console.warn('Vitals: could not find or create the Drive sheet', e);
      notifyStatus();
      return;
    }
  }
  notifyStatus();
  flushQueue();
}

async function apiFetch(url, opts){
  const token = await ensureValidToken();
  const headers = Object.assign({}, opts && opts.headers, { Authorization: 'Bearer ' + token });
  const resp = await fetch(url, Object.assign({}, opts, { headers }));
  if(!resp.ok){
    const text = await resp.text().catch(()=> '');
    throw new Error(`Drive API ${resp.status}: ${text}`);
  }
  return resp.status === 204 ? null : resp.json();
}

async function findOrCreateSheet(){
  const q = encodeURIComponent(`name='${DRIVE_CONFIG.SHEET_NAME}' and trashed=false`);
  const search = await apiFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
  if(search.files && search.files.length) return search.files[0].id;

  const created = await apiFetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ properties: { title: DRIVE_CONFIG.SHEET_NAME } })
  });
  const id = created.spreadsheetId;
  await apiFetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${DRIVE_CONFIG.SHEET_TAB}!A1:L1?valueInputOption=RAW`, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ values: [HEADER_ROW] })
  });
  return id;
}

function entryToRow(entry){
  const d = new Date(entry.ts);
  const pad2 = n => String(n).padStart(2,'0');
  const dateStr = d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());
  const timeStr = pad2(d.getHours())+':'+pad2(d.getMinutes());
  const contextLabels = {fasting:'Fasting', before:'Before meal', after:'After meal'};
  return [
    entry.id, entry.type, dateStr, timeStr,
    (entry.type==='liquid'||entry.type==='urine') ? entry.amount : '',
    entry.type==='liquid' ? (entry.drink||'') : '',
    entry.type==='bp' ? entry.systolic : '', entry.type==='bp' ? entry.diastolic : '', entry.type==='bp' ? (entry.pulse||'') : '',
    entry.type==='sugar' ? entry.value : '', entry.type==='sugar' ? (contextLabels[entry.context]||'') : '',
    entry.note || ''
  ];
}

async function findRowNumberById(id){
  const data = await apiFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${DRIVE_CONFIG.SHEET_TAB}!A:A`);
  const rows = data.values || [];
  for(let i=0;i<rows.length;i++){ if(rows[i][0] === id) return i+1; }
  return null;
}
async function appendRow(entry){
  await apiFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${DRIVE_CONFIG.SHEET_TAB}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ values: [entryToRow(entry)] })
  });
}
async function upsertRow(entry){
  const rowNum = await findRowNumberById(entry.id);
  if(!rowNum){ await appendRow(entry); return; }
  await apiFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${DRIVE_CONFIG.SHEET_TAB}!A${rowNum}:L${rowNum}?valueInputOption=RAW`, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ values: [entryToRow(entry)] })
  });
}
async function clearRow(id){
  const rowNum = await findRowNumberById(id);
  if(!rowNum) return;
  await apiFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${DRIVE_CONFIG.SHEET_TAB}!A${rowNum}:L${rowNum}:clear`, {
    method: 'POST'
  });
}

/* ---------------------------------------------------------------------
   Offline queue — survives closing the app; flushed when signed in + online
   --------------------------------------------------------------------- */
function getQueue(){
  try{ return JSON.parse(localStorage.getItem('vitals:drive:queue') || '[]'); }
  catch(e){ return []; }
}
function saveQueue(q){ localStorage.setItem('vitals:drive:queue', JSON.stringify(q)); }

function queueUpsert(entry){
  const q = getQueue().filter(item => !(item.op==='upsert' && item.entry.id===entry.id) && !(item.op==='delete' && item.id===entry.id));
  q.push({ op:'upsert', entry });
  saveQueue(q);
  flushQueue();
}
function queueDelete(id){
  const q = getQueue().filter(item => !(item.op==='upsert' && item.entry.id===id) && !(item.op==='delete' && item.id===id));
  q.push({ op:'delete', id });
  saveQueue(q);
  flushQueue();
}
async function flushQueue(){
  if(flushing || !accessToken || !spreadsheetId || !navigator.onLine) return;
  flushing = true;
  try{
    let q = getQueue();
    while(q.length){
      const item = q[0];
      try{
        if(item.op === 'upsert') await upsertRow(item.entry);
        else await clearRow(item.id);
      } catch(e){
        console.warn('Vitals: Drive sync item failed, will retry later', e);
        break; // stop here, keep remaining queue for next attempt
      }
      q.shift();
      saveQueue(q);
    }
  } finally {
    flushing = false;
  }
}

/* ---------------------------------------------------------------------
   Public API
   --------------------------------------------------------------------- */
window.VitalsDrive = {
  init(){
    setInterval(flushQueue, 60000);
    if(accessToken) notifyStatus();
  },
  signIn,
  disconnect,
  isConnected: () => !!accessToken,
  isConfigured,
  getSheetUrl,
  queueUpsert,
  queueDelete,
  flushQueue
};

'use strict';

/* ================================================================
   VITALS — GOOGLE DRIVE / GOOGLE SHEETS TWO-WAY SYNC
   ================================================================ */

const DRIVE_CONFIG = {
  CLIENT_ID: '724605143169-61ikt0nqu8i0j0rev323itqetk9phl72.apps.googleusercontent.com',
  SCOPES: 'https://www.googleapis.com/auth/drive.file',
  SHEET_NAME: 'Vitals Health Log',
  SHEET_TAB: 'Sheet1',
  CONFIG_TAB: 'Config'
};

/*
   Sheet1 columns:

   A  ID
   B  Type
   C  Date
   D  Time
   E  Amount (mL)
   F  Drink
   G  Systolic
   H  Diastolic
   I  Pulse
   J  Sugar (mg/dL)
   K  Context
   L  Note
   M  UpdatedAt
   N  Deleted
   O  Value

   O is used for custom metrics such as:
   Weight
   Serum creatinine
   eGFR
   Tacrolimus level
   etc.
*/

const HEADER_ROW = [
  'ID',
  'Type',
  'Date',
  'Time',
  'Amount (mL)',
  'Drink',
  'Systolic',
  'Diastolic',
  'Pulse',
  'Sugar (mg/dL)',
  'Context',
  'Note',
  'UpdatedAt',
  'Deleted',
  'Value'
];

const CONFIG_HEADER_ROW = [
  'ID',
  'Name',
  'Unit',
  'ColorClass',
  'UpdatedAt',
  'Deleted'
];

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;

let spreadsheetId =
  localStorage.getItem('vitals:drive:spreadsheetId') || null;

let syncing = false;
let flushing = false;


/* ================================================================
   BASIC HELPERS
   ================================================================ */

function isConfigured(){
  return !!(
    DRIVE_CONFIG.CLIENT_ID &&
    !DRIVE_CONFIG.CLIENT_ID.includes('PASTE_YOUR')
  );
}

function getSheetUrl(){
  return spreadsheetId
    ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`
    : null;
}

function notifyStatus(extra){
  window.dispatchEvent(
    new CustomEvent('vitals-drive-status',{
      detail:Object.assign({
        connected:!!accessToken,
        sheetUrl:getSheetUrl()
      },extra || {})
    })
  );
}

function notifyDataChanged(){
  window.dispatchEvent(
    new CustomEvent('vitals-drive-data-changed')
  );
}


/* ================================================================
   GOOGLE AUTHENTICATION
   ================================================================ */

function ensureTokenClient(){

  if(tokenClient) return true;

  if(
    !window.google ||
    !google.accounts ||
    !google.accounts.oauth2
  ){
    return false;
  }

  tokenClient =
    google.accounts.oauth2.initTokenClient({

      client_id:DRIVE_CONFIG.CLIENT_ID,

      scope:DRIVE_CONFIG.SCOPES,

      callback:()=>{}
    });

  return true;
}

function requestToken(promptMode){

  return new Promise((resolve,reject)=>{

    if(!ensureTokenClient()){
      reject(
        new Error('Google Identity Services not loaded')
      );
      return;
    }

    tokenClient.callback = response => {

      if(!response || response.error){
        reject(response || new Error('Google authentication failed'));
        return;
      }

      accessToken = response.access_token;

      tokenExpiry =
        Date.now() +
        ((Number(response.expires_in) || 3600) * 1000);

      notifyStatus();

      resolve(accessToken);
    };

    try{

      tokenClient.requestAccessToken({
        prompt:promptMode || ''
      });

    }catch(error){

      reject(error);
    }
  });
}

async function ensureValidToken(interactive=false){

  if(
    accessToken &&
    Date.now() < tokenExpiry - 30000
  ){
    return accessToken;
  }

  return requestToken(
    interactive ? 'consent' : ''
  );
}

async function signIn(){

  if(!isConfigured()){
    alert('Google Drive is not configured.');
    return false;
  }

  try{

    await requestToken('consent');

    await afterSignIn();

    return true;

  }catch(error){

    console.warn(
      'Vitals: Google sign-in failed',
      error
    );

    notifyStatus({
      connected:false,
      error:'Google sign-in failed'
    });

    return false;
  }
}

function disconnect(){

  accessToken = null;
  tokenExpiry = 0;

  notifyStatus({
    connected:false
  });
}


/* ================================================================
   GOOGLE API
   ================================================================ */

async function apiFetch(url,options={}){

  let token;

  try{

    token =
      await ensureValidToken(false);

  }catch(error){

    throw error;
  }

  const headers = Object.assign(
    {},
    options.headers || {},
    {
      Authorization:'Bearer ' + token
    }
  );

  let response =
    await fetch(
      url,
      Object.assign(
        {},
        options,
        {headers}
      )
    );

  /*
     Access token may have expired.
     Get a fresh token once and retry.
  */

  if(response.status === 401){

    accessToken = null;
    tokenExpiry = 0;

    token =
      await ensureValidToken(false);

    headers.Authorization =
      'Bearer ' + token;

    response =
      await fetch(
        url,
        Object.assign(
          {},
          options,
          {headers}
        )
      );
  }

  if(!response.ok){

    const text =
      await response.text().catch(()=>'');

    throw new Error(
      `Google API ${response.status}: ${text}`
    );
  }

  if(response.status === 204){
    return null;
  }

  return response.json();
}


/* ================================================================
   FIND / CREATE SHEET
   ================================================================ */

async function findOrCreateSheet(){

  const query =
    encodeURIComponent(
      `name='${DRIVE_CONFIG.SHEET_NAME}' and trashed=false`
    );

  const result =
    await apiFetch(
      `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`
    );

  if(
    result.files &&
    result.files.length
  ){
    return result.files[0].id;
  }

  const created =
    await apiFetch(
      'https://sheets.googleapis.com/v4/spreadsheets',
      {
        method:'POST',

        headers:{
          'Content-Type':'application/json'
        },

        body:JSON.stringify({
          properties:{
            title:DRIVE_CONFIG.SHEET_NAME
          }
        })
      }
    );

  return created.spreadsheetId;
}


/* ================================================================
   SHEET HEADERS
   ================================================================ */

async function ensureHeader(){

  await apiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${DRIVE_CONFIG.SHEET_TAB}!A1:O1?valueInputOption=RAW`,
    {
      method:'PUT',

      headers:{
        'Content-Type':'application/json'
      },

      body:JSON.stringify({
        values:[HEADER_ROW]
      })
    }
  );
}


/* ================================================================
   CONFIG SHEET — CUSTOM METRICS
   ================================================================ */

async function getSpreadsheetMetadata(){

  return apiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`
  );
}

async function ensureConfigSheet(){

  const meta =
    await getSpreadsheetMetadata();

  const sheets =
    (meta.sheets || []).map(
      s => s.properties
    );

  const existing =
    sheets.find(
      s => s.title === DRIVE_CONFIG.CONFIG_TAB
    );

  if(existing){
    return existing.sheetId;
  }

  const result =
    await apiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      {
        method:'POST',

        headers:{
          'Content-Type':'application/json'
        },

        body:JSON.stringify({
          requests:[
            {
              addSheet:{
                properties:{
                  title:DRIVE_CONFIG.CONFIG_TAB
                }
              }
            }
          ]
        })
      }
    );

  return result
    ?.replies?.[0]
    ?.addSheet
    ?.properties
    ?.sheetId || null;
}

async function ensureConfigHeader(){

  await ensureConfigSheet();

  await apiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${DRIVE_CONFIG.CONFIG_TAB}!A1:F1?valueInputOption=RAW`,
    {
      method:'PUT',

      headers:{
        'Content-Type':'application/json'
      },

      body:JSON.stringify({
        values:[CONFIG_HEADER_ROW]
      })
    }
  );
}

function metricToRow(metric,deleted=false){

  return [
    metric.id || '',
    metric.name || '',
    metric.unit || '',
    metric.colorClass || 'orange',
    Number(metric.updatedAt) || Date.now(),
    deleted ? 'TRUE' : 'FALSE'
  ];
}

function rowToMetric(row){

  if(!row || !row[0]){
    return null;
  }

  return {
    id:row[0],
    name:row[1] || '',
    unit:row[2] || '',
    colorClass:row[3] || 'orange',
    updatedAt:Number(row[4]) || 0,
    deleted:
      String(row[5] || '').toUpperCase() === 'TRUE'
  };
}

async function getRemoteMetrics(){

  const result =
    await apiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${DRIVE_CONFIG.CONFIG_TAB}!A2:F`
    );

  const map = new Map();

  (result.values || []).forEach(row=>{

    const metric =
      rowToMetric(row);

    if(metric){
      map.set(metric.id,metric);
    }
  });

  return map;
}

async function findMetricRow(id){

  const result =
    await apiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${DRIVE_CONFIG.CONFIG_TAB}!A:A`
    );

  const rows =
    result.values || [];

  for(let i=0;i<rows.length;i++){

    if(rows[i][0] === id){
      return i + 1;
    }
  }

  return null;
}

async function writeMetric(metric,deleted=false){

  const row =
    metricToRow(metric,deleted);

  const rowNumber =
    await findMetricRow(metric.id);

  if(!rowNumber){

    await apiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${DRIVE_CONFIG.CONFIG_TAB}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method:'POST',

        headers:{
          'Content-Type':'application/json'
        },

        body:JSON.stringify({
          values:[row]
        })
      }
    );

    return;
  }

  await apiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${DRIVE_CONFIG.CONFIG_TAB}!A${rowNumber}:F${rowNumber}?valueInputOption=RAW`,
    {
      method:'PUT',

      headers:{
        'Content-Type':'application/json'
      },

      body:JSON.stringify({
        values:[row]
      })
    }
  );
}

async function syncCustomMetrics(){

  await ensureConfigHeader();

  const remote =
    await getRemoteMetrics();

  const local =
    DB.getCustomMetrics() || [];

  const localMap =
    new Map(
      local.map(
        m => [
          m.id,
          Object.assign(
            {},
            m,
            {
              updatedAt:
                Number(m.updatedAt) || 1
            }
          )
        ]
      )
    );

  const merged =
    new Map(localMap);

  const uploads = [];

  /*
     Remote → local
  */

  for(const [id,remoteMetric] of remote){

    const localMetric =
      localMap.get(id);

    if(remoteMetric.deleted){

      if(
        !localMetric ||
        remoteMetric.updatedAt >=
        Number(localMetric.updatedAt || 0)
      ){

        merged.delete(id);

      }else{

        uploads.push(localMetric);
      }

      continue;
    }

    if(!localMetric){

      merged.set(
        id,
        remoteMetric
      );

      continue;
    }

    const rt =
      Number(remoteMetric.updatedAt) || 0;

    const lt =
      Number(localMetric.updatedAt) || 0;

    if(rt > lt){

      merged.set(
        id,
        remoteMetric
      );

    }else if(lt > rt){

      uploads.push(localMetric);
    }
  }

  /*
     Local-only metrics → remote
  */

  for(
    const [id,localMetric]
    of localMap
  ){

    if(!remote.has(id)){
      uploads.push(localMetric);
    }
  }

  /*
     Save merged local definitions.
  */

  const finalMetrics =
    Array.from(
      merged.values()
    ).map(metric=>{

      const copy =
        Object.assign({},metric);

      delete copy.deleted;

      return copy;
    });

  DB.saveCustomMetrics(
    finalMetrics
  );

  /*
     Upload local winners.
  */

  for(const metric of uploads){

    await writeMetric(
      metric,
      false
    );
  }
}


/* ================================================================
   ENTRY → SHEET ROW
   ================================================================ */

function entryToRow(entry,deleted=false){

  const date =
    new Date(
      Number(entry.ts) || Date.now()
    );

  const pad =
    n => String(n).padStart(2,'0');

  const dateString =
    `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;

  const timeString =
    `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  const contextLabels = {
    fasting:'Fasting',
    before:'Before meal',
    after:'After meal'
  };

  let amount = '';
  let drink = '';
  let systolic = '';
  let diastolic = '';
  let pulse = '';
  let sugar = '';
  let context = '';
  let value = '';

  if(
    entry.type === 'liquid' ||
    entry.type === 'urine'
  ){
    amount =
      entry.amount == null
        ? ''
        : entry.amount;
  }

  if(entry.type === 'liquid'){
    drink =
      entry.drink || '';
  }

  if(entry.type === 'bp'){

    systolic =
      entry.systolic == null
        ? ''
        : entry.systolic;

    diastolic =
      entry.diastolic == null
        ? ''
        : entry.diastolic;

    pulse =
      entry.pulse == null
        ? ''
        : entry.pulse;
  }

  if(entry.type === 'sugar'){

    sugar =
      entry.value == null
        ? ''
        : entry.value;

    context =
      contextLabels[entry.context] || '';
  }

  /*
     Custom metrics.
  */

  if(
    entry.type !== 'liquid' &&
    entry.type !== 'urine' &&
    entry.type !== 'bp' &&
    entry.type !== 'sugar'
  ){

    value =
      entry.value == null
        ? ''
        : entry.value;
  }

  return [
    entry.id || '',
    entry.type || '',
    dateString,
    timeString,
    amount,
    drink,
    systolic,
    diastolic,
    pulse,
    sugar,
    context,
    entry.note || '',
    Number(entry.updatedAt) || Date.now(),
    deleted ? 'TRUE' : 'FALSE',
    value
  ];
}


/* ================================================================
   SHEET ROW → ENTRY
   ================================================================ */

function rowToEntry(row){

  if(!row || !row[0]){
    return null;
  }

  const id =
    row[0];

  const type =
    row[1] || '';

  const date =
    row[2] || '';

  const time =
    row[3] || '00:00';

  const parsed =
    Date.parse(
      `${date}T${time}:00`
    );

  const ts =
    Number.isNaN(parsed)
      ? Date.now()
      : parsed;

  const updatedAt =
    Number(row[12]) || ts;

  const deleted =
    String(row[13] || '')
      .toUpperCase() === 'TRUE';

  if(deleted){

    return {
      id,
      updatedAt,
      deleted:true
    };
  }

  const entry = {
    id,
    type,
    ts,
    updatedAt
  };

  if(
    type === 'liquid' ||
    type === 'urine'
  ){

    entry.amount =
      Number(row[4]) || 0;
  }

  if(type === 'liquid'){
    entry.drink =
      row[5] || '';
  }

  if(type === 'bp'){

    entry.systolic =
      Number(row[6]) || 0;

    entry.diastolic =
      Number(row[7]) || 0;

    entry.pulse =
      row[8] === '' ||
      row[8] == null
        ? null
        : Number(row[8]);
  }

  if(type === 'sugar'){

    entry.value =
      Number(row[9]) || 0;

    const c =
      String(row[10] || '')
        .toLowerCase();

    if(c === 'before meal'){
      entry.context = 'before';
    }else if(c === 'after meal'){
      entry.context = 'after';
    }else{
      entry.context = 'fasting';
    }
  }

  /*
     Custom metric value lives in column O.
  */

  if(
    type !== 'liquid' &&
    type !== 'urine' &&
    type !== 'bp' &&
    type !== 'sugar'
  ){

    entry.value =
      Number(row[14]) || 0;
  }

  entry.note =
    row[11] || '';

  return entry;
}


/* ================================================================
   REMOTE DATA
   ================================================================ */

async function getAllRows(){

  const result =
    await apiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${DRIVE_CONFIG.SHEET_TAB}!A2:O`
    );

  return result.values || [];
}

async function getRemoteMap(){

  const rows =
    await getAllRows();

  const map =
    new Map();

  rows.forEach(row=>{

    const entry =
      rowToEntry(row);

    if(entry && entry.id){

      map.set(
        entry.id,
        entry
      );
    }
  });

  return map;
}


/* ================================================================
   FIND / WRITE ENTRY ROW
   ================================================================ */

async function findEntryRow(id){

  const result =
    await apiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${DRIVE_CONFIG.SHEET_TAB}!A:A`
    );

  const rows =
    result.values || [];

  for(let i=0;i<rows.length;i++){

    if(rows[i][0] === id){
      return i + 1;
    }
  }

  return null;
}

async function writeEntryRow(
  entry,
  deleted=false
){

  const row =
    entryToRow(
      entry,
      deleted
    );

  const rowNumber =
    await findEntryRow(entry.id);

  if(!rowNumber){

    await apiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${DRIVE_CONFIG.SHEET_TAB}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method:'POST',

        headers:{
          'Content-Type':'application/json'
        },

        body:JSON.stringify({
          values:[row]
        })
      }
    );

    return;
  }

  await apiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${DRIVE_CONFIG.SHEET_TAB}!A${rowNumber}:O${rowNumber}?valueInputOption=RAW`,
    {
      method:'PUT',

      headers:{
        'Content-Type':'application/json'
      },

      body:JSON.stringify({
        values:[row]
      })
    }
  );
}


/* ================================================================
   TWO-WAY SYNC
   ================================================================ */

async function syncNow(){

  if(
    syncing ||
    !accessToken ||
    !spreadsheetId ||
    !navigator.onLine
  ){
    return false;
  }

  syncing = true;

  try{

    /*
       FIRST: synchronize custom metric definitions.
       This is what allows Weight to appear on the tablet.
    */

    await syncCustomMetrics();

    /*
       THEN: synchronize readings.
    */

    const remote =
      await getRemoteMap();

    const local =
      DB.getEntries() || [];

    const localMap =
      new Map(
        local.map(
          e => [e.id,e]
        )
      );

    const merged =
      new Map(localMap);

    const uploads = [];

    /*
       Remote records.
    */

    for(
      const [id,remoteEntry]
      of remote
    ){

      const localEntry =
        localMap.get(id);

      if(remoteEntry.deleted){

        if(
          !localEntry ||
          Number(remoteEntry.updatedAt || 0) >=
          Number(localEntry.updatedAt || 0)
        ){

          merged.delete(id);

        }else{

          uploads.push({
            entry:localEntry,
            deleted:false
          });
        }

        continue;
      }

      /*
         Exists only on remote.
      */

      if(!localEntry){

        merged.set(
          id,
          remoteEntry
        );

        continue;
      }

      const rt =
        Number(remoteEntry.updatedAt || 0);

      const lt =
        Number(localEntry.updatedAt || 0);

      if(rt > lt){

        merged.set(
          id,
          remoteEntry
        );

      }else if(lt > rt){

        uploads.push({
          entry:localEntry,
          deleted:false
        });
      }
    }

    /*
       Local-only records.
    */

    for(
      const [id,localEntry]
      of localMap
    ){

      if(!remote.has(id)){

        uploads.push({
          entry:localEntry,
          deleted:false
        });
      }
    }

    /*
       Save merged local database.
    */

    const mergedList =
      Array.from(
        merged.values()
      )
      .filter(
        e => e && e.id && !e.deleted
      )
      .sort(
        (a,b)=>
          (a.ts || 0) -
          (b.ts || 0)
      );

    DB.saveEntries(
      mergedList
    );

    /*
       Refresh the Vitals UI.
    */

    notifyDataChanged();

    /*
       Upload local winners.
    */

    for(const item of uploads){

      await writeEntryRow(
        item.entry,
        item.deleted
      );
    }

    notifyStatus({
      connected:true,
      lastSyncAt:Date.now()
    });

    return true;

  }catch(error){

    console.warn(
      'Vitals Drive sync failed:',
      error
    );

    notifyStatus({
      connected:!!accessToken,
      error:'Sync failed — will retry'
    });

    return false;

  }finally{

    syncing = false;
  }
}


/* ================================================================
   OFFLINE QUEUE
   ================================================================ */

function getQueue(){

  try{

    return JSON.parse(
      localStorage.getItem(
        'vitals:drive:queue'
      ) || '[]'
    );

  }catch(e){

    return [];
  }
}

function saveQueue(queue){

  localStorage.setItem(
    'vitals:drive:queue',
    JSON.stringify(queue)
  );
}

function queueUpsert(entry){

  const queue =
    getQueue().filter(item=>{

      if(
        item.op === 'upsert' &&
        item.entry &&
        item.entry.id === entry.id
      ){
        return false;
      }

      if(
        item.op === 'delete' &&
        item.id === entry.id
      ){
        return false;
      }

      return true;
    });

  queue.push({
    op:'upsert',
    entry
  });

  saveQueue(queue);

  flushQueue();
}

function queueDelete(
  id,
  updatedAt
){

  const queue =
    getQueue().filter(item=>{

      if(
        item.op === 'upsert' &&
        item.entry &&
        item.entry.id === id
      ){
        return false;
      }

      if(
        item.op === 'delete' &&
        item.id === id
      ){
        return false;
      }

      return true;
    });

  queue.push({
    op:'delete',
    id,
    updatedAt:
      Number(updatedAt) || Date.now()
  });

  saveQueue(queue);

  flushQueue();
}

async function flushQueue(){

  if(
    flushing ||
    !accessToken ||
    !spreadsheetId ||
    !navigator.onLine
  ){
    return;
  }

  flushing = true;

  try{

    const queue =
      getQueue();

    while(queue.length){

      const item =
        queue[0];

      try{

        if(item.op === 'upsert'){

          await writeEntryRow(
            item.entry,
            false
          );

        }else if(item.op === 'delete'){

          const tombstone = {
            id:item.id,
            type:'deleted',
            ts:Number(item.updatedAt) || Date.now(),
            updatedAt:Number(item.updatedAt) || Date.now()
          };

          await writeEntryRow(
            tombstone,
            true
          );
        }

      }catch(error){

        console.warn(
          'Vitals queue item failed:',
          error
        );

        break;
      }

      queue.shift();

      saveQueue(queue);
    }

  }finally{

    flushing = false;
  }
}


/* ================================================================
   AFTER SIGN-IN
   ================================================================ */

async function afterSignIn(){

  if(!spreadsheetId){

    spreadsheetId =
      await findOrCreateSheet();

    localStorage.setItem(
      'vitals:drive:spreadsheetId',
      spreadsheetId
    );
  }

  await ensureHeader();

  await ensureConfigHeader();

  notifyStatus({
    connected:true
  });

  /*
     Pull first, then push.
  */

  await syncNow();

  await flushQueue();
}


/* ================================================================
   AUTOMATIC RECONNECTION
   ================================================================ */

async function attemptRestore(){

  if(
    accessToken ||
    !navigator.onLine ||
    !isConfigured()
  ){
    return;
  }

  try{

    /*
       Empty prompt attempts silent token reuse.
       If Google refuses it, we simply remain disconnected.
       The user can manually reconnect.
    */

    await requestToken('');

    await afterSignIn();

  }catch(error){

    console.log(
      'Vitals: silent Drive reconnect unavailable.'
    );

    notifyStatus({
      connected:false,
      needsReconnect:true
    });
  }
}


/* ================================================================
   ONLINE EVENT
   ================================================================ */

window.addEventListener(
  'online',
  async ()=>{

    await attemptRestore();

    if(accessToken){

      await syncNow();

      await flushQueue();
    }
  }
);


/* ================================================================
   PUBLIC API
   ================================================================ */

window.VitalsDrive = {

  init(){

    /*
       Try to restore an existing Google authorization.
    */

    setTimeout(
      attemptRestore,
      700
    );

    /*
       Periodic synchronization.
    */

    setInterval(
      async ()=>{

        if(!accessToken){

          await attemptRestore();

          return;
        }

        await syncNow();

        await flushQueue();

      },
      60000
    );

    /*
       Local data changed.
    */

    window.addEventListener(
      'vitals-local-data-changed',
      async ()=>{

        if(accessToken){

          await flushQueue();

          await syncNow();
        }
      }
    );

    notifyStatus();
  },

  signIn,

  disconnect,

  isConnected(){
    return !!accessToken;
  },

  isConfigured,

  getSheetUrl,

  queueUpsert,

  queueDelete,

  flushQueue,

  syncNow
};

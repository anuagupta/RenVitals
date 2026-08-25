'use strict';

/* =========================================================================
   Vitals — drive.js
   Two-way Google Drive / Google Sheets synchronization.

   Data flow:

        PHONE
          ↕
     Google Sheet
          ↕
        TABLET

   LocalStorage remains the local/offline copy.
   Google Sheet is the shared cross-device copy.
   ========================================================================= */

const DRIVE_CONFIG = {
  CLIENT_ID: 'https://724605143169-61ikt0nqu8i0j0rev323itqetk9phl72.apps.googleusercontent.com',
  SCOPES: 'https://www.googleapis.com/auth/drive.file',
  SHEET_NAME: 'Vitals Health Log',
  SHEET_TAB: 'Sheet1'
};

/*
 * Original Vitals columns:
 * A-L
 *
 * New synchronization columns:
 * M = UpdatedAt
 * N = Deleted
 *
 * Keeping the original first 12 columns means your existing Sheet data
 * remains compatible.
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
  'Deleted'
];

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;

let spreadsheetId =
  localStorage.getItem('vitals:drive:spreadsheetId') || null;

let flushing = false;
let syncing = false;

/* =========================================================================
   BASIC STATUS
   ========================================================================= */

function isConfigured(){
  return DRIVE_CONFIG.CLIENT_ID &&
    !DRIVE_CONFIG.CLIENT_ID.includes('PASTE_YOUR');
}

function getSheetUrl(){
  return spreadsheetId
    ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`
    : null;
}

function notifyStatus(extra){
  window.dispatchEvent(
    new CustomEvent('vitals-drive-status', {
      detail: Object.assign({
        connected: !!accessToken,
        sheetUrl: getSheetUrl()
      }, extra || {})
    })
  );
}

function notifyDataChanged(){
  window.dispatchEvent(
    new CustomEvent('vitals-drive-data-changed')
  );
}

/* =========================================================================
   GOOGLE AUTHENTICATION
   ========================================================================= */

function ensureTokenClient(){

  if(tokenClient) return true;

  if(
    !window.google ||
    !window.google.accounts ||
    !window.google.accounts.oauth2
  ){
    console.warn(
      'Vitals: Google Identity Services script has not loaded yet.'
    );
    return false;
  }

  tokenClient =
    google.accounts.oauth2.initTokenClient({
      client_id: DRIVE_CONFIG.CLIENT_ID,
      scope: DRIVE_CONFIG.SCOPES,
      callback: () => {}
    });

  return true;
}

function requestToken(promptMode){

  return new Promise((resolve, reject) => {

    if(!ensureTokenClient()){
      reject(new Error(
        'Google Identity Services not ready'
      ));
      return;
    }

    tokenClient.callback = (response) => {

      if(response.error){
        reject(response);
        return;
      }

      accessToken = response.access_token;

      tokenExpiry =
        Date.now() +
        ((response.expires_in || 3600) * 1000);

      resolve(accessToken);
    };

    tokenClient.requestAccessToken({
      prompt: promptMode
    });

  });
}

async function ensureValidToken(){

  if(
    accessToken &&
    Date.now() < tokenExpiry - 30000
  ){
    return accessToken;
  }

  return requestToken(
    accessToken ? '' : 'consent'
  );
}

async function signIn(){

  if(!isConfigured()){

    alert(
      'Google Drive sync is not configured yet. ' +
      'Please put your Google OAuth Client ID in drive.js.'
    );

    return;
  }

  try{

    await requestToken('consent');

    await afterSignIn();

  }catch(error){

    console.warn(
      'Vitals: Google Drive sign-in failed',
      error
    );

  }
}

function disconnect(){

  accessToken = null;

  notifyStatus();
}

/* =========================================================================
   GOOGLE API
   ========================================================================= */

async function apiFetch(url, options){

  const token = await ensureValidToken();

  const headers = Object.assign(
    {},
    options && options.headers,
    {
      Authorization: 'Bearer ' + token
    }
  );

  const response = await fetch(
    url,
    Object.assign({}, options || {}, { headers })
  );

  if(!response.ok){

    const text =
      await response.text().catch(() => '');

    throw new Error(
      `Google API ${response.status}: ${text}`
    );
  }

  if(response.status === 204){
    return null;
  }

  return response.json();
}

/* =========================================================================
   FIND / CREATE THE SHARED SHEET
   ========================================================================= */

async function findOrCreateSheet(){

  const query =
    encodeURIComponent(
      `name='${DRIVE_CONFIG.SHEET_NAME}' and trashed=false`
    );

  const search = await apiFetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`
  );

  if(
    search.files &&
    search.files.length
  ){
    return search.files[0].id;
  }

  const created = await apiFetch(
    'https://sheets.googleapis.com/v4/spreadsheets',
    {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({
        properties: {
          title: DRIVE_CONFIG.SHEET_NAME
        }
      })
    }
  );

  return created.spreadsheetId;
}

/* =========================================================================
   ENSURE / UPGRADE HEADER
   ========================================================================= */

async function ensureHeader(){

  const range =
    `${DRIVE_CONFIG.SHEET_TAB}!A1:N1`;

  await apiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
    {
      method: 'PUT',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({
        values: [HEADER_ROW]
      })
    }
  );
}

/* =========================================================================
   SIGN-IN INITIALIZATION
   ========================================================================= */

async function afterSignIn(){

  if(!spreadsheetId){

    try{

      spreadsheetId =
        await findOrCreateSheet();

      localStorage.setItem(
        'vitals:drive:spreadsheetId',
        spreadsheetId
      );

    }catch(error){

      console.warn(
        'Vitals: could not find/create Sheet',
        error
      );

      notifyStatus({
        error: 'Could not open Vitals Health Log'
      });

      return;
    }
  }

  await ensureHeader();

  notifyStatus();

  /*
   * IMPORTANT:
   * First synchronize the Sheet and this device.
   */
  await syncNow();

  await flushQueue();
}

/* =========================================================================
   LOCAL ENTRY → SHEET ROW
   ========================================================================= */

function entryToRow(entry, deleted){

  const d =
    new Date(
      entry.ts || Date.now()
    );

  const pad2 =
    n => String(n).padStart(2, '0');

  const dateStr =
    d.getFullYear() +
    '-' +
    pad2(d.getMonth() + 1) +
    '-' +
    pad2(d.getDate());

  const timeStr =
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes());

  const contextLabels = {
    fasting: 'Fasting',
    before: 'Before meal',
    after: 'After meal'
  };

  return [

    entry.id || '',

    entry.type || '',

    dateStr,

    timeStr,

    (entry.type === 'liquid' ||
     entry.type === 'urine')
      ? entry.amount
      : '',

    entry.type === 'liquid'
      ? (entry.drink || '')
      : '',

    entry.type === 'bp'
      ? entry.systolic
      : '',

    entry.type === 'bp'
      ? entry.diastolic
      : '',

    entry.type === 'bp'
      ? (entry.pulse == null ? '' : entry.pulse)
      : '',

    entry.type === 'sugar'
      ? entry.value
      : '',

    entry.type === 'sugar'
      ? (contextLabels[entry.context] || '')
      : '',

    entry.note || '',

    entry.updatedAt || Date.now(),

    deleted ? 'TRUE' : 'FALSE'
  ];
}

/* =========================================================================
   SHEET ROW → LOCAL ENTRY
   ========================================================================= */

function rowToEntry(row){

  if(!row || !row[0]){
    return null;
  }

  const id = row[0];

  const type = row[1] || '';

  const date = row[2] || '';

  const time = row[3] || '00:00';

  const parsedTs =
    Date.parse(
      `${date}T${time}:00`
    );

  const ts =
    isNaN(parsedTs)
      ? Date.now()
      : parsedTs;

  /*
   * Old rows won't have UpdatedAt.
   * In that case use the entry timestamp.
   */
  const updatedAt =
    Number(row[12]) || ts;

  const deleted =
    String(row[13] || '')
      .toUpperCase() === 'TRUE';

  if(deleted){

    return {
      id,
      updatedAt,
      deleted: true
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

    const context =
      String(row[10] || '')
        .toLowerCase();

    if(context === 'before meal'){
      entry.context = 'before';
    }else if(context === 'after meal'){
      entry.context = 'after';
    }else{
      entry.context = 'fasting';
    }
  }

  /*
   * Custom metrics use .value.
   */
  if(
    type !== 'liquid' &&
    type !== 'urine' &&
    type !== 'bp' &&
    type !== 'sugar'
  ){

    const rawValue = row[11];

    /*
     * For custom metrics the old sheet doesn't have a dedicated value
     * column. We therefore preserve the value in the Note field only
     * for old records if necessary. New custom records are handled by
     * the local entry object and the sync timestamp.
     */
    if(
      rawValue !== undefined &&
      rawValue !== null &&
      rawValue !== ''
    ){
      const n = Number(rawValue);
      if(!isNaN(n)){
        entry.value = n;
      }
    }

    if(entry.value === undefined){
      entry.value = 0;
    }
  }

  entry.note =
    row[11] || '';

  /*
   * The existing app expects custom metric values in .value.
   * If the Sheet row contains a numeric note and this is a custom metric,
   * use it as the value only when appropriate.
   */
  if(
    type !== 'liquid' &&
    type !== 'urine' &&
    type !== 'bp' &&
    type !== 'sugar'
  ){

    const n = Number(row[11]);

    if(!isNaN(n) && row[11] !== ''){
      entry.value = n;
      entry.note = '';
    }
  }

  return entry;
}

/* =========================================================================
   READ ALL SHEET ROWS
   ========================================================================= */

async function getAllRows(){

  const response =
    await apiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${DRIVE_CONFIG.SHEET_TAB}!A2:N`
    );

  return response.values || [];
}

/* =========================================================================
   FIND ROW BY ENTRY ID
   ========================================================================= */

async function findRowNumberById(id){

  const response =
    await apiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${DRIVE_CONFIG.SHEET_TAB}!A:A`
    );

  const rows =
    response.values || [];

  for(let i = 0; i < rows.length; i++){

    if(rows[i][0] === id){
      return i + 1;
    }
  }

  return null;
}

/* =========================================================================
   WRITE / UPDATE ROW
   ========================================================================= */

async function appendRow(entry, deleted){

  await apiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${DRIVE_CONFIG.SHEET_TAB}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({
        values: [
          entryToRow(entry, deleted)
        ]
      })
    }
  );
}

async function upsertRow(entry, deleted){

  const rowNumber =
    await findRowNumberById(entry.id);

  if(!rowNumber){

    await appendRow(
      entry,
      deleted
    );

    return;
  }

  await apiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${DRIVE_CONFIG.SHEET_TAB}!A${rowNumber}:N${rowNumber}?valueInputOption=RAW`,
    {
      method: 'PUT',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({
        values: [
          entryToRow(
            entry,
            deleted
          )
        ]
      })
    }
  );
}

/* =========================================================================
   DOWNLOAD REMOTE DATA
   ========================================================================= */

async function getRemoteMap(){

  const rows =
    await getAllRows();

  const map =
    new Map();

  rows.forEach(row => {

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

/* =========================================================================
   TWO-WAY SYNCHRONIZATION
   ========================================================================= */

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

    const remote =
      await getRemoteMap();

    const local =
      DB.getEntries();

    const localMap =
      new Map(
        local.map(
          entry => [entry.id, entry]
        )
      );

    const merged =
      new Map(localMap);

    const uploads = [];

    /*
     * Compare every record that exists remotely.
     */
    for(const [id, remoteEntry] of remote){

      const localEntry =
        localMap.get(id);

      /*
       * Remote deletion.
       */
      if(remoteEntry.deleted){

        if(
          !localEntry ||
          Number(remoteEntry.updatedAt || 0) >=
          Number(localEntry.updatedAt || 0)
        ){

          merged.delete(id);

        }else{

          /*
           * Local copy is newer.
           * Re-upload it.
           */
          uploads.push({
            entry: localEntry,
            deleted: false
          });
        }

        continue;
      }

      /*
       * Record exists only remotely.
       */
      if(!localEntry){

        merged.set(
          id,
          remoteEntry
        );

        continue;
      }

      const localTime =
        Number(localEntry.updatedAt || 0);

      const remoteTime =
        Number(remoteEntry.updatedAt || 0);

      /*
       * Remote is newer → download it.
       */
      if(remoteTime > localTime){

        merged.set(
          id,
          remoteEntry
        );

      /*
       * Local is newer → upload it.
       */
      }else if(localTime > remoteTime){

        uploads.push({
          entry: localEntry,
          deleted: false
        });
      }
    }

    /*
     * Anything that exists only locally must be uploaded.
     */
    for(const [id, localEntry] of localMap){

      if(!remote.has(id)){

        uploads.push({
          entry: localEntry,
          deleted: false
        });
      }
    }

    /*
     * Save the merged dataset locally.
     */
    const mergedList =
      Array.from(merged.values())
        .filter(
          entry =>
            entry &&
            entry.id &&
            !entry.deleted
        )
        .sort(
          (a,b) =>
            (a.ts || 0) -
            (b.ts || 0)
        );

    DB.saveEntries(
      mergedList
    );

    /*
     * Tell app.js that the visible data has changed.
     */
    notifyDataChanged();

    /*
     * Upload local winners.
     */
    for(const item of uploads){

      await upsertRow(
        item.entry,
        item.deleted
      );
    }

    notifyStatus({
      lastSyncAt: Date.now()
    });

    return true;

  }catch(error){

    console.warn(
      'Vitals: Google Drive synchronization failed',
      error
    );

    notifyStatus({
      error:
        'Sync failed — will retry automatically'
    });

    return false;

  }finally{

    syncing = false;
  }
}

/* =========================================================================
   OFFLINE QUEUE
   ========================================================================= */

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
    getQueue().filter(item => {

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
    op: 'upsert',
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
    getQueue().filter(item => {

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
    op: 'delete',
    id,
    updatedAt:
      updatedAt || Date.now()
  });

  saveQueue(queue);

  flushQueue();
}

/* =========================================================================
   FLUSH OFFLINE CHANGES
   ========================================================================= */

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

    let queue =
      getQueue();

    while(queue.length){

      const item =
        queue[0];

      try{

        if(item.op === 'upsert'){

          await upsertRow(
            item.entry,
            false
          );

        }else if(item.op === 'delete'){

          /*
           * We don't erase the Sheet row.
           * We write a tombstone so the deletion propagates
           * to the other device.
           */
          const tombstone = {
            id: item.id,
            type: 'deleted',
            ts: item.updatedAt || Date.now(),
            updatedAt:
              item.updatedAt || Date.now()
          };

          await upsertRow(
            tombstone,
            true
          );
        }

      }catch(error){

        console.warn(
          'Vitals: queue item failed; will retry',
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

/* =========================================================================
   AUTOMATIC ONLINE SYNC
   ========================================================================= */

window.addEventListener(
  'online',
  () => {

    if(!window.VitalsDrive){
      return;
    }

    window.VitalsDrive
      .syncNow()
      .then(
        () =>
          window.VitalsDrive.flushQueue()
      );
  }
);

/* =========================================================================
   PUBLIC API
   ========================================================================= */

window.VitalsDrive = {

  init(){

    /*
     * Retry synchronization every minute.
     */
    setInterval(
      async () => {

        if(!accessToken){
          return;
        }

        await syncNow();

        await flushQueue();

      },
      60000
    );

    /*
     * Local entry changed.
     */
    window.addEventListener(
      'vitals-local-data-changed',
      () => {

        if(accessToken){

          flushQueue();
        }
      }
    );

    if(accessToken){
      notifyStatus();
    }
  },

  signIn,

  disconnect,

  isConnected:
    () => !!accessToken,

  isConfigured,

  getSheetUrl,

  queueUpsert,

  queueDelete,

  flushQueue,

  syncNow
};

'use strict';

/* =========================================================================
   Vitals — drive.js
   Two-way Google Drive / Google Sheets synchronization.

   IMPORTANT:
   - Sheet1 stores health entries.
   - Metrics stores custom metric definitions (Weight, Serum Creatinine, etc.).
   - Sync is ID/timestamp based and is designed to be idempotent.
   - Custom metric IDs are normalized by metric name so duplicate tiles do not
     multiply when two devices have the same metric under different IDs.
   ========================================================================= */

const DRIVE_CONFIG = {
  CLIENT_ID:'724605143169-61ikt0nqu8i0j0rev323itqetk9phl72.apps.googleusercontent.com',
  SCOPES: 'https://www.googleapis.com/auth/drive.file',
  SHEET_NAME: 'Vitals Health Log',
  SHEET_TAB: 'Sheet1',
  METRICS_TAB: 'Metrics'
};

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

const METRICS_HEADER_ROW = [
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

let flushing = false;
let syncing = false;
let authRestoreStarted = false;


/* =========================================================================
   BASIC HELPERS
   ========================================================================= */

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
    new CustomEvent(
      'vitals-drive-status',
      {
        detail: Object.assign(
          {
            connected: !!accessToken,
            sheetUrl: getSheetUrl()
          },
          extra || {}
        )
      }
    )
  );

}


function notifyDataChanged(){

  window.dispatchEvent(
    new CustomEvent(
      'vitals-drive-data-changed'
    )
  );

}


function normalizeMetricName(name){

  return String(
    name == null ? '' : name
  )
    .trim()
    .replace(/\s+/g,' ')
    .toLowerCase();

}


function metricUpdatedAt(metric){

  return Number(
    metric && metric.updatedAt
  ) || 0;

}


/* =========================================================================
   GOOGLE AUTHENTICATION
   ========================================================================= */

function ensureTokenClient(){

  if(tokenClient){
    return true;
  }

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

      client_id:
        DRIVE_CONFIG.CLIENT_ID,

      scope:
        DRIVE_CONFIG.SCOPES,

      callback:
        () => {}

    });

  return true;

}


function requestToken(promptMode){

  return new Promise(
    (resolve,reject) => {

      if(!ensureTokenClient()){

        reject(
          new Error(
            'Google Identity Services not ready'
          )
        );

        return;
      }

      tokenClient.callback =
        response => {

          if(response.error){

            reject(response);

            return;
          }

          accessToken =
            response.access_token;

          tokenExpiry =
            Date.now() +
            (
              (response.expires_in || 3600) *
              1000
            );

          /*
           * Remember that this device has already authorized
           * the application.
           */
          localStorage.setItem(
            'vitals:drive:authorized',
            '1'
          );

          resolve(accessToken);

        };


      tokenClient.requestAccessToken({

        /*
         * Empty prompt means:
         * reuse the existing Google authorization if possible.
         */
        prompt:
          promptMode || ''

      });

    }
  );

}


async function restoreAuthorizedSession(){

  if(
    authRestoreStarted ||
    accessToken ||
    !isConfigured()
  ){

    return false;
  }

  if(
    localStorage.getItem(
      'vitals:drive:authorized'
    ) !== '1'
  ){

    return false;
  }

  authRestoreStarted = true;

  try{

    /*
     * Silent restoration.
     * This should not show the Google consent screen again.
     */
    await requestToken('');

    return true;

  }catch(error){

    console.warn(
      'Vitals: silent Drive authorization restore failed',
      error
    );

    return false;

  }finally{

    authRestoreStarted = false;

  }

}


async function ensureValidToken(){

  if(
    accessToken &&
    Date.now() <
      tokenExpiry - 30000
  ){

    return accessToken;
  }

  /*
   * After a page/PWA refresh, try the existing authorization
   * silently before asking the user to connect again.
   */
  try{

    return await requestToken('');

  }catch(error){

    /*
     * Do not silently force the consent screen here.
     * Explicit sign-in handles that.
     */
    throw error;

  }

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

    /*
     * Explicit user-initiated connection.
     */
    await requestToken('consent');

    await afterSignIn();

  }catch(error){

    console.warn(
      'Vitals: Google Drive sign-in failed',
      error
    );

    notifyStatus({
      error:
        'Google Drive connection failed'
    });

  }

}


function disconnect(){

  accessToken = null;

  tokenExpiry = 0;

  localStorage.removeItem(
    'vitals:drive:authorized'
  );

  notifyStatus();

}


/* =========================================================================
   GOOGLE API
   ========================================================================= */

async function apiFetch(
  url,
  options
){

  let token =
    await ensureValidToken();

  let headers =
    Object.assign(
      {},
      options && options.headers,
      {
        Authorization:
          'Bearer ' + token
      }
    );

  let response =
    await fetch(
      url,
      Object.assign(
        {},
        options || {},
        {
          headers
        }
      )
    );


  /*
   * Token may have become invalid even though its local expiry
   * has not been reached. Try one silent renewal.
   */
  if(response.status === 401){

    accessToken = null;

    tokenExpiry = 0;

    token =
      await requestToken('');

    headers =
      Object.assign(
        {},
        options && options.headers,
        {
          Authorization:
            'Bearer ' + token
        }
      );

    response =
      await fetch(
        url,
        Object.assign(
          {},
          options || {},
          {
            headers
          }
        )
      );

  }


  if(!response.ok){

    const text =
      await response
        .text()
        .catch(
          () => ''
        );

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
   SPREADSHEET DISCOVERY / CREATION
   ========================================================================= */

async function getSpreadsheetMetadata(){

  return apiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}` +
    `?fields=spreadsheetId,sheets(properties(sheetId,title))`
  );

}


async function ensureTab(title){

  const metadata =
    await getSpreadsheetMetadata();

  const existing =
    (metadata.sheets || [])
      .find(
        sheet =>
          sheet.properties &&
          sheet.properties.title === title
      );

  if(existing){

    return existing.properties.sheetId;

  }


  const result =
    await apiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      {
        method:
          'POST',

        headers:{
          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify({

            requests:[
              {
                addSheet:{
                  properties:{
                    title
                  }
                }
              }
            ]

          })

      }
    );


  if(
    result.replies &&
    result.replies[0] &&
    result.replies[0].addSheet
  ){

    return result
      .replies[0]
      .addSheet
      .properties
      .sheetId;

  }

  return null;

}


async function findOrCreateSheet(){

  const query =
    encodeURIComponent(
      `name='${DRIVE_CONFIG.SHEET_NAME}' and trashed=false`
    );

  const search =
    await apiFetch(
      `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`
    );


  if(
    search.files &&
    search.files.length
  ){

    return search.files[0].id;

  }


  const created =
    await apiFetch(
      'https://sheets.googleapis.com/v4/spreadsheets',
      {
        method:
          'POST',

        headers:{
          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify({

            properties:{
              title:
                DRIVE_CONFIG.SHEET_NAME
            }

          })

      }
    );


  return created.spreadsheetId;

}


/* =========================================================================
   SHEET HEADERS
   ========================================================================= */

async function ensureHeader(){

  const range =
    encodeURIComponent(
      DRIVE_CONFIG.SHEET_TAB +
      '!A1:O1'
    );

  await apiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
    {
      method:
        'PUT',

      headers:{
        'Content-Type':
          'application/json'
      },

      body:
        JSON.stringify({
          values:[
            HEADER_ROW
          ]
        })

    }
  );

}


async function ensureMetricsHeader(){

  /*
   * Create Metrics tab if it doesn't exist.
   */
  await ensureTab(
    DRIVE_CONFIG.METRICS_TAB
  );


  const range =
    encodeURIComponent(
      DRIVE_CONFIG.METRICS_TAB +
      '!A1:F1'
    );


  await apiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
    {
      method:
        'PUT',

      headers:{
        'Content-Type':
          'application/json'
      },

      body:
        JSON.stringify({
          values:[
            METRICS_HEADER_ROW
          ]
        })

    }
  );

}


/* =========================================================================
   AFTER SIGN-IN
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
        error:
          'Could not open Vitals Health Log'
      });

      return;

    }

  }


  await ensureHeader();

  await ensureMetricsHeader();

  notifyStatus();


  /*
   * Synchronize immediately after connecting.
   */
  await syncNow();

  await flushQueue();

}


/* =========================================================================
   ENTRY → SHEET ROW
   ========================================================================= */

function entryToRow(
  entry,
  deleted
){

  const d =
    new Date(
      entry.ts || Date.now()
    );

  const pad2 =
    n =>
      String(n).padStart(2,'0');


  const dateStr =
    d.getFullYear() +
    '-' +
    pad2(d.getMonth()+1) +
    '-' +
    pad2(d.getDate());


  const timeStr =
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes());


  const contextLabels = {

    fasting:
      'Fasting',

    before:
      'Before meal',

    after:
      'After meal'

  };


  const isCustom =
    entry.type &&
    ![
      'liquid',
      'urine',
      'bp',
      'sugar'
    ].includes(
      entry.type
    );


  return [

    entry.id || '',

    entry.type || '',

    dateStr,

    timeStr,

    (
      entry.type === 'liquid' ||
      entry.type === 'urine'
    )
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
      ? (
          entry.pulse == null
            ? ''
            : entry.pulse
        )
      : '',

    entry.type === 'sugar'
      ? entry.value
      : '',

    entry.type === 'sugar'
      ? (
          contextLabels[
            entry.context
          ] || ''
        )
      : '',

    entry.note || '',

    entry.updatedAt ||
      Date.now(),

    deleted
      ? 'TRUE'
      : 'FALSE',

    /*
     * NEW:
     * Custom metric values have their own column.
     */
    isCustom &&
    entry.value != null
      ? entry.value
      : ''

  ];

}


/* =========================================================================
   SHEET ROW → ENTRY
   ========================================================================= */

function rowToEntry(row){

  if(
    !row ||
    !row[0]
  ){

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


  const parsedTs =
    Date.parse(
      `${date}T${time}:00`
    );


  const ts =
    isNaN(parsedTs)
      ? Date.now()
      : parsedTs;


  /*
   * Old rows may not contain UpdatedAt.
   */
  const updatedAt =
    Number(row[12]) ||
    ts;


  const deleted =
    String(
      row[13] || ''
    ).toUpperCase() === 'TRUE';


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

    const context =
      String(
        row[10] || ''
      ).toLowerCase();


    if(
      context === 'before meal'
    ){

      entry.context =
        'before';

    }else if(
      context === 'after meal'
    ){

      entry.context =
        'after';

    }else{

      entry.context =
        'fasting';

    }

  }


  /*
   * Custom metric.
   *
   * New format:
   * O = Value
   *
   * Old format:
   * L = value
   *
   * The fallback keeps old data readable.
   */
  if(
    type !== 'liquid' &&
    type !== 'urine' &&
    type !== 'bp' &&
    type !== 'sugar'
  ){

    if(
      row[14] !== '' &&
      row[14] != null &&
      !isNaN(
        Number(row[14])
      )
    ){

      entry.value =
        Number(row[14]);

    }else if(
      row[11] !== '' &&
      row[11] != null &&
      !isNaN(
        Number(row[11])
      )
    ){

      entry.value =
        Number(row[11]);

    }else{

      entry.value =
        null;

    }


    entry.note =
      row[11] || '';

  }else{

    entry.note =
      row[11] || '';

  }


  return entry;

}


/* =========================================================================
   READ SHEET DATA
   ========================================================================= */

async function getAllRows(){

  const range =
    encodeURIComponent(
      DRIVE_CONFIG.SHEET_TAB +
      '!A2:O'
    );


  const response =
    await apiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`
    );


  return response.values || [];

}


/* =========================================================================
   FIND ENTRY ROW
   ========================================================================= */

async function findRowNumberById(id){

  const range =
    encodeURIComponent(
      DRIVE_CONFIG.SHEET_TAB +
      '!A:A'
    );


  const response =
    await apiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`
    );


  const rows =
    response.values || [];


  for(
    let i=0;
    i<rows.length;
    i++
  ){

    if(
      rows[i][0] === id
    ){

      /*
       * Sheet row number is array index + 1.
       */
      return i + 1;

    }

  }


  return null;

}


/* =========================================================================
   WRITE ENTRY
   ========================================================================= */

async function appendRow(
  entry,
  deleted
){

  const range =
    encodeURIComponent(
      DRIVE_CONFIG.SHEET_TAB +
      '!A1:O1'
    );


  await apiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method:
        'POST',

      headers:{
        'Content-Type':
          'application/json'
      },

      body:
        JSON.stringify({
          values:[
            entryToRow(
              entry,
              deleted
            )
          ]
        })

    }
  );

}


async function upsertRow(
  entry,
  deleted
){

  const rowNumber =
    await findRowNumberById(
      entry.id
    );


  if(!rowNumber){

    await appendRow(
      entry,
      deleted
    );

    return;

  }


  const range =
    encodeURIComponent(
      DRIVE_CONFIG.SHEET_TAB +
      `!A${rowNumber}:O${rowNumber}`
    );


  await apiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
    {
      method:
        'PUT',

      headers:{
        'Content-Type':
          'application/json'
      },

      body:
        JSON.stringify({
          values:[
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
   CUSTOM METRICS
   ========================================================================= */

function metricToRow(
  metric,
  deleted
){

  return [

    metric.id || '',

    metric.name || '',

    metric.unit || '',

    metric.colorClass || '',

    metric.updatedAt ||
      Date.now(),

    deleted
      ? 'TRUE'
      : 'FALSE'

  ];

}


function rowToMetric(row){

  if(
    !row ||
    !row[0]
  ){

    return null;

  }


  const id =
    String(row[0]);

  const name =
    String(
      row[1] || ''
    ).trim();

  const updatedAt =
    Number(row[4]) || 0;

  const deleted =
    String(
      row[5] || ''
    ).toUpperCase() === 'TRUE';


  if(!name){

    return {

      id,

      updatedAt,

      deleted:true

    };

  }


  return {

    id,

    name,

    unit:
      String(
        row[2] || ''
      ),

    colorClass:
      String(
        row[3] || ''
      ),

    updatedAt,

    deleted

  };

}


async function getAllMetricRows(){

  const range =
    encodeURIComponent(
      DRIVE_CONFIG.METRICS_TAB +
      '!A2:F'
    );


  const response =
    await apiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`
    );


  return response.values || [];

}


async function findMetricRowNumberById(
  id
){

  const range =
    encodeURIComponent(
      DRIVE_CONFIG.METRICS_TAB +
      '!A:A'
    );


  const response =
    await apiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`
    );


  const rows =
    response.values || [];


  for(
    let i=0;
    i<rows.length;
    i++
  ){

    if(
      rows[i][0] === id
    ){

      return i + 1;

    }

  }


  return null;

}


async function upsertMetricRow(
  metric,
  deleted
){

  const rowNumber =
    await findMetricRowNumberById(
      metric.id
    );


  if(!rowNumber){

    const range =
      encodeURIComponent(
        DRIVE_CONFIG.METRICS_TAB +
        '!A1:F1'
      );


    await apiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method:
          'POST',

        headers:{
          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify({
            values:[
              metricToRow(
                metric,
                deleted
              )
            ]
          })

      }
    );

    return;

  }


  const range =
    encodeURIComponent(
      DRIVE_CONFIG.METRICS_TAB +
      `!A${rowNumber}:F${rowNumber}`
    );


  await apiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
    {
      method:
        'PUT',

      headers:{
        'Content-Type':
          'application/json'
      },

      body:
        JSON.stringify({
          values:[
            metricToRow(
              metric,
              deleted
            )
          ]
        })

    }
  );

}


/* =========================================================================
   NORMALIZE / DEDUPLICATE CUSTOM METRICS
   ========================================================================= */

function canonicalizeMetrics(
  localMetrics,
  remoteMetrics
){

  const groups =
    new Map();


  function add(
    metric,
    source
  ){

    if(
      !metric ||
      metric.deleted ||
      !metric.name
    ){

      return;

    }


    const key =
      normalizeMetricName(
        metric.name
      );


    if(!key){

      return;

    }


    if(!groups.has(key)){

      groups.set(
        key,
        []
      );

    }


    groups
      .get(key)
      .push({
        metric,
        source
      });

  }


  localMetrics.forEach(
    metric =>
      add(
        metric,
        'local'
      )
  );


  remoteMetrics.forEach(
    metric =>
      add(
        metric,
        'remote'
      )
  );


  const canonical =
    [];

  const idRemap =
    new Map();


  for(
    const [
      key,
      items
    ]
    of groups
  ){

    /*
     * Newest definition wins.
     * If timestamps tie, choose a deterministic ID.
     */
    items.sort(
      (a,b)=>{

        const timeDifference =
          metricUpdatedAt(
            b.metric
          ) -
          metricUpdatedAt(
            a.metric
          );


        if(
          timeDifference
        ){

          return timeDifference;

        }


        return String(
          a.metric.id
        ).localeCompare(
          String(
            b.metric.id
          )
        );

      }
    );


    const winner =
      Object.assign(
        {},
        items[0].metric
      );


    /*
     * Deterministic ID prevents the same metric being represented
     * by a different ID on the phone and tablet.
     */
    const ids =
      new Set(
        items.map(
          item =>
            item.metric.id
        )
      );


    const preferredId =
      Array.from(ids)
        .sort()[0];


    winner.id =
      preferredId;


    for(
      const item
      of items
    ){

      idRemap.set(
        item.metric.id,
        preferredId
      );

    }


    canonical.push(
      winner
    );

  }


  return {

    metrics:
      canonical,

    idRemap

  };

}


/* =========================================================================
   REMAP ENTRIES WHEN A DUPLICATE METRIC ID IS FOUND
   ========================================================================= */

function remapEntries(
  entries,
  idRemap
){

  let changed =
    false;


  const output =
    entries.map(
      entry => {

        if(
          !entry ||
          !entry.type
        ){

          return entry;

        }


        const newType =
          idRemap.get(
            entry.type
          );


        if(
          newType &&
          newType !== entry.type
        ){

          changed = true;


          return Object.assign(
            {},
            entry,
            {
              type:
                newType,

              updatedAt:
                Date.now()
            }
          );

        }


        return entry;

      }
    );


  return {

    entries:
      output,

    changed

  };

}


/* =========================================================================
   SYNCHRONIZE CUSTOM METRICS
   ========================================================================= */

async function syncMetrics(){

  const localMetrics =
    (
      DB.getCustomMetrics
        ? DB.getCustomMetrics()
        : []
    ).map(
      metric =>
        Object.assign(
          {},
          metric
        )
    );


  const remoteRows =
    await getAllMetricRows();


  const remoteMetrics =
    remoteRows
      .map(rowToMetric)
      .filter(Boolean);


  /*
   * Combine phone/tablet metric definitions and collapse duplicate
   * names such as:
   *
   * Serum Creatinine
   * Serum creatinine
   * serum creatinine
   */
  const normalized =
    canonicalizeMetrics(
      localMetrics,
      remoteMetrics
    );


  const metrics =
    normalized.metrics;

  const idRemap =
    normalized.idRemap;


  /*
   * Change existing entries that point to a duplicate metric ID.
   */
  const localEntries =
    DB.getEntries();


  const remapped =
    remapEntries(
      localEntries,
      idRemap
    );


  if(remapped.changed){

    DB.saveEntries(
      remapped.entries
    );

  }


  /*
   * Save the normalized metric definitions locally.
   */
  if(DB.saveCustomMetrics){

    DB.saveCustomMetrics(
      metrics
    );

  }


  /*
   * Make sure every canonical metric exists remotely.
   */
  for(
    const metric
    of metrics
  ){

    await upsertMetricRow(
      metric,
      false
    );

  }


  /*
   * Tombstone old duplicate metric IDs on the remote sheet.
   * This prevents them from coming back during the next sync.
   */
  for(
    const remote
    of remoteMetrics
  ){

    const canonicalId =
      idRemap.get(
        remote.id
      );


    if(
      canonicalId &&
      canonicalId !== remote.id
    ){

      await upsertMetricRow(
        Object.assign(
          {},
          remote,
          {
            updatedAt:
              Date.now()
          }
        ),
        true
      );

    }

  }


  return {

    metrics,

    idRemap

  };

}


/* =========================================================================
   REMOTE ENTRY MAP
   ========================================================================= */

async function getRemoteMap(){

  const rows =
    await getAllRows();


  const map =
    new Map();


  rows.forEach(
    row => {

      const entry =
        rowToEntry(row);


      if(
        entry &&
        entry.id
      ){

        const existing =
          map.get(
            entry.id
          );


        /*
         * If duplicate rows somehow exist in Sheet1,
         * keep the newest one.
         */
        if(
          !existing ||
          Number(
            entry.updatedAt || 0
          ) >=
          Number(
            existing.updatedAt || 0
          )
        ){

          map.set(
            entry.id,
            entry
          );

        }

      }

    }
  );


  return map;

}


/* =========================================================================
   TWO-WAY ENTRY SYNCHRONIZATION
   ========================================================================= */

async function syncEntries(
  idRemap
){

  const remote =
    await getRemoteMap();


  const local =
    DB.getEntries();


  /*
   * Normalize local entries first.
   */
  const localMap =
    new Map();


  local.forEach(
    entry => {

      const normalized =
        Object.assign(
          {},
          entry
        );


      if(
        normalized.type &&
        idRemap.has(
          normalized.type
        )
      ){

        normalized.type =
          idRemap.get(
            normalized.type
          );

      }


      const existing =
        localMap.get(
          normalized.id
        );


      if(
        !existing ||
        Number(
          normalized.updatedAt || 0
        ) >=
        Number(
          existing.updatedAt || 0
        )
      ){

        localMap.set(
          normalized.id,
          normalized
        );

      }

    }
  );


  const merged =
    new Map(
      localMap
    );


  const uploads =
    [];


  /*
   * Compare every remote record.
   */
  for(
    const [
      id,
      remoteOriginal
    ]
    of remote
  ){

    const remoteEntry =
      Object.assign(
        {},
        remoteOriginal
      );


    if(
      remoteEntry.type &&
      idRemap.has(
        remoteEntry.type
      )
    ){

      remoteEntry.type =
        idRemap.get(
          remoteEntry.type
        );

    }


    const localEntry =
      localMap.get(
        id
      );


    /*
     * Remote deletion.
     */
    if(
      remoteEntry.deleted
    ){

      if(
        !localEntry ||
        Number(
          remoteEntry.updatedAt || 0
        ) >=
        Number(
          localEntry.updatedAt || 0
        )
      ){

        merged.delete(
          id
        );

      }else{

        uploads.push({
          entry:
            localEntry,

          deleted:
            false
        });

      }


      continue;

    }


    /*
     * Remote-only record.
     */
    if(!localEntry){

      merged.set(
        id,
        remoteEntry
      );

      continue;

    }


    const localTime =
      Number(
        localEntry.updatedAt || 0
      );


    const remoteTime =
      Number(
        remoteEntry.updatedAt || 0
      );


    /*
     * Remote newer → download.
     */
    if(
      remoteTime >
      localTime
    ){

      merged.set(
        id,
        remoteEntry
      );

    /*
     * Local newer → upload.
     */
    }else if(
      localTime >
      remoteTime
    ){

      uploads.push({
        entry:
          localEntry,

        deleted:
          false
      });

    }

  }


  /*
   * Local-only records → upload.
   */
  for(
    const [
      id,
      localEntry
    ]
    of localMap
  ){

    if(
      !remote.has(id)
    ){

      uploads.push({
        entry:
          localEntry,

        deleted:
          false
      });

    }

  }


  /*
   * Save merged local dataset.
   */
  const mergedList =
    Array.from(
      merged.values()
    )
      .filter(
        entry =>
          entry &&
          entry.id &&
          !entry.deleted
      )
      .sort(
        (a,b)=>
          (a.ts || 0) -
          (b.ts || 0)
      );


  DB.saveEntries(
    mergedList
  );


  notifyDataChanged();


  /*
   * Upload local winners.
   *
   * De-duplicate the upload queue itself.
   */
  const uploadedIds =
    new Set();


  for(
    const item
    of uploads
  ){

    if(
      uploadedIds.has(
        item.entry.id
      )
    ){

      continue;

    }


    uploadedIds.add(
      item.entry.id
    );


    await upsertRow(
      item.entry,
      item.deleted
    );

  }

}


/* =========================================================================
   MAIN SYNCHRONIZATION
   ========================================================================= */

async function syncNow(){

  if(
    syncing ||
    !spreadsheetId ||
    !navigator.onLine
  ){

    return false;

  }


  /*
   * If the page/PWA was refreshed, restore the previous
   * Google authorization silently.
   */
  if(!accessToken){

    try{

      await restoreAuthorizedSession();

    }catch(error){

      console.warn(
        'Vitals: authorization restore failed',
        error
      );

    }

  }


  if(!accessToken){

    return false;

  }


  syncing = true;


  try{

    /*
     * Make sure both tabs exist before reading them.
     */
    await ensureHeader();

    await ensureMetricsHeader();


    /*
     * FIRST:
     * synchronize metric definitions.
     *
     * This is what fixes Weight disappearing and duplicate
     * Serum Creatinine definitions.
     */
    const metricResult =
      await syncMetrics();


    /*
     * SECOND:
     * synchronize actual entries.
     */
    await syncEntries(
      metricResult.idRemap
    );


    notifyStatus({
      lastSyncAt:
        Date.now()
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

  }catch(error){

    return [];

  }

}


function saveQueue(queue){

  localStorage.setItem(
    'vitals:drive:queue',
    JSON.stringify(queue)
  );

}


function queueUpsert(
  entry
){

  const queue =
    getQueue()
      .filter(
        item => {

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

        }
      );


  queue.push({

    op:
      'upsert',

    entry

  });


  saveQueue(
    queue
  );


  flushQueue();

}


function queueDelete(
  id,
  updatedAt
){

  const queue =
    getQueue()
      .filter(
        item => {

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

        }
      );


  queue.push({

    op:
      'delete',

    id,

    updatedAt:
      updatedAt || Date.now()

  });


  saveQueue(
    queue
  );


  flushQueue();

}


/* =========================================================================
   FLUSH OFFLINE CHANGES
   ========================================================================= */

async function flushQueue(){

  if(
    flushing ||
    !spreadsheetId ||
    !navigator.onLine
  ){

    return;

  }


  if(!accessToken){

    try{

      await restoreAuthorizedSession();

    }catch(error){

      return;

    }

  }


  if(!accessToken){

    return;

  }


  flushing = true;


  try{

    let queue =
      getQueue();


    while(
      queue.length
    ){

      const item =
        queue[0];


      try{

        if(
          item.op === 'upsert'
        ){

          await upsertRow(
            item.entry,
            false
          );

        }else if(
          item.op === 'delete'
        ){

          /*
           * We keep the Sheet row and write a tombstone.
           * This allows deletion to propagate to the other device.
           */
          const tombstone = {

            id:
              item.id,

            type:
              'deleted',

            ts:
              item.updatedAt ||
              Date.now(),

            updatedAt:
              item.updatedAt ||
              Date.now()

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

      saveQueue(
        queue
      );

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

    if(
      !window.VitalsDrive
    ){

      return;

    }


    window.VitalsDrive
      .syncNow()
      .then(
        () =>
          window.VitalsDrive
            .flushQueue()
      );

  }
);


/* =========================================================================
   PUBLIC API
   ========================================================================= */

window.VitalsDrive = {

  init(){

    /*
     * Background sync approximately once per minute.
     */
    setInterval(
      async () => {

        if(!spreadsheetId){

          return;

        }


        if(!accessToken){

          await restoreAuthorizedSession();

        }


        if(accessToken){

          await syncNow();

          await flushQueue();

        }

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


    /*
     * Restore an already-authorized Google session after
     * a PWA/page refresh without showing consent again.
     */
    restoreAuthorizedSession()
      .then(
        async restored => {

          if(!restored){

            return;

          }


          try{

            if(!spreadsheetId){

              spreadsheetId =
                await findOrCreateSheet();

              localStorage.setItem(
                'vitals:drive:spreadsheetId',
                spreadsheetId
              );

            }


            await ensureHeader();

            await ensureMetricsHeader();

            notifyStatus();


            await syncNow();

            await flushQueue();


          }catch(error){

            console.warn(
              'Vitals: automatic Drive restore/sync failed',
              error
            );


            notifyStatus({
              error:
                'Drive sync needs attention'
            });

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
    () =>
      !!accessToken,

  isConfigured,

  getSheetUrl,

  queueUpsert,

  queueDelete,

  flushQueue,

  syncNow

};

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
  METRICS_TAB: 'Metrics',
  ALARMS_TAB: 'Alarms'
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

const ALARMS_HEADER_ROW = [
  'ID',
  'Label',
  'Time',
  'Days',
  'Tone',
  'Enabled',
  'UpdatedAt',
  'Deleted'
];

const ACCESS_TOKEN_KEY = 'vitals:drive:accessToken';
const TOKEN_EXPIRY_KEY = 'vitals:drive:tokenExpiry';
const LAST_SYNC_KEY = 'vitals:drive:lastSyncAt';

let tokenClient = null;

/*
 * The access token used to live ONLY in memory, which meant every single
 * page refresh threw away a perfectly valid, unexpired token and forced a
 * brand new silent-auth attempt — and that attempt has no user gesture
 * behind it, so browsers routinely block it as a popup (this is what
 * "connection lost on every refresh" actually was). The fix: persist the
 * token itself, not just a boolean "was authorized" flag, and restore it
 * straight from storage — no Google call at all — as long as it hasn't
 * actually expired yet. A real Google round-trip is then only needed
 * roughly once an hour (when the token genuinely expires), not on every
 * refresh/visibility-change/app-reopen.
 */
let accessToken =
  localStorage.getItem(ACCESS_TOKEN_KEY) || null;

let tokenExpiry =
  Number(localStorage.getItem(TOKEN_EXPIRY_KEY)) || 0;

if(
  accessToken &&
  Date.now() >= tokenExpiry - 30000
){

  // Stored token is already expired (or expires almost immediately) —
  // don't trust it.
  accessToken = null;
  tokenExpiry = 0;
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXPIRY_KEY);

}

function setAccessToken(token, expiresInSeconds){

  accessToken = token;

  tokenExpiry =
    Date.now() +
    ((expiresInSeconds || 3600) * 1000);

  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  localStorage.setItem(TOKEN_EXPIRY_KEY, String(tokenExpiry));

}

function clearAccessToken(){

  accessToken = null;
  tokenExpiry = 0;

  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXPIRY_KEY);

}


let spreadsheetId =
  localStorage.getItem('vitals:drive:spreadsheetId') || null;

let flushing = false;
let syncing = false;
let authRestoreStarted = false;

/*
 * =========================================================================
 * CONNECTION STATE MACHINE
 *
 * drive.js is the single owner of Drive authentication and connection
 * state. app.js only ever calls signIn() / disconnect() / syncNow() and
 * reads status via the 'vitals-drive-status' event or getState() — it
 * never talks to Google Identity Services directly.
 *
 * States: 'disconnected' | 'authenticating' | 'connected' | 'syncing' | 'error'
 * =========================================================================
 */
let driveState = accessToken ? 'connected' : 'disconnected';

// Automatic (non-user-initiated) silent-restore attempts are throttled so
// that page refreshes, visibility changes and 'online' events happening in
// quick succession (very common when an Android tablet's screen turns on
// and off) cannot hammer Google's auth endpoint or flicker the connection
// UI. A genuinely user-initiated Connect tap (signIn) is never throttled.
let lastAutoAuthAttempt = 0;
const AUTO_AUTH_COOLDOWN_MS = 5 * 60 * 1000;

// Successive syncNow() calls triggered by overlapping triggers (interval +
// visibilitychange + online, all around the same moment) are coalesced so
// the app doesn't re-read the whole sheet several times in a row.
//
// Restored from storage (like the access token) so Settings can show an
// accurate "Last synced …" time immediately after a refresh, instead of
// going blank until the next sync completes in this session.
let lastSyncCompletedAt =
  Number(localStorage.getItem(LAST_SYNC_KEY)) || 0;
const MIN_SYNC_INTERVAL_MS = 20 * 1000;

function setState(next){
  driveState = next;
}


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
            state: driveState,
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

          setAccessToken(
            response.access_token,
            response.expires_in
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

  /*
   * Throttle automatic restore attempts. The very first call after a page
   * load always goes through (lastAutoAuthAttempt starts at 0), but
   * subsequent triggers (visibilitychange, 'online', the 60s interval)
   * within the cooldown window are ignored instead of re-attempting
   * authentication. This is what stops the "disconnect / reconnect" loop
   * that used to happen every time the tablet's screen turned back on.
   */
  const now = Date.now();

  if(
    lastAutoAuthAttempt &&
    (now - lastAutoAuthAttempt) < AUTO_AUTH_COOLDOWN_MS
  ){

    return false;
  }

  lastAutoAuthAttempt = now;

  authRestoreStarted = true;

  setState('authenticating');

  try{

    /*
     * Silent restoration.
     * This should not show the Google consent screen again.
     */
    await requestToken('');

    setState('connected');

    notifyStatus();

    return true;

  }catch(error){

    console.warn(
      'Vitals: silent Drive authorization restore failed',
      error
    );

    setState('disconnected');

    return false;

  }finally{

    authRestoreStarted = false;

  }

}


/*
 * =========================================================================
 * RECONNECT ON UNLOCK
 *
 * This is the ONLY place other than an explicit signIn() tap that is
 * allowed to attempt authentication automatically. app.js calls this
 * exactly once, right when the user successfully unlocks the app (PIN or
 * biometric) — a real user gesture, which is why a silent restore
 * attempted here is far less likely to be blocked as a pop-up than one
 * fired from a timer or a visibility/online event. If it fails (blocked,
 * no network, session truly gone), it does NOT retry — the user simply
 * sees "Not connected" with a manual Connect button, instead of the app
 * silently hammering Google every few minutes.
 * =========================================================================
 */
async function reconnectIfNeeded(){

  if(accessToken){

    return true;

  }

  let restored = false;

  try{

    restored = await restoreAuthorizedSession();

  }catch(error){

    restored = false;

  }

  if(restored){

    await syncNow(true);

    await flushQueue();

  }

  return restored;

}


function hasStoredAuthorization(){

  return localStorage.getItem('vitals:drive:authorized') === '1';

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
   * The access token expired mid-session (e.g. the tablet sat idle for
   * over an hour) — try to renew it silently, once, before asking the
   * user to connect again.
   */
  try{

    return await requestToken('');

  }catch(error){

    /*
     * Do not silently force the consent screen here — explicit sign-in
     * handles that. But DO clear the dead token/expiry and drop to
     * 'disconnected' so the next sync attempt goes through
     * restoreAuthorizedSession()'s throttled path instead of retrying
     * this same silent renewal on every single sync tick.
     */
    clearAccessToken();

    setState('disconnected');

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

  /*
   * This is the ONLY place a visible Google consent screen may be shown —
   * it only runs when the user explicitly taps "Connect" in Settings.
   * Nothing triggered by page load, refresh, visibility or connectivity
   * changes is allowed to call requestToken('consent').
   */
  setState('authenticating');

  notifyStatus();

  try{

    await requestToken('consent');

    setState('connected');

    await afterSignIn();

  }catch(error){

    console.warn(
      'Vitals: Google Drive sign-in failed',
      error
    );

    setState('disconnected');

    notifyStatus({
      error:
        'Google Drive connection failed'
    });

  }

}


function disconnect(){

  clearAccessToken();

  localStorage.removeItem(
    'vitals:drive:authorized'
  );

  setState('disconnected');

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

    clearAccessToken();

    try{

      token =
        await requestToken('');

    }catch(renewError){

      /*
       * The session is genuinely gone (revoked, expired beyond silent
       * renewal, etc). Reflect that immediately instead of leaving the
       * UI claiming to be connected.
       */
      setState('disconnected');

      throw renewError;

    }

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


/*
 * =========================================================================
 * LINK TO AN EXISTING SPREADSHEET (multi-device fix)
 *
 * findOrCreateSheet() above discovers "the" spreadsheet by searching Drive
 * for a file named DRIVE_CONFIG.SHEET_NAME. That search runs under the
 * 'drive.file' scope (deliberately the narrowest scope that still lets the
 * app work, rather than asking for access to the user's entire Drive), and
 * under 'drive.file' a files.list() search is only reliably visible to the
 * same authorization that created the file — a second device signing in
 * separately (even the same Google account, same app) can come back with
 * zero results and unknowingly create its OWN second spreadsheet with the
 * same name. Both devices then show "Connected" and sync perfectly well —
 * just each to their own copy, which looks exactly like "data isn't
 * syncing between devices."
 *
 * The fix is not to widen the OAuth scope (that would trade this app's
 * access to a couple of its own sheets for access to this Google account's
 * entire Drive, for a personal health log — not a good trade). Instead,
 * this lets a device explicitly link itself to a spreadsheet ID it already
 * knows about (pasted from another device's "Open your Sheet" link), which
 * works under 'drive.file' because opening a specific known file by ID is
 * allowed even when discovering it by search is not.
 * =========================================================================
 */
function parseSpreadsheetId(input){

  const raw = String(input == null ? '' : input).trim();

  if(!raw){
    return null;
  }

  const urlMatch =
    raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);

  if(urlMatch){
    return urlMatch[1];
  }

  // A bare spreadsheet ID: no slashes/spaces, reasonably long.
  if(/^[a-zA-Z0-9-_]{20,}$/.test(raw)){
    return raw;
  }

  return null;

}


async function linkToExistingSpreadsheet(input){

  const id = parseSpreadsheetId(input);

  if(!id){

    return {
      ok: false,
      error: "That doesn't look like a Google Sheets link or ID."
    };
  }

  if(!accessToken){

    return {
      ok: false,
      error: 'Connect to Google Drive on this device first.'
    };
  }

  // Verify this account can actually open the file before committing to it
  // — a bad paste or a sheet this account can't see should fail loudly
  // here, not silently leave the device pointed at a broken spreadsheetId.
  let metadata;

  try{

    metadata =
      await apiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${id}` +
        `?fields=spreadsheetId,properties(title)`
      );

  }catch(error){

    return {
      ok: false,
      error: "Couldn't open that sheet — check the link and that this Google account has access to it."
    };
  }

  spreadsheetId = metadata.spreadsheetId;

  localStorage.setItem(
    'vitals:drive:spreadsheetId',
    spreadsheetId
  );

  try{

    await ensureSpreadsheetReady();

    await syncNow(true);

    await flushQueue();

  }catch(error){

    /*
     * The link itself succeeded (spreadsheetId is now saved) even if this
     * particular first sync attempt hiccuped, e.g. a momentary network
     * blip — the regular 60s sync loop will pick it up from here.
     */
    console.warn(
      'Vitals: linked to existing spreadsheet but the first sync failed',
      error
    );

  }

  notifyStatus();

  return {
    ok: true,
    title:
      metadata.properties &&
      metadata.properties.title
  };

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


async function ensureAlarmsHeader(){

  /*
   * Create Alarms tab if it doesn't exist.
   */
  await ensureTab(
    DRIVE_CONFIG.ALARMS_TAB
  );


  const range =
    encodeURIComponent(
      DRIVE_CONFIG.ALARMS_TAB +
      '!A1:H1'
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
            ALARMS_HEADER_ROW
          ]
        })

    }
  );

}


/* =========================================================================
   SPREADSHEET READINESS (shared by sign-in, restore and every sync)

   Every path that needs to talk to Drive funnels through this single
   function, so "find/create the sheet, make sure every tab + header
   exists" is defined in exactly one place instead of being duplicated
   (and able to drift out of sync) across afterSignIn/init/syncNow.
   ========================================================================= */

async function ensureSpreadsheetReady(){

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

  await ensureAlarmsHeader();

}


/* =========================================================================
   AFTER SIGN-IN
   ========================================================================= */

async function afterSignIn(){

  try{

    await ensureSpreadsheetReady();

  }catch(error){

    console.warn(
      'Vitals: could not find/create Sheet',
      error
    );

    setState('error');

    notifyStatus({
      error:
        'Could not open Vitals Health Log'
    });

    return;

  }


  notifyStatus();


  /*
   * Synchronize immediately after connecting. force=true bypasses the
   * MIN_SYNC_INTERVAL_MS coalescing since this is a deliberate,
   * user-initiated action, not a background trigger.
   */
  await syncNow(true);

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
   ALARMS

   Alarms are simpler than custom metrics: there is no name-based
   canonicalization step, just a plain last-write-wins merge by stable
   alarm ID (section 13 of the spec). Deletions are tombstoned the same
   way entries and metrics are, via the Deleted column, so a delete made
   on one device is not silently resurrected by the other device's copy.
   ========================================================================= */

function alarmToRow(
  alarm,
  deleted
){

  return [

    alarm.id || '',

    alarm.label || '',

    alarm.time || '',

    JSON.stringify(
      alarm.days != null
        ? alarm.days
        : 'daily'
    ),

    alarm.tone || 'chime',

    alarm.enabled === false
      ? 'FALSE'
      : 'TRUE',

    alarm.updatedAt ||
      Date.now(),

    deleted
      ? 'TRUE'
      : 'FALSE'

  ];

}


function rowToAlarm(row){

  if(
    !row ||
    !row[0]
  ){

    return null;

  }


  const id =
    String(row[0]);

  const label =
    String(
      row[1] || ''
    ).trim();

  const updatedAt =
    Number(row[6]) || 0;

  const deleted =
    String(
      row[7] || ''
    ).toUpperCase() === 'TRUE';


  if(
    deleted ||
    !label
  ){

    return {

      id,

      updatedAt,

      deleted:true

    };

  }


  let days = 'daily';

  try{

    const parsed =
      JSON.parse(
        row[3]
      );

    if(
      parsed === 'daily' ||
      Array.isArray(parsed)
    ){

      days = parsed;

    }

  }catch(error){

    days = 'daily';

  }


  return {

    id,

    label,

    time:
      row[2] || '',

    days,

    tone:
      row[4] || 'chime',

    enabled:
      String(
        row[5] || ''
      ).toUpperCase() === 'TRUE',

    updatedAt,

    deleted:false

  };

}


async function getAllAlarmRows(){

  const range =
    encodeURIComponent(
      DRIVE_CONFIG.ALARMS_TAB +
      '!A2:H'
    );


  const response =
    await apiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`
    );


  return response.values || [];

}


async function findAlarmRowNumberById(
  id
){

  const range =
    encodeURIComponent(
      DRIVE_CONFIG.ALARMS_TAB +
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


async function upsertAlarmRow(
  alarm,
  deleted
){

  const rowNumber =
    await findAlarmRowNumberById(
      alarm.id
    );


  if(!rowNumber){

    const range =
      encodeURIComponent(
        DRIVE_CONFIG.ALARMS_TAB +
        '!A1:H1'
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
              alarmToRow(
                alarm,
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
      DRIVE_CONFIG.ALARMS_TAB +
      `!A${rowNumber}:H${rowNumber}`
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
            alarmToRow(
              alarm,
              deleted
            )
          ]
        })

    }
  );

}


async function syncAlarms(){

  const remoteRows =
    await getAllAlarmRows();

  const remote =
    new Map();

  remoteRows.forEach(
    row => {

      const alarm =
        rowToAlarm(row);

      if(
        alarm &&
        alarm.id
      ){

        const existing =
          remote.get(
            alarm.id
          );

        if(
          !existing ||
          Number(alarm.updatedAt || 0) >=
          Number(existing.updatedAt || 0)
        ){

          remote.set(
            alarm.id,
            alarm
          );

        }

      }

    }
  );


  const localList =
    (
      DB.getAlarms
        ? DB.getAlarms()
        : []
    ).map(
      alarm =>
        Object.assign(
          {},
          alarm
        )
    );

  const localMap =
    new Map();

  localList.forEach(
    alarm => {

      const existing =
        localMap.get(
          alarm.id
        );

      if(
        !existing ||
        Number(alarm.updatedAt || 0) >=
        Number(existing.updatedAt || 0)
      ){

        localMap.set(
          alarm.id,
          alarm
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


  for(
    const [
      id,
      remoteAlarm
    ]
    of remote
  ){

    const localAlarm =
      localMap.get(id);


    if(
      remoteAlarm.deleted
    ){

      if(
        !localAlarm ||
        Number(remoteAlarm.updatedAt || 0) >=
        Number(localAlarm.updatedAt || 0)
      ){

        merged.delete(id);

      }else{

        uploads.push({

          alarm:
            localAlarm,

          deleted:
            false

        });

      }

      continue;

    }


    if(!localAlarm){

      merged.set(
        id,
        remoteAlarm
      );

      continue;

    }


    const localTime =
      Number(
        localAlarm.updatedAt || 0
      );

    const remoteTime =
      Number(
        remoteAlarm.updatedAt || 0
      );


    if(remoteTime > localTime){

      merged.set(
        id,
        remoteAlarm
      );

    }else if(localTime > remoteTime){

      uploads.push({

        alarm:
          localAlarm,

        deleted:
          false

      });

    }

  }


  for(
    const [
      id,
      localAlarm
    ]
    of localMap
  ){

    if(!remote.has(id)){

      uploads.push({

        alarm:
          localAlarm,

        deleted:
          false

      });

    }

  }


  const mergedList =
    Array.from(
      merged.values()
    ).filter(
      alarm =>
        alarm &&
        alarm.id &&
        !alarm.deleted
    );


  if(DB.saveAlarms){

    DB.saveAlarms(
      mergedList
    );

    notifyDataChanged();

  }


  const uploadedIds =
    new Set();

  for(
    const item
    of uploads
  ){

    if(
      uploadedIds.has(
        item.alarm.id
      )
    ){

      continue;

    }

    uploadedIds.add(
      item.alarm.id
    );

    await upsertAlarmRow(
      item.alarm,
      item.deleted
    );

  }


  return mergedList;

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

async function syncNow(force){

  if(
    syncing ||
    !navigator.onLine
  ){

    return false;

  }


  /*
   * Coalesce bursts of near-simultaneous triggers (the 60s interval,
   * visibilitychange and 'online' can all fire within moments of each
   * other, e.g. when an Android tablet's screen turns back on). force=true
   * (used right after an explicit connect) bypasses this.
   */
  if(
    !force &&
    lastSyncCompletedAt &&
    (Date.now() - lastSyncCompletedAt) < MIN_SYNC_INTERVAL_MS
  ){

    return false;

  }


  /*
   * syncNow() does NOT attempt to authenticate on its own — if there's no
   * access token right now, it just quietly does nothing. Authentication
   * only ever happens from reconnectIfNeeded() (called right when the
   * user unlocks the app — a real gesture) or from an explicit signIn()
   * tap. This is what stops the "asks to reconnect again and again" loop:
   * the periodic interval, visibilitychange and 'online' triggers all
   * call syncNow(), and none of them can trigger a Google auth attempt.
   */
  if(!accessToken){

    return false;

  }


  syncing = true;

  setState('syncing');

  notifyStatus();


  try{

    /*
     * Make sure the spreadsheet and every tab/header exist before
     * reading them. Also covers the rare case where the token restored
     * fine but spreadsheetId was somehow lost.
     */
    await ensureSpreadsheetReady();


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


    /*
     * THIRD:
     * synchronize alarms.
     */
    await syncAlarms();


    lastSyncCompletedAt =
      Date.now();

    localStorage.setItem(
      LAST_SYNC_KEY,
      String(lastSyncCompletedAt)
    );

    setState('connected');

    notifyStatus({
      lastSyncAt:
        lastSyncCompletedAt
    });


    return true;


  }catch(error){

    console.warn(
      'Vitals: Google Drive synchronization failed',
      error
    );


    /*
     * A failed sync doesn't necessarily mean the session died — apiFetch
     * already moves us to 'disconnected' if the token turned out to be
     * unrecoverable. Otherwise we're still connected, just hit a
     * transient error (network blip, quota, etc).
     */
    setState(
      accessToken
        ? 'connected'
        : 'disconnected'
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


/*
 * Every queued item now carries a `kind` ('entry' | 'metric' | 'alarm') so
 * one offline queue can carry all three record types. Items queued by an
 * older version of this file have no `kind` field — they are always
 * entries, so `kind || 'entry'` keeps them working after this update.
 */
function dedupeQueueFor(
  kind,
  matchId
){

  return getQueue()
    .filter(
      item => {

        const itemKind =
          item.kind || 'entry';

        if(itemKind !== kind) return true;

        const itemId =
          itemKind === 'entry'
            ? (
                item.op === 'upsert'
                  ? (item.entry && item.entry.id)
                  : item.id
              )
            : itemKind === 'metric'
              ? (
                  item.op === 'upsert'
                    ? (item.metric && item.metric.id)
                    : item.id
                )
              : (
                  item.op === 'upsert'
                    ? (item.alarm && item.alarm.id)
                    : item.id
                );

        return itemId !== matchId;

      }
    );

}


function queueUpsert(
  entry
){

  const queue =
    dedupeQueueFor('entry', entry.id);

  queue.push({

    kind:
      'entry',

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
    dedupeQueueFor('entry', id);

  queue.push({

    kind:
      'entry',

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


function queueMetricUpsert(
  metric
){

  const queue =
    dedupeQueueFor('metric', metric.id);

  queue.push({

    kind:
      'metric',

    op:
      'upsert',

    metric

  });


  saveQueue(
    queue
  );


  flushQueue();

}


function queueMetricDelete(
  id,
  updatedAt
){

  const queue =
    dedupeQueueFor('metric', id);

  queue.push({

    kind:
      'metric',

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


function queueAlarmUpsert(
  alarm
){

  const queue =
    dedupeQueueFor('alarm', alarm.id);

  queue.push({

    kind:
      'alarm',

    op:
      'upsert',

    alarm

  });


  saveQueue(
    queue
  );


  flushQueue();

}


function queueAlarmDelete(
  id,
  updatedAt
){

  const queue =
    dedupeQueueFor('alarm', id);

  queue.push({

    kind:
      'alarm',

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


  /*
   * Same rule as syncNow(): never attempt to authenticate from here.
   * Queued changes just wait until reconnectIfNeeded() or signIn()
   * establishes a connection, then this drains naturally.
   */
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

      const kind =
        item.kind || 'entry';


      try{

        if(kind === 'entry'){

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

        }else if(kind === 'metric'){

          if(
            item.op === 'upsert'
          ){

            await upsertMetricRow(
              item.metric,
              false
            );

          }else if(
            item.op === 'delete'
          ){

            await upsertMetricRow(
              {
                id:
                  item.id,

                updatedAt:
                  item.updatedAt ||
                  Date.now()
              },
              true
            );

          }

        }else if(kind === 'alarm'){

          if(
            item.op === 'upsert'
          ){

            await upsertAlarmRow(
              item.alarm,
              false
            );

          }else if(
            item.op === 'delete'
          ){

            await upsertAlarmRow(
              {
                id:
                  item.id,

                updatedAt:
                  item.updatedAt ||
                  Date.now()
              },
              true
            );

          }

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
     * Background sync approximately once per minute. syncNow() is a cheap
     * no-op if we're not currently connected — this interval never
     * attempts to authenticate, so it can stay this simple.
     */
    setInterval(
      async () => {

        await syncNow();

        await flushQueue();

      },
      60000
    );


    /*
     * A local entry/metric/alarm changed — push the offline queue if
     * we're already connected. This does NOT attempt to authenticate;
     * if we're disconnected the queued item just waits for the next
     * successful connection.
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
     * Startup: this does NOT attempt to authenticate. If a still-valid
     * token was already persisted from a previous session (see
     * ACCESS_TOKEN_KEY above), it's already loaded into `accessToken` by
     * now, so this syncs immediately with no Google call at all. If we're
     * not connected, this simply does nothing — reconnectIfNeeded() is
     * called by app.js right when the user unlocks, and that's the only
     * place a fresh authentication attempt happens automatically.
     */
    syncNow(true)
      .then(
        () =>
          flushQueue()
      )
      .catch(
        error => {

          console.warn(
            'Vitals: automatic Drive restore/sync failed',
            error
          );

        }
      );


    notifyStatus();

  },


  signIn,

  disconnect,

  reconnectIfNeeded,

  hasStoredAuthorization,

  isConnected:
    () =>
      !!accessToken,

  getState:
    () =>
      driveState,

  getLastSyncTime:
    () =>
      lastSyncCompletedAt,

  isConfigured,

  getSheetUrl,

  linkToExistingSpreadsheet,

  queueUpsert,

  queueDelete,

  queueMetricUpsert,

  queueMetricDelete,

  queueAlarmUpsert,

  queueAlarmDelete,

  flushQueue,

  syncNow

};

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const app = read('app.js'), drive = read('drive.js'), dashboard = read('dashboard.js');
const extract = (source, start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert(first >= 0 && last > first, start);
  return source.slice(first, last);
};

async function run() {
  let queue = [{kind:'entry', op:'upsert', queueId:'first', entry:{id:'same', value:1}}];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const uploaded = [];
  const flushing = vm.createContext({
    flushing:false, spreadsheetId:'demo', accessToken:'synthetic', navigator:{onLine:true},
    Date, console,
    getQueue:() => structuredClone(queue),
    saveQueue:items => { queue = structuredClone(items); },
    upsertRow:async entry => { uploaded.push(entry.value); if(uploaded.length === 1) await gate; }
  });
  vm.runInContext(extract(drive, 'async function flushQueueUnlocked(){', '/* =========================================================================\n   MANUAL RESTORE'), flushing);
  const pending = flushing.flushQueueUnlocked();
  queue = [{kind:'entry', op:'upsert', queueId:'second', entry:{id:'same', value:2}}];
  release();
  await pending;
  assert.deepEqual(uploaded, [1,2]);
  assert.deepEqual(queue, []);
  console.log('PASS queue: edits arriving during an upload are sent rather than lost.');

  let remote = [{id:'same', updatedAt:20}];
  const guards = vm.createContext({
    getAllRows:async () => remote, rowToEntry:row => row,
    getAllMetricRows:async () => remote, rowToMetric:row => row,
    getAllMedicineRows:async () => remote, rowToMedicine:row => row,
    getAllDoseLogRows:async () => remote, rowToDoseLog:row => row
  });
  vm.runInContext(extract(drive, 'async function shouldUploadRecord(', 'async function syncNowUnlocked('), guards);
  for(const kind of ['entry','metric','medicine','doselog']) {
    assert.equal(await guards.shouldUploadRecord(kind, {id:'same',updatedAt:10}, false), false);
    assert.equal(await guards.shouldUploadRecord(kind, {id:'same',updatedAt:30}, false), true);
    remote = [{id:'same',updatedAt:20,deleted:true}];
    assert.equal(await guards.shouldUploadRecord(kind, {id:'same',updatedAt:20}, false), false);
    remote = [{id:'same',updatedAt:20}];
  }
  console.log('PASS conflicts: older writes and equal-time resurrection are blocked for all record types.');

  const restore = vm.createContext({
    DB:{getEntries:() => [], saveEntries:() => false},
    getRemoteMap:async () => new Map([['remote',{id:'remote',updatedAt:20}]]), notifyStatus(){}
  });
  vm.runInContext(extract(drive, 'async function restoreFromSheet(){', '/* =========================================================================\n   AUTOMATIC ONLINE SYNC'), restore);
  await assert.rejects(restore.restoreFromSheet(), /Could not save restored/);
  console.log('PASS persistence: failed Restore writes cannot report success.');

  const times = vm.createContext({pad2:n => String(n).padStart(2,'0')});
  vm.runInContext(extract(app, 'function parseImportTime(', 'function normalizeImportText('), times);
  assert.equal(times.parseImportTime('8:99 AM'), null);
  assert.equal(times.parseImportTime('23:60'), null);
  assert.equal(times.parseImportTime('12:00 AM'), '00:00');
  assert.equal(times.parseImportTime('12:00 PM'), '12:00');
  assert.equal(times.parseImportTime('23:59'), '23:59');
  console.log('PASS import: invalid minutes rejected, midnight/noon and valid times preserved.');

  const parsers = vm.createContext({Date});
  vm.runInContext(extract(drive, 'function validRecordId(', '/* =========================================================================\n   READ SHEET DATA'), parsers);
  const invalid = ['record','liquid','not-a-date','12:00','100'];
  assert.equal(parsers.rowToEntry(invalid), null);
  assert.equal(parsers.rowToEntry(['bad"><span','liquid','2026-10-01','12:00','100']), null);
  assert.equal(parsers.rowToEntry(['record','liquid','2026-10-01','12:00','100']).amount, 100);
  console.log('PASS imports: invalid dates and unsafe IDs cannot become live restored readings.');

  const duplicates = vm.createContext({});
  vm.runInContext(extract(dashboard, 'function newestLiveRecords(', 'async function loadData('), duplicates);
  const survivors = duplicates.newestLiveRecords([
    {id:'same',updatedAt:1}, {id:'same',updatedAt:2,deleted:true}, {id:'live',updatedAt:3}
  ], row => row);
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].id, 'live');
  assert.equal(duplicates.newestLiveRecords([], row => row).length, 0);
  console.log('PASS dashboard: newest deletion markers win before filtering.');

  const history = vm.createContext({
    DB:{
      getMedicines:() => [{id:'current',name:'Current medicine',dose:'1 tablet',enabled:false}],
      getDoseLog:() => ({
        one:{id:'one',medicineId:'current',date:'2026-10-01',time:'08:00',status:'taken'},
        two:{id:'two',medicineId:'removed',medicineName:'Archived medicine',medicineDose:'2 tablets',date:'2026-10-01',time:'09:00',status:'skipped'},
        three:{id:'three',date:'2026-09-30',time:'08:00',status:'taken'},
        four:{id:'four',date:'2026-10-01',time:'10:00',status:'pending'}
      })
    }
  });
  vm.runInContext(extract(app, 'function medicineHistoryRecords(', 'function renderMedicineDayHistory('), history);
  const records = history.medicineHistoryRecords('2026-10-01');
  assert.equal(records.length, 2);
  assert.equal(records[0].medicineName, 'Current medicine');
  assert.equal(records[1].medicineName, 'Archived medicine');
  assert.equal(records[1].status, 'skipped');
  assert.equal(history.medicineHistoryRecords('2020-01-01').length, 0);
  console.log('PASS history: selected-date marks include disabled and archived medicines, excluding other dates and pending doses.');

  const pair = await webcrypto.subtle.generateKey(
    {name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'}, true, ['sign','verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  jwk.kid = 'test-key';
  const jwt = vm.createContext({
    Date, Uint8Array, TextEncoder, TextDecoder, atob, crypto:webcrypto,
    window:{VitalsDrive:{GOOGLE_CLIENT_ID:'expected-client'}},
    fetch:async () => ({ok:true,json:async () => ({keys:[jwk]})})
  });
  vm.runInContext(extract(app, 'let authGateNonce = null;', 'async function handleGoogleCredentialResponse'), jwt);
  vm.runInContext("authGateNonce = 'expected-nonce';", jwt);
  const claims = {sub:'user',iss:'https://accounts.google.com',aud:'expected-client',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+600,nonce:'expected-nonce'};
  const sign = async payload => {
    const head = Buffer.from(JSON.stringify({alg:'RS256',kid:'test-key'})).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(head+'.'+body));
    return head+'.'+body+'.'+Buffer.from(signature).toString('base64url');
  };
  assert.equal((await jwt.verifyGoogleIdToken(await sign(claims))).sub, 'user');
  for(const change of [{aud:'wrong'},{exp:1},{nonce:'wrong'},{iss:'https://wrong.example'}]) {
    assert.equal(await jwt.verifyGoogleIdToken(await sign({...claims,...change})), null);
  }
  const signed = (await sign(claims)).split('.');
  signed[1] = Buffer.from(JSON.stringify({...claims,sub:'forged'})).toString('base64url');
  assert.equal(await jwt.verifyGoogleIdToken(signed.join('.')), null);
  console.log('PASS identity: valid signatures accepted; forged, expired, wrong-client, wrong-issuer, and wrong-nonce tokens rejected.');

  const handlers = {};
  const worker = vm.createContext({
    self:{location:{origin:'https://example.test'}, addEventListener:(name, handler) => {handlers[name]=handler;}},
    URL, Response, fetch:async () => {throw new Error('offline');},
    caches:{match:async key => key === './index.html' ? new Response('<html>offline shell</html>') : undefined}
  });
  vm.runInContext(read('service-worker.js'), worker);
  let result;
  handlers.fetch({request:{method:'GET',url:'https://example.test/missing.png',mode:'cors'},respondWith:value => {result=value;}});
  assert.equal((await result).type, 'error');
  handlers.fetch({request:{method:'GET',url:'https://example.test/index.html',mode:'navigate'},respondWith:value => {result=value;}});
  assert.equal(await (await result).text(), '<html>offline shell</html>');
  console.log('PASS offline: missing assets do not receive HTML; main navigation still has its offline fallback.');

  for(const [script,page] of [['app.js','index.html'],['dashboard.js','dashboard.html']]) {
    const html = read(page), ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    const wired = read(script).slice(read(script).indexOf('function wireEvents(){'));
    for(const match of wired.matchAll(/(?:\$\('#([^']+)'\)|getElementById\('([^']+)'\))\.addEventListener/g)) {
      assert(ids.includes(match[1] || match[2]), match[1] || match[2]);
    }
  }
  console.log('PASS markup: event targets exist and IDs are unique.');
}
run().catch(error => {console.error(error);process.exitCode=1;});

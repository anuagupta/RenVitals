const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname,'..',name),'utf8');
async function scenario(latest, editing, offline=false){
  let refreshed = null, probe = null, interval;
  const storage = new Map();
  const context = vm.createContext({URL, Date, AbortController, setTimeout, clearTimeout,
    setInterval:fn => {interval=fn;},
    location:{href:'https://example.test/RenVitals/',replace:url => {refreshed=url;}},
    navigator:{onLine:!offline}, window:{addEventListener(){}},
    sessionStorage:{getItem:key => storage.get(key),setItem:(key,value)=>storage.set(key,value)},
    document:{visibilityState:'visible', activeElement:{tagName:'BODY'},addEventListener(){},
      querySelector:selector=>selector.startsWith('meta')?{content:'old'}:editing?{}:null,
      createElement:()=>({style:{},setAttribute(){}}),body:{appendChild(){}}},
    DOMParser:class {parseFromString(){return {querySelector:()=>({content:latest})};}},
    fetch:async(url,options)=>{probe={url,options};return {ok:true,text:async()=>'<html></html>'};}
  });
  vm.runInContext(read('release-check.js'),context);
  await context.window.VitalsUpdates.check();
  await new Promise(resolve=>setImmediate(resolve));
  return {get refreshed(){return refreshed;},probe,closeForm(){editing=false;interval();}};
}
(async()=>{
  const same=await scenario('old',false); assert.equal(same.refreshed,null);
  const newer=await scenario('new',false); assert(newer.refreshed.includes('__vitals_release=new'));
  assert.equal(newer.probe.options.cache,'no-store'); assert(newer.probe.url.includes('__vitals_check='));
  const draft=await scenario('new',true); assert.equal(draft.refreshed,null); draft.closeForm(); assert(draft.refreshed);
  const offline=await scenario('new',false,true); assert.equal(offline.probe,null); assert.equal(offline.refreshed,null);
  console.log('PASS release refresh: fresh probes, unchanged version, safe deferred update, and offline preservation.');
  let fetchCall, response, saved;
  const handlers={};
  vm.runInNewContext(read('service-worker.js'),{URL,Date,Response,
    self:{location:{origin:'https://example.test',href:'https://example.test/RenVitals/service-worker.js'},addEventListener:(name,fn)=>handlers[name]=fn},
    fetch:async(url,options)=>{fetchCall={url,options};return new Response('latest');},
    caches:{open:async()=>({put:async(key)=>{saved=key;}})}
  });
  const work=[];
  handlers.fetch({request:{method:'GET',url:'https://example.test/RenVitals/?__vitals_release=new',mode:'navigate'},respondWith:p=>response=p,waitUntil:p=>work.push(p)});
  assert.equal(await (await response).text(),'latest'); await Promise.all(work);
  assert.equal(fetchCall.options.cache,'no-store'); assert(fetchCall.url.includes('__vitals_fresh='));
  assert.equal(saved,'https://example.test/RenVitals/');
  console.log('PASS worker: network bypasses HTTP/CDN cache; offline key remains stable.');
})().catch(error=>{console.error(error);process.exitCode=1;});

'use strict';
// Release checks never touch account storage or upload queues. Bump the
// vitals-release meta tag in index.html whenever publishing a new release.
(() => {
  const current = document.querySelector('meta[name="vitals-release"]')?.content;
  if(!current) return;
  let checking = false;
  let pending = null;
  let refreshing = false;
  let notice = null;
  function editing(){
    return !!document.querySelector('#sheet.show, .detail.show, dialog[open]') ||
      ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
  }
  function refreshWhenSafe(){
    if(!pending || refreshing || document.visibilityState === 'hidden') return;
    if(editing()){
      if(!notice){
        notice = document.createElement('div');
        notice.setAttribute('role', 'status');
        notice.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2000;padding:12px;text-align:center;background:#172b3a;color:white;font:14px sans-serif';
        notice.textContent = 'An update is ready. Finish and close your current form to refresh safely.';
        document.body.appendChild(notice);
      }
      return;
    }
    // Prevent repeat reloads if different CDN edges temporarily disagree.
    const key = 'vitals:last-release-refresh';
    try {
      if(sessionStorage.getItem(key) === current + '>' + pending) return;
      sessionStorage.setItem(key, current + '>' + pending);
    } catch (_) { return; } // Don't risk a reload loop when storage is blocked.
    refreshing = true;
    const url = new URL(location.href);
    url.searchParams.set('__vitals_release', pending);
    location.replace(url.href);
  }
  async function check(){
    if(checking || navigator.onLine === false) return;
    checking = true;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 10000);
    try {
      const url = new URL('index.html', location.href);
      url.searchParams.set('__vitals_check', Date.now().toString());
      const response = await fetch(url.href, {cache:'no-store', signal:abort.signal});
      if(!response.ok) return;
      const html = new DOMParser().parseFromString(await response.text(), 'text/html');
      const latest = html.querySelector('meta[name="vitals-release"]')?.content;
      if(latest && latest !== current){ pending = latest; refreshWhenSafe(); }
    } catch (_) { /* Offline or unreachable: preserve the downloaded app. */ }
    finally { clearTimeout(timeout); checking = false; }
  }
  window.VitalsUpdates = {check};
  window.addEventListener('pageshow', check);
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'visible'){ refreshWhenSafe(); check(); }
  });
  setInterval(() => { if(pending) refreshWhenSafe(); }, 1000);
  check();
})();

(function () {
  var ID = '__happenings_bm__';
  var existing = document.getElementById(ID);
  if (existing) { existing.remove(); return; }

  var DEFAULT_WORKER = '__DEFAULT_WORKER__';
  var DEFAULT_API_KEY = '__DEFAULT_API_KEY__';
  var RELAY_URL = '__RELAY_URL__';

  var host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'position:fixed;top:0;right:0;width:320px;height:100%;z-index:2147483647;pointer-events:none;';
  document.body.appendChild(host);
  var shadow = host.attachShadow({ mode: 'open' });

  var css = ''
    + '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:0;}'
    + '#sb{position:fixed;top:0;right:0;width:320px;background:#fff;border-left:2px solid #007bff;box-shadow:-4px 0 16px rgba(0,0,0,.2);display:flex;flex-direction:column;font-size:13px;pointer-events:all;}'
    + '#hd{background:#007bff;color:#fff;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}'
    + '#hd h2{font-size:15px;font-weight:700;}'
    + '#xb{background:none;border:none;color:#fff;font-size:22px;cursor:pointer;line-height:1;padding:0 2px;}'
    + '#bd{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px;}'
    + 'label{display:block;font-weight:600;margin-bottom:3px;color:#444;font-size:12px;}'
    + 'input{width:100%;padding:6px 8px;border:1px solid #ccc;border-radius:4px;font-size:12px;color:#333;}'
    + '.cur{font-size:11px;color:#666;word-break:break-all;background:#f5f5f5;padding:6px 8px;border-radius:4px;}'
    + '.divider{border:none;border-top:1px solid #eee;}'
    + '.btn{width:100%;padding:9px;background:#007bff;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:600;}'
    + '.btn:hover{background:#0056b3;}'
    + '.btn:disabled{background:#aaa;cursor:not-allowed;}'
    + '#st{font-size:12px;padding:8px;border-radius:4px;display:none;}'
    + '#st.info{background:#e8f4fd;color:#0c5460;display:block;}'
    + '#st.err{background:#f8d7da;color:#721c24;display:block;}'
    + '#st.ok{background:#d4edda;color:#155724;display:block;}'
    + '#cf{display:flex;flex-direction:column;gap:10px;}'
    + '#tg{font-size:11px;color:#999;text-decoration:none;cursor:pointer;text-align:right;display:none;}'
    + '#tg:hover{color:#666;}';

  shadow.innerHTML = '<style>' + css + '</style>'
    + '<div id="sb">'
    + '<div id="hd"><h2>Tokoro</h2><button id="xb">&#x2715;</button></div>'
    + '<div id="bd">'
    + '<div id="cf">'
    + '<div><label>API Key</label><input type="text" id="ak"/></div>'
    + '<div><label>Worker URL</label><input type="url" id="wu"/></div>'
    + '</div>'
    + '<a href="#" id="tg">&#9881; Settings</a>'
    + '<hr class="divider"/>'
    + '<div><label>Current Page</label><div class="cur" id="cu"></div></div>'
    + '<button class="btn" id="eb">Extract Events</button>'
    + '<div id="st"></div>'
    + '</div></div>';

  var S = function (id) { return shadow.getElementById(id); };
  var ak = S('ak'), wu = S('wu'), cu = S('cu'), eb = S('eb'), st = S('st');
  var cf = S('cf'), tg = S('tg');

  ak.value = localStorage.getItem('happenings_api_key') || DEFAULT_API_KEY;
  wu.value = localStorage.getItem('happenings_worker_url') || DEFAULT_WORKER;
  cu.textContent = window.location.href;

  function updateCfVisibility(forceShow) {
    var hasKey = ak.value && ak.value !== DEFAULT_API_KEY && ak.value !== '__DEFAULT_API_KEY__';
    var hasUrl = wu.value && wu.value !== DEFAULT_WORKER && wu.value !== '__DEFAULT_WORKER__';
    if (forceShow || !hasKey || !hasUrl) {
      cf.style.display = 'flex';
      tg.style.display = 'none';
    } else {
      cf.style.display = 'none';
      tg.style.display = 'block';
    }
  }
  updateCfVisibility(false);

  ak.addEventListener('input', function () { localStorage.setItem('happenings_api_key', ak.value); });
  wu.addEventListener('input', function () { localStorage.setItem('happenings_worker_url', wu.value); });
  S('xb').addEventListener('click', function () { host.remove(); });
  tg.addEventListener('click', function (e) { e.preventDefault(); updateCfVisibility(true); });

  function setStatus(msg, cls) { st.textContent = msg; st.className = cls; }

  eb.addEventListener('click', async function () {
    var apiKey = ak.value.trim();
    var workerUrl = (wu.value.trim() || DEFAULT_WORKER).replace(/\/$/, '');
    if (!apiKey) { updateCfVisibility(true); setStatus('API key not configured', 'err'); return; }

    eb.disabled = true;
    eb.textContent = 'Opening...';
    setStatus('Preparing page content...', 'info');

    // Preprocess HTML: strip scripts (keep JSON-LD), styles, noscript, svg, empty elements.
    // This mirrors the Apple Shortcut preprocessing and keeps the payload small and focused.
    var clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('script:not([type="application/ld+json"]), style, noscript, svg')
      .forEach(function (el) { el.remove(); });
    var keep = new Set(['IMG', 'INPUT', 'BR', 'HR', 'META', 'LINK', 'SOURCE', 'TRACK', 'WBR', 'AREA', 'BASE', 'COL', 'EMBED', 'PARAM']);
    Array.from(clone.querySelectorAll('*')).reverse().forEach(function (el) {
      if (!keep.has(el.tagName) && el.textContent.trim() === '' && el.querySelectorAll('img').length === 0) {
        el.remove();
      }
    });
    var html = clone.outerHTML;
    if (html.length > 400000) html = html.substring(0, 400000);

    // Open relay popup on happenings-query.pages.dev — it lives outside the current page's
    // CSP, so it can freely fetch the crawler-worker and return results via postMessage.
    var popup = window.open(RELAY_URL + '?relay=1', 'happenings_relay', 'width=440,height=680,resizable=yes,scrollbars=yes');
    if (!popup) {
      setStatus('Popup blocked. Please allow popups for this page and try again.', 'err');
      eb.disabled = false;
      eb.textContent = 'Extract Events';
      return;
    }

    setStatus('Waiting for relay to load\u2026', 'info');

    var sent = false;
    var listener;
    var timer = setTimeout(function () {
      window.removeEventListener('message', listener);
      if (!sent) {
        setStatus('Relay did not respond. Please try again.', 'err');
        eb.disabled = false;
        eb.textContent = 'Extract Events';
      }
    }, 20000);

    listener = function (evt) {
      if (evt.source !== popup) return;
      if (!evt.data || evt.data.type !== 'ready') return;
      clearTimeout(timer);
      window.removeEventListener('message', listener);
      sent = true;
      popup.postMessage({
        type: 'crawl_data',
        url: window.location.href,
        html: html,
        title: document.title,
        apiKey: apiKey,
        workerUrl: workerUrl,
      }, '*');
      setStatus('Extracting events in popup\u2026', 'info');
      eb.disabled = false;
      eb.textContent = 'Extract Events';
      // Close sidebar shortly after handing off to the popup
      setTimeout(function () { host.remove(); }, 1500);
    };
    window.addEventListener('message', listener);
  });
})()

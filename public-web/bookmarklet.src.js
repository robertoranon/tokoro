(function () {
  var RELAY_URL = '__RELAY_URL__';

  // Preprocess: strip scripts (keep JSON-LD), styles, noscript, svg, empty elements
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

  var popup = window.open(RELAY_URL + '?relay=1', 'happenings_relay', 'width=440,height=680,resizable=yes,scrollbars=yes');
  if (!popup) { alert('Tokoro: popup blocked. Please allow popups for this page.'); return; }

  var listener;
  var timer = setTimeout(function () { window.removeEventListener('message', listener); }, 20000);

  listener = function (evt) {
    if (evt.source !== popup) return;
    if (!evt.data || evt.data.type !== 'ready') return;
    clearTimeout(timer);
    window.removeEventListener('message', listener);
    popup.postMessage({ type: 'crawl_data', url: window.location.href, html: html, title: document.title }, '*');
  };
  window.addEventListener('message', listener);
})()

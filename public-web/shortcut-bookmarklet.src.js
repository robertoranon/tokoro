(function () {
  var RELAY_URL = '__RELAY_URL__';

  // JSON-LD scripts for structured data extraction server-side
  var jsonLds = Array.from(
    document.querySelectorAll('script[type="application/ld+json"]')
  )
    .map(function (s) {
      return s.outerHTML;
    })
    .join('\n');

  // Visible text for LLM extraction (server strips tags anyway, so sending
  // the full HTML DOM is wasteful and pushes the URL past iOS length limits)
  var text = ((document.body && document.body.innerText) || '').trim();
  if (text.length > 15000) text = text.substring(0, 15000);

  var payload = JSON.stringify({
    url: window.location.href,
    title: document.title,
    html: jsonLds + (jsonLds ? '\n' : '') + text,
  });
  console.log(
    '[tokoro] crawler-worker payload (' + payload.length + ' chars):',
    payload
  );
  var encoded = btoa(unescape(encodeURIComponent(payload)));
  completion(RELAY_URL + 'publish.html#crawl=' + encoded);
})();

(function () {
  var RELAY_URL = '__RELAY_URL__';
  var WORKER_URL = '__CRAWLER_WORKER_URL__';

  var jsonLds = Array.from(
    document.querySelectorAll('script[type="application/ld+json"]')
  )
    .map(function (s) {
      return s.outerHTML;
    })
    .join('\n');

  var text = ((document.body && document.body.innerText) || '').trim();
  if (text.length > 15000) text = text.substring(0, 15000);

  fetch(WORKER_URL + '/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: window.location.href,
      title: document.title,
      html: jsonLds + (jsonLds ? '\n' : '') + text,
    }),
  })
    .then(function (r) {
      return r.json();
    })
    .then(function (result) {
      if (result.token) {
        completion(RELAY_URL + '?preview=' + result.token);
      } else {
        completion('Error: no token returned');
      }
    })
    .catch(function (err) {
      completion('Error: ' + err.message);
    });
})();

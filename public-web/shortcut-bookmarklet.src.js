(function () {
  var RELAY_URL = '__RELAY_URL__';
  var CRAWLER_URL = '__CRAWLER_URL__';
  var API_KEY = '__API_KEY__';

  var clone = document.documentElement.cloneNode(true);
  clone
    .querySelectorAll(
      'script:not([type="application/ld+json"]), style, noscript, svg'
    )
    .forEach(function (el) {
      el.remove();
    });
  var keep = new Set([
    'IMG',
    'INPUT',
    'BR',
    'HR',
    'META',
    'LINK',
    'SOURCE',
    'TRACK',
    'WBR',
    'AREA',
    'BASE',
    'COL',
    'EMBED',
    'PARAM',
  ]);
  Array.from(clone.querySelectorAll('*'))
    .reverse()
    .forEach(function (el) {
      if (
        !keep.has(el.tagName) &&
        el.textContent.trim() === '' &&
        el.querySelectorAll('img').length === 0
      ) {
        el.remove();
      }
    });
  var html = clone.outerHTML;
  if (html.length > 400000) html = html.substring(0, 400000);

  fetch(CRAWLER_URL + '/crawl', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: window.location.href,
      html: html,
      title: document.title,
      mode: 'direct',
    }),
  })
    .then(function (resp) {
      return resp.json();
    })
    .then(function (result) {
      if (!result.success || !result.events || !result.events.length) {
        completion(
          result.dropped_events && result.dropped_events.length
            ? 'Found events but they were dropped during normalization.'
            : 'No events found on this page.'
        );
        return;
      }
      var encoded = btoa(
        unescape(encodeURIComponent(JSON.stringify(result.events)))
      );
      completion(RELAY_URL + 'publish.html#events=' + encoded);
    })
    .catch(function (err) {
      completion('Error: ' + err.message);
    });
})();

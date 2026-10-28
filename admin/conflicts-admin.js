'use strict';

/**
 * Admin client for show conflicts. A classic script (so the admin page works
 * from file:// too): window.TokoroAdminConflicts in the browser, require() in
 * Node tests. `ed` (@noble/ed25519, SHA-512 already configured) is injected.
 */

const conflictsHex = b =>
  Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const conflictsUnhex = h =>
  Uint8Array.from(h.match(/../g), x => parseInt(x, 16));

function createConflictsApi({ ed, fetchFn, workerUrl, privKeyHex }) {
  const base = String(workerUrl).replace(/\/+$/, '');

  async function call(method, path, domain, payload, body) {
    const priv = conflictsUnhex(privKeyHex);
    const ts = String(Math.floor(Date.now() / 1000));
    const msg = new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(domain + ':' + payload + ':' + ts)
      )
    );
    const headers = {
      'X-Pubkey': conflictsHex(await ed.getPublicKeyAsync(priv)),
      'X-Signature': conflictsHex(await ed.signAsync(msg, priv)),
      'X-Timestamp': ts,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetchFn(base + path, { method, headers, body });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) {
      throw new Error(
        (data && (data.message || data.error)) ||
          'Request failed (' + res.status + ')'
      );
    }
    return data;
  }

  return {
    // admin-read signs the exact path requested, query string included.
    list: (status = 'open') => {
      const path = '/admin/conflicts?status=' + encodeURIComponent(status);
      return call('GET', path, 'admin-read', path);
    },
    // The signature covers the exact raw JSON body that is sent.
    resolve: (id, obj) => {
      const body = JSON.stringify(obj);
      return call(
        'POST',
        '/admin/conflicts/' + encodeURIComponent(id) + '/resolve',
        'admin-conflict-resolve',
        body,
        body
      );
    },
  };
}

/** The url itself when it is a parseable http(s) URL, else null (never link javascript:/data:). */
function safeHttpUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:' ? url : null;
  } catch {
    return null;
  }
}

// Distinct top-level name: classic scripts share one global scope.
const adminConflictsApi = { createConflictsApi, safeHttpUrl };
if (typeof module !== 'undefined') module.exports = adminConflictsApi;
if (typeof window !== 'undefined')
  window.TokoroAdminConflicts = adminConflictsApi;

'use strict';

/**
 * Admin client for members and suggestions. A classic script (so the admin page
 * works from file:// too): window.TokoroAdminMembers in the browser, require()
 * in Node tests. `ed` (@noble/ed25519, SHA-512 already configured) is injected.
 */

const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const unhex = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));

function b64urlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The personal link for a member: the seed travels in the fragment, never to a server. */
function buildMemberLink(publicWebUrl, seed) {
  return (
    String(publicWebUrl).replace(/\/+$/, '') +
    '/tours.html#k=' +
    b64urlEncode(seed)
  );
}

/**
 * Text for `npm run bands-scout -- bands.txt`: one band per line, "Name" or
 * "Name | site" (the first spelling and the first site of each group).
 */
function bandsTxt(groups) {
  return groups
    .map(g => {
      const name = String(g.name_variants[0] || '')
        .replace(/[|\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!name) return '';
      return (g.urls && g.urls[0] ? name + ' | ' + g.urls[0] : name) + '\n';
    })
    .join('');
}

function createAdminApi({ ed, fetchFn, workerUrl, privKeyHex }) {
  const base = String(workerUrl).replace(/\/+$/, '');

  async function headers(domain, payload) {
    const priv = unhex(privKeyHex);
    const ts = String(Math.floor(Date.now() / 1000));
    const msg = new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(domain + ':' + payload + ':' + ts)
      )
    );
    return {
      'X-Pubkey': hex(await ed.getPublicKeyAsync(priv)),
      'X-Signature': hex(await ed.signAsync(msg, priv)),
      'X-Timestamp': ts,
    };
  }

  async function call(method, path, domain, payload, body) {
    const h = await headers(domain, payload);
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetchFn(base + path, { method, headers: h, body });
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

  const postJson = (path, domain, obj) => {
    const body = JSON.stringify(obj);
    return call('POST', path, domain, body, body);
  };

  return {
    listMembers: () =>
      call('GET', '/admin/members', 'admin-read', '/admin/members'),
    /** Creates the member and returns { pubkey, seed } — the seed is not stored anywhere. */
    async createMember(name) {
      const seed = ed.utils.randomPrivateKey();
      const pubkey = hex(await ed.getPublicKeyAsync(seed));
      await postJson('/admin/members', 'admin-member', { pubkey, name });
      return { pubkey, seed };
    },
    revokeMember: pubkey =>
      call(
        'POST',
        '/admin/members/' + pubkey + '/revoke',
        'admin-member-revoke',
        pubkey
      ),
    deleteMember: pubkey =>
      call('DELETE', '/admin/members/' + pubkey, 'admin-member-delete', pubkey),
    // admin-read signs the exact path requested, query string included.
    listSuggestions: ({ detail = false } = {}) => {
      const path = '/admin/suggestions' + (detail ? '?detail=1' : '');
      return call('GET', path, 'admin-read', path);
    },
    rejectSuggestions: (ids, reason) =>
      postJson('/admin/suggestions/reject', 'admin-suggestion-reject', {
        ids,
        reason: reason || '',
      }),
    linkSuggestions: (ids, actUrl) =>
      postJson('/admin/suggestions/link', 'admin-suggestion-link', {
        ids,
        act_url: actUrl,
      }),
    followers: () =>
      call(
        'GET',
        '/admin/band-followers',
        'admin-read',
        '/admin/band-followers'
      ),
  };
}

// Not named `api`: classic scripts share one global scope, and a duplicate top-level
// const breaks loading (member.js and tours.js collided this way).
const adminMembersApi = {
  b64urlEncode,
  buildMemberLink,
  bandsTxt,
  createAdminApi,
};
if (typeof module !== 'undefined') module.exports = adminMembersApi;
if (typeof window !== 'undefined') window.TokoroAdminMembers = adminMembersApi;

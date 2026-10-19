'use strict';

/**
 * Member logic for tours.html (no DOM): the personal link, the signed API
 * client, and the matching of a member's suggestions against the tracked bands.
 * Loaded as a classic script in the browser (window.TokoroMember) and via
 * require() in the Node tests.
 *
 * normalizeActUrl / normalizeName MUST behave exactly like worker/src/band-keys.ts
 * (worker/src/contract.test.ts runs both against each other).
 */

const MEMBER_SEED_KEY = 'tokoro_member';
const MEMBER_VIEW_KEY = 'tokoro_member_view';
const AUTO_FOLLOWED_KEY = 'tokoro_member_autofollowed';

// PKCS8 wrapper of a raw 32-byte Ed25519 seed (RFC 8410), so WebCrypto can import it.
const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);

function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function b64urlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Uint8Array from base64url, or null for anything malformed. */
function b64urlDecode(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const b64 =
      s.replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - (s.length % 4)) % 4);
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function normalizeActUrl(raw) {
  if (typeof raw !== 'string') return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.protocol + '//' + u.host + u.pathname.replace(/\/+$/, '');
}

function normalizeName(raw) {
  return String(raw || '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

// ── The personal link ────────────────────────────────────────────────────────

/** "#k=<seed>" → { status: 'none' | 'invalid' | 'found', seed? }. 'invalid': right shape, wrong length. */
function readLinkSeed(hash) {
  const m = /^#?k=([A-Za-z0-9_-]+)$/.exec(String(hash || ''));
  if (!m) return { status: 'none' };
  const bytes = b64urlDecode(m[1]);
  if (!bytes || bytes.length !== 32) return { status: 'invalid' };
  return { status: 'found', seed: m[1] };
}

/** { pubkey, privateKey } from a base64url seed; throws when the seed is not 32 bytes. */
async function importMember(seedB64) {
  const seed = b64urlDecode(seedB64);
  if (!seed || seed.length !== 32) throw new Error('Invalid member seed');
  const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
  pkcs8.set(PKCS8_PREFIX, 0);
  pkcs8.set(seed, PKCS8_PREFIX.length);
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    'Ed25519',
    true,
    ['sign']
  );
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  return { pubkey: bytesToHex(b64urlDecode(jwk.x)), privateKey };
}

/**
 * true when this browser's WebCrypto can import (and export) an Ed25519 key,
 * which member features need; false otherwise. Never throws. `subtle` is
 * injectable for tests.
 */
async function supportsEd25519(
  subtle = typeof crypto !== 'undefined' ? crypto.subtle : null
) {
  try {
    if (!subtle) return false;
    const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
    pkcs8.set(PKCS8_PREFIX, 0);
    pkcs8.fill(7, PKCS8_PREFIX.length); // a fixed test seed
    const key = await subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, [
      'sign',
    ]);
    const jwk = await subtle.exportKey('jwk', key);
    return !!(jwk && typeof jwk.x === 'string');
  } catch {
    return false;
  }
}

function loadStoredSeed(storage) {
  try {
    return (storage && storage.getItem(MEMBER_SEED_KEY)) || null;
  } catch {
    return null;
  }
}
function saveSeed(storage, seed) {
  try {
    storage.setItem(MEMBER_SEED_KEY, seed);
  } catch {}
}
function clearSeed(storage) {
  try {
    storage.removeItem(MEMBER_SEED_KEY);
  } catch {}
}

function loadAutoFollowed(storage) {
  try {
    const arr = JSON.parse(
      (storage && storage.getItem(AUTO_FOLLOWED_KEY)) || '[]'
    );
    return new Set(Array.isArray(arr) ? arr.filter(Number.isInteger) : []);
  } catch {
    return new Set();
  }
}
function saveAutoFollowed(storage, set) {
  try {
    storage.setItem(AUTO_FOLLOWED_KEY, JSON.stringify([...set]));
  } catch {}
}

// ── Suggestions vs tracked bands ─────────────────────────────────────────────

/**
 * Suggestions as the page shows them. state: 'waiting' | 'added' | 'rejected'.
 * A pending suggestion matching a tracked band (by site url, else by name) is
 * 'added' and carries autoFollowUrl; 'linked' ones were followed by the server.
 */
function describeSuggestions(suggestions, trackedBands) {
  const byName = new Map();
  const byUrl = new Map();
  for (const b of trackedBands || []) {
    const n = normalizeName(b.name);
    if (n && !byName.has(n)) byName.set(n, b.url);
    const u = normalizeActUrl(b.url);
    if (u && !byUrl.has(u)) byUrl.set(u, b.url);
  }
  return (suggestions || []).map(s => {
    let state = 'waiting';
    let autoFollowUrl = null;
    if (s.status === 'linked') {
      state = 'added';
    } else if (s.status === 'rejected') {
      state = 'rejected';
    } else {
      const u = s.url ? normalizeActUrl(s.url) : null;
      const hit = (u && byUrl.get(u)) || byName.get(normalizeName(s.name));
      if (hit) {
        state = 'added';
        autoFollowUrl = hit;
      }
    }
    return {
      id: s.id,
      name: s.name,
      state,
      reason: s.reject_reason || '',
      autoFollowUrl,
    };
  });
}

function followedSet(bands) {
  return new Set((bands || []).map(normalizeActUrl).filter(Boolean));
}
function isFollowed(set, bandUrl) {
  const k = normalizeActUrl(bandUrl);
  return !!k && set.has(k);
}

// ── Signed API client ────────────────────────────────────────────────────────

async function signRequest(member, domain, payload, nowSec) {
  const ts = String(nowSec);
  const msg = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(domain + ':' + payload + ':' + ts)
    )
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('Ed25519', member.privateKey, msg)
  );
  return {
    'X-Pubkey': member.pubkey,
    'X-Signature': bytesToHex(sig),
    'X-Timestamp': ts,
  };
}

/**
 * Calls return { ok, status, data }. A 401 that carries server_time (the
 * device clock is off) is retried once with the corrected clock.
 * `clock` is injectable for tests.
 */
function createMemberApi(
  fetchFn,
  apiBase,
  member,
  clock = () => Math.floor(Date.now() / 1000)
) {
  let offsetSec = 0;

  async function call(method, path, domain, payload, body) {
    let res = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = await signRequest(
        member,
        domain,
        payload,
        clock() + offsetSec
      );
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      res = await fetchFn(apiBase + path, { method, headers, body });
      if (res.status === 401 && attempt === 0) {
        let data = null;
        try {
          data = await res.clone().json();
        } catch {}
        if (data && typeof data.server_time === 'number') {
          offsetSec = data.server_time - clock();
          continue;
        }
      }
      break;
    }
    let data = null;
    try {
      data = await res.json();
    } catch {}
    return { ok: res.ok, status: res.status, data };
  }

  function bandCall(method, domain, bandUrl) {
    const url = normalizeActUrl(bandUrl);
    if (!url) return Promise.resolve({ ok: false, status: 400, data: null });
    const enc = b64urlEncode(new TextEncoder().encode(url));
    return call(method, '/member/bands/' + enc, domain, url);
  }

  return {
    me: () => call('GET', '/member/me', 'member-read', '/member/me'),
    follow: bandUrl => bandCall('POST', 'band-follow', bandUrl),
    unfollow: bandUrl => bandCall('DELETE', 'band-unfollow', bandUrl),
    suggest: (name, url) => {
      const obj = { name };
      if (url) obj.url = url;
      const body = JSON.stringify(obj);
      return call('POST', '/member/suggestions', 'band-suggest', body, body);
    },
    telegramLinkCode: () =>
      call(
        'POST',
        '/member/telegram/link-code',
        'telegram-link-code',
        '/member/telegram/link-code'
      ),
  };
}

// Not named `api`: tours.js declares a top-level `api` too, and classic
// scripts share one global scope (a duplicate `const` fails to load).
const memberApi = {
  MEMBER_VIEW_KEY,
  b64urlEncode,
  b64urlDecode,
  normalizeActUrl,
  normalizeName,
  readLinkSeed,
  importMember,
  supportsEd25519,
  loadStoredSeed,
  saveSeed,
  clearSeed,
  loadAutoFollowed,
  saveAutoFollowed,
  describeSuggestions,
  followedSet,
  isFollowed,
  createMemberApi,
};

if (typeof module !== 'undefined') module.exports = memberApi;
if (typeof window !== 'undefined')
  window.TokoroMember = Object.assign(window.TokoroMember || {}, memberApi);

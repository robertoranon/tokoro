// Normalization shared by the member endpoints. The browser copies of
// normalizeActUrl/normalizeName live in public-web/member.js and MUST behave
// identically (a contract test in contract.test.ts checks this).

/** scheme + host(+port) + path; no query, hash or trailing slash. null if not an http(s) URL. */
export function normalizeActUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

/** Case-, accent- and punctuation-insensitive key for comparing band names. */
export function normalizeName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function encodeB64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** UTF-8 text from base64url, or null for anything malformed. */
export function decodeB64Url(s: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const b64 =
      s.replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - (s.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

import { describe, it, expect } from 'vitest';
import { verifySignedRequest } from './member-auth';
import { makeKey, authHeaders } from '../test-support/sign';

const req = (headers: Record<string, string>) =>
  new Request('https://w.test/member/me', { headers });

describe('verifySignedRequest', () => {
  it('accepts a fresh, correctly signed request', async () => {
    const key = await makeKey();
    const r = await verifySignedRequest(
      req(await authHeaders(key, 'member-read', '/member/me')),
      'member-read',
      '/member/me'
    );
    expect(r).toEqual({ ok: true, pubkey: key.pubkey });
  });

  it('accepts an upper-case pubkey header', async () => {
    const key = await makeKey();
    const h = await authHeaders(key, 'member-read', '/member/me');
    h['X-Pubkey'] = h['X-Pubkey'].toUpperCase();
    const r = await verifySignedRequest(req(h), 'member-read', '/member/me');
    expect(r).toEqual({ ok: true, pubkey: key.pubkey });
  });

  it('rejects a signature made for another domain', async () => {
    const key = await makeKey();
    const r = await verifySignedRequest(
      req(await authHeaders(key, 'admin-read', '/member/me')),
      'member-read',
      '/member/me'
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('rejects a signature made for another payload', async () => {
    const key = await makeKey();
    const r = await verifySignedRequest(
      req(await authHeaders(key, 'member-read', '/other')),
      'member-read',
      '/member/me'
    );
    expect(r.ok).toBe(false);
  });

  it('rejects a signature that belongs to a different key', async () => {
    const a = await makeKey();
    const b = await makeKey();
    const h = await authHeaders(a, 'member-read', '/member/me');
    h['X-Pubkey'] = b.pubkey;
    const r = await verifySignedRequest(req(h), 'member-read', '/member/me');
    expect(r.ok).toBe(false);
  });

  it('rejects a timestamp outside the window and reports the server time', async () => {
    const key = await makeKey();
    const now = Math.floor(Date.now() / 1000);
    const r = await verifySignedRequest(
      req(await authHeaders(key, 'member-read', '/member/me', now - 1000)),
      'member-read',
      '/member/me'
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(Math.abs((r.serverTime ?? 0) - now)).toBeLessThan(5);
    }
  });

  it('rejects missing or malformed headers', async () => {
    const r1 = await verifySignedRequest(req({}), 'member-read', '/member/me');
    expect(r1.ok).toBe(false);
    const key = await makeKey();
    const h = await authHeaders(key, 'member-read', '/member/me');
    h['X-Signature'] = 'zz';
    const r2 = await verifySignedRequest(req(h), 'member-read', '/member/me');
    expect(r2.ok).toBe(false);
  });
});

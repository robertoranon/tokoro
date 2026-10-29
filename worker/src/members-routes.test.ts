import { describe, it, expect, beforeEach } from 'vitest';
import worker, { BACKUP_TABLES } from './index';
import { encodeB64Url } from './band-keys';
import { makeD1 } from '../test-support/d1';
import { makeKey, authHeaders, type TestKey } from '../test-support/sign';

let env: any;
let admin: TestKey;
let anna: TestKey;

async function send(
  key: TestKey,
  method: string,
  path: string,
  domain: string,
  payload: string,
  body?: string
) {
  const headers = await authHeaders(key, domain, payload);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(
    new Request('https://w.test' + path, { method, headers, body }),
    env
  );
}

beforeEach(async () => {
  admin = await makeKey();
  anna = await makeKey();
  env = {
    DB: makeD1(),
    ADMIN_PUBKEY: admin.pubkey,
  };
});

describe('member lifecycle through the Worker', () => {
  it('create → follow → suggest → link → revoke', async () => {
    const createBody = JSON.stringify({ pubkey: anna.pubkey, name: 'Anna' });
    expect(
      (
        await send(
          admin,
          'POST',
          '/admin/members',
          'admin-member',
          createBody,
          createBody
        )
      ).status
    ).toBe(201);

    const meOf = () =>
      send(anna, 'GET', '/member/me', 'member-read', '/member/me');
    expect(((await (await meOf()).json()) as any).name).toBe('Anna');

    const alpha = 'https://alpha.example';
    expect(
      (
        await send(
          anna,
          'POST',
          '/member/bands/' + encodeB64Url(alpha),
          'band-follow',
          alpha
        )
      ).status
    ).toBe(200);

    const sBody = JSON.stringify({ name: 'Beta' });
    const sRes = await send(
      anna,
      'POST',
      '/member/suggestions',
      'band-suggest',
      sBody,
      sBody
    );
    const { id } = (await sRes.json()) as any;

    const list = await send(
      admin,
      'GET',
      '/admin/suggestions',
      'admin-read',
      '/admin/suggestions'
    );
    expect(((await list.json()) as any[])[0].ids).toEqual([id]);

    const lBody = JSON.stringify({
      ids: [id],
      act_url: 'https://beta.example',
    });
    await send(
      admin,
      'POST',
      '/admin/suggestions/link',
      'admin-suggestion-link',
      lBody,
      lBody
    );
    const me: any = await (await meOf()).json();
    expect(me.bands.sort()).toEqual([
      'https://alpha.example',
      'https://beta.example',
    ]);
    expect(me.suggestions[0].status).toBe('linked');

    const followers = await send(
      admin,
      'GET',
      '/admin/band-followers',
      'admin-read',
      '/admin/band-followers'
    );
    expect(((await followers.json()) as any[]).length).toBe(2);

    await send(
      admin,
      'POST',
      `/admin/members/${anna.pubkey}/revoke`,
      'admin-member-revoke',
      anna.pubkey
    );
    expect((await meOf()).status).toBe(403);
  });
});

describe('members are not publishers', () => {
  beforeEach(async () => {
    env.ALLOWED_PUBKEYS = 'ab'.repeat(32); // a publisher that is not Anna
    const body = JSON.stringify({ pubkey: anna.pubkey, name: 'Anna' });
    await send(admin, 'POST', '/admin/members', 'admin-member', body, body);
  });

  it('POST /events is rejected by the allowlist', async () => {
    const res = await worker.fetch(
      new Request('https://w.test/events', {
        method: 'POST',
        body: JSON.stringify({
          pubkey: anna.pubkey,
          signature: '0'.repeat(128),
          title: 'x',
          lat: 1,
          lng: 1,
          start_time: '2030-01-01T00:00:00',
          category: 'music',
        }),
      }),
      env
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).message).toBe(
      'Public key not in allowlist'
    );
  });

  it('POST /events/:id/act is rejected by the allowlist', async () => {
    const res = await worker.fetch(
      new Request('https://w.test/events/abc/act', {
        method: 'POST',
        body: JSON.stringify({
          pubkey: anna.pubkey,
          signature: '0'.repeat(128),
          act_name: 'A',
          act_url: 'https://a.example',
        }),
      }),
      env
    );
    expect(res.status).toBe(403);
  });
});

describe('existing behaviour is unchanged', () => {
  it('answers CORS preflight and allows the new auth headers', async () => {
    const res = await worker.fetch(
      new Request('https://w.test/member/me', { method: 'OPTIONS' }),
      env
    );
    expect(res.status).toBe(200);
    const allow = res.headers.get('Access-Control-Allow-Headers') || '';
    for (const h of [
      'Content-Type',
      'X-Pubkey',
      'X-Signature',
      'X-Timestamp',
    ]) {
      expect(allow).toContain(h);
    }
  });

  it('still serves the unauthenticated blocklist read', async () => {
    const res = await worker.fetch(
      new Request('https://w.test/admin/blocklist'),
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('still returns 404 for unknown routes', async () => {
    const res = await worker.fetch(new Request('https://w.test/nope'), env);
    expect(res.status).toBe(404);
  });
});

describe('backup', () => {
  it('BACKUP_TABLES includes member_festivals and festival_suggestions', () => {
    const t: readonly string[] = BACKUP_TABLES;
    expect(t).toContain('member_festivals');
    expect(t).toContain('festival_suggestions');
    expect(t.indexOf('festival_suggestions')).toBeGreaterThan(
      t.indexOf('band_suggestions')
    );
  });
});

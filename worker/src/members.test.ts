import { describe, it, expect, beforeEach } from 'vitest';
import { routeMemberRequest } from './members';
import { encodeB64Url } from './band-keys';
import { makeD1 } from '../test-support/d1';
import { makeKey, authHeaders, type TestKey } from '../test-support/sign';

let env: any;
let anna: TestKey;

async function addMember(key: TestKey, name = 'Anna', revoked = false) {
  await env.DB.prepare(
    'INSERT INTO members (pubkey, name, created_at, revoked_at) VALUES (?, ?, ?, ?)'
  )
    .bind(
      key.pubkey,
      name,
      '2026-10-13T10:00:00',
      revoked ? '2026-10-14T10:00:00' : null
    )
    .run();
}

async function call(
  key: TestKey,
  method: string,
  path: string,
  domain: string,
  payload: string,
  body?: string
) {
  const headers = await authHeaders(key, domain, payload);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return (await routeMemberRequest(
    new Request('https://w.test' + path, { method, headers, body }),
    env,
    path
  ))!;
}

const me = (key: TestKey) =>
  call(key, 'GET', '/member/me', 'member-read', '/member/me');
const bandPath = (url: string) => '/member/bands/' + encodeB64Url(url);

beforeEach(async () => {
  env = { DB: makeD1() };
  anna = await makeKey();
  await addMember(anna);
});

describe('routing', () => {
  it('returns null for paths it does not own', async () => {
    const r = await routeMemberRequest(
      new Request('https://w.test/events'),
      env,
      '/events'
    );
    expect(r).toBeNull();
  });
});

describe('GET /member/me', () => {
  it('returns the name, followed bands and suggestions of an active member', async () => {
    const res = await me(anna);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: 'Anna',
      bands: [],
      suggestions: [],
      telegram: { linked: false, radar_alerts: false },
    });
  });

  it('403 for an unknown key', async () => {
    const stranger = await makeKey();
    expect((await me(stranger)).status).toBe(403);
  });

  it('403 for a revoked member', async () => {
    const bob = await makeKey();
    await addMember(bob, 'Bob', true);
    expect((await me(bob)).status).toBe(403);
  });

  it('401 without valid auth', async () => {
    const r = await routeMemberRequest(
      new Request('https://w.test/member/me'),
      env,
      '/member/me'
    );
    expect(r!.status).toBe(401);
  });
});

describe('follow / unfollow', () => {
  const url = 'https://Alpha.example/tour/';

  it('stores the normalized url and is idempotent', async () => {
    const p = bandPath(url);
    const r1 = await call(
      anna,
      'POST',
      p,
      'band-follow',
      'https://alpha.example/tour'
    );
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ act_url: 'https://alpha.example/tour' });
    const r2 = await call(
      anna,
      'POST',
      p,
      'band-follow',
      'https://alpha.example/tour'
    );
    expect(r2.status).toBe(200);
    const body: any = await (await me(anna)).json();
    expect(body.bands).toEqual(['https://alpha.example/tour']);
  });

  it('unfollow removes it and is idempotent', async () => {
    const p = bandPath(url);
    await call(anna, 'POST', p, 'band-follow', 'https://alpha.example/tour');
    const r = await call(
      anna,
      'DELETE',
      p,
      'band-unfollow',
      'https://alpha.example/tour'
    );
    expect(r.status).toBe(200);
    const again = await call(
      anna,
      'DELETE',
      p,
      'band-unfollow',
      'https://alpha.example/tour'
    );
    expect(again.status).toBe(200);
    expect(((await (await me(anna)).json()) as any).bands).toEqual([]);
  });

  it('400 for a path that is not base64url or not an http(s) url', async () => {
    const bad = await call(
      anna,
      'POST',
      '/member/bands/***',
      'band-follow',
      'x'
    );
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const notUrl = await call(
      anna,
      'POST',
      bandPath('ftp://x.example'),
      'band-follow',
      'ftp://x.example'
    );
    expect(notUrl.status).toBe(400);
  });

  it('keeps one list per member', async () => {
    const bob = await makeKey();
    await addMember(bob, 'Bob');
    await call(
      anna,
      'POST',
      bandPath(url),
      'band-follow',
      'https://alpha.example/tour'
    );
    expect(((await (await me(bob)).json()) as any).bands).toEqual([]);
  });
});

describe('POST /member/suggestions', () => {
  const send = (key: TestKey, obj: unknown) => {
    const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
    return call(key, 'POST', '/member/suggestions', 'band-suggest', body, body);
  };

  it('creates a pending suggestion and lists it in /member/me', async () => {
    const res = await send(anna, {
      name: ' Beta Band ',
      url: 'https://Beta.example/',
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as any;
    const body: any = await (await me(anna)).json();
    expect(body.suggestions).toEqual([
      {
        id,
        name: 'Beta Band',
        url: 'https://beta.example',
        status: 'pending',
        act_url: null,
        reject_reason: null,
        created_at: expect.any(String),
      },
    ]);
  });

  it('returns the existing id for a duplicate pending name from the same member', async () => {
    const first: any = await (await send(anna, { name: 'Beta Band' })).json();
    const dup = await send(anna, { name: 'beta-band!' });
    expect(dup.status).toBe(200);
    expect(((await dup.json()) as any).id).toBe(first.id);
  });

  it('lets two members suggest the same name', async () => {
    const bob = await makeKey();
    await addMember(bob, 'Bob');
    expect((await send(anna, { name: 'Beta' })).status).toBe(201);
    expect((await send(bob, { name: 'Beta' })).status).toBe(201);
  });

  it('400 for invalid input', async () => {
    expect((await send(anna, { name: '   ' })).status).toBe(400);
    expect((await send(anna, { name: '!!!' })).status).toBe(400);
    expect((await send(anna, { name: 'x'.repeat(121) })).status).toBe(400);
    expect((await send(anna, { name: 'Ok', url: 'ftp://x' })).status).toBe(400);
    expect((await send(anna, { name: 'Ok', url: 7 })).status).toBe(400);
    expect((await send(anna, 'not json')).status).toBe(400);
  });
});

describe('hardening', () => {
  const sendSuggest = (key: TestKey, body: string) =>
    call(key, 'POST', '/member/suggestions', 'band-suggest', body, body);

  it('400 for a suggestion url longer than 500 characters', async () => {
    const long = 'https://band.example/' + 'a'.repeat(480);
    const res = await sendSuggest(
      anna,
      JSON.stringify({ name: 'Long', url: long })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'url must be an http(s) URL (max 500 characters)',
    });
    // exactly 500 is fine
    const ok = 'https://band.example/' + 'a'.repeat(500 - 21);
    expect(ok.length).toBe(500);
    expect(
      (await sendSuggest(anna, JSON.stringify({ name: 'Ok', url: ok }))).status
    ).toBe(201);
  });

  it('413 for an oversized body without Content-Length (after the header check)', async () => {
    const body = JSON.stringify({ name: 'Big', pad: 'x'.repeat(9000) });
    const res = await sendSuggest(anna, body);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Payload too large' });
  });

  it('413 from Content-Length before authentication', async () => {
    const res = (await routeMemberRequest(
      new Request('https://w.test/member/suggestions', {
        method: 'POST',
        headers: { 'Content-Length': '100000' },
        body: '{}',
      }),
      env,
      '/member/suggestions'
    ))!;
    expect(res.status).toBe(413);
  });

  it('401 for malformed headers without reading the body', async () => {
    const req = new Request('https://w.test/member/suggestions', {
      method: 'POST',
      headers: { 'X-Pubkey': 'nothex', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Beta' }),
    });
    const res = (await routeMemberRequest(req, env, '/member/suggestions'))!;
    expect(res.status).toBe(401);
    expect(req.bodyUsed).toBe(false);
  });

  it('401 for a stale timestamp without reading the body', async () => {
    const body = JSON.stringify({ name: 'Beta' });
    const headers = await authHeaders(
      anna,
      'band-suggest',
      body,
      Math.floor(Date.now() / 1000) - 3600
    );
    const req = new Request('https://w.test/member/suggestions', {
      method: 'POST',
      headers,
      body,
    });
    const res = (await routeMemberRequest(req, env, '/member/suggestions'))!;
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).server_time).toEqual(expect.any(Number));
    expect(req.bodyUsed).toBe(false);
  });

  it('403 for a revoked member on follow, unfollow and suggest', async () => {
    const bob = await makeKey();
    await addMember(bob, 'Bob', true);
    const url = 'https://alpha.example';
    expect(
      (await call(bob, 'POST', bandPath(url), 'band-follow', url)).status
    ).toBe(403);
    expect(
      (await call(bob, 'DELETE', bandPath(url), 'band-unfollow', url)).status
    ).toBe(403);
    expect(
      (await sendSuggest(bob, JSON.stringify({ name: 'Beta' }))).status
    ).toBe(403);
    const n = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM band_suggestions'
    ).first();
    expect(n).toEqual({ n: 0 });
  });
});

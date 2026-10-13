import { describe, it, expect, beforeEach } from 'vitest';
import { routeAdminMemberRequest, groupSuggestions } from './admin-members';
import { makeD1 } from '../test-support/d1';
import { makeKey, authHeaders, type TestKey } from '../test-support/sign';

let env: any;
let admin: TestKey;

async function call(
  key: TestKey,
  method: string,
  path: string,
  domain: string,
  payload: string,
  body?: string,
  query = ''
) {
  const headers = await authHeaders(key, domain, payload);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return (await routeAdminMemberRequest(
    new Request('https://w.test' + path + query, { method, headers, body }),
    env,
    path
  ))!;
}

const createMember = (pubkey: string, name: string) => {
  const body = JSON.stringify({ pubkey, name });
  return call(admin, 'POST', '/admin/members', 'admin-member', body, body);
};
const listMembers = () =>
  call(admin, 'GET', '/admin/members', 'admin-read', '/admin/members');

async function addSuggestion(
  pubkey: string,
  name: string,
  url: string | null = null
) {
  const r = await env.DB.prepare(
    `INSERT INTO band_suggestions (pubkey, name, url, status, created_at) VALUES (?, ?, ?, 'pending', ?)`
  )
    .bind(pubkey, name, url, '2026-10-13T10:00:00')
    .run();
  return r.meta.last_row_id as number;
}

beforeEach(async () => {
  admin = await makeKey();
  env = { DB: makeD1(), ADMIN_PUBKEY: admin.pubkey };
});

describe('auth', () => {
  it('503 when ADMIN_PUBKEY is not configured', async () => {
    env.ADMIN_PUBKEY = undefined;
    const res = await listMembers();
    expect(res.status).toBe(503);
  });

  it('403 for a valid signature from another key', async () => {
    const other = await makeKey();
    const res = await call(
      other,
      'GET',
      '/admin/members',
      'admin-read',
      '/admin/members'
    );
    expect(res.status).toBe(403);
  });

  it('401 for a bad signature', async () => {
    const res = await call(
      admin,
      'GET',
      '/admin/members',
      'admin-read',
      '/wrong'
    );
    expect(res.status).toBe(401);
  });

  it('returns null for paths it does not own', async () => {
    const r = await routeAdminMemberRequest(
      new Request('https://w.test/admin/blocklist'),
      env,
      '/admin/blocklist'
    );
    expect(r).toBeNull();
  });
});

describe('members', () => {
  it('creates, lists, revokes and deletes a member', async () => {
    const anna = await makeKey();
    const created = await createMember(anna.pubkey, 'Anna');
    expect(created.status).toBe(201);

    const list: any[] = (await (await listMembers()).json()) as any[];
    expect(list).toEqual([
      {
        pubkey: anna.pubkey,
        name: 'Anna',
        created_at: expect.any(String),
        revoked_at: null,
        band_count: 0,
      },
    ]);

    const rev = await call(
      admin,
      'POST',
      `/admin/members/${anna.pubkey}/revoke`,
      'admin-member-revoke',
      anna.pubkey
    );
    expect(rev.status).toBe(200);
    const after: any[] = (await (await listMembers()).json()) as any[];
    expect(after[0].revoked_at).toEqual(expect.any(String));

    const del = await call(
      admin,
      'DELETE',
      `/admin/members/${anna.pubkey}`,
      'admin-member-delete',
      anna.pubkey
    );
    expect(del.status).toBe(200);
    expect(((await (await listMembers()).json()) as any[]).length).toBe(0);
  });

  it('a signature for revoke cannot be used to delete', async () => {
    const anna = await makeKey();
    await createMember(anna.pubkey, 'Anna');
    const res = await call(
      admin,
      'DELETE',
      `/admin/members/${anna.pubkey}`,
      'admin-member-revoke',
      anna.pubkey
    );
    expect(res.status).toBe(401);
  });

  it('409 for an existing pubkey, 400 for bad input, 404 for unknown member', async () => {
    const anna = await makeKey();
    await createMember(anna.pubkey, 'Anna');
    expect((await createMember(anna.pubkey, 'Again')).status).toBe(409);
    expect((await createMember('nothex', 'X')).status).toBe(400);
    expect((await createMember((await makeKey()).pubkey, '  ')).status).toBe(
      400
    );
    expect((await createMember(admin.pubkey, 'Me')).status).toBe(400);
    const ghost = (await makeKey()).pubkey;
    const res = await call(
      admin,
      'POST',
      `/admin/members/${ghost}/revoke`,
      'admin-member-revoke',
      ghost
    );
    expect(res.status).toBe(404);
  });

  it('delete cascades to follows and suggestions', async () => {
    const anna = await makeKey();
    await createMember(anna.pubkey, 'Anna');
    await env.DB.prepare(
      'INSERT INTO member_bands (pubkey, act_url, created_at) VALUES (?, ?, ?)'
    )
      .bind(anna.pubkey, 'https://a.example', 'x')
      .run();
    await addSuggestion(anna.pubkey, 'Beta');
    await call(
      admin,
      'DELETE',
      `/admin/members/${anna.pubkey}`,
      'admin-member-delete',
      anna.pubkey
    );
    const f = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM member_bands'
    ).first();
    const s = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM band_suggestions'
    ).first();
    expect(f.n).toBe(0);
    expect(s.n).toBe(0);
  });
});

describe('groupSuggestions', () => {
  const row = (
    id: number,
    pubkey: string,
    name: string,
    url: string | null,
    created_at: string,
    member_name = 'M'
  ) => ({
    id,
    pubkey,
    name,
    url,
    created_at,
    member_name,
  });

  it('groups by normalized name, counts distinct members, orders by demand', () => {
    const groups = groupSuggestions(
      [
        row(1, 'a', 'Sigur Rós', null, '2026-10-01T00:00:00'),
        row(
          2,
          'b',
          'sigur ros!',
          'https://sigurros.example',
          '2026-10-02T00:00:00'
        ),
        row(3, 'b', 'Sigur Ros', null, '2026-10-03T00:00:00'),
        row(4, 'a', 'Solo Act', null, '2026-10-01T00:00:00'),
      ],
      false
    );
    expect(groups.map(g => g.key)).toEqual(['sigurros', 'soloact']);
    expect(groups[0]).toMatchObject({
      members: 2,
      ids: [1, 2, 3],
      urls: ['https://sigurros.example'],
      created_at: '2026-10-01T00:00:00',
    });
    expect(groups[0].name_variants[0]).toBe('Sigur Ros'); // seen twice-normalized? see below
    expect('member_names' in groups[0]).toBe(false);
  });

  it('adds member names only with detail', () => {
    const groups = groupSuggestions(
      [
        row(1, 'a', 'X Band', null, 't', 'Anna'),
        row(2, 'b', 'x band', null, 't', 'Bob'),
      ],
      true
    );
    expect(groups[0].member_names).toEqual(['Anna', 'Bob']);
  });
});

describe('suggestions', () => {
  async function memberWithSuggestion(name: string, sname: string) {
    const k = await makeKey();
    await createMember(k.pubkey, name);
    const id = await addSuggestion(k.pubkey, sname);
    return { k, id };
  }

  it('lists pending suggestions grouped, without member names by default', async () => {
    await memberWithSuggestion('Anna', 'Beta Band');
    const res = await call(
      admin,
      'GET',
      '/admin/suggestions',
      'admin-read',
      '/admin/suggestions'
    );
    const groups: any[] = (await res.json()) as any[];
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toBe(1);
    expect(groups[0].member_names).toBeUndefined();
    const detail = await call(
      admin,
      'GET',
      '/admin/suggestions',
      'admin-read',
      '/admin/suggestions',
      undefined,
      '?detail=1'
    );
    expect(((await detail.json()) as any[])[0].member_names).toEqual(['Anna']);
  });

  it('rejects with a reason', async () => {
    const { id } = await memberWithSuggestion('Anna', 'Beta Band');
    const body = JSON.stringify({ ids: [id], reason: 'Not touring' });
    const res = await call(
      admin,
      'POST',
      '/admin/suggestions/reject',
      'admin-suggestion-reject',
      body,
      body
    );
    expect(await res.json()).toEqual({ updated: 1 });
    const row = await env.DB.prepare(
      'SELECT status, reject_reason FROM band_suggestions WHERE id = ?'
    )
      .bind(id)
      .first();
    expect(row).toEqual({ status: 'rejected', reject_reason: 'Not touring' });
  });

  it('links to a band: marks linked, stores the normalized act_url and follows it for the suggester', async () => {
    const { k, id } = await memberWithSuggestion('Anna', 'Beta Band');
    const body = JSON.stringify({
      ids: [id],
      act_url: 'https://Beta.example/',
    });
    const res = await call(
      admin,
      'POST',
      '/admin/suggestions/link',
      'admin-suggestion-link',
      body,
      body
    );
    expect(await res.json()).toEqual({ updated: 1 });
    const row = await env.DB.prepare(
      'SELECT status, act_url FROM band_suggestions WHERE id = ?'
    )
      .bind(id)
      .first();
    expect(row).toEqual({ status: 'linked', act_url: 'https://beta.example' });
    const f = await env.DB.prepare(
      'SELECT act_url FROM member_bands WHERE pubkey = ?'
    )
      .bind(k.pubkey)
      .first();
    expect(f).toEqual({ act_url: 'https://beta.example' });
  });

  it('validates reject/link bodies', async () => {
    const bad = JSON.stringify({ ids: [], reason: 'x' });
    expect(
      (
        await call(
          admin,
          'POST',
          '/admin/suggestions/reject',
          'admin-suggestion-reject',
          bad,
          bad
        )
      ).status
    ).toBe(400);
    const noUrl = JSON.stringify({ ids: [1] });
    expect(
      (
        await call(
          admin,
          'POST',
          '/admin/suggestions/link',
          'admin-suggestion-link',
          noUrl,
          noUrl
        )
      ).status
    ).toBe(400);
    const badUrl = JSON.stringify({ ids: [1], act_url: 'nope' });
    expect(
      (
        await call(
          admin,
          'POST',
          '/admin/suggestions/link',
          'admin-suggestion-link',
          badUrl,
          badUrl
        )
      ).status
    ).toBe(400);
  });
});

describe('band followers', () => {
  it('counts followers per band, most followed first, without names', async () => {
    const ins = (p: string, u: string) =>
      env.DB.prepare(
        'INSERT INTO member_bands (pubkey, act_url, created_at) VALUES (?, ?, ?)'
      )
        .bind(p, u, 'x')
        .run();
    await ins('a', 'https://one.example');
    await ins('b', 'https://one.example');
    await ins('a', 'https://two.example');
    const res = await call(
      admin,
      'GET',
      '/admin/band-followers',
      'admin-read',
      '/admin/band-followers'
    );
    expect(await res.json()).toEqual([
      { act_url: 'https://one.example', followers: 2 },
      { act_url: 'https://two.example', followers: 1 },
    ]);
  });
});

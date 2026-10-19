import { describe, it, expect, beforeEach } from 'vitest';
import worker from './index';
import { makeD1 } from '../test-support/d1';
import { makeKey, authHeaders, type TestKey } from '../test-support/sign';

let env: any;
let anna: TestKey;
let bot: TestKey;

async function addMember(key: TestKey, name: string, revoked = false) {
  await env.DB.prepare(
    'INSERT INTO members (pubkey, name, created_at, revoked_at) VALUES (?, ?, ?, ?)'
  )
    .bind(
      key.pubkey,
      name,
      '2026-10-13T10:00:00',
      revoked ? '2026-10-14T00:00:00' : null
    )
    .run();
}

async function linkCode(key: TestKey) {
  const p = '/member/telegram/link-code';
  return worker.fetch(
    new Request('https://w.test' + p, {
      method: 'POST',
      headers: await authHeaders(key, 'telegram-link-code', p),
    }),
    env
  );
}

async function botPost(path: string, domain: string, obj: object, key = bot) {
  const body = JSON.stringify(obj);
  const headers = await authHeaders(key, domain, body);
  headers['Content-Type'] = 'application/json';
  return worker.fetch(
    new Request('https://w.test' + path, { method: 'POST', headers, body }),
    env
  );
}
const link = (code: string, chat_id: string) =>
  botPost('/telegram/link', 'telegram-link', { code, chat_id });

const memberRow = (key: TestKey) =>
  env.DB.prepare(
    'SELECT telegram_chat_id, radar_alerts FROM members WHERE pubkey = ?'
  )
    .bind(key.pubkey)
    .first();

beforeEach(async () => {
  anna = await makeKey();
  bot = await makeKey();
  env = {
    DB: makeD1(),
    TELEGRAM_BOT_USERNAME: 'tokoro_bot',
    TELEGRAM_BOT_PUBKEY: bot.pubkey,
  };
  await addMember(anna, 'Anna');
});

describe('POST /member/telegram/link-code', () => {
  it('issues a fresh code and the bot url, replacing older codes', async () => {
    const first = (await (await linkCode(anna)).json()) as any;
    const res = await linkCode(anna);
    expect(res.status).toBe(200);
    const { code, bot_url } = (await res.json()) as any;
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(bot_url).toBe('https://t.me/tokoro_bot?start=' + code);
    expect(code).not.toBe(first.code);
    const n = (await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM telegram_link_codes'
    ).first()) as any;
    expect(n.n).toBe(1);
  });

  it('403 for a non-member, 503 when the bot username is not configured', async () => {
    expect((await linkCode(await makeKey())).status).toBe(403);
    delete env.TELEGRAM_BOT_USERNAME;
    expect((await linkCode(anna)).status).toBe(503);
  });
});

describe('POST /telegram/link', () => {
  it('links the chat, consumes the code and reports the band count', async () => {
    await env.DB.prepare(
      "INSERT INTO member_bands (pubkey, act_url, created_at) VALUES (?, 'https://a.example', 'x')"
    )
      .bind(anna.pubkey)
      .run();
    const { code } = (await (await linkCode(anna)).json()) as any;
    const res = await link(code, '12345');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: 'Anna',
      bands: 1,
      radar_alerts: false,
    });
    expect(await memberRow(anna)).toEqual({
      telegram_chat_id: '12345',
      radar_alerts: 0,
    });
    expect((await link(code, '12345')).status).toBe(404); // single use
  });

  it('410 for an expired code', async () => {
    await env.DB.prepare(
      "INSERT INTO telegram_link_codes (code, pubkey, expires_at) VALUES (?, ?, '2000-01-01T00:00:00')"
    )
      .bind('a'.repeat(22), anna.pubkey)
      .run();
    expect((await link('a'.repeat(22), '1')).status).toBe(410);
  });

  it('403 when the member was revoked after asking for the code', async () => {
    const { code } = (await (await linkCode(anna)).json()) as any;
    await env.DB.prepare("UPDATE members SET revoked_at = 'x' WHERE pubkey = ?")
      .bind(anna.pubkey)
      .run();
    expect((await link(code, '1')).status).toBe(403);
  });

  it('moves a chat from one member to another', async () => {
    const bea = await makeKey();
    await addMember(bea, 'Bea');
    await link(((await (await linkCode(anna)).json()) as any).code, '777');
    await link(((await (await linkCode(bea)).json()) as any).code, '777');
    expect(((await memberRow(anna)) as any).telegram_chat_id).toBeNull();
    expect(((await memberRow(bea)) as any).telegram_chat_id).toBe('777');
  });

  it('rejects keys other than the bot (403) and an unconfigured bot (503)', async () => {
    const { code } = (await (await linkCode(anna)).json()) as any;
    expect(
      (
        await botPost(
          '/telegram/link',
          'telegram-link',
          { code, chat_id: '1' },
          anna
        )
      ).status
    ).toBe(403);
    delete env.TELEGRAM_BOT_PUBKEY;
    expect((await link(code, '1')).status).toBe(503);
  });

  it('400 for a missing or malformed chat_id', async () => {
    expect((await link('a'.repeat(22), 'abc')).status).toBe(400);
  });
});

describe('POST /telegram/settings and /telegram/unlink', () => {
  beforeEach(async () => {
    await link(((await (await linkCode(anna)).json()) as any).code, '42');
  });

  it('turns radar alerts on and off', async () => {
    const on = await botPost('/telegram/settings', 'telegram-settings', {
      chat_id: '42',
      radar_alerts: true,
    });
    expect(on.status).toBe(200);
    expect(((await memberRow(anna)) as any).radar_alerts).toBe(1);
    await botPost('/telegram/settings', 'telegram-settings', {
      chat_id: '42',
      radar_alerts: false,
    });
    expect(((await memberRow(anna)) as any).radar_alerts).toBe(0);
  });

  it('400 when radar_alerts is not a boolean', async () => {
    const res = await botPost('/telegram/settings', 'telegram-settings', {
      chat_id: '42',
      radar_alerts: 'yes',
    });
    expect(res.status).toBe(400);
  });

  it('unlinks; both endpoints answer 404 for an unknown chat', async () => {
    expect(
      (await botPost('/telegram/unlink', 'telegram-unlink', { chat_id: '42' }))
        .status
    ).toBe(200);
    expect(((await memberRow(anna)) as any).telegram_chat_id).toBeNull();
    expect(
      (await botPost('/telegram/unlink', 'telegram-unlink', { chat_id: '42' }))
        .status
    ).toBe(404);
    expect(
      (
        await botPost('/telegram/settings', 'telegram-settings', {
          chat_id: '42',
          radar_alerts: true,
        })
      ).status
    ).toBe(404);
  });
});

describe('GET /member/me', () => {
  it('reports the telegram link state', async () => {
    const meOf = async () =>
      (await (
        await worker.fetch(
          new Request('https://w.test/member/me', {
            headers: await authHeaders(anna, 'member-read', '/member/me'),
          }),
          env
        )
      ).json()) as any;
    expect((await meOf()).telegram).toEqual({
      linked: false,
      radar_alerts: false,
    });
    await link(((await (await linkCode(anna)).json()) as any).code, '9');
    expect((await meOf()).telegram).toEqual({
      linked: true,
      radar_alerts: false,
    });
  });
});

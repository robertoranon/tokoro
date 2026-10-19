import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as ed from '@noble/ed25519';
import { bytesToHex } from './bot-shared'; // also configures sha512Async
import { handleTelegram } from './telegram';

let apiCalls: string[];
let tgCalls: string[];
let env: any;

const update = {
  update_id: 1,
  message: {
    message_id: 1,
    chat: { id: 4242, type: 'private' },
    text: '/stop',
  },
};
const post = (headers: Record<string, string> = {}) =>
  new Request('https://bot/telegram', {
    method: 'POST',
    headers,
    body: JSON.stringify(update),
  });

beforeEach(async () => {
  apiCalls = [];
  tgCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      tgCalls.push(String(url));
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 1 } })
      );
    })
  );
  const priv = ed.utils.randomPrivateKey();
  env = {
    TELEGRAM_BOT_TOKEN: 'tok',
    PREVIEW_CACHE: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
    BOT_PRIVKEY: bytesToHex(priv),
    BOT_PUBKEY: bytesToHex(await ed.getPublicKeyAsync(priv)),
    API_WORKER_URL: 'https://api.example',
    API_WORKER: {
      fetch: async (req: Request) => {
        apiCalls.push(new URL(req.url).pathname);
        return new Response('{}', { status: 200 });
      },
    },
  };
});

afterEach(() => vi.unstubAllGlobals());

describe('handleTelegram webhook secret', () => {
  it('rejects a wrong or missing secret header with 401', async () => {
    env.TELEGRAM_WEBHOOK_SECRET = 's3cret';
    const missing = await handleTelegram(post(), env);
    const wrong = await handleTelegram(
      post({ 'X-Telegram-Bot-Api-Secret-Token': 'nope' }),
      env
    );
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(apiCalls).toEqual([]);
    expect(tgCalls).toEqual([]);
  });

  it('runs alert commands when the secret matches', async () => {
    env.TELEGRAM_WEBHOOK_SECRET = 's3cret';
    const res = await handleTelegram(
      post({ 'X-Telegram-Bot-Api-Secret-Token': 's3cret' }),
      env
    );
    expect(res.status).toBe(200);
    expect(apiCalls).toEqual(['/telegram/unlink']);
  });

  it('ignores alert commands when no secret is configured', async () => {
    const res = await handleTelegram(post(), env);
    expect(res.status).toBe(200);
    expect(apiCalls).toEqual([]);
    expect(tgCalls.some(u => u.includes('sendMessage'))).toBe(true);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import * as ed from '@noble/ed25519';
import { bytesToHex, hexToBytes } from './bot-shared'; // also configures sha512Async
import {
  handleAlertCommand,
  handleAdminCommand,
  parseNameAndUrl,
} from './telegram-alerts';

let calls: { path: string; headers: Headers; body: any }[];
let answer: { status: number; body: any };
let env: any;
let replies: string[];
const reply = async (t: string) => {
  replies.push(t);
};
const dm = (text: string) => ({ chat: { id: 4242, type: 'private' }, text });

beforeEach(async () => {
  const priv = ed.utils.randomPrivateKey();
  calls = [];
  replies = [];
  answer = { status: 200, body: {} };
  env = {
    BOT_PRIVKEY: bytesToHex(priv),
    BOT_PUBKEY: bytesToHex(await ed.getPublicKeyAsync(priv)),
    API_WORKER: {
      fetch: async (req: Request) => {
        calls.push({
          path: new URL(req.url).pathname,
          headers: req.headers,
          body: JSON.parse(await req.text()),
        });
        return new Response(JSON.stringify(answer.body), {
          status: answer.status,
        });
      },
    },
  };
});

async function verifies(c: (typeof calls)[0], domain: string) {
  const ts = c.headers.get('X-Timestamp')!;
  const msg = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${domain}:${JSON.stringify(c.body)}:${ts}`)
    )
  );
  return ed.verifyAsync(
    hexToBytes(c.headers.get('X-Signature')!),
    msg,
    hexToBytes(c.headers.get('X-Pubkey')!)
  );
}

describe('handleAlertCommand', () => {
  it('/start <code> links the chat with a signed call', async () => {
    answer = {
      status: 200,
      body: { name: 'Anna', bands: 3, radar_alerts: false },
    };
    expect(
      await handleAlertCommand(
        dm('/start abcDEF_123-xyz0123456789'),
        env,
        reply
      )
    ).toBe(true);
    expect(calls[0].path).toBe('/telegram/link');
    expect(calls[0].body).toEqual({
      code: 'abcDEF_123-xyz0123456789',
      chat_id: '4242',
    });
    expect(await verifies(calls[0], 'telegram-link')).toBe(true);
    expect(replies[0]).toContain('Connected, Anna');
    expect(replies[0]).toContain('3 bands');
    expect(replies[0]).toContain('/radar on');
    // the command is case-insensitive, like /radar and /stop
    expect(await handleAlertCommand(dm('/START abcDEF'), env, reply)).toBe(
      true
    );
    expect(calls[1].body.code).toBe('abcDEF');
  });

  it.each([
    [
      3,
      2,
      "Connected, Anna. You'll get a daily message when your 3 bands announce new shows or your 2 festivals announce a new edition.",
    ],
    [
      0,
      1,
      "Connected, Anna. You'll get a daily message when your 1 festival announces a new edition.",
    ],
    [
      3,
      0,
      "Connected, Anna. You'll get a daily message when your 3 bands announce new shows.",
    ],
    [
      0,
      0,
      "Connected, Anna. You'll get a daily message when your 0 bands announce new shows.",
    ],
  ])(
    '/start connect message with %i bands, %i festivals',
    async (bands, festivals, first) => {
      answer = {
        status: 200,
        body: { name: 'Anna', bands, festivals, radar_alerts: false },
      };
      await handleAlertCommand(dm('/start abc'), env, reply);
      expect(replies[0].split('\n')[0]).toBe(first);
    }
  );

  it('/start with an expired or unknown code explains what to do', async () => {
    answer = { status: 410, body: { error: 'Code expired' } };
    await handleAlertCommand(dm('/start abc'), env, reply);
    answer = { status: 404, body: { error: 'Unknown code' } };
    await handleAlertCommand(dm('/start abc'), env, reply);
    expect(replies.every(r => r.includes('expired'))).toBe(true);
  });

  it('/radar on|off updates the setting; bare /radar shows usage without a call', async () => {
    await handleAlertCommand(dm('/radar on'), env, reply);
    expect(calls[0].path).toBe('/telegram/settings');
    expect(calls[0].body).toEqual({ chat_id: '4242', radar_alerts: true });
    expect(await verifies(calls[0], 'telegram-settings')).toBe(true);
    await handleAlertCommand(dm('/radar OFF'), env, reply);
    expect(calls[1].body.radar_alerts).toBe(false);
    await handleAlertCommand(dm('/radar'), env, reply);
    expect(calls).toHaveLength(2);
    expect(replies[2]).toContain('/radar on');
  });

  it('/stop unlinks; an unlinked chat gets a hint', async () => {
    await handleAlertCommand(dm('/stop'), env, reply);
    expect(calls[0].path).toBe('/telegram/unlink');
    expect(await verifies(calls[0], 'telegram-unlink')).toBe(true);
    expect(replies[0]).toContain('Disconnected');
    answer = { status: 404, body: { error: 'Chat not linked' } };
    await handleAlertCommand(dm('/stop'), env, reply);
    expect(replies[1]).toContain("isn't connected");
  });

  it('ignores other messages, bare /start and group chats', async () => {
    expect(await handleAlertCommand(dm('hello'), env, reply)).toBe(false);
    expect(await handleAlertCommand(dm('/start'), env, reply)).toBe(false);
    expect(
      await handleAlertCommand(
        { chat: { id: 1, type: 'group' }, text: '/stop' },
        env,
        reply
      )
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('a worker failure gets a generic error reply', async () => {
    answer = { status: 500, body: {} };
    await handleAlertCommand(dm('/radar on'), env, reply);
    expect(replies[0]).toContain('went wrong');
  });
});

describe('parseNameAndUrl', () => {
  it('accepts "Name | url", "Name url" and a bare name', () => {
    expect(parseNameAndUrl('Karate | https://karate.example/')).toEqual({
      name: 'Karate',
      url: 'https://karate.example/',
    });
    expect(parseNameAndUrl('  The   Ex https://theex.nl')).toEqual({
      name: 'The Ex',
      url: 'https://theex.nl',
    });
    expect(parseNameAndUrl('Tiny Fest')).toEqual({ name: 'Tiny Fest' });
    expect(parseNameAndUrl('https://x.example')).toEqual({
      name: '',
      url: 'https://x.example',
    });
  });
});

describe('handleAdminCommand', () => {
  const group = (text: string) => ({
    chat: { id: -1001, type: 'supergroup' },
    text,
  });

  it('ignores other messages', async () => {
    expect(await handleAdminCommand(dm('/bands'), env, reply)).toBe(false);
    expect(await handleAdminCommand(dm('https://x.example'), env, reply)).toBe(
      false
    );
    expect(calls).toEqual([]);
  });

  it('/band sends a signed admin-suggest call and confirms', async () => {
    answer = {
      status: 201,
      body: { id: 7, name: 'Karate', url: 'https://karate.example' },
    };
    expect(
      await handleAdminCommand(
        group('/band@tokoro_bot Karate | https://karate.example'),
        env,
        reply
      )
    ).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/telegram/admin-suggest');
    expect(calls[0].body).toEqual({
      chat_id: '-1001',
      kind: 'band',
      name: 'Karate',
      url: 'https://karate.example',
    });
    expect(await verifies(calls[0], 'telegram-admin-suggest')).toBe(true);
    expect(replies[0]).toContain('Added band <b>Karate</b>');
  });

  it('/festival without a url omits it', async () => {
    answer = { status: 201, body: { id: 1, name: 'Tiny Fest', url: null } };
    await handleAdminCommand(group('/festival Tiny Fest'), env, reply);
    expect(calls[0].body).toEqual({
      chat_id: '-1001',
      kind: 'festival',
      name: 'Tiny Fest',
    });
    expect(replies[0]).toContain('Festivals');
  });

  it('shows usage without a name, and reports duplicates and errors', async () => {
    await handleAdminCommand(group('/band'), env, reply);
    expect(calls).toEqual([]);
    expect(replies.pop()).toContain('/band Name');

    answer = { status: 200, body: { id: 3, duplicate: true } };
    await handleAdminCommand(group('/band Karate'), env, reply);
    expect(replies.pop()).toContain('already waiting');

    answer = { status: 400, body: { error: 'url must be an http(s) URL' } };
    await handleAdminCommand(group('/band Karate http://'), env, reply);
    expect(replies.pop()).toContain('Url must be an http(s) URL');
  });

  it('403: explains in a private chat, stays silent in groups', async () => {
    answer = { status: 403, body: {} };
    await handleAdminCommand(group('/band Karate'), env, reply);
    expect(replies).toEqual([]);
    await handleAdminCommand(dm('/band Karate'), env, reply);
    expect(replies[0]).toContain('Only the admin chat');
  });
});

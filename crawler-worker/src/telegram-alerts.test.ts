import { describe, it, expect, beforeEach } from 'vitest';
import * as ed from '@noble/ed25519';
import { bytesToHex, hexToBytes } from './bot-shared'; // also configures sha512Async
import { handleAlertCommand } from './telegram-alerts';

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

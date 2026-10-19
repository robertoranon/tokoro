/**
 * Telegram alert commands (tours members): /start <code>, /radar on|off, /stop.
 * Each one calls the API worker's /telegram/* endpoints, signed with the bot
 * key (headers X-Pubkey/X-Signature/X-Timestamp, worker/SPECS.md 3.6). The
 * digests themselves are sent by the API worker's cron.
 */
import * as ed25519 from '@noble/ed25519';
import { Env } from './types';
import { hexToBytes, bytesToHex } from './bot-shared'; // also configures sha512Async

export interface AlertCommandMessage {
  chat: { id: number; type: string };
  text?: string;
}
export type Reply = (text: string) => Promise<unknown>;

const DOMAINS: Record<string, string> = {
  '/telegram/link': 'telegram-link',
  '/telegram/settings': 'telegram-settings',
  '/telegram/unlink': 'telegram-unlink',
};

const MSG = {
  expired:
    'This link has expired. Open Telegram alerts again from the tours page.',
  inactive: 'This personal link is no longer active.',
  notLinked:
    "This chat isn't connected. Open Telegram alerts from your tours page link.",
  radarUsage: 'Send /radar on or /radar off.',
  radarOn: 'Festival radar alerts are on.',
  radarOff: 'Festival radar alerts are off.',
  stopped: "Disconnected. You won't receive alerts.",
  error: 'Something went wrong. Please try again later.',
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function connected(name: string, bands: number, radar: boolean): string {
  const n = `${bands} band${bands === 1 ? '' : 's'}`;
  return [
    `Connected, ${escapeHtml(name)}. You'll get a daily message when your ${n} announce new shows.`,
    radar
      ? 'Festival radar alerts are on (/radar off to stop them).'
      : 'Festival radar alerts are off — send /radar on to enable.',
    '/stop to disconnect.',
  ].join('\n');
}

async function signedHeaders(
  domain: string,
  payload: string,
  pubkey: string,
  privHex: string
): Promise<Record<string, string>> {
  const ts = String(Math.floor(Date.now() / 1000));
  const msg = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${domain}:${payload}:${ts}`)
    )
  );
  const sig = await ed25519.signAsync(msg, hexToBytes(privHex));
  return {
    'Content-Type': 'application/json',
    'X-Pubkey': pubkey.toLowerCase(),
    'X-Signature': bytesToHex(sig),
    'X-Timestamp': ts,
  };
}

async function callWorker(
  env: Env,
  path: string,
  payload: object
): Promise<{ status: number; data: any }> {
  const body = JSON.stringify(payload);
  const headers = await signedHeaders(
    DOMAINS[path],
    body,
    env.BOT_PUBKEY!,
    env.BOT_PRIVKEY!
  );
  const init = { method: 'POST', headers, body };
  const res = env.API_WORKER
    ? await env.API_WORKER.fetch(new Request('https://worker' + path, init))
    : await fetch(`${env.API_WORKER_URL}${path}`, init);
  let data: any = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

/** True when the message was an alert command (and has been answered). */
export async function handleAlertCommand(
  message: AlertCommandMessage,
  env: Env,
  reply: Reply
): Promise<boolean> {
  if (message.chat.type !== 'private' || !message.text) return false;
  const text = message.text.trim();
  const chat_id = String(message.chat.id);

  const start = text.match(/^\/start(?:@\S+)?\s+([A-Za-z0-9_-]+)$/);
  const radar = text.match(/^\/radar(?:@\S+)?(?:\s+(\S+))?$/i);
  const stop = /^\/stop(?:@\S+)?$/i.test(text);
  if (!start && !radar && !stop) return false;

  try {
    if (start) {
      const { status, data } = await callWorker(env, '/telegram/link', {
        code: start[1],
        chat_id,
      });
      if (status === 200 && data && typeof data.name === 'string') {
        await reply(
          connected(
            data.name,
            Number(data.bands) || 0,
            data.radar_alerts === true
          )
        );
      } else if (status === 404 || status === 410) await reply(MSG.expired);
      else if (status === 403) await reply(MSG.inactive);
      else await reply(MSG.error);
      return true;
    }
    if (radar) {
      const arg = (radar[1] || '').toLowerCase();
      if (arg !== 'on' && arg !== 'off') {
        await reply(MSG.radarUsage);
        return true;
      }
      const { status } = await callWorker(env, '/telegram/settings', {
        chat_id,
        radar_alerts: arg === 'on',
      });
      if (status === 200)
        await reply(arg === 'on' ? MSG.radarOn : MSG.radarOff);
      else if (status === 404) await reply(MSG.notLinked);
      else await reply(MSG.error);
      return true;
    }
    const { status } = await callWorker(env, '/telegram/unlink', { chat_id });
    if (status === 200) await reply(MSG.stopped);
    else if (status === 404) await reply(MSG.notLinked);
    else await reply(MSG.error);
  } catch (err) {
    console.error('[telegram-alerts]', err);
    await reply(MSG.error);
  }
  return true;
}

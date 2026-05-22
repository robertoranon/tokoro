/**
 * Telegram bot webhook handler.
 *
 * POST /telegram receives Telegram updates, crawls URLs/images via WorkerCrawler,
 * stores pending events in KV, and publishes confirmed events using the bot's
 * Ed25519 keypair.
 */

import * as ed25519 from '@noble/ed25519';
import { Env } from './types';
import { PreparedEvent } from './event-types';
import { WorkerCrawler } from './crawler-adapter';

// Configure @noble/ed25519 to use the Web Crypto API for SHA-512
// (required in Cloudflare Workers — same pattern as worker/src/crypto.ts)
ed25519.etc.sha512Async = async (...messages: Uint8Array[]) => {
  const combined = new Uint8Array(
    messages.reduce((acc, m) => acc + m.length, 0)
  );
  let offset = 0;
  for (const m of messages) {
    combined.set(m, offset);
    offset += m.length;
  }
  const hashBuffer = await crypto.subtle.digest('SHA-512', combined);
  return new Uint8Array(hashBuffer);
};

// ---------------------------------------------------------------------------
// Telegram API types (subset used by this bot)
// ---------------------------------------------------------------------------

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  photo?: TelegramPhotoSize[];
  document?: { file_id: string; mime_type?: string };
}

interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
  width: number;
  height: number;
}

interface TelegramCallbackQuery {
  id: string;
  message?: TelegramMessage;
  data?: string;
}

// ---------------------------------------------------------------------------
// Hex utilities
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Signs a PreparedEvent using the bot's Ed25519 private key.
 * Returns the hex-encoded signature.
 *
 * Canonical object and hashing match exactly what the API worker verifies
 * in worker/src/crypto.ts verifyEventSignature().
 */
async function signEvent(
  event: PreparedEvent,
  pubkey: string,
  privkeyHex: string
): Promise<string> {
  const canonical = {
    pubkey,
    title: event.title,
    description: event.description || '',
    url: event.url || '',
    venue_name: event.venue_name || '',
    address: event.address || '',
    lat: event.lat,
    lng: event.lng,
    start_time: event.start_time,
    end_time: event.end_time,
    category: event.category,
    tags: event.tags || [],
    created_at: event.created_at,
  };

  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify(canonical));
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashHex = bytesToHex(new Uint8Array(hashBuffer));

  const signatureBytes = await ed25519.signAsync(
    hexToBytes(hashHex),
    hexToBytes(privkeyHex)
  );
  return bytesToHex(signatureBytes);
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** One-line summary for a single event used in numbered list. */
function formatEventLine(event: PreparedEvent, index: number): string {
  const date = event.start_time.slice(0, 10);
  const time = event.start_time.slice(11, 16);
  const venue = event.venue_name || event.address || 'unknown venue';
  return `${index + 1}. <b>${escapeHtml(event.title)}</b>\n   ${date} ${time} · ${escapeHtml(venue)}`;
}

/** Full detail card for a single event in the one-by-one flow. */
function formatEventDetail(
  event: PreparedEvent,
  index: number,
  total: number
): string {
  const lines: string[] = [
    `<b>Event ${index + 1} of ${total}</b>`,
    `<b>${escapeHtml(event.title)}</b>`,
  ];
  if (event.description)
    lines.push(escapeHtml(event.description.slice(0, 200)));
  lines.push(`📅 ${event.start_time.replace('T', ' ').slice(0, 16)}`);
  if (event.venue_name) lines.push(`📍 ${escapeHtml(event.venue_name)}`);
  if (event.address) lines.push(`🗺 ${escapeHtml(event.address)}`);
  lines.push(`🏷 ${event.category}`);
  if (event.tags?.length) lines.push(`🔖 ${event.tags.join(', ')}`);
  return lines.join('\n');
}

/** Numbered summary of all events. */
function formatEventSummary(events: PreparedEvent[]): string {
  const lines = events.map((e, i) => formatEventLine(e, i));
  return `Found <b>${events.length}</b> event${events.length !== 1 ? 's' : ''}:\n\n${lines.join('\n\n')}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// KV key and callback_data helpers
// ---------------------------------------------------------------------------

function buildKvKey(chatId: number, messageId: number): string {
  return `tg:${chatId}:${messageId}`;
}

type CallbackData =
  | { type: 'pub_all'; kvKey: string }
  | { type: 'choose'; kvKey: string }
  | { type: 'event'; kvKey: string; index: number; action: 'publish' | 'skip' };

function encodeCallback(data: CallbackData): string {
  switch (data.type) {
    case 'pub_all':
      return `pub_all:${data.kvKey}`;
    case 'choose':
      return `choose:${data.kvKey}`;
    case 'event':
      return `event:${data.kvKey}:${data.index}:${data.action}`;
  }
}

function parseCallback(raw: string): CallbackData | null {
  if (raw.startsWith('pub_all:')) {
    return { type: 'pub_all', kvKey: raw.slice(8) };
  }
  if (raw.startsWith('choose:')) {
    return { type: 'choose', kvKey: raw.slice(7) };
  }
  if (raw.startsWith('event:')) {
    const parts = raw.split(':');
    // format: event:tg:{chatId}:{messageId}:{index}:{action}
    // kvKey = parts[1] + ':' + parts[2] + ':' + parts[3]
    // index = parts[4], action = parts[5]
    if (parts.length < 6) return null;
    const kvKey = `${parts[1]}:${parts[2]}:${parts[3]}`;
    const index = parseInt(parts[4], 10);
    const action = parts[5] as 'publish' | 'skip';
    if (isNaN(index) || (action !== 'publish' && action !== 'skip'))
      return null;
    return { type: 'event', kvKey, index, action };
  }
  return null;
}

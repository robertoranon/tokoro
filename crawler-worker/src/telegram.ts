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

// ---------------------------------------------------------------------------
// Telegram API client
// ---------------------------------------------------------------------------

class TelegramClient {
  private baseUrl: string;
  private fileBaseUrl: string;

  constructor(private token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.fileBaseUrl = `https://api.telegram.org/file/bot${token}`;
  }

  async sendMessage(
    chatId: number,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>
  ): Promise<TelegramMessage> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    };
    if (inlineKeyboard) {
      body.reply_markup = { inline_keyboard: inlineKeyboard };
    }
    const res = await fetch(`${this.baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { result: TelegramMessage };
    return data.result;
  }

  async editMessage(
    chatId: number,
    messageId: number,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
    };
    if (inlineKeyboard) {
      body.reply_markup = { inline_keyboard: inlineKeyboard };
    }
    await fetch(`${this.baseUrl}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    await fetch(`${this.baseUrl}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  }

  /**
   * Downloads a photo by file_id and returns it as base64 string + mime type.
   * Uses the largest available size variant.
   */
  async downloadPhoto(
    fileId: string
  ): Promise<{ data: string; mimeType: string }> {
    const res = await fetch(`${this.baseUrl}/getFile?file_id=${fileId}`);
    const json = (await res.json()) as { result: { file_path: string } };
    const filePath = json.result.file_path;

    const fileRes = await fetch(`${this.fileBaseUrl}/${filePath}`);
    const buffer = await fileRes.arrayBuffer();

    // Base64-encode without stack overflow on large buffers
    const uint8 = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < uint8.length; i += chunkSize) {
      binary += String.fromCharCode(...uint8.subarray(i, i + chunkSize));
    }
    const base64 = btoa(binary);

    const ext = filePath.split('.').pop()?.toLowerCase();
    const mimeType =
      ext === 'png'
        ? 'image/png'
        : ext === 'gif'
          ? 'image/gif'
          : ext === 'webp'
            ? 'image/webp'
            : 'image/jpeg';

    return { data: base64, mimeType };
  }
}

// ---------------------------------------------------------------------------
// KV state — pending events
// ---------------------------------------------------------------------------

const KV_TTL_SECONDS = 1800; // 30 minutes

async function storePendingEvents(
  kv: KVNamespace,
  kvKey: string,
  events: PreparedEvent[]
): Promise<void> {
  await kv.put(kvKey, JSON.stringify(events), {
    expirationTtl: KV_TTL_SECONDS,
  });
}

async function loadPendingEvents(
  kv: KVNamespace,
  kvKey: string
): Promise<PreparedEvent[] | null> {
  const raw = await kv.get(kvKey);
  if (!raw) return null;
  return JSON.parse(raw) as PreparedEvent[];
}

async function deletePendingEvents(
  kv: KVNamespace,
  kvKey: string
): Promise<void> {
  await kv.delete(kvKey);
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/**
 * Signs a PreparedEvent with the bot keypair and POSTs it to the API worker.
 * Returns the published event ID on success, throws on failure.
 */
async function publishEvent(event: PreparedEvent, env: Env): Promise<string> {
  const pubkey = env.BOT_PUBKEY!;
  const signature = await signEvent(event, pubkey, env.BOT_PRIVKEY!);

  const body = {
    ...event,
    pubkey,
    signature,
  };

  const res = await fetch(`${env.API_WORKER_URL}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = (await res.json()) as { error?: string; message?: string };
    throw new Error(err.message || err.error || `HTTP ${res.status}`);
  }

  const result = (await res.json()) as { id: string };
  return result.id;
}

// ---------------------------------------------------------------------------
// Shared: send summary + store pending events
// ---------------------------------------------------------------------------

async function sendEventSummary(
  chatId: number,
  events: PreparedEvent[],
  env: Env,
  tg: TelegramClient
): Promise<void> {
  const text = formatEventSummary(events);
  const sent = await tg.sendMessage(chatId, text);
  const kvKey = buildKvKey(chatId, sent.message_id);

  await storePendingEvents(env.PREVIEW_CACHE!, kvKey, events);

  await tg.editMessage(chatId, sent.message_id, text, [
    [
      {
        text: '✅ Publish all',
        callback_data: encodeCallback({ type: 'pub_all', kvKey }),
      },
      {
        text: '📋 Choose one by one',
        callback_data: encodeCallback({ type: 'choose', kvKey }),
      },
    ],
  ]);
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

async function handleUrl(
  chatId: number,
  url: string,
  env: Env,
  tg: TelegramClient
): Promise<void> {
  await tg.sendMessage(chatId, '🔍 Crawling…');

  const crawler = new WorkerCrawler({ env, mode: 'discover' });
  const result = await crawler.crawl(url);

  if (result.events.length === 0) {
    await tg.sendMessage(chatId, 'No events found.');
    return;
  }

  await sendEventSummary(chatId, result.events, env, tg);
}

async function handlePhoto(
  chatId: number,
  photos: TelegramPhotoSize[],
  mimeType: string,
  env: Env,
  tg: TelegramClient
): Promise<void> {
  await tg.sendMessage(chatId, '🔍 Processing image…');

  // Use the largest available photo variant
  const largest = photos.reduce((best, p) =>
    (p.file_size ?? 0) > (best.file_size ?? 0) ? p : best
  );

  const { data: imageData, mimeType: detectedMime } = await tg.downloadPhoto(
    largest.file_id
  );
  const resolvedMime = mimeType || detectedMime;

  const crawler = new WorkerCrawler({
    env,
    mode: 'image',
    imageData,
    imageMimeType: resolvedMime,
  });
  const result = await crawler.crawl(undefined);

  if (result.events.length === 0) {
    await tg.sendMessage(chatId, 'No events found in image.');
    return;
  }

  await sendEventSummary(chatId, result.events, env, tg);
}

async function handleMessage(
  message: TelegramMessage,
  env: Env,
  tg: TelegramClient
): Promise<void> {
  const chatId = message.chat.id;

  // Photo message
  if (message.photo && message.photo.length > 0) {
    await handlePhoto(chatId, message.photo, 'image/jpeg', env, tg);
    return;
  }

  // Image document
  if (message.document?.mime_type?.startsWith('image/')) {
    // Wrap the document as a single-element photo array for reuse
    const pseudo: TelegramPhotoSize[] = [
      { file_id: message.document.file_id, width: 0, height: 0 },
    ];
    await handlePhoto(chatId, pseudo, message.document.mime_type, env, tg);
    return;
  }

  // Text with URL
  if (message.text) {
    const urlMatch = message.text.match(/https?:\/\/\S+/);
    if (urlMatch) {
      await handleUrl(chatId, urlMatch[0], env, tg);
      return;
    }
  }

  await tg.sendMessage(
    chatId,
    "Send me a URL or an image and I'll extract events from it."
  );
}

// ---------------------------------------------------------------------------
// Confirmation callbacks
// ---------------------------------------------------------------------------

async function handlePublishAll(
  chatId: number,
  messageId: number,
  kvKey: string,
  callbackId: string,
  env: Env,
  tg: TelegramClient
): Promise<void> {
  await tg.answerCallback(callbackId);

  const events = await loadPendingEvents(env.PREVIEW_CACHE!, kvKey);
  if (!events) {
    await tg.sendMessage(
      chatId,
      'Session expired. Send the URL or image again.'
    );
    return;
  }

  let published = 0;
  let failed = 0;
  for (const event of events) {
    try {
      await publishEvent(event, env);
      published++;
    } catch {
      failed++;
    }
  }

  await deletePendingEvents(env.PREVIEW_CACHE!, kvKey);

  const parts = [
    `✅ Published ${published} event${published !== 1 ? 's' : ''}.`,
  ];
  if (failed > 0) parts.push(`❌ ${failed} failed.`);
  await tg.editMessage(chatId, messageId, parts.join(' '));
}

async function sendEventCard(
  chatId: number,
  events: PreparedEvent[],
  index: number,
  kvKey: string,
  tg: TelegramClient
): Promise<void> {
  const text = formatEventDetail(events[index], index, events.length);
  await tg.sendMessage(chatId, text, [
    [
      {
        text: '✅ Publish',
        callback_data: encodeCallback({
          type: 'event',
          kvKey,
          index,
          action: 'publish',
        }),
      },
      {
        text: '❌ Skip',
        callback_data: encodeCallback({
          type: 'event',
          kvKey,
          index,
          action: 'skip',
        }),
      },
    ],
  ]);
}

async function handleChooseByOne(
  chatId: number,
  kvKey: string,
  callbackId: string,
  env: Env,
  tg: TelegramClient
): Promise<void> {
  await tg.answerCallback(callbackId);

  const events = await loadPendingEvents(env.PREVIEW_CACHE!, kvKey);
  if (!events) {
    await tg.sendMessage(
      chatId,
      'Session expired. Send the URL or image again.'
    );
    return;
  }

  await sendEventCard(chatId, events, 0, kvKey, tg);
}

async function handleEventDecision(
  chatId: number,
  messageId: number,
  kvKey: string,
  index: number,
  action: 'publish' | 'skip',
  callbackId: string,
  env: Env,
  tg: TelegramClient
): Promise<void> {
  await tg.answerCallback(
    callbackId,
    action === 'publish' ? '✅ Publishing…' : '❌ Skipped'
  );

  const events = await loadPendingEvents(env.PREVIEW_CACHE!, kvKey);
  if (!events) {
    await tg.sendMessage(
      chatId,
      'Session expired. Send the URL or image again.'
    );
    return;
  }

  // Mark result on the card
  const resultText =
    action === 'publish'
      ? `${formatEventDetail(events[index], index, events.length)}\n\n<i>✅ Published</i>`
      : `${formatEventDetail(events[index], index, events.length)}\n\n<i>❌ Skipped</i>`;
  await tg.editMessage(chatId, messageId, resultText);

  if (action === 'publish') {
    try {
      await publishEvent(events[index], env);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await tg.sendMessage(chatId, `❌ Failed to publish: ${msg}`);
    }
  }

  const next = index + 1;
  if (next < events.length) {
    await sendEventCard(chatId, events, next, kvKey, tg);
  } else {
    await deletePendingEvents(env.PREVIEW_CACHE!, kvKey);
    await tg.sendMessage(chatId, 'Done! That was the last event.');
  }
}

async function handleCallbackQuery(
  query: TelegramCallbackQuery,
  env: Env,
  tg: TelegramClient
): Promise<void> {
  if (!query.data || !query.message) return;

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const parsed = parseCallback(query.data);

  if (!parsed) {
    await tg.answerCallback(query.id, 'Unknown action');
    return;
  }

  switch (parsed.type) {
    case 'pub_all':
      await handlePublishAll(
        chatId,
        messageId,
        parsed.kvKey,
        query.id,
        env,
        tg
      );
      break;
    case 'choose':
      await handleChooseByOne(chatId, parsed.kvKey, query.id, env, tg);
      break;
    case 'event':
      await handleEventDecision(
        chatId,
        messageId,
        parsed.kvKey,
        parsed.index,
        parsed.action,
        query.id,
        env,
        tg
      );
      break;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function handleTelegram(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return new Response('Telegram bot not configured', { status: 503 });
  }
  if (!env.PREVIEW_CACHE) {
    return new Response('PREVIEW_CACHE KV not bound', { status: 503 });
  }
  if (!env.BOT_PRIVKEY || !env.BOT_PUBKEY) {
    return new Response('Bot keypair not configured', { status: 503 });
  }
  if (!env.API_WORKER_URL) {
    return new Response('API_WORKER_URL not configured', { status: 503 });
  }

  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN);

  let update: TelegramUpdate;
  try {
    update = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  try {
    if (update.message) {
      await handleMessage(update.message, env, tg);
    } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env, tg);
    }
  } catch (err) {
    console.error('Telegram handler error:', err);
    // Swallow errors — Telegram retries on non-200, so always return 200
    // to avoid duplicate processing
  }

  return new Response('OK', { status: 200 });
}

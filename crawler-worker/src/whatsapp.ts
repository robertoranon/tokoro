/**
 * WhatsApp bot webhook handler.
 *
 * GET  /whatsapp — Meta webhook verification (echoes hub.challenge)
 * POST /whatsapp — receives WhatsApp Cloud API updates, crawls URLs/images
 *                  via WorkerCrawler, stores pending events in KV, and
 *                  publishes confirmed events using the bot's Ed25519 keypair.
 */

import { Env } from './types';
import { PreparedEvent } from './event-types';
import { WorkerCrawler } from './crawler-adapter';
import {
  publishEvent,
  storePendingEvents,
  loadPendingEvents,
  deletePendingEvents,
} from './bot-shared';

// ── WhatsApp Cloud API types (subset used by this bot) ────────────────────────

interface WhatsAppWebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: WhatsAppValue;
      field: string;
    }>;
  }>;
}

interface WhatsAppValue {
  messaging_product: string;
  metadata: { display_phone_number: string; phone_number_id: string };
  contacts?: Array<{ profile: { name: string }; wa_id: string }>;
  messages?: WhatsAppMessage[];
  statuses?: unknown[];
}

interface WhatsAppMessage {
  id: string; // wamid.XXX — incoming message ID
  from: string; // sender's phone number, e.g. "393471234567"
  timestamp: string;
  type: string; // "text" | "image" | "interactive" | ...
  text?: { body: string };
  image?: { id: string; mime_type?: string };
  interactive?: {
    type: string; // "button_reply"
    button_reply?: { id: string; title: string };
  };
  context?: { from: string; id: string };
}

// ── WhatsApp Cloud API client ─────────────────────────────────────────────────

class WhatsAppClient {
  private baseUrl = 'https://graph.facebook.com/v20.0';

  constructor(
    private token: string,
    private phoneNumberId: string
  ) {}

  private authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  async sendText(to: string, body: string): Promise<void> {
    await fetch(`${this.baseUrl}/${this.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeader() },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body },
      }),
    });
  }

  /**
   * Sends a message with up to 3 reply buttons.
   * Button titles are max 20 characters; body text is max 1024 characters.
   */
  async sendInteractive(
    to: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>
  ): Promise<void> {
    await fetch(`${this.baseUrl}/${this.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeader() },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText.slice(0, 1024) },
          action: {
            buttons: buttons.map(b => ({
              type: 'reply',
              reply: { id: b.id, title: b.title.slice(0, 20) },
            })),
          },
        },
      }),
    });
  }

  /**
   * Downloads a WhatsApp media object by its media ID.
   * Step 1: fetch media metadata to get the download URL.
   * Step 2: download raw bytes using auth header.
   * Returns base64-encoded image data and MIME type.
   */
  async downloadMedia(
    mediaId: string
  ): Promise<{ data: string; mimeType: string }> {
    const metaRes = await fetch(`${this.baseUrl}/${mediaId}`, {
      headers: this.authHeader(),
    });
    const meta = (await metaRes.json()) as { url: string; mime_type?: string };

    const fileRes = await fetch(meta.url, { headers: this.authHeader() });
    const buffer = await fileRes.arrayBuffer();

    const uint8 = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < uint8.length; i += chunkSize) {
      binary += String.fromCharCode(...uint8.subarray(i, i + chunkSize));
    }
    return {
      data: btoa(binary),
      mimeType: meta.mime_type ?? 'image/jpeg',
    };
  }
}

// ── Button ID encoding/parsing ────────────────────────────────────────────────
// Button IDs carry the KV key and action in a colon-delimited string.
// KV key format: wa:{senderPhone}:{uuid}  (no colons in UUID — safe to split by ':')
// Max button ID length: 256 chars. These are well under that limit.

type ButtonData =
  | { type: 'pub_all'; kvKey: string }
  | { type: 'choose'; kvKey: string }
  | { type: 'event'; kvKey: string; index: number; action: 'publish' | 'skip' };

function encodeButtonId(data: ButtonData): string {
  switch (data.type) {
    case 'pub_all':
      return `pub_all:${data.kvKey}`;
    case 'choose':
      return `choose:${data.kvKey}`;
    case 'event':
      return `event:${data.kvKey}:${data.index}:${data.action}`;
  }
}

function parseButtonId(raw: string): ButtonData | null {
  if (raw.startsWith('pub_all:'))
    return { type: 'pub_all', kvKey: raw.slice(8) };
  if (raw.startsWith('choose:')) return { type: 'choose', kvKey: raw.slice(7) };
  if (raw.startsWith('event:')) {
    // format: event:wa:{phone}:{uuid}:{index}:{action}
    // parts:  [0]   [1][2]    [3]    [4]     [5]
    const parts = raw.split(':');
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

// ── Formatters (plain text — WhatsApp does not render HTML) ───────────────────

function formatEventLine(event: PreparedEvent, index: number): string {
  const date = event.start_time.slice(0, 10);
  const time = event.start_time.slice(11, 16);
  const venue = event.venue_name || event.address || 'unknown venue';
  return `${index + 1}. ${event.title}\n   ${date} ${time} · ${venue}`;
}

function formatEventSummary(events: PreparedEvent[]): string {
  const lines = events.map((e, i) => formatEventLine(e, i));
  return `Found ${events.length} event${events.length !== 1 ? 's' : ''}:\n\n${lines.join('\n\n')}`;
}

function formatEventDetail(
  event: PreparedEvent,
  index: number,
  total: number
): string {
  const lines: string[] = [`Event ${index + 1} of ${total}`, event.title];
  if (event.description) lines.push(event.description.slice(0, 200));
  lines.push(`📅 ${event.start_time.replace('T', ' ').slice(0, 16)}`);
  if (event.venue_name) lines.push(`📍 ${event.venue_name}`);
  if (event.address) lines.push(`🗺 ${event.address}`);
  lines.push(`🏷 ${event.category}`);
  if (event.tags?.length) lines.push(`🔖 ${event.tags.join(', ')}`);
  return lines.join('\n');
}

// ── Shared: store pending events and send summary with buttons ─────────────────

async function sendEventSummary(
  to: string,
  events: PreparedEvent[],
  env: Env,
  wa: WhatsAppClient
): Promise<void> {
  // Generate the KV key before sending — avoids a send-then-edit dance.
  const kvKey = `wa:${to}:${crypto.randomUUID()}`;
  await storePendingEvents(env.PREVIEW_CACHE!, kvKey, events);

  const text = formatEventSummary(events);
  await wa.sendInteractive(to, text, [
    { id: encodeButtonId({ type: 'pub_all', kvKey }), title: 'Publish all' },
    {
      id: encodeButtonId({ type: 'choose', kvKey }),
      title: 'Choose one by one',
    },
  ]);
}

// ── Message handlers ──────────────────────────────────────────────────────────

async function handleUrl(
  from: string,
  url: string,
  env: Env,
  wa: WhatsAppClient
): Promise<void> {
  await wa.sendText(from, '🔍 Crawling…');
  try {
    const crawler = new WorkerCrawler({ env, mode: 'discover' });
    const result = await crawler.crawl(url);
    if (result.events.length === 0) {
      await wa.sendText(from, 'No events found.');
      return;
    }
    await sendEventSummary(from, result.events, env, wa);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await wa.sendText(from, `❌ ${msg}`);
  }
}

async function handleImage(
  from: string,
  mediaId: string,
  mimeType: string,
  env: Env,
  wa: WhatsAppClient
): Promise<void> {
  await wa.sendText(from, '🔍 Processing image…');
  try {
    const { data: imageData, mimeType: detectedMime } =
      await wa.downloadMedia(mediaId);
    const crawler = new WorkerCrawler({
      env,
      mode: 'image',
      imageData,
      imageMimeType: mimeType || detectedMime,
    });
    const result = await crawler.crawl(undefined);
    if (result.events.length === 0) {
      await wa.sendText(from, 'No events found in image.');
      return;
    }
    await sendEventSummary(from, result.events, env, wa);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await wa.sendText(from, `❌ ${msg}`);
  }
}

async function sendEventCard(
  to: string,
  events: PreparedEvent[],
  index: number,
  kvKey: string,
  wa: WhatsAppClient
): Promise<void> {
  const text = formatEventDetail(events[index], index, events.length);
  await wa.sendInteractive(to, text, [
    {
      id: encodeButtonId({ type: 'event', kvKey, index, action: 'publish' }),
      title: '✅ Publish',
    },
    {
      id: encodeButtonId({ type: 'event', kvKey, index, action: 'skip' }),
      title: '❌ Skip',
    },
  ]);
}

async function handlePublishAll(
  from: string,
  kvKey: string,
  env: Env,
  wa: WhatsAppClient
): Promise<void> {
  const events = await loadPendingEvents(env.PREVIEW_CACHE!, kvKey);
  if (!events) {
    await wa.sendText(from, 'Session expired. Send the URL or image again.');
    return;
  }

  let published = 0,
    failed = 0;
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
  await wa.sendText(from, parts.join(' '));
}

async function handleChooseByOne(
  from: string,
  kvKey: string,
  env: Env,
  wa: WhatsAppClient
): Promise<void> {
  const events = await loadPendingEvents(env.PREVIEW_CACHE!, kvKey);
  if (!events) {
    await wa.sendText(from, 'Session expired. Send the URL or image again.');
    return;
  }
  await sendEventCard(from, events, 0, kvKey, wa);
}

async function handleEventDecision(
  from: string,
  kvKey: string,
  index: number,
  action: 'publish' | 'skip',
  env: Env,
  wa: WhatsAppClient
): Promise<void> {
  const events = await loadPendingEvents(env.PREVIEW_CACHE!, kvKey);
  if (!events) {
    await wa.sendText(from, 'Session expired. Send the URL or image again.');
    return;
  }

  if (action === 'publish') {
    try {
      await publishEvent(events[index], env);
      await wa.sendText(from, `✅ Published: ${events[index].title}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await wa.sendText(from, `❌ Failed: ${msg}`);
    }
  } else {
    await wa.sendText(from, `❌ Skipped: ${events[index].title}`);
  }

  const next = index + 1;
  if (next < events.length) {
    await sendEventCard(from, events, next, kvKey, wa);
  } else {
    await deletePendingEvents(env.PREVIEW_CACHE!, kvKey);
    await wa.sendText(from, 'Done! That was the last event.');
  }
}

async function handleMessage(
  message: WhatsAppMessage,
  env: Env,
  wa: WhatsAppClient
): Promise<void> {
  const from = message.from;

  if (message.type === 'image' && message.image?.id) {
    await handleImage(
      from,
      message.image.id,
      message.image.mime_type ?? 'image/jpeg',
      env,
      wa
    );
    return;
  }

  if (message.type === 'text' && message.text?.body) {
    const urlMatch = message.text.body.match(/https?:\/\/\S+/);
    if (urlMatch) {
      await handleUrl(from, urlMatch[0], env, wa);
      return;
    }
    // No URL — silently ignore (works for both groups and DMs)
    return;
  }

  if (
    message.type === 'interactive' &&
    message.interactive?.type === 'button_reply' &&
    message.interactive.button_reply?.id
  ) {
    const parsed = parseButtonId(message.interactive.button_reply.id);
    if (!parsed) return;
    switch (parsed.type) {
      case 'pub_all':
        await handlePublishAll(from, parsed.kvKey, env, wa);
        break;
      case 'choose':
        await handleChooseByOne(from, parsed.kvKey, env, wa);
        break;
      case 'event':
        await handleEventDecision(
          from,
          parsed.kvKey,
          parsed.index,
          parsed.action,
          env,
          wa
        );
        break;
    }
    return;
  }

  // All other message types — silently ignore
}

// ── Entry points ──────────────────────────────────────────────────────────────

/**
 * Handles GET /whatsapp — Meta webhook verification challenge.
 * Meta sends this once when you register the webhook URL in the dashboard.
 */
export function handleWhatsAppVerification(
  request: Request,
  env: Env
): Response {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const challenge = url.searchParams.get('hub.challenge');
  const verifyToken = url.searchParams.get('hub.verify_token');

  if (mode === 'subscribe' && verifyToken === env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge ?? '', { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

/**
 * Handles POST /whatsapp — incoming WhatsApp Cloud API webhook updates.
 */
export async function handleWhatsApp(
  request: Request,
  env: Env
): Promise<Response> {
  if (
    !env.WHATSAPP_TOKEN ||
    !env.WHATSAPP_PHONE_ID ||
    !env.WHATSAPP_VERIFY_TOKEN ||
    !env.PREVIEW_CACHE ||
    !env.BOT_PRIVKEY ||
    !env.BOT_PUBKEY
  ) {
    console.error('WhatsApp bot: missing required configuration');
    return new Response('OK', { status: 200 });
  }

  let payload: WhatsAppWebhookPayload;
  try {
    payload = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  console.log(
    '[whatsapp] webhook received:',
    JSON.stringify(payload).slice(0, 200)
  );

  const wa = new WhatsAppClient(env.WHATSAPP_TOKEN, env.WHATSAPP_PHONE_ID);

  try {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;
        for (const message of change.value.messages ?? []) {
          await handleMessage(message, env, wa);
        }
      }
    }
  } catch (err) {
    console.error('WhatsApp handler error:', err);
    // Always return 200 to prevent Meta from retrying
  }

  return new Response('OK', { status: 200 });
}

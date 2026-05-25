// crawler-worker/src/bot-shared.ts
import * as ed25519 from '@noble/ed25519';
import { Env } from './types';
import { PreparedEvent } from './event-types';

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

export const KV_TTL_SECONDS = 1800; // 30 minutes

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Signs a PreparedEvent using the bot's Ed25519 private key.
 * Canonical object and hashing match what the API worker verifies in
 * worker/src/crypto.ts verifyEventSignature().
 */
export async function signEvent(
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

/**
 * Signs a PreparedEvent with the bot keypair and POSTs it to the API worker.
 * Returns the published event ID on success, throws on failure.
 */
export async function publishEvent(
  event: PreparedEvent,
  env: Env
): Promise<string> {
  console.log(
    `[publishEvent] signing "${event.title}" with pubkey ${env.BOT_PUBKEY?.slice(0, 8)}...`
  );
  const pubkey = env.BOT_PUBKEY!;

  let signature: string;
  try {
    signature = await signEvent(event, pubkey, env.BOT_PRIVKEY!);
    console.log(
      `[publishEvent] signed ok, posting to ${env.API_WORKER_URL}/events`
    );
  } catch (err) {
    console.error(`[publishEvent] signEvent failed:`, err);
    throw err;
  }

  const body = { ...event, pubkey, signature };

  let res: Response;
  try {
    if (env.API_WORKER) {
      res = await env.API_WORKER.fetch(
        new Request('https://worker/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      );
    } else {
      res = await fetch(`${env.API_WORKER_URL}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    console.log(`[publishEvent] API responded ${res.status}`);
  } catch (err) {
    console.error(`[publishEvent] fetch failed:`, err);
    throw err;
  }

  if (!res.ok) {
    const raw = await res.text();
    let msg: string;
    try {
      const err = JSON.parse(raw) as { error?: string; message?: string };
      msg = err.message || err.error || `HTTP ${res.status}`;
    } catch {
      msg = `HTTP ${res.status}: ${raw.slice(0, 200)}`;
    }
    console.error(`[publishEvent] API rejected "${event.title}": ${msg}`);
    throw new Error(msg);
  }

  const result = (await res.json()) as { id: string };
  console.log(`[publishEvent] published ok, id=${result.id}`);
  return result.id;
}

export async function storePendingEvents(
  kv: KVNamespace,
  kvKey: string,
  events: PreparedEvent[]
): Promise<void> {
  await kv.put(kvKey, JSON.stringify(events), {
    expirationTtl: KV_TTL_SECONDS,
  });
}

export async function loadPendingEvents(
  kv: KVNamespace,
  kvKey: string
): Promise<PreparedEvent[] | null> {
  const raw = await kv.get(kvKey);
  if (!raw) return null;
  return JSON.parse(raw) as PreparedEvent[];
}

export async function deletePendingEvents(
  kv: KVNamespace,
  kvKey: string
): Promise<void> {
  await kv.delete(kvKey);
}

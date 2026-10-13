import * as ed25519 from '@noble/ed25519';
import './crypto'; // side effect: configures ed25519.etc.sha512Async
import { jsonResponse } from './http';

export const MAX_SKEW_SECONDS = 300;

const HEX_64 = /^[0-9a-f]{64}$/i;
const HEX_128 = /^[0-9a-f]{128}$/i;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * The bytes signed by member and admin requests:
 * SHA-256("<domain>:<payload>:<timestamp>"). The domain separates operations
 * (a signature for one can never be replayed on another); the timestamp
 * limits replay to MAX_SKEW_SECONDS.
 */
export async function signedMessage(
  domain: string,
  payload: string,
  timestamp: string
): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(`${domain}:${payload}:${timestamp}`);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export type AuthResult =
  | { ok: true; pubkey: string }
  | { ok: false; status: number; error: string; serverTime?: number };

/** Verify X-Pubkey / X-Signature / X-Timestamp for (domain, payload). */
export async function verifySignedRequest(
  request: Request,
  domain: string,
  payload: string,
  nowMs: number = Date.now()
): Promise<AuthResult> {
  const pubkey = (request.headers.get('X-Pubkey') || '').toLowerCase();
  const signature = request.headers.get('X-Signature') || '';
  const ts = request.headers.get('X-Timestamp') || '';
  if (
    !HEX_64.test(pubkey) ||
    !HEX_128.test(signature) ||
    !/^\d{1,12}$/.test(ts)
  ) {
    return {
      ok: false,
      status: 401,
      error: 'Missing or malformed authentication headers',
    };
  }
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - Number(ts)) > MAX_SKEW_SECONDS) {
    return {
      ok: false,
      status: 401,
      error: 'Timestamp out of range',
      serverTime: nowSec,
    };
  }
  try {
    const valid = await ed25519.verifyAsync(
      hexToBytes(signature),
      await signedMessage(domain, payload, ts),
      hexToBytes(pubkey)
    );
    if (!valid) return { ok: false, status: 401, error: 'Invalid signature' };
  } catch {
    return { ok: false, status: 401, error: 'Invalid signature' };
  }
  return { ok: true, pubkey };
}

/** The JSON error response for a failed AuthResult (includes server_time on clock skew). */
export function authErrorResponse(
  r: Extract<AuthResult, { ok: false }>
): Response {
  return jsonResponse(
    r.serverTime !== undefined
      ? { error: r.error, server_time: r.serverTime }
      : { error: r.error },
    r.status
  );
}

import * as ed from '@noble/ed25519';

// Configure SHA-512 for Node.js (required by @noble/ed25519), as normalizer.ts
// does. noble passes several arrays: hash them all, or signatures differ from
// the worker's test vector (and the nonce stops depending on the message).
if (typeof crypto !== 'undefined' && crypto.subtle) {
  ed.etc.sha512Async = async (...m) => {
    const data = ed.etc.concatBytes(...m);
    const buffer = await crypto.subtle.digest('SHA-512', data as BufferSource);
    return new Uint8Array(buffer);
  };
}

/**
 * The bytes signed to attach an act to an existing event: SHA-256 of
 * "act:" + event id + "\n" + act name + "\n" + act url. Must stay identical to
 * `actMessage` in worker/src/crypto.ts (the worker's test vector pins both).
 */
export async function adoptMessage(
  eventId: string,
  actName: string,
  actUrl: string
): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(
    `act:${eventId}\n${actName}\n${actUrl}`
  );
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

const hexToBytes = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/g)!.map(h => parseInt(h, 16)));
const bytesToHex = (b: Uint8Array) =>
  Array.from(b)
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');

/** Hex Ed25519 signature for `POST /events/:id/act`. */
export async function signAdoption(
  privkeyHex: string,
  eventId: string,
  actName: string,
  actUrl: string
): Promise<string> {
  const message = await adoptMessage(eventId, actName, actUrl);
  return bytesToHex(await ed.signAsync(message, hexToBytes(privkeyHex)));
}

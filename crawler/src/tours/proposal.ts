import * as ed from '@noble/ed25519';
// adopt.ts configures noble's SHA-512 for Node.js; importing it applies that.
import './adopt.js';

/**
 * The bytes signed to propose deleting a held event: SHA-256 of
 * "proposal:" + event id + "\n" + reason. Must stay identical to
 * `proposalMessage` in worker/src/crypto.ts (a crawler test pins the vector).
 */
export async function proposalMessage(
  eventId: string,
  reason: string
): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(`proposal:${eventId}\n${reason}`);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

const hexToBytes = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/g)!.map(h => parseInt(h, 16)));
const bytesToHex = (b: Uint8Array) =>
  Array.from(b)
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');

/** Hex Ed25519 signature for `POST /conflicts/proposals`. */
export async function signProposal(
  privkeyHex: string,
  eventId: string,
  reason: string
): Promise<string> {
  const message = await proposalMessage(eventId, reason);
  return bytesToHex(await ed.signAsync(message, hexToBytes(privkeyHex)));
}

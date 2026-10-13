import * as ed from '@noble/ed25519';
import '../src/crypto'; // configures ed.etc.sha512Async
import { signedMessage } from '../src/member-auth';

export interface TestKey {
  priv: Uint8Array;
  pubkey: string;
}

export const toHex = (b: Uint8Array) =>
  Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

export async function makeKey(): Promise<TestKey> {
  const priv = ed.utils.randomPrivateKey();
  return { priv, pubkey: toHex(await ed.getPublicKeyAsync(priv)) };
}

/** Headers for a signed member/admin request, exactly as the clients build them. */
export async function authHeaders(
  key: TestKey,
  domain: string,
  payload: string,
  ts: number = Math.floor(Date.now() / 1000)
): Promise<Record<string, string>> {
  const msg = await signedMessage(domain, payload, String(ts));
  const sig = await ed.signAsync(msg, key.priv);
  return {
    'X-Pubkey': key.pubkey,
    'X-Signature': toHex(sig),
    'X-Timestamp': String(ts),
  };
}

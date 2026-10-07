// Block (or unblock) a public key on the API worker, signed with the admin key.
//
// A blocked key is refused for every write: publishing, editing, deleting
// events and adopting events into a band. Use it after rotating a key that
// may have been exposed: removing a key from ALLOWED_PUBKEYS stops it
// publishing and editing, but the worker still lets a key delete the events it
// owns, and only the blocklist stops that.
//
// Usage (from worker/):
//   read -s ADMIN_PRIVKEY; export ADMIN_PRIVKEY      # paste the admin private key (64 hex), Enter
//   export WORKER_URL=https://your-worker.workers.dev
//   npx tsx scripts/block-key.ts <target_pubkey_64_hex>             # block
//   npx tsx scripts/block-key.ts <target_pubkey_64_hex> --unblock   # undo
//
// The admin private key is read from the environment only (never from an
// argument, so it does not end up in your shell history) and is never sent:
// only the signature is.
import * as ed from '@noble/ed25519';
import '../src/crypto'; // configures ed.etc.sha512Async correctly (all arguments hashed)

const HEX64 = /^[0-9a-f]{64}$/i;

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const hexToBytes = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/g)!.map(h => parseInt(h, 16)));
const bytesToHex = (b: Uint8Array) =>
  Array.from(b)
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');

/** The signature the worker checks: SHA-256("blocklist:" + target) signed by the admin key. */
export async function signBlocklist(
  adminPrivkeyHex: string,
  targetPubkeyHex: string
): Promise<string> {
  const message = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('blocklist:' + targetPubkeyHex)
    )
  );
  return bytesToHex(await ed.signAsync(message, hexToBytes(adminPrivkeyHex)));
}

async function main() {
  const args = process.argv.slice(2);
  const unblock = args.includes('--unblock');
  const target = args.find(a => !a.startsWith('--')) ?? '';
  const privkey = (process.env.ADMIN_PRIVKEY ?? '').trim();
  const workerUrl = (process.env.WORKER_URL ?? '').trim().replace(/\/$/, '');

  if (!HEX64.test(target)) {
    fail(
      'give the public key to block as 64 hex characters, e.g. npx tsx scripts/block-key.ts <pubkey>'
    );
  }
  if (!HEX64.test(privkey)) {
    fail(
      'ADMIN_PRIVKEY must be set (64 hex characters): read -s ADMIN_PRIVKEY; export ADMIN_PRIVKEY'
    );
  }
  if (!/^https?:\/\//.test(workerUrl))
    fail('WORKER_URL must be set, e.g. https://your-worker.workers.dev');

  const adminPubkey = bytesToHex(
    await ed.getPublicKeyAsync(hexToBytes(privkey))
  );
  const signature = await signBlocklist(privkey, target);
  console.log(
    `${unblock ? 'Unblocking' : 'Blocking'} ${target.slice(0, 10)}… as admin ${adminPubkey.slice(0, 10)}… on ${workerUrl}`
  );

  const res = await fetch(
    unblock
      ? `${workerUrl}/admin/blocklist/${target}`
      : `${workerUrl}/admin/blocklist`,
    {
      method: unblock ? 'DELETE' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'tokoro-block-key-script',
      },
      body: JSON.stringify(
        unblock
          ? { pubkey: adminPubkey, signature }
          : { pubkey: adminPubkey, signature, target_pubkey: target }
      ),
    }
  );
  const body = await res.text();
  console.log(`HTTP ${res.status} ${body}`);
  if (!res.ok) {
    if (res.status === 403) {
      console.error(
        'The worker does not recognise this admin key: its public key must equal the ADMIN_PUBKEY secret.'
      );
    }
    process.exit(1);
  }
}

// Only run when executed directly, not when imported (the signature helper is testable).
if (process.argv[1]?.endsWith('block-key.ts')) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

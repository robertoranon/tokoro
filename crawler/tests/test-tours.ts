import * as ed from '@noble/ed25519';
import { EventNormalizer } from '../src/utils/normalizer.js';
import { ExtractedEventSchema } from '../src/types/event.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const bytesToHex = (b: Uint8Array) =>
  Array.from(b)
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');
const hexToBytes = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/g)!.map(h => parseInt(h, 16)));

async function main() {
  console.log('\n=== act fields through the normalizer ===\n');
  {
    const privkey = bytesToHex(ed.utils.randomPrivateKey());
    const pubkey = bytesToHex(await ed.getPublicKeyAsync(hexToBytes(privkey)));
    const normalizer = new EventNormalizer({ keypair: { privkey, pubkey } });
    const base = {
      title: 'Test Band live',
      lat: 46.06,
      lng: 13.23,
      start_time: '2030-11-12T21:00:00',
      category: 'music' as const,
    };
    const withAct = (await normalizer.normalize({
      ...base,
      act_name: 'Test Band',
      act_url: 'https://band.example',
    }))!;
    assert(withAct.act_name === 'Test Band', 'act_name copied');
    assert(withAct.act_url === 'https://band.example', 'act_url copied');

    const without = (await normalizer.normalize(base))!;
    assert(!('act_name' in without), 'no act_name key when absent');
    assert(!('act_url' in without), 'no act_url key when absent');

    const parsed = ExtractedEventSchema.safeParse({
      ...base,
      act_name: 'Test Band',
      act_url: 'https://band.example',
    });
    assert(parsed.success, 'schema accepts act fields');
  }

  // (later tasks append their sections above this line)

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

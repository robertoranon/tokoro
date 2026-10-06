import * as ed from '@noble/ed25519';
import { EventNormalizer } from '../src/utils/normalizer.js';
import { ExtractedEventSchema } from '../src/types/event.js';
import {
  parseBandsConfig,
  normalizeActUrl,
  activeBands,
  activeSources,
  effectiveRegion,
} from '../src/tours/bands-config.js';

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

  console.log('\n=== normalizeActUrl ===\n');
  {
    assert(
      normalizeActUrl('https://Band.example/') === 'https://band.example',
      'host lowercased, trailing slash stripped'
    );
    assert(
      normalizeActUrl('https://band.example/live/?utm=1#x') ===
        'https://band.example/live',
      'query and hash dropped'
    );
    assert(
      throws(() => normalizeActUrl('ftp://band.example')),
      'non-http rejected'
    );
    assert(
      throws(() => normalizeActUrl('nonsense')),
      'garbage rejected'
    );
  }

  console.log('\n=== parseBandsConfig ===\n');
  {
    const ok = parseBandsConfig(`
defaults:
  fetcher: jina
  region: { south: 34, west: -11, north: 72, east: 45 }
bands:
  - name: Test Band
    url: https://testband.example/
    aliases: ["The Test Band"]
    added: 2026-10-06
  - name: Far Band
    url: https://farband.example
    region: none
  - name: Paused Band
    url: https://paused.example
    status: paused
sources:
  - url: https://testband.example/live
    mode: band
    band: Test Band
  - url: https://venue.example/programme
    mode: listing
    only: [Test Band]
  - url: https://agg.example/gigs
    mode: listing
    fetcher: playwright
`);
    assert(ok.bands.length === 3, 'three bands parsed');
    assert(
      ok.bands[0].url === 'https://testband.example',
      'band url normalised'
    );
    assert(ok.bands[0].aliases?.[0] === 'The Test Band', 'aliases kept');
    assert(ok.bands[0].added === '2026-10-06', 'yaml date → string');
    assert(ok.bands[2].status === 'paused', 'status parsed');
    assert(ok.sources.length === 3, 'three sources parsed');
    assert(ok.sources[0].fetcher === 'jina', 'default fetcher applied');
    assert(
      ok.sources[2].fetcher === 'playwright',
      'per-source fetcher override'
    );
    assert(
      ok.sources[0].mode === 'band' && ok.sources[0].band === 'Test Band',
      'band source'
    );
    assert(
      ok.sources[1].mode === 'listing' &&
        ok.sources[1].only?.[0] === 'Test Band',
      'listing source with only'
    );
    assert(
      activeBands(ok).length === 2,
      'paused band excluded from activeBands'
    );
    assert(activeSources(ok).length === 3, 'all sources active');
    assert(
      effectiveRegion(ok, ok.bands[0])?.north === 72,
      'default region applies to a band without its own'
    );
    assert(
      effectiveRegion(ok, ok.bands[1]) === undefined,
      'region: none → worldwide'
    );

    assert(
      parseBandsConfig('bands:\nsources:\n').bands.length === 0,
      'null sections → empty'
    );

    const bad = (yaml: string) => throws(() => parseBandsConfig(yaml));
    assert(bad('foo: 1'), 'missing bands/sources rejected');
    assert(bad('bands: [{name: A}]\nsources: []'), 'band without url rejected');
    assert(
      bad('bands: [{url: "https://a.example"}]\nsources: []'),
      'band without name rejected'
    );
    assert(
      bad(
        'bands: [{name: A, url: "https://a.example"}, {name: a, url: "https://b.example"}]\nsources: []'
      ),
      'duplicate band name (case-insensitive) rejected'
    );
    assert(
      bad(
        'bands: [{name: A, url: "https://a.example"}, {name: B, url: "https://a.example/"}]\nsources: []'
      ),
      'duplicate band url rejected'
    );
    assert(
      bad(
        'bands: [{name: A, url: "https://a.example"}]\nsources: [{url: "https://s.example", mode: band}]'
      ),
      'band-mode source without band rejected'
    );
    assert(
      bad(
        'bands: [{name: A, url: "https://a.example"}]\nsources: [{url: "https://s.example", mode: band, band: Nope}]'
      ),
      'band-mode source referencing an unknown band rejected'
    );
    assert(
      bad(
        'bands: [{name: A, url: "https://a.example"}]\nsources: [{url: "https://s.example", mode: listing, only: [Nope]}]'
      ),
      'listing "only" naming an unknown band rejected'
    );
    assert(
      bad('bands: []\nsources: [{url: "https://s.example", mode: weird}]'),
      'invalid mode rejected'
    );
    assert(
      bad(
        'bands: []\nsources: [{url: "https://s.example", mode: listing}, {url: "https://s.example/", mode: listing}]'
      ),
      'duplicate source url rejected'
    );
    assert(
      bad(
        'bands: [{name: A, url: "https://a.example", region: {south: 10, west: 0, north: 5, east: 9}}]\nsources: []'
      ),
      'region with south >= north rejected'
    );
    assert(
      bad(
        'bands: [{name: A, url: "https://a.example", status: sleepy}]\nsources: []'
      ),
      'invalid status rejected'
    );
  }

  // (later tasks append their sections above this line)

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

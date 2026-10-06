// Smoke test: TourPublisher + EventNormalizer + processTourSourcePage against
// a real worker. Precondition: `npm run dev` running in worker/ (local D1
// migrated through 0006, no ALLOWED_PUBKEYS configured locally).
// Run from crawler/: npm run smoke:tours [http://localhost:8787]
import * as ed from '@noble/ed25519';
import { EventNormalizer } from '../src/utils/normalizer.js';
import { TourPublisher } from '../src/tours/tour-publisher.js';
import { parseBandsConfig } from '../src/tours/bands-config.js';
import {
  processTourSourcePage,
  type TourSourceDeps,
} from '../src/tours/tour-source.js';
import type { TourShowDraft } from '../src/tours/tour-shows.js';

const API = process.argv[2] || 'http://localhost:8787';

const bytesToHex = (b: Uint8Array) =>
  Array.from(b)
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');
const hexToBytes = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/g)!.map(h => parseInt(h, 16)));

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    if (detail !== undefined) console.log('      ', detail);
    failures++;
  }
}

async function main() {
  const privkey = bytesToHex(ed.utils.randomPrivateKey());
  const pubkey = bytesToHex(await ed.getPublicKeyAsync(hexToBytes(privkey)));
  const normalizer = new EventNormalizer({ keypair: { privkey, pubkey } });
  const tours = new TourPublisher(API, pubkey);

  const nonce = Date.now().toString(36);
  const year = new Date().getFullYear() + 1;
  const bandUrl = `https://smoke-band-${nonce}.example`;
  const config = parseBandsConfig(`
bands:
  - name: Smoke Band ${nonce}
    url: ${bandUrl}
sources:
  - { url: "${bandUrl}/live", mode: band, band: "Smoke Band ${nonce}" }
`);
  const page = { url: `${bandUrl}/live`, title: 'Live', html: '', text: 'x' };

  const drafts = (endHour: string): TourShowDraft[] => [
    {
      title: `Smoke show udine ${nonce}`,
      performers: [`Smoke Band ${nonce}`],
      start_time: `${year}-09-04T21:00:00`,
      end_time: endHour ? `${year}-09-04T${endHour}` : undefined,
      venue_name: 'Smoke Club',
      city: 'Udine',
      lat: 46.0637,
      lng: 13.2353,
    },
    {
      title: `Smoke show ljubljana ${nonce}`,
      performers: [`Smoke Band ${nonce}`],
      start_time: `${year}-09-06`,
      venue_name: 'Smoke Hall',
      city: 'Ljubljana',
      lat: 46.0569,
      lng: 14.5058,
    },
  ];
  const deps = (list: TourShowDraft[]): TourSourceDeps => ({
    extract: async () => list,
    lookup: u => tours.lookup(u),
    normalize: (e, o) => normalizer.normalize(e, o),
    apply: (ev, m) => tours.apply(ev, m),
    today: `${year - 1}-12-31`,
  });

  // Run 1: nothing there yet → two published.
  let res = await processTourSourcePage(
    page,
    config.sources[0],
    config,
    deps(drafts(''))
  );
  check(
    'run 1: both shows published',
    res.length === 2 && res.every(r => r.outcome === 'published'),
    res
  );

  // Run 2: identical → all unchanged, nothing duplicated.
  res = await processTourSourcePage(
    page,
    config.sources[0],
    config,
    deps(drafts(''))
  );
  check(
    'run 2: unchanged (created_at preserved, no duplicates)',
    res.length === 2 && res.every(r => r.outcome === 'unchanged'),
    res
  );
  let existing = await tours.lookup(bandUrl);
  check(
    'run 2: exactly two shows stored',
    existing.length === 2,
    existing.length
  );
  check(
    'stored shows carry act_name and act_url',
    existing.every(e => e.act_url === bandUrl && !!e.act_name),
    existing[0]
  );

  // Run 3: the Udine show gains an end time → one update.
  res = await processTourSourcePage(
    page,
    config.sources[0],
    config,
    deps(drafts('23:30:00'))
  );
  check(
    'run 3: changed end time → updated, other unchanged',
    res.filter(r => r.outcome === 'updated').length === 1 &&
      res.filter(r => r.outcome === 'unchanged').length === 1,
    res
  );

  // Run 4: a show vanishing from the page is NOT deleted.
  res = await processTourSourcePage(
    page,
    config.sources[0],
    config,
    deps(drafts('23:30:00').slice(0, 1))
  );
  existing = await tours.lookup(bandUrl);
  check(
    'run 4: vanished show is left alone (never deleted)',
    existing.length === 2,
    existing.length
  );

  // The act_url / has_act filters on the API.
  const q = async (qs: string) => {
    const r = await fetch(
      `${API}/events?${qs}&from=2000-01-01T00:00:00&to=2999-12-31T23:59:59`
    );
    const j: any = await r.json();
    return Array.isArray(j) ? j : j.events;
  };
  check(
    'API: act_url filter finds the shows',
    (await q(`act_url=${encodeURIComponent(bandUrl + '/')}`)).length === 2
  );
  check(
    'API: has_act=1 includes them',
    (await q('has_act=1')).some((e: any) => e.act_url === bandUrl)
  );
  check(
    'API: has_act=0 excludes them',
    !(await q('has_act=0')).some((e: any) => e.act_url === bandUrl)
  );

  console.log(
    failures === 0
      ? '\nAll smoke checks passed.'
      : `\n${failures} smoke check(s) FAILED.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

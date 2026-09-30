// Smoke test: RadarPublisher + EventNormalizer against a real worker.
// Precondition: `npm run dev` running in worker/ (local D1 migrated, no
// ALLOWED_PUBKEYS configured locally).
// Run from crawler/: npm run smoke:radar [http://localhost:8787]
import * as ed from '@noble/ed25519';
import { EventNormalizer } from '../src/utils/normalizer.js';
import { RadarPublisher, matchEdition } from '../src/radar/radar-publisher.js';
import { finalizeRadarEntry } from '../src/radar/festival-entry.js';

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
  const radar = new RadarPublisher(API, pubkey);

  const nonce = Date.now().toString(36);
  const year = new Date().getFullYear() + 1;
  const festivalUrl = `https://smoke-${nonce}.example`;

  const draft = {
    title: `Smoke Radar ${nonce} ${year}`,
    festival_name: `Smoke Radar ${nonce} ${year}`,
    description: 'Smoke-test radar entry',
    address: 'Udine',
    lat: 46.0637,
    lng: 13.2353,
    start_time: `${year}-09-04T00:00:00`,
    end_time: `${year}-09-06T23:59:59`,
    category: 'music' as const,
    tags: ['Smoke'],
  };
  const entry = finalizeRadarEntry(draft, festivalUrl);

  // Run 1: nothing there yet → publish.
  let existing = await radar.lookup(festivalUrl);
  let match = matchEdition(existing, String(entry.start_time));
  check('run 1: lookup finds nothing', existing.length === 0 && !match);
  const first = (await normalizer.normalize(entry, {
    createdAt: match?.created_at,
  }))!;
  check('run 1: publishes', (await radar.apply(first, match)) === 'published');

  // Run 2: identical entry, freshly normalized (new created_at!) → must be unchanged.
  existing = await radar.lookup(festivalUrl);
  match = matchEdition(existing, String(entry.start_time));
  check('run 2: lookup finds the entry (wide window)', !!match, existing);
  const second = (await normalizer.normalize(entry, {
    createdAt: match?.created_at,
  }))!;
  check(
    'run 2: unchanged (null vs empty string, tags order, created_at preserved)',
    (await radar.apply(second, match)) === 'unchanged'
  );

  // Run 3: the festival extended a day → PUT, re-signed with the stored created_at.
  const extended = { ...entry, end_time: `${year}-09-07T23:59:59` };
  const third = (await normalizer.normalize(extended, {
    createdAt: match?.created_at,
  }))!;
  check(
    'run 3: changed dates → updated',
    (await radar.apply(third, match)) === 'updated'
  );

  // Run 4: the update is visible, created_at is intact, updated_at is set.
  existing = await radar.lookup(festivalUrl);
  match = matchEdition(existing, String(entry.start_time));
  check(
    'run 4: one entry, new end_time, created_at unchanged',
    existing.length === 1 &&
      match?.end_time === `${year}-09-07T23:59:59` &&
      match?.created_at === first.created_at,
    match
  );

  // Run 5: a program event under the same festival_url must never be matched.
  const concert = (await normalizer.normalize({
    title: `Smoke Concert ${nonce}`,
    description: 'Not a radar entry',
    address: 'Udine',
    lat: 46.0637,
    lng: 13.2353,
    start_time: `${year}-09-05T21:00:00`,
    end_time: `${year}-09-05T23:00:00`,
    tags: ['festival'],
    category: 'music',
    festival_name: 'Smoke Radar',
    festival_url: festivalUrl,
  }))!;
  const postConcert = await fetch(`${API}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(concert),
  });
  existing = await radar.lookup(festivalUrl);
  match = matchEdition(existing, String(entry.start_time));
  check(
    'run 5: program event exists but the radar entry is still the match',
    postConcert.status === 201 &&
      existing.length === 2 &&
      match?.title === entry.title,
    { status: postConcert.status, count: existing.length }
  );

  // Cleanup: DELETE signs the event id.
  for (const e of existing) {
    const signature = bytesToHex(
      await ed.signAsync(hexToBytes(e.id), hexToBytes(privkey))
    );
    await fetch(`${API}/events/${e.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pubkey, signature }),
    });
  }

  console.log(
    failures === 0 ? '\nAll smoke checks passed' : `\n${failures} FAILURES`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

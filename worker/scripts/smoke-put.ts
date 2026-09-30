// Smoke test for PUT /events/:id and festival filters.
// Precondition: `npm run dev` running in another terminal, local DB migrated,
// no ALLOWED_PUBKEYS configured locally.
// Run from worker/: npx tsx scripts/smoke-put.ts [http://localhost:8787]
import * as ed from '@noble/ed25519';

ed.etc.sha512Async = async (...messages: Uint8Array[]) => {
  const combined = new Uint8Array(
    messages.reduce((acc, m) => acc + m.length, 0)
  );
  let offset = 0;
  for (const m of messages) {
    combined.set(m, offset);
    offset += m.length;
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-512', combined));
};

const API = process.argv[2] || 'http://localhost:8787';

const bytesToHex = (b: Uint8Array) =>
  Array.from(b)
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');
const hexToBytes = (hex: string) => {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    b[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return b;
};

// Must mirror worker/src/crypto.ts verifyEventSignature canonical order.
async function signEvent(event: any, privkey: string): Promise<string> {
  const canonical = JSON.stringify({
    pubkey: event.pubkey,
    title: event.title,
    description: event.description || '',
    url: event.url || '',
    venue_name: event.venue_name || '',
    address: event.address || '',
    lat: event.lat,
    lng: event.lng,
    start_time: event.start_time,
    end_time: event.end_time ?? null,
    category: event.category,
    tags: event.tags || [],
    created_at: event.created_at,
  });
  const hash = bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
    )
  );
  return bytesToHex(await ed.signAsync(hexToBytes(hash), hexToBytes(privkey)));
}

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

  // Unique title so duplicate detection can never trip across reruns
  const nonce = Date.now().toString(36);
  const nextYear = new Date().getFullYear() + 1;
  const event: any = {
    pubkey,
    title: `Smoke Fest ${nonce}`,
    description: 'Smoke-test radar entry',
    url: 'https://smokefest.example',
    venue_name: 'Test Meadow',
    address: 'Udine',
    lat: 46.0637,
    lng: 13.2353,
    start_time: `${nextYear}-09-04T00:00:00`,
    end_time: `${nextYear}-09-06T23:59:59`,
    category: 'music',
    tags: ['festival', 'smoke'],
    festival_name: `Smoke Fest ${nonce}`,
    festival_url: 'https://smokefest.example',
    created_at: new Date().toISOString().slice(0, 19),
  };
  event.signature = await signEvent(event, privkey);

  // 1. POST → 201
  const postRes = await fetch(`${API}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  const posted = (await postRes.json()) as any;
  check('POST /events → 201', postRes.status === 201, posted);
  const id = posted.id;

  // 2. PUT with changed title + end_time → 200
  const updated = {
    ...event,
    title: `Smoke Fest ${nonce} (updated)`,
    end_time: `${nextYear}-09-07T23:59:59`,
  };
  updated.signature = await signEvent(updated, privkey);
  const putRes = await fetch(`${API}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updated),
  });
  check('PUT own event → 200', putRes.status === 200, await putRes.json());

  // 3. GET ?has_festival=1 (no-geo browse) shows the updated title
  const from = `${nextYear}-09-01T00:00:00`;
  const to = `${nextYear}-09-30T00:00:00`;
  const listRes = await fetch(
    `${API}/events?has_festival=1&from=${from}&to=${to}`
  );
  const list = (await listRes.json()) as any;
  const found = (list.events || []).find((e: any) => e.id === id);
  check(
    'GET ?has_festival=1 returns updated entry',
    found?.title === `Smoke Fest ${nonce} (updated)` && !!found?.updated_at,
    found
  );

  // 4. GET ?pubkey=&festival_url= (radar update-lookup combination)
  const lookupRes = await fetch(
    `${API}/events?pubkey=${pubkey}&festival_url=${encodeURIComponent(
      'https://smokefest.example/'
    )}&from=${from}&to=${to}`
  );
  const lookup = (await lookupRes.json()) as any[];
  check(
    'GET ?pubkey&festival_url (trailing slash) finds entry',
    Array.isArray(lookup) && lookup.some((e: any) => e.id === id),
    lookup
  );

  // 5. PUT signed by a different key → 403
  const stranger = bytesToHex(ed.utils.randomPrivateKey());
  const strangerPub = bytesToHex(
    await ed.getPublicKeyAsync(hexToBytes(stranger))
  );
  const foreign = { ...updated, pubkey: strangerPub };
  foreign.signature = await signEvent(foreign, stranger);
  const foreignRes = await fetch(`${API}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(foreign),
  });
  check("PUT other's event → 403", foreignRes.status === 403);

  // 6. PUT with altered created_at → 400
  const redated = { ...updated, created_at: '2020-01-01T00:00:00' };
  redated.signature = await signEvent(redated, privkey);
  const redatedRes = await fetch(`${API}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(redated),
  });
  check('PUT with changed created_at → 400', redatedRes.status === 400);

  // 7. PUT unknown id → 404
  const ghostRes = await fetch(`${API}/events/${'f'.repeat(64)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updated),
  });
  check('PUT unknown id → 404', ghostRes.status === 404);

  // Cleanup: delete the smoke event (sign the event id)
  const delSig = bytesToHex(
    await ed.signAsync(hexToBytes(id), hexToBytes(privkey))
  );
  await fetch(`${API}/events/${id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey, signature: delSig }),
  });

  console.log(
    failures === 0 ? '\nAll smoke checks passed' : `\n${failures} FAILURES`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

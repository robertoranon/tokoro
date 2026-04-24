// public-web/tests/signing.test.mjs
import { createRequire } from 'module';
const { bytesToHex, signEvent } = createRequire(import.meta.url)('../signing.js');
import assert from 'node:assert/strict';

// ── bytesToHex ────────────────────────────────────────────────────────────────
{ const bytes = new Uint8Array([0, 1, 15, 16, 255]);
  assert.equal(bytesToHex(bytes), '00010f10ff');
  console.log('✅ bytesToHex: converts bytes to lowercase hex'); }

{ assert.equal(bytesToHex(new Uint8Array([])), '');
  console.log('✅ bytesToHex: empty array → empty string'); }

// ── signEvent ─────────────────────────────────────────────────────────────────
// Node 18+ has Web Crypto natively via globalThis.crypto
{ const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const kp = {
    pubkey: bytesToHex(pubBytes),
    privkeyB64: btoa(String.fromCharCode(...privBytes)),
  };

  const event = {
    title: 'Test Concert',
    description: 'A test',
    url: 'https://example.com',
    venue_name: 'Test Venue',
    address: '1 Test St',
    lat: 48.8566,
    lng: 2.3522,
    start_time: '2026-06-01T20:00:00',
    end_time: '2026-06-01T23:00:00',
    category: 'music',
    tags: ['jazz'],
    created_at: '2026-04-24T00:00:00',
  };

  const signed = await signEvent(event, kp);

  assert.equal(signed.pubkey, kp.pubkey);
  assert.equal(signed.title, 'Test Concert');
  assert.equal(signed.description, 'A test');
  assert.equal(signed.tags[0], 'jazz');
  assert.equal(typeof signed.signature, 'string');
  assert.equal(signed.signature.length, 128);
  assert.match(signed.signature, /^[0-9a-f]+$/);

  // Signature is verifiable
  const sigBytes = Uint8Array.from(
    signed.signature.match(/../g).map(h => parseInt(h, 16))
  );
  const canonical = JSON.stringify({
    pubkey: signed.pubkey, title: signed.title, description: signed.description,
    url: signed.url, venue_name: signed.venue_name, address: signed.address,
    lat: signed.lat, lng: signed.lng, start_time: signed.start_time,
    end_time: signed.end_time, category: signed.category, tags: signed.tags,
    created_at: signed.created_at,
  });
  const msgBytes = new TextEncoder().encode(canonical);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBytes);
  const ok = await crypto.subtle.verify('Ed25519', pair.publicKey, sigBytes, new Uint8Array(hashBuffer));
  assert.equal(ok, true);
  console.log('✅ signEvent: produces verifiable Ed25519 signature'); }

{ // Missing optional fields default to empty string / empty array
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const kp = {
    pubkey: bytesToHex(pubBytes),
    privkeyB64: btoa(String.fromCharCode(...privBytes)),
  };
  const minimal = {
    title: 'Minimal', lat: 0, lng: 0,
    start_time: '2026-06-01T20:00:00', category: 'other', created_at: '2026-04-24T00:00:00',
  };
  const signed = await signEvent(minimal, kp);
  assert.equal(signed.description, '');
  assert.equal(signed.url, '');
  assert.deepEqual(signed.tags, []);
  console.log('✅ signEvent: missing optional fields default to empty string / []'); }

console.log('\n✅ All signing.js tests passed');

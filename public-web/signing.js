'use strict';

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function loadOrCreateKeypair() {
  const stored = localStorage.getItem('tokoro_keypair');
  if (stored) {
    try {
      const kp = JSON.parse(stored);
      if (kp.pubkey && kp.privkeyB64) return { ...kp, isNew: false };
    } catch (_) {}
  }
  const pair = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ]);
  const pubBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', pair.publicKey)
  );
  const privBytes = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', pair.privateKey)
  );
  const kp = {
    pubkey: bytesToHex(pubBytes),
    privkeyB64: btoa(
      Array.from(privBytes, b => String.fromCharCode(b)).join('')
    ),
  };
  localStorage.setItem('tokoro_keypair', JSON.stringify(kp));
  return { ...kp, isNew: true };
}

async function signEvent(preparedEvent, kp) {
  const eventData = {
    pubkey: kp.pubkey,
    title: preparedEvent.title,
    description: preparedEvent.description || '',
    url: preparedEvent.url || '',
    venue_name: preparedEvent.venue_name || '',
    address: preparedEvent.address || '',
    lat: preparedEvent.lat,
    lng: preparedEvent.lng,
    start_time: preparedEvent.start_time,
    end_time: preparedEvent.end_time,
    category: preparedEvent.category,
    tags: preparedEvent.tags || [],
    created_at: preparedEvent.created_at,
  };
  const msgBytes = new TextEncoder().encode(JSON.stringify(eventData));
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBytes);
  const privBytes = Uint8Array.from(atob(kp.privkeyB64), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    privBytes.buffer,
    'Ed25519',
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign(
    'Ed25519',
    cryptoKey,
    new Uint8Array(hashBuffer)
  );
  return { ...eventData, signature: bytesToHex(new Uint8Array(sigBuffer)) };
}

if (typeof module !== 'undefined') {
  module.exports = { bytesToHex, signEvent };
}
if (typeof window !== 'undefined') {
  window.bytesToHex = bytesToHex;
  window.loadOrCreateKeypair = loadOrCreateKeypair;
  window.signEvent = signEvent;
}

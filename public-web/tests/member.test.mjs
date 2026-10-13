// public-web/tests/member.test.mjs — run: node public-web/tests/member.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const M = createRequire(import.meta.url)('../member.js');

const hexToBytes = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));
const fakeStorage = () => {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
  };
};
const RFC_SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const RFC_PUB = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const RFC_SEED_B64 = M.b64urlEncode(hexToBytes(RFC_SEED));

test('base64url round-trips bytes and rejects junk', () => {
  const bytes = Uint8Array.from([0, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual([...M.b64urlDecode(M.b64urlEncode(bytes))], [...bytes]);
  assert.equal(M.b64urlDecode('abc*'), null);
});

test('normalizeActUrl matches the worker rules', () => {
  assert.equal(M.normalizeActUrl('HTTPS://Band.Example/Tour/?x=1#y'), 'https://band.example/Tour');
  assert.equal(M.normalizeActUrl('https://band.example/'), 'https://band.example');
  assert.equal(M.normalizeActUrl('http://a.example:8080/x/'), 'http://a.example:8080/x');
  assert.equal(M.normalizeActUrl('ftp://a.example'), null);
  assert.equal(M.normalizeActUrl('nonsense'), null);
});

test('normalizeName ignores case, accents and punctuation', () => {
  assert.equal(M.normalizeName('Sigur Rós!'), 'sigurros');
  assert.equal(M.normalizeName('AC/DC'), 'acdc');
});

test('readLinkSeed', () => {
  assert.deepEqual(M.readLinkSeed(''), { status: 'none' });
  assert.deepEqual(M.readLinkSeed('#other=1'), { status: 'none' });
  assert.deepEqual(M.readLinkSeed('#k=' + RFC_SEED_B64), { status: 'found', seed: RFC_SEED_B64 });
  assert.equal(M.readLinkSeed('#k=' + RFC_SEED_B64.slice(0, 10)).status, 'invalid');
  assert.equal(M.readLinkSeed('#k=***').status, 'none'); // not even the right shape
});

test('importMember derives the public key (RFC 8032 test vector 1)', async () => {
  const member = await M.importMember(RFC_SEED_B64);
  assert.equal(member.pubkey, RFC_PUB);
});

test('importMember rejects a seed of the wrong length', async () => {
  await assert.rejects(() => M.importMember(M.b64urlEncode(new Uint8Array(5))));
});

test('stored seed helpers', () => {
  const s = fakeStorage();
  assert.equal(M.loadStoredSeed(s), null);
  M.saveSeed(s, RFC_SEED_B64);
  assert.equal(M.loadStoredSeed(s), RFC_SEED_B64);
  M.clearSeed(s);
  assert.equal(M.loadStoredSeed(s), null);
  assert.equal(M.loadStoredSeed(null), null);
});

test('auto-followed ids are remembered', () => {
  const s = fakeStorage();
  assert.deepEqual([...M.loadAutoFollowed(s)], []);
  M.saveAutoFollowed(s, new Set([3, 5]));
  assert.deepEqual([...M.loadAutoFollowed(s)].sort(), [3, 5]);
});

test('describeSuggestions', () => {
  const tracked = [
    { name: 'Sigur Rós', url: 'https://sigurros.example/' },
    { name: 'Beta', url: 'https://beta.example' },
  ];
  const out = M.describeSuggestions(
    [
      { id: 1, name: 'sigur ros', url: null, status: 'pending', act_url: null, reject_reason: null },
      { id: 2, name: 'Some Alias', url: 'https://BETA.example/', status: 'pending', act_url: null, reject_reason: null },
      { id: 3, name: 'Gamma', url: null, status: 'pending', act_url: null, reject_reason: null },
      { id: 4, name: 'Delta', url: null, status: 'rejected', act_url: null, reject_reason: 'Not touring' },
      { id: 5, name: 'Eps', url: null, status: 'linked', act_url: 'https://eps.example', reject_reason: null },
    ],
    tracked
  );
  assert.deepEqual(
    out.map(v => [v.id, v.state, v.autoFollowUrl]),
    [
      [1, 'added', 'https://sigurros.example/'],
      [2, 'added', 'https://beta.example'],
      [3, 'waiting', null],
      [4, 'rejected', null],
      [5, 'added', null], // linked: followed by the server, never by the client
    ]
  );
  assert.equal(out[3].reason, 'Not touring');
});

// ── API client ────────────────────────────────────────────────────────────────
const sha256 = async s =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
async function verifies(member, headers, domain, payload) {
  const key = await crypto.subtle.importKey('raw', hexToBytes(member.pubkey), 'Ed25519', false, ['verify']);
  return crypto.subtle.verify(
    'Ed25519',
    key,
    hexToBytes(headers['X-Signature']),
    await sha256(`${domain}:${payload}:${headers['X-Timestamp']}`)
  );
}
const jsonRes = (status, data) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
  clone() { return this; },
});

test('me() signs a read request', async () => {
  const member = await M.importMember(RFC_SEED_B64);
  const calls = [];
  const api = M.createMemberApi(async (url, init) => { calls.push({ url, init }); return jsonRes(200, { name: 'Anna' }); }, 'https://w.test', member);
  const res = await api.me();
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { name: 'Anna' });
  assert.equal(calls[0].url, 'https://w.test/member/me');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers['X-Pubkey'], RFC_PUB);
  assert.equal(await verifies(member, calls[0].init.headers, 'member-read', '/member/me'), true);
});

test('follow/unfollow sign the normalized url and encode it in the path', async () => {
  const member = await M.importMember(RFC_SEED_B64);
  const calls = [];
  const api = M.createMemberApi(async (url, init) => { calls.push({ url, init }); return jsonRes(200, {}); }, 'https://w.test', member);
  await api.follow('https://Alpha.example/tour/');
  await api.unfollow('https://Alpha.example/tour/');
  const enc = M.b64urlEncode(new TextEncoder().encode('https://alpha.example/tour'));
  assert.equal(calls[0].url, 'https://w.test/member/bands/' + enc);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(await verifies(member, calls[0].init.headers, 'band-follow', 'https://alpha.example/tour'), true);
  assert.equal(calls[1].init.method, 'DELETE');
  assert.equal(await verifies(member, calls[1].init.headers, 'band-unfollow', 'https://alpha.example/tour'), true);
});

test('suggest signs the exact body it sends', async () => {
  const member = await M.importMember(RFC_SEED_B64);
  const calls = [];
  const api = M.createMemberApi(async (url, init) => { calls.push({ url, init }); return jsonRes(201, { id: 1 }); }, 'https://w.test', member);
  await api.suggest('Beta Band', 'https://beta.example');
  await api.suggest('No Site', '');
  assert.equal(calls[0].init.body, JSON.stringify({ name: 'Beta Band', url: 'https://beta.example' }));
  assert.equal(calls[1].init.body, JSON.stringify({ name: 'No Site' }));
  assert.equal(await verifies(member, calls[0].init.headers, 'band-suggest', calls[0].init.body), true);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
});

test('a clock-skew 401 is retried once with the server time', async () => {
  const member = await M.importMember(RFC_SEED_B64);
  const stamps = [];
  const serverNow = 1_900_000_000;
  const api = M.createMemberApi(
    async (url, init) => {
      stamps.push(Number(init.headers['X-Timestamp']));
      return stamps.length === 1
        ? jsonRes(401, { error: 'Timestamp out of range', server_time: serverNow })
        : jsonRes(200, { name: 'Anna' });
    },
    'https://w.test',
    member,
    () => 1_000 // the device clock is far off
  );
  const res = await api.me();
  assert.equal(res.ok, true);
  assert.equal(stamps.length, 2);
  assert.equal(stamps[0], 1_000);
  assert.equal(stamps[1], serverNow);
});

test('other failures are returned as they are', async () => {
  const member = await M.importMember(RFC_SEED_B64);
  const api = M.createMemberApi(async () => jsonRes(403, { error: 'Forbidden' }), 'https://w.test', member);
  const res = await api.me();
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
});

test('followedSet / isFollowed use normalized urls', () => {
  const set = M.followedSet(['https://alpha.example/', 'junk']);
  assert.equal(M.isFollowed(set, 'HTTPS://alpha.example'), true);
  assert.equal(M.isFollowed(set, 'https://beta.example'), false);
});

test('supportsEd25519: true where WebCrypto has Ed25519', async () => {
  assert.equal(await M.supportsEd25519(), true);
});

test('supportsEd25519: false (never throws) when Ed25519 is missing', async () => {
  const rejecting = {
    importKey: async () => {
      throw new DOMException('Unrecognized name', 'NotSupportedError');
    },
    exportKey: async () => ({}),
  };
  assert.equal(await M.supportsEd25519(rejecting), false);
  assert.equal(await M.supportsEd25519(null), false);
  const throwingSync = {
    importKey: () => {
      throw new TypeError('sync failure');
    },
  };
  assert.equal(await M.supportsEd25519(throwingSync), false);
});

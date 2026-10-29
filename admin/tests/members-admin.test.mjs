// admin/tests/members-admin.test.mjs — run: node admin/tests/members-admin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const A = createRequire(import.meta.url)('../members-admin.js');

test('buildMemberLink puts the seed in the fragment of tours.html', () => {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
  const link = A.buildMemberLink('https://tours.example/', seed);
  assert.match(link, /^https:\/\/tours\.example\/tours\.html#k=[A-Za-z0-9_-]{43}$/);
  assert.equal(A.buildMemberLink('https://tours.example', seed), link);
});

test('bandsTxt: one line per group, name first, site hint when known', () => {
  const groups = [
    { name_variants: ['Sigur Ros', 'Sigur Rós'], urls: ['https://sigurros.example'] },
    { name_variants: ['Solo Act'], urls: [] },
    { name_variants: ['Two Sites'], urls: ['https://a.example', 'https://b.example'] },
  ];
  assert.equal(
    A.bandsTxt(groups),
    'Sigur Ros | https://sigurros.example\nSolo Act\nTwo Sites | https://a.example\n'
  );
});

test('bandsTxt drops names containing "|" separators and newlines', () => {
  assert.equal(A.bandsTxt([{ name_variants: ['A | B\nC'], urls: [] }]), 'A B C\n');
});

test('bandsTxt of nothing is empty', () => {
  assert.equal(A.bandsTxt([]), '');
});

test('admin reads sign the exact path they request, query string included', async () => {
  const sent = [];
  const fetchFn = async (url, init) => {
    sent.push({ url, init });
    return { ok: true, status: 200, json: async () => [] };
  };
  const signed = [];
  const ed = {
    getPublicKeyAsync: async () => new Uint8Array(32),
    signAsync: async msg => {
      signed.push(Buffer.from(msg).toString('hex'));
      return new Uint8Array(64);
    },
  };
  const api = A.createAdminApi({ ed, fetchFn, workerUrl: 'https://w.test/', privKeyHex: '00'.repeat(32) });
  await api.listSuggestions({ detail: true });
  await api.listSuggestions();
  await api.listMembers();
  await api.followers();
  const digest = (payload, ts) =>
    crypto.createHash('sha256').update('admin-read:' + payload + ':' + ts).digest('hex');
  const expected = [
    ['https://w.test/admin/suggestions?detail=1', '/admin/suggestions?detail=1'],
    ['https://w.test/admin/suggestions', '/admin/suggestions'],
    ['https://w.test/admin/members', '/admin/members'],
    ['https://w.test/admin/band-followers', '/admin/band-followers'],
  ];
  expected.forEach(([url, payload], i) => {
    assert.equal(sent[i].url, url);
    assert.equal(signed[i], digest(payload, sent[i].init.headers['X-Timestamp']));
  });
});

test('festivalsYaml: entries for festivals.yaml, TODO marker when no site', () => {
  const groups = [
    { name_variants: ['Terraforma'], urls: ['https://terraforma.example'] },
    { name_variants: ['No Site'], urls: [] },
  ];
  assert.equal(
    A.festivalsYaml(groups, '2026-10-29'),
    '  - url: https://terraforma.example\n' +
      '    name: "Terraforma"\n' +
      '    added: 2026-10-29\n' +
      '\n' +
      '  # TODO url\n' +
      '  - url:\n' +
      '    name: "No Site"\n' +
      '    added: 2026-10-29\n'
  );
});

test('festivalsYaml double-quotes names with : or # and escapes quotes', () => {
  const out = A.festivalsYaml(
    [{ name_variants: ['Fest: "One" #1'], urls: ['https://f.example'] }],
    '2026-10-29'
  );
  assert.match(out, /^ {4}name: "Fest: \\"One\\" #1"$/m);
});

test('festivalsYaml always quotes names so YAML keeps them strings', () => {
  const names = ['2024', 'No', '"Quoted"', 'a: b # c'];
  const out = A.festivalsYaml(
    names.map(n => ({ name_variants: [n], urls: ['https://f.example'] })),
    '2026-10-29'
  );
  for (const n of names)
    assert.ok(out.includes('    name: ' + JSON.stringify(n) + '\n'), n);
});

test('festival admin methods call the right path and sign with the right domain', async () => {
  const sent = [];
  const fetchFn = async (url, init) => {
    sent.push({ url, init });
    return { ok: true, status: 200, json: async () => [] };
  };
  const signed = [];
  const ed = {
    getPublicKeyAsync: async () => new Uint8Array(32),
    signAsync: async msg => {
      signed.push(Buffer.from(msg).toString('hex'));
      return new Uint8Array(64);
    },
  };
  const api = A.createAdminApi({ ed, fetchFn, workerUrl: 'https://w.test/', privKeyHex: '00'.repeat(32) });
  await api.listFestivalSuggestions({ detail: true });
  await api.listFestivalSuggestions();
  await api.rejectFestivalSuggestions([1, 2], 'nope');
  await api.linkFestivalSuggestions([3], 'https://f.example');
  await api.festivalFollowers();
  const rejectBody = JSON.stringify({ ids: [1, 2], reason: 'nope' });
  const linkBody = JSON.stringify({ ids: [3], festival_url: 'https://f.example' });
  const expected = [
    ['/admin/festival-suggestions?detail=1', 'admin-read', '/admin/festival-suggestions?detail=1', 'GET'],
    ['/admin/festival-suggestions', 'admin-read', '/admin/festival-suggestions', 'GET'],
    ['/admin/festival-suggestions/reject', 'admin-festival-suggestion-reject', rejectBody, 'POST'],
    ['/admin/festival-suggestions/link', 'admin-festival-suggestion-link', linkBody, 'POST'],
    ['/admin/festival-followers', 'admin-read', '/admin/festival-followers', 'GET'],
  ];
  expected.forEach(([path, domain, payload, method], i) => {
    assert.equal(sent[i].url, 'https://w.test' + path);
    assert.equal(sent[i].init.method, method);
    const d = crypto
      .createHash('sha256')
      .update(domain + ':' + payload + ':' + sent[i].init.headers['X-Timestamp'])
      .digest('hex');
    assert.equal(signed[i], d);
  });
  assert.equal(sent[2].init.body, rejectBody);
  assert.equal(sent[3].init.body, linkBody);
});

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

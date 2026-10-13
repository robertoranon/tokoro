// admin/tests/members-admin.test.mjs — run: node admin/tests/members-admin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

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

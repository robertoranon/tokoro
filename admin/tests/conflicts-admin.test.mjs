// admin/tests/conflicts-admin.test.mjs — run: node --test admin/tests/conflicts-admin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const C = createRequire(import.meta.url)('../conflicts-admin.js');

function setup(response) {
  const sent = [];
  const signed = [];
  const fetchFn = async (url, init) => {
    sent.push({ url, init });
    return response;
  };
  const ed = {
    getPublicKeyAsync: async () => new Uint8Array(32),
    signAsync: async msg => {
      signed.push(Buffer.from(msg).toString('hex'));
      return new Uint8Array(64);
    },
  };
  const api = C.createConflictsApi({ ed, fetchFn, workerUrl: 'https://w.test/', privKeyHex: '00'.repeat(32) });
  return { api, sent, signed };
}
const digest = (domain, payload, ts) =>
  crypto.createHash('sha256').update(domain + ':' + payload + ':' + ts).digest('hex');

test('list signs the exact path+query with admin-read and returns the parsed list', async () => {
  const body = { conflicts: [{ id: 'c1' }] };
  const { api, sent, signed } = setup({ ok: true, status: 200, json: async () => body });
  assert.deepEqual(await api.list('open'), body);
  await api.list();
  assert.equal(sent[0].url, 'https://w.test/admin/conflicts?status=open');
  assert.equal(sent[1].url, 'https://w.test/admin/conflicts?status=open');
  const ts = sent[0].init.headers['X-Timestamp'];
  assert.equal(signed[0], digest('admin-read', '/admin/conflicts?status=open', ts));
  assert.equal(sent[0].init.method, 'GET');
});

test('resolve signs the exact raw body it sends with admin-conflict-resolve', async () => {
  const { api, sent, signed } = setup({ ok: true, status: 200, json: async () => ({ ok: true }) });
  const body = { action: 'delete', event_id: 'e1' };
  await api.resolve('c1', body);
  assert.equal(sent[0].url, 'https://w.test/admin/conflicts/c1/resolve');
  assert.equal(sent[0].init.method, 'POST');
  assert.equal(sent[0].init.body, JSON.stringify(body));
  const ts = sent[0].init.headers['X-Timestamp'];
  assert.equal(signed[0], digest('admin-conflict-resolve', sent[0].init.body, ts));
});

test('sweep posts {} signed with admin-conflict-sweep and returns the counts', async () => {
  const counts = { scanned: 3, conflicts_created: 1, failed: 0 };
  const { api, sent, signed } = setup({ ok: true, status: 200, json: async () => counts });
  assert.deepEqual(await api.sweep(), counts);
  assert.equal(sent[0].url, 'https://w.test/admin/conflicts/sweep');
  assert.equal(sent[0].init.method, 'POST');
  assert.equal(sent[0].init.body, '{}');
  assert.equal(sent[0].init.headers['Content-Type'], 'application/json');
  const ts = sent[0].init.headers['X-Timestamp'];
  assert.equal(signed[0], digest('admin-conflict-sweep', '{}', ts));
});

test('admin-read and admin-conflict-resolve signatures differ for the same payload', async () => {
  const p = '{"action":"keep_both"}';
  assert.notEqual(digest('admin-read', p, '1'), digest('admin-conflict-resolve', p, '1'));
});

test('HTTP errors reject with the server error', async () => {
  const { api } = setup({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) });
  await assert.rejects(api.list('open'), /forbidden/);
  await assert.rejects(api.resolve('c1', { action: 'keep_both' }), /forbidden/);
  await assert.rejects(api.sweep(), /forbidden/);
});

test('safeHttpUrl keeps http(s) urls and rejects everything else', () => {
  const { safeHttpUrl } = C;
  assert.equal(safeHttpUrl('http://a.example/x'), 'http://a.example/x');
  assert.equal(safeHttpUrl('https://a.example/x'), 'https://a.example/x');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'JAVASCRIPT:alert(1)', '//evil.example', '', null, undefined, 42, {}]) {
    assert.equal(safeHttpUrl(bad), null, String(bad));
  }
});

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as ed from '@noble/ed25519';
import './crypto'; // configures ed.etc.sha512Async
import worker from './index';
import { normalizeActUrl, normalizeName } from './band-keys';
import { makeD1 } from '../test-support/d1';
import { makeKey, toHex } from '../test-support/sign';

const nodeRequire = createRequire(import.meta.url);
const M = nodeRequire('../../public-web/member.js');
const AM = nodeRequire('../../admin/members-admin.js');

async function setup() {
  const admin = await makeKey();
  const env: any = {
    DB: makeD1(),
    ADMIN_PUBKEY: admin.pubkey,
  };
  const fetchFn = (url: string, init: RequestInit) =>
    worker.fetch(new Request(url, init), env);
  const adminApi = AM.createAdminApi({
    ed,
    fetchFn,
    workerUrl: 'https://w.test',
    privKeyHex: toHex(admin.priv),
  });
  return { env, fetchFn, adminApi };
}

describe('browser and admin clients against the Worker', () => {
  it('runs the whole flow through the real signing code on both sides', async () => {
    const { fetchFn, adminApi } = await setup();

    // admin issues a link; the member's browser turns it into the same identity
    const { pubkey, seed } = await adminApi.createMember('Anna');
    const link = AM.buildMemberLink('https://tours.example/', seed);
    const found = M.readLinkSeed(new URL(link).hash);
    expect(found.status).toBe('found');
    const imported = await M.importMember(found.seed);
    expect(imported.pubkey).toBe(pubkey);

    const api = M.createMemberApi(fetchFn, 'https://w.test', imported);
    const me = await api.me();
    expect(me.ok).toBe(true);
    expect(me.data.name).toBe('Anna');

    // follow with a messy url; the server stores what both sides normalize to
    expect((await api.follow('HTTPS://Alpha.example/tour/?x=1')).ok).toBe(true);
    expect((await api.me()).data.bands).toEqual(['https://alpha.example/tour']);
    expect((await api.unfollow('https://alpha.example/tour/')).ok).toBe(true);
    expect((await api.me()).data.bands).toEqual([]);

    // suggest → admin lists, copies for bands-scout, links
    expect((await api.suggest('Beta Band', 'https://beta.example/')).ok).toBe(
      true
    );
    const groups = await adminApi.listSuggestions();
    expect(groups).toHaveLength(1);
    // admin-read signs the query string too
    const detailed = await adminApi.listSuggestions({ detail: true });
    expect(detailed[0].member_names).toEqual(['Anna']);
    expect(await adminApi.listMembers()).toHaveLength(1);
    expect(AM.bandsTxt(groups)).toBe('Beta Band | https://beta.example\n');
    await adminApi.linkSuggestions(groups[0].ids, 'https://beta.example/');
    const after = await api.me();
    expect(after.data.bands).toEqual(['https://beta.example']);
    expect(after.data.suggestions[0].status).toBe('linked');
    expect(M.describeSuggestions(after.data.suggestions, [])[0].state).toBe(
      'added'
    );

    // revoke → the same signed call is refused
    await adminApi.revokeMember(pubkey);
    expect((await api.me()).status).toBe(403);
  });

  it('survives a wrong device clock', async () => {
    const { fetchFn, adminApi } = await setup();
    const { seed } = await adminApi.createMember('Bob');
    const imported = await M.importMember(M.b64urlEncode(seed));
    const behind = () => Math.floor(Date.now() / 1000) - 3600;
    const api = M.createMemberApi(fetchFn, 'https://w.test', imported, behind);
    const me = await api.me();
    expect(me.ok).toBe(true);
    expect(me.data.name).toBe('Bob');
  });

  it('keeps client and server normalization identical', () => {
    const urls = [
      'HTTPS://Band.Example/Tour/?x=1#y',
      'https://band.example/',
      'http://a.example:8080/x/',
      'https://a.example:443/',
      '  https://a.example/b  ',
      'ftp://a.example',
      'nonsense',
      '',
    ];
    for (const u of urls) expect(M.normalizeActUrl(u)).toBe(normalizeActUrl(u));
    for (const n of [
      'Sigur Rós!',
      'AC/DC',
      ' The  Band ',
      '!!!',
      'Zoë & Co.',
    ]) {
      expect(M.normalizeName(n)).toBe(normalizeName(n));
    }
  });
});

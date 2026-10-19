import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import './crypto';
import worker, { alertPendingFor } from './index';
import { actMessage } from './crypto';
import { makeD1 } from '../test-support/d1';
import { makeKey, toHex } from '../test-support/sign';

describe('alertPendingFor', () => {
  it('is 1 for band shows and festival entries, 0 otherwise', () => {
    expect(alertPendingFor({ act_url: 'https://a.example' })).toBe(1);
    expect(alertPendingFor({ festival_url: 'https://f.example' })).toBe(1);
    expect(alertPendingFor({})).toBe(0);
    expect(alertPendingFor({ act_url: '', festival_url: '' })).toBe(0);
  });
});

describe('POST /events/:id/act', () => {
  it('sets alert_pending when a band is attached', async () => {
    const DB = makeD1();
    await DB.prepare(
      `INSERT INTO events (id, pubkey, signature, title, lat, lng, geohash5, geohash6,
         start_time, category, created_at)
       VALUES ('e1', 'pk', 'sig', 'Show', 45, 13, 'u0000', 'u00000',
         '2030-01-01T21:00:00', 'music', '2020-01-01T00:00:00')`
    ).run();
    const key = await makeKey();
    const actName = 'Alpha';
    const actUrl = 'https://alpha.example';
    const sig = await ed.signAsync(
      await actMessage('e1', actName, actUrl),
      key.priv
    );
    const res = await worker.fetch(
      new Request('https://w.test/events/e1/act', {
        method: 'POST',
        body: JSON.stringify({
          pubkey: key.pubkey,
          signature: toHex(sig),
          act_name: actName,
          act_url: actUrl,
        }),
      }),
      { DB } as any
    );
    expect(res.status).toBe(200);
    const row = (await DB.prepare(
      'SELECT alert_pending FROM events WHERE id = ?'
    )
      .bind('e1')
      .first()) as any;
    expect(row.alert_pending).toBe(1);
  });
});

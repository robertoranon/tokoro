import { describe, it, expect, vi } from 'vitest';
import {
  newEditions,
  sendAlertDigests,
  digestFor,
  formatDigest,
  fmtAlertDate,
  fmtDayRange,
  MAX_DIGEST_LINES,
  MAX_SENDS_PER_RUN,
  type AlertEvent,
  type Recipient,
} from './alerts';
import { makeD1 } from '../test-support/d1';

const ev = (o: Partial<AlertEvent>): AlertEvent => ({
  id: 'x',
  title: 'T',
  start_time: '2026-11-14T21:00:00',
  end_time: null,
  venue_name: null,
  address: null,
  url: null,
  act_name: null,
  act_url: null,
  festival_name: null,
  festival_url: null,
  ...o,
});

const anna: Recipient = {
  pubkey: 'p',
  name: 'Anna',
  chat_id: '1',
  radar: false,
  bands: ['https://alpha.example/'],
};

describe('fmtAlertDate / fmtDayRange', () => {
  it('formats weekday, day, month, time unless midnight, year unless current', () => {
    expect(fmtAlertDate('2026-11-14T21:00:00', 2026)).toBe('Sat 14 Nov 21:00');
    expect(fmtAlertDate('2026-11-14T00:00:00', 2026)).toBe('Sat 14 Nov');
    expect(fmtAlertDate('2027-01-02T00:00:00', 2026)).toBe('Sat 2 Jan 2027');
  });
  it('collapses ranges', () => {
    expect(fmtDayRange('2027-06-18T00:00:00', '2027-06-18T23:00:00')).toBe(
      '18 Jun 2027'
    );
    expect(fmtDayRange('2027-06-18T00:00:00', '2027-06-21T00:00:00')).toBe(
      '18–21 Jun 2027'
    );
    expect(fmtDayRange('2027-06-30T00:00:00', '2027-07-02T00:00:00')).toBe(
      '30 Jun – 2 Jul 2027'
    );
    expect(fmtDayRange('2026-12-30T00:00:00', '2027-01-02T00:00:00')).toBe(
      '30 Dec 2026 – 2 Jan 2027'
    );
  });
});

describe('newEditions', () => {
  const f = 'https://fest.example';
  it('groups the pending entries of a festival into one edition', () => {
    const eds = newEditions(
      [
        ev({
          festival_url: f,
          festival_name: 'Fest',
          start_time: '2027-06-19T00:00:00',
          venue_name: 'Park',
        }),
        ev({
          festival_url: f,
          festival_name: 'Fest',
          start_time: '2027-06-18T00:00:00',
          end_time: '2027-06-18T23:00:00',
          venue_name: 'Square',
        }),
        ev({
          festival_url: f,
          start_time: '2027-06-20T00:00:00',
          end_time: '2027-06-21T02:00:00',
        }),
      ],
      new Set()
    );
    expect(eds).toEqual([
      {
        festival_url: f,
        name: 'Fest',
        start: '2027-06-18T00:00:00',
        end: '2027-06-21T02:00:00',
        place: 'Square',
      },
    ]);
  });
  it('is not new when the festival already has an upcoming processed entry', () => {
    expect(newEditions([ev({ festival_url: f })], new Set([f]))).toEqual([]);
  });
  it('falls back to the title for the name and ignores non-festival events', () => {
    const eds = newEditions(
      [
        ev({ festival_url: f, title: 'Fest 2027' }),
        ev({ act_url: 'https://a.example' }),
      ],
      new Set()
    );
    expect(eds.map(e => e.name)).toEqual(['Fest 2027']);
  });
});

describe('newEditions url keys', () => {
  it('ignores case and trailing slash when matching known festivals', () => {
    const e = ev({ festival_url: 'https://fest.example' });
    expect(newEditions([e], new Set(['https://fest.example']))).toHaveLength(0);
    expect(
      newEditions(
        [e],
        new Set(['https://fest.example/'.toLowerCase().replace(/\/+$/, '')])
      )
    ).toEqual([]);
  });
});

describe('digestFor', () => {
  const shows = [
    ev({ id: 's1', act_url: 'https://Alpha.example', act_name: 'Alpha' }),
    ev({ id: 's2', act_url: 'https://beta.example', act_name: 'Beta' }),
  ];
  const editions = [
    { festival_url: 'f', name: 'Fest', start: 'a', end: 'a', place: null },
  ];
  it('keeps only followed bands (case and trailing slash ignored)', () => {
    expect(digestFor(anna, shows, editions)!.shows.map(s => s.id)).toEqual([
      's1',
    ]);
    expect(digestFor(anna, shows, editions)!.editions).toEqual([]);
  });
  it('adds editions only with radar alerts on', () => {
    expect(
      digestFor({ ...anna, radar: true }, shows, editions)!.editions
    ).toHaveLength(1);
  });
  it('null when there is nothing for the member', () => {
    expect(digestFor({ ...anna, bands: [] }, shows, editions)).toBeNull();
  });
});

describe('formatDigest', () => {
  it('groups shows by band (alphabetical), escapes text and adds links', () => {
    const text = formatDigest(
      [
        ev({
          act_name: 'Zeta',
          act_url: 'https://z.example',
          start_time: '2026-11-20T20:00:00',
          venue_name: 'Club <1>',
          url: 'https://club.example/z',
        }),
        ev({
          act_name: 'Alpha & Co',
          act_url: 'https://a.example',
          start_time: '2026-11-15T00:00:00',
          address: 'Via Roma 1, Udine',
        }),
        ev({
          act_name: 'Alpha & Co',
          act_url: 'https://a.example',
          start_time: '2026-11-14T21:00:00',
          venue_name: 'Hall',
        }),
      ],
      [
        {
          festival_url: 'https://fest.example',
          name: 'Fest',
          start: '2027-06-18T00:00:00',
          end: '2027-06-21T00:00:00',
          place: 'Park',
        },
      ],
      { year: 2026, publicWebUrl: 'https://tokoro.example/' }
    );
    expect(text).toBe(
      [
        '🎸 <b>New shows</b>',
        '<b>Alpha &amp; Co</b>',
        '• Sat 14 Nov 21:00 · Hall',
        '• Sun 15 Nov · Via Roma 1, Udine',
        '<b>Zeta</b>',
        '• Fri 20 Nov 20:00 · Club &lt;1&gt; · <a href="https://club.example/z">page</a>',
        '',
        '🎪 <b>New festival editions</b>',
        '• <b>Fest</b> · 18–21 Jun 2027 · Park · <a href="https://fest.example">site</a>',
        '',
        '<a href="https://tokoro.example/tours.html">All shows</a> · <a href="https://tokoro.example/festivals.html">Festivals</a>',
      ].join('\n')
    );
  });

  it(`caps at ${MAX_DIGEST_LINES} item lines`, () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      ev({
        act_name: 'A',
        act_url: 'https://a.example',
        start_time: `2026-12-${String(i + 1).padStart(2, '0')}T00:00:00`,
      })
    );
    const text = formatDigest(many, [], { year: 2026 });
    expect(text.split('\n').filter(l => l.startsWith('• '))).toHaveLength(
      MAX_DIGEST_LINES
    );
    expect(text.endsWith('…and 5 more')).toBe(true);
  });

  it('stays within the Telegram length limit', () => {
    const long = 'V'.repeat(150);
    const many = Array.from({ length: 25 }, (_, i) =>
      ev({
        act_name: `${i} ${long}`,
        act_url: `https://a${i}.example`,
        start_time: `2026-12-${String(i + 1).padStart(2, '0')}T20:00:00`,
        venue_name: long,
        address: long,
      })
    );
    const text = formatDigest(many, [], {
      year: 2026,
      publicWebUrl: 'https://t.example',
    });
    const plain = text
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
    expect(plain.length).toBeLessThanOrEqual(4096);
    expect(text).toMatch(
      /…and \d+ more\n\n<a href="https:\/\/t\.example\/tours\.html">/
    );
  });

  it('never links a non-http url', () => {
    const text = formatDigest(
      [
        ev({
          act_name: 'A',
          act_url: 'https://a.example',
          url: 'javascript:alert(1)',
        }),
      ],
      [],
      { year: 2026 }
    );
    expect(text).not.toContain('href');
  });
});

describe('sendAlertDigests', () => {
  const TODAY = '2026-10-20T00:00:00';

  async function setup() {
    const DB = makeD1();
    const addEvent = (id: string, o: Record<string, unknown>) =>
      DB.prepare(
        `INSERT INTO events (id, pubkey, signature, title, lat, lng, geohash5, geohash6,
           start_time, category, created_at, act_name, act_url, festival_name, festival_url, alert_pending)
         VALUES (?, 'pk', 'sig', ?, 45, 13, 'u0000', 'u00000', ?, 'music', 'x', ?, ?, ?, ?, ?)`
      )
        .bind(
          id,
          o.title ?? id,
          o.start ?? '2026-11-14T21:00:00',
          o.act_name ?? null,
          o.act_url ?? null,
          o.festival_name ?? null,
          o.festival_url ?? null,
          o.pending ?? 1
        )
        .run();
    const addMember = async (
      pk: string,
      chat: string | null,
      radar: number,
      bands: string[],
      revoked = false
    ) => {
      await DB.prepare(
        'INSERT INTO members (pubkey, name, created_at, revoked_at, telegram_chat_id, radar_alerts) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(pk, pk, 'x', revoked ? 'x' : null, chat, radar)
        .run();
      for (const b of bands)
        await DB.prepare(
          "INSERT INTO member_bands (pubkey, act_url, created_at) VALUES (?, ?, 'x')"
        )
          .bind(pk, b)
          .run();
    };
    const sent: { chat_id: string; text: string }[] = [];
    let status = 200;
    const fetchFn = async (_url: string, init: any) => {
      const b = JSON.parse(init.body);
      sent.push({ chat_id: b.chat_id, text: b.text });
      return new Response('{}', { status });
    };
    const env: any = { DB, TELEGRAM_BOT_TOKEN: 't' };
    return {
      DB,
      env,
      addEvent,
      addMember,
      sent,
      fetchFn,
      setStatus: (s: number) => (status = s),
    };
  }

  it('sends one message per member with something new, then clears the flags', async () => {
    const s = await setup();
    await s.addEvent('a1', {
      act_name: 'Alpha',
      act_url: 'https://alpha.example',
    });
    await s.addEvent('b1', {
      act_name: 'Beta',
      act_url: 'https://beta.example',
    });
    await s.addEvent('old', {
      act_name: 'Alpha',
      act_url: 'https://alpha.example',
      start: '2026-10-01T00:00:00',
    });
    await s.addEvent('f1', {
      festival_name: 'Fest',
      festival_url: 'https://fest.example',
      start: '2027-06-18T00:00:00',
    });
    await s.addMember('anna', '1', 0, ['https://alpha.example']);
    await s.addMember('bea', '2', 1, []);
    await s.addMember('cid', '3', 1, ['https://alpha.example'], true); // revoked
    await s.addMember('dan', null, 1, ['https://alpha.example']); // not linked

    const r = await sendAlertDigests(s.env, {
      fetchFn: s.fetchFn as any,
      today: TODAY,
    });

    expect(s.sent.map(m => m.chat_id).sort()).toEqual(['1', '2']);
    const annaText = s.sent.find(m => m.chat_id === '1')!.text;
    expect(annaText).toContain('Alpha');
    expect(annaText).not.toContain('Beta');
    expect(annaText).not.toContain('Fest');
    expect(s.sent.find(m => m.chat_id === '2')!.text).toContain('Fest');
    expect(r).toEqual({ sent: 2, cleared: 4 });
    const left = (await s.DB.prepare(
      'SELECT COUNT(*) AS n FROM events WHERE alert_pending = 1'
    ).first()) as any;
    expect(left.n).toBe(0);
  });

  it('does not announce a festival that already had an upcoming entry', async () => {
    const s = await setup();
    await s.addEvent('f0', {
      festival_url: 'https://fest.example',
      pending: 0,
    });
    await s.addEvent('f1', {
      festival_url: 'https://fest.example',
      start: '2026-11-15T00:00:00',
    });
    await s.addMember('bea', '2', 1, []);
    await sendAlertDigests(s.env, { fetchFn: s.fetchFn as any, today: TODAY });
    expect(s.sent).toEqual([]);
  });

  it('clears the chat id when the member blocked the bot (403)', async () => {
    const s = await setup();
    await s.addEvent('a1', {
      act_name: 'Alpha',
      act_url: 'https://alpha.example',
    });
    await s.addMember('anna', '1', 0, ['https://alpha.example']);
    s.setStatus(403);
    await sendAlertDigests(s.env, { fetchFn: s.fetchFn as any, today: TODAY });
    const m = (await s.DB.prepare(
      "SELECT telegram_chat_id FROM members WHERE pubkey = 'anna'"
    ).first()) as any;
    expect(m.telegram_chat_id).toBeNull();
  });

  it('retries once after a 429, waiting retry_after (at most 5 s)', async () => {
    const s = await setup();
    await s.addEvent('a1', {
      act_name: 'Alpha',
      act_url: 'https://alpha.example',
    });
    await s.addMember('anna', '1', 0, ['https://alpha.example']);
    const waits: number[] = [];
    let calls = 0;
    const fetchFn = async () =>
      ++calls === 1
        ? new Response(JSON.stringify({ parameters: { retry_after: 30 } }), {
            status: 429,
          })
        : new Response('{}', { status: 200 });
    const r = await sendAlertDigests(s.env, {
      fetchFn: fetchFn as any,
      today: TODAY,
      sleep: async ms => {
        waits.push(ms);
      },
    });
    expect(waits).toEqual([5000]);
    expect(r.sent).toBe(1);
  });

  it('does nothing without a bot token', async () => {
    const s = await setup();
    await s.addEvent('a1', {
      act_name: 'Alpha',
      act_url: 'https://alpha.example',
    });
    delete s.env.TELEGRAM_BOT_TOKEN;
    expect(
      await sendAlertDigests(s.env, { fetchFn: s.fetchFn as any, today: TODAY })
    ).toEqual({ sent: 0, cleared: 0 });
  });

  it('deletes expired link codes', async () => {
    const s = await setup();
    await s.DB.prepare(
      "INSERT INTO telegram_link_codes VALUES ('c', 'p', '2000-01-01T00:00:00')"
    ).run();
    await sendAlertDigests(s.env, { fetchFn: s.fetchFn as any, today: TODAY });
    const n = (await s.DB.prepare(
      'SELECT COUNT(*) AS n FROM telegram_link_codes'
    ).first()) as any;
    expect(n.n).toBe(0);
  });

  it('a 500 for one member does not stop the others; flags are still cleared', async () => {
    const s = await setup();
    await s.addEvent('a1', {
      act_name: 'Alpha',
      act_url: 'https://alpha.example',
    });
    await s.addMember('anna', '1', 0, ['https://alpha.example']);
    await s.addMember('bea', '2', 0, ['https://alpha.example']);
    const sent: string[] = [];
    const fetchFn = async (_u: string, init: any) => {
      const b = JSON.parse(init.body);
      sent.push(b.chat_id);
      return new Response('{}', { status: b.chat_id === '1' ? 500 : 200 });
    };
    const r = await sendAlertDigests(s.env, {
      fetchFn: fetchFn as any,
      today: TODAY,
    });
    expect(sent.sort()).toEqual(['1', '2']);
    expect(r.sent).toBe(1);
    const left = (await s.DB.prepare(
      'SELECT COUNT(*) AS n FROM events WHERE alert_pending != 0'
    ).first()) as any;
    expect(left.n).toBe(0);
  });

  it('leaves past pending events out of messages but clears them', async () => {
    const s = await setup();
    await s.addEvent('old', {
      act_name: 'Alpha',
      act_url: 'https://alpha.example',
      start: '2026-10-01T00:00:00',
    });
    await s.addMember('anna', '1', 0, ['https://alpha.example']);
    const r = await sendAlertDigests(s.env, {
      fetchFn: s.fetchFn as any,
      today: TODAY,
    });
    expect(s.sent).toEqual([]);
    expect(r.cleared).toBe(1);
  });

  it('keeps events flagged while sending pending for the next run', async () => {
    const s = await setup();
    await s.addEvent('a1', {
      act_name: 'Alpha',
      act_url: 'https://alpha.example',
    });
    await s.addMember('anna', '1', 0, ['https://alpha.example']);
    const fetchFn = async () => {
      await s.addEvent('late', {
        act_name: 'Alpha',
        act_url: 'https://alpha.example',
      });
      return new Response('{}', { status: 200 });
    };
    await sendAlertDigests(s.env, { fetchFn: fetchFn as any, today: TODAY });
    const late = (await s.DB.prepare(
      "SELECT alert_pending AS p FROM events WHERE id = 'late'"
    ).first()) as any;
    expect(late.p).toBe(1);
  });

  it('does not re-announce a festival whose processed entry already started', async () => {
    const s = await setup();
    await s.addEvent('f0', {
      festival_url: 'https://fest.example',
      start: '2026-10-19T00:00:00',
      pending: 0,
    });
    await s.addEvent('f1', {
      festival_url: 'https://Fest.example/',
      start: '2026-10-21T00:00:00',
    });
    await s.addMember('bea', '2', 1, []);
    await sendAlertDigests(s.env, { fetchFn: s.fetchFn as any, today: TODAY });
    expect(s.sent).toEqual([]);
  });

  it('sends to at most MAX_SENDS_PER_RUN members and warns', async () => {
    const s = await setup();
    await s.addEvent('a1', {
      act_name: 'Alpha',
      act_url: 'https://alpha.example',
    });
    for (let i = 0; i < MAX_SENDS_PER_RUN + 1; i++)
      await s.addMember('m' + i, String(i), 0, ['https://alpha.example']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sendAlertDigests(s.env, { fetchFn: s.fetchFn as any, today: TODAY });
    expect(s.sent).toHaveLength(MAX_SENDS_PER_RUN);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

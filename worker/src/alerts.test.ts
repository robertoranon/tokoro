import { describe, it, expect, vi } from 'vitest';
import {
  newEditions,
  notifyConflict,
  sendAlertDigests,
  digestFor,
  formatDigest,
  fmtAlertDate,
  fmtDayRange,
  MAX_DIGEST_CHARS,
  MAX_SENDS_PER_RUN,
  type AlertEvent,
  type Recipient,
} from './alerts';
import { reevaluateConflicts } from './conflicts';
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
  festivals: [],
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
  const edA = {
    festival_url: 'https://fest.example/x/',
    name: 'A',
    start: '2027-06-18T00:00:00',
    end: '2027-06-18T00:00:00',
    place: null,
  };
  const edB = {
    festival_url: 'https://other.example/',
    name: 'B',
    start: '2027-07-01T00:00:00',
    end: '2027-07-01T00:00:00',
    place: null,
  };
  const fan = { ...anna, bands: [], festivals: ['https://Fest.example/X'] };
  it('digestFor puts followed editions in followed, matching case-insensitively', () => {
    expect(digestFor(fan, [], [edA])!.followed).toEqual([edA]);
  });
  it('digestFor does not repeat a followed edition under editions when radar is on', () => {
    const d = digestFor({ ...fan, radar: true }, [], [edA, edB])!;
    expect(d.followed).toEqual([edA]);
    expect(d.editions).toEqual([edB]);
  });
  it('digestFor sends a festivals-only member their followed editions with radar off', () => {
    const d = digestFor(fan, [], [edA, edB])!;
    expect(d).not.toBeNull();
    expect(d.editions).toEqual([]);
    expect(d.followed).toEqual([edA]);
  });
});

describe('formatDigest followed festivals', () => {
  const ed = (name: string) => ({
    festival_url: 'https://f.example/' + name,
    name,
    start: '2027-06-18T00:00:00',
    end: '2027-06-20T00:00:00',
    place: 'Berlin',
  });
  it('formatDigest orders sections', () => {
    const [text] = formatDigest(
      [
        ev({
          id: 's',
          act_url: 'https://a.example',
          act_name: 'Alpha',
          start_time: '2026-11-14T21:00:00',
        }),
      ],
      [ed('New')],
      { year: 2026, publicWebUrl: 'https://tokoro.example' },
      [ed('Mine')]
    );
    const a = text.indexOf('🎸 <b>New shows</b>');
    const b = text.indexOf('🎪 <b>Festivals you follow</b>');
    const c = text.indexOf('🎪 <b>New festival editions</b>');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(text).toContain(
      '• <b>Mine</b> · 18–20 Jun 2027 · Berlin · <a href="https://f.example/Mine">site</a>'
    );
  });
  it('adds the Festivals link when only followed is non-empty', () => {
    const [text] = formatDigest(
      [],
      [],
      { year: 2026, publicWebUrl: 'https://tokoro.example' },
      [ed('Mine')]
    );
    expect(text).toContain(
      '<a href="https://tokoro.example/festivals.html">Festivals</a>'
    );
  });
});

describe('formatDigest', () => {
  const plain = (t: string) =>
    t
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
  const ed0 = {
    festival_url: 'https://fest.example',
    name: 'Fest',
    start: '2027-06-18T00:00:00',
    end: '2027-06-21T00:00:00',
    place: 'Park',
  };
  it('a range show in the digest uses fmtDayRange', () => {
    const [text] = formatDigest(
      [
        ev({
          act_name: 'A',
          act_url: 'https://a.example',
          start_time: '2027-06-18T00:00:00',
          end_time: '2027-06-20T00:00:00',
        }),
        ev({
          act_name: 'B',
          act_url: 'https://b.example',
          start_time: '2027-06-18T00:00:00',
          end_time: '2027-06-18T23:00:00',
        }),
      ],
      [],
      { year: 2027 }
    );
    expect(text).toContain('18–20 Jun 2027');
    expect(text).toContain('Fri 18 Jun');
    expect(text).not.toContain('Fri 18 Jun –');
  });
  it('escapes dates and edition ranges', () => {
    const [text] = formatDigest(
      [
        ev({
          act_name: 'A',
          act_url: 'https://a.example',
          start_time: '2027-01-01T<b>x',
        }),
      ],
      [
        {
          festival_url: 'https://f.example',
          name: 'F',
          start: '2027-01-01T<b>x',
          end: '2027-01-02T<b>x',
          place: null,
        },
      ],
      { year: 2027 }
    );
    expect(text).not.toContain('<b>x');
  });
  it('groups shows by band (alphabetical), escapes text and adds links', () => {
    const [text] = formatDigest(
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

  it('splits a long digest over several messages, listing every item', () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      ev({
        act_name: `Band ${Math.floor(i / 40)}`,
        act_url: `https://b${Math.floor(i / 40)}.example`,
        start_time: `2026-12-${String((i % 28) + 1).padStart(2, '0')}T20:00:00`,
        venue_name: 'V'.repeat(60),
        url: `https://club.example/${i}`,
      })
    );
    const msgs = formatDigest(many, [ed0], {
      year: 2026,
      publicWebUrl: 'https://t.example',
    });
    expect(msgs.length).toBeGreaterThan(1);
    const all = msgs.join('\n');
    expect(all.split('\n').filter(l => l.startsWith('• '))).toHaveLength(121);
    expect(all).not.toContain('more');
    for (const m of msgs) {
      expect(plain(m).length).toBeLessThanOrEqual(MAX_DIGEST_CHARS);
      // A message continuing a section starts with its heading again.
      expect(/^(🎸|🎪) <b>/.test(m)).toBe(true);
    }
    // A band split across messages gets its name repeated after the heading.
    for (const m of msgs.slice(1)) {
      const ls = m.split('\n');
      if (ls[0] === '🎸 <b>New shows</b>')
        expect(ls[1]).toMatch(/^<b>Band \d<\/b>$/);
    }
    // The links line closes the last message only.
    expect(msgs.at(-1)!.endsWith('Festivals</a>')).toBe(true);
    expect(msgs.slice(0, -1).some(m => m.includes('tours.html'))).toBe(false);
  });

  it('stays within the Telegram length limit with long fields', () => {
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
    const msgs = formatDigest(many, [], {
      year: 2026,
      publicWebUrl: 'https://t.example',
    });
    for (const m of msgs) expect(plain(m).length).toBeLessThanOrEqual(4096);
    expect(
      msgs
        .join('\n')
        .split('\n')
        .filter(l => l.startsWith('• '))
    ).toHaveLength(25);
  });

  it('never links a non-http url', () => {
    const [text] = formatDigest(
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
           start_time, category, created_at, act_name, act_url, festival_name, festival_url, alert_pending, held)
         VALUES (?, 'pk', 'sig', ?, ?, 13, 'u0000', 'u00000', ?, 'music', 'x', ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          id,
          o.title ?? id,
          o.lat ?? 45,
          o.start ?? '2026-11-14T21:00:00',
          o.act_name ?? null,
          o.act_url ?? null,
          o.festival_name ?? null,
          o.festival_url ?? null,
          o.pending ?? 1,
          o.held ?? 0
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

  it('does not send, claim or clear a held event; sends it once released', async () => {
    const s = await setup();
    const band = 'https://alpha.example';
    await s.addEvent('h1', {
      act_name: 'Alpha',
      act_url: band,
      lat: 45,
    });
    await s.addEvent('h2', {
      act_name: 'Alpha',
      act_url: band,
      lat: 50,
    });
    await reevaluateConflicts(s.env, band, '2026-11-14'); // holds both
    await s.DB.prepare(
      "UPDATE events SET alert_pending = 1 WHERE id = 'h1'"
    ).run();
    await s.addMember('anna', '1', 0, [band]);
    await sendAlertDigests(s.env, { fetchFn: s.fetchFn as any, today: TODAY });
    expect(s.sent).toEqual([]);
    const row = (await s.DB.prepare(
      "SELECT alert_pending AS p FROM events WHERE id = 'h1'"
    ).first()) as any;
    expect(row.p).toBe(1);

    await s.DB.prepare("DELETE FROM events WHERE id = 'h2'").run();
    await reevaluateConflicts(s.env, band, '2026-11-14');
    await sendAlertDigests(s.env, { fetchFn: s.fetchFn as any, today: TODAY });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].text).toContain('Alpha');
  });

  it('a held festival show does not make its festival known', async () => {
    const s = await setup();
    await s.addEvent('fh', {
      festival_url: 'https://fest.example',
      act_url: 'https://alpha.example',
      pending: 0,
      held: 1,
    });
    await s.addEvent('f1', {
      festival_name: 'Fest',
      festival_url: 'https://fest.example',
      start: '2026-11-15T00:00:00',
    });
    await s.addMember('bea', '2', 1, []);
    await sendAlertDigests(s.env, { fetchFn: s.fetchFn as any, today: TODAY });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].text).toContain('Fest');
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
  it('sends a long digest as several messages, all counted in the budget', async () => {
    const s = await setup();
    for (let i = 0; i < 300; i++)
      await s.addEvent('a' + i, {
        act_name: 'Alpha',
        act_url: 'https://alpha.example',
        start: `2027-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}T21:00:00`,
      });
    await s.addMember('anna', '1', 0, ['https://alpha.example']);
    const r = await sendAlertDigests(s.env, {
      fetchFn: s.fetchFn as any,
      today: TODAY,
    });
    expect(s.sent.length).toBeGreaterThan(1);
    expect(r.sent).toBe(s.sent.length);
    const items = s.sent
      .flatMap(m => m.text.split('\n'))
      .filter(l => l.startsWith('• '));
    expect(items).toHaveLength(300);
  });

  describe('admin chat', () => {
    const A = 'https://alpha.example';
    it('digest gives the admin chat every show and edition, even with no follows', async () => {
      const s = await setup();
      s.env.ADMIN_TELEGRAM_CHAT_ID = '999';
      await s.addEvent('a1', { act_name: 'Alpha', act_url: A });
      await s.addEvent('b1', {
        act_name: 'Beta',
        act_url: 'https://beta.example',
      });
      await s.addEvent('f1', {
        festival_name: 'Fest',
        festival_url: 'https://fest.example',
        start: '2027-06-18T00:00:00',
      });
      const r = await sendAlertDigests(s.env, {
        fetchFn: s.fetchFn as any,
        today: TODAY,
      });
      expect(r.sent).toBe(1);
      expect(s.sent).toHaveLength(1);
      expect(s.sent[0].chat_id).toBe('999');
      expect(s.sent[0].text).toContain('Alpha');
      expect(s.sent[0].text).toContain('Beta');
      expect(s.sent[0].text).toContain('Fest');
    });

    it('sends nothing to an admin when the var is unset', async () => {
      const s = await setup();
      await s.addEvent('a1', { act_name: 'Alpha', act_url: A });
      await sendAlertDigests(s.env, {
        fetchFn: s.fetchFn as any,
        today: TODAY,
      });
      expect(s.sent).toHaveLength(0);
    });

    it('member digests are unchanged', async () => {
      const s = await setup();
      s.env.ADMIN_TELEGRAM_CHAT_ID = '999';
      await s.addEvent('a1', { act_name: 'Alpha', act_url: A });
      await s.addEvent('b1', {
        act_name: 'Beta',
        act_url: 'https://beta.example',
      });
      await s.addMember('anna', '1', 0, [A]);
      await sendAlertDigests(s.env, {
        fetchFn: s.fetchFn as any,
        today: TODAY,
      });
      const anna = s.sent.find(m => m.chat_id === '1')!;
      expect(anna.text).toContain('Alpha');
      expect(anna.text).not.toContain('Beta');
      expect(s.sent.find(m => m.chat_id === '999')!.text).toContain('Beta');
    });

    it('a 403 from the admin chat leaves member chats intact', async () => {
      const s = await setup();
      s.env.ADMIN_TELEGRAM_CHAT_ID = '999';
      await s.addEvent('a1', { act_name: 'Alpha', act_url: A });
      await s.addMember('anna', '1', 0, [A]);
      await s.addMember('bea', '2', 0, [A]);
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const fetchFn = async (_u: string, init: any) => {
        const b = JSON.parse(init.body);
        s.sent.push({ chat_id: b.chat_id, text: b.text });
        return new Response('{}', { status: b.chat_id === '999' ? 403 : 200 });
      };
      await sendAlertDigests(s.env, { fetchFn: fetchFn as any, today: TODAY });
      err.mockRestore();
      const rows = (
        await s.DB.prepare(
          'SELECT telegram_chat_id FROM members ORDER BY pubkey'
        ).all<{ telegram_chat_id: string | null }>()
      ).results!;
      expect(rows.map(r => r.telegram_chat_id)).toEqual(['1', '2']);
    });

    it('is sent first when recipients exceed MAX_SENDS_PER_RUN', async () => {
      const s = await setup();
      s.env.ADMIN_TELEGRAM_CHAT_ID = '999';
      await s.addEvent('a1', { act_name: 'Alpha', act_url: A });
      for (let i = 0; i < MAX_SENDS_PER_RUN + 1; i++)
        await s.addMember('m' + i, String(i), 0, [A]);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await sendAlertDigests(s.env, {
        fetchFn: s.fetchFn as any,
        today: TODAY,
      });
      warn.mockRestore();
      expect(s.sent).toHaveLength(MAX_SENDS_PER_RUN);
      expect(s.sent[0].chat_id).toBe('999');
    });
  });
});

describe('notifyConflict', () => {
  const c = {
    actName: 'Fish & Chips',
    day: '2026-11-14',
    events: [
      {
        id: 'e1',
        title: 'Show <1>',
        start_time: '2026-11-14T21:00:00',
        venue_name: 'Club & Co',
        address: null,
        url: null,
      },
      {
        id: 'e2',
        title: 'Second',
        start_time: '2026-11-14T20:00:00',
        venue_name: null,
        address: 'Main St 1',
        url: null,
      },
    ],
  };
  const mk = (extra: Record<string, unknown> = {}) => {
    const calls: { url: string; body: any }[] = [];
    const fetchFn = async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response('{}', { status: 200 });
    };
    return {
      calls,
      fetchFn,
      env: { TELEGRAM_BOT_TOKEN: 'tok', ...extra } as any,
    };
  };

  it('sends nothing when ADMIN_TELEGRAM_CHAT_ID is unset', async () => {
    const m = mk();
    await notifyConflict(m.env, c, { fetchFn: m.fetchFn as any });
    expect(m.calls).toHaveLength(0);
  });

  it('sends nothing when the bot token is unset', async () => {
    const m = mk({
      ADMIN_TELEGRAM_CHAT_ID: '999',
      TELEGRAM_BOT_TOKEN: undefined,
    });
    await notifyConflict(m.env, c, { fetchFn: m.fetchFn as any });
    expect(m.calls).toHaveLength(0);
  });

  it('posts one escaped message naming band, day, titles and places', async () => {
    const m = mk({
      ADMIN_TELEGRAM_CHAT_ID: '999',
      ADMIN_PAGE_URL: 'https://admin.example/',
    });
    await notifyConflict(m.env, c, { fetchFn: m.fetchFn as any });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].url).toBe('https://api.telegram.org/bottok/sendMessage');
    const { chat_id, text } = m.calls[0].body;
    expect(chat_id).toBe('999');
    expect(text).toContain('Fish &amp; Chips');
    expect(text).toContain('2026-11-14');
    expect(text).toContain('Show &lt;1&gt;');
    expect(text).toContain('Club &amp; Co');
    expect(text).toContain('Second');
    expect(text).toContain('Main St 1');
    expect(text).toContain('Conflicts');
    expect(text).toContain('https://admin.example/');
  });

  it('omits the link without ADMIN_PAGE_URL and falls back without a band name', async () => {
    const m = mk({ ADMIN_TELEGRAM_CHAT_ID: '999' });
    await notifyConflict(
      m.env,
      { ...c, actName: null, events: c.events },
      { fetchFn: m.fetchFn as any }
    );
    expect(m.calls[0].body.text).not.toContain('href');
    expect(m.calls[0].body.text).toContain('Unnamed band');
  });

  it('never throws when the send fails', async () => {
    const m = mk({ ADMIN_TELEGRAM_CHAT_ID: '999' });
    const bad = async () => {
      throw new Error('boom');
    };
    await expect(
      notifyConflict(m.env, c, { fetchFn: bad as any })
    ).resolves.toBeUndefined();
  });
});

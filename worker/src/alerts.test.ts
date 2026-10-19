import { describe, it, expect } from 'vitest';
import {
  newEditions,
  digestFor,
  formatDigest,
  fmtAlertDate,
  fmtDayRange,
  MAX_DIGEST_LINES,
  type AlertEvent,
  type Recipient,
} from './alerts';

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

// Daily Telegram digest for tours members: new shows of followed bands and,
// with radar alerts on, newly announced festival editions. See
// worker/SPECS.md (Telegram alerts).

export interface AlertEvent {
  id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  venue_name: string | null;
  address: string | null;
  url: string | null;
  act_name: string | null;
  act_url: string | null;
  festival_name: string | null;
  festival_url: string | null;
}

export interface Recipient {
  pubkey: string;
  name: string;
  chat_id: string;
  radar: boolean;
  bands: string[]; // followed act_url values
}

export interface Edition {
  festival_url: string;
  name: string;
  start: string;
  end: string;
  place: string | null;
}

export const MAX_DIGEST_LINES = 25;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** The comparison key for band urls used by tours.html: lower-case, no trailing slash. */
export const bandKey = (u: string) => u.toLowerCase().replace(/\/+$/, '');

function parts(ts: string) {
  const y = Number(ts.slice(0, 4));
  const m = Number(ts.slice(5, 7));
  const d = Number(ts.slice(8, 10));
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { y, m, d, wd, time: ts.slice(11, 16) };
}

/** "Sat 14 Nov 21:00": time left out at midnight, year added when not `year`. */
export function fmtAlertDate(ts: string, year: number): string {
  const p = parts(ts);
  let s = `${DAYS[p.wd]} ${p.d} ${MONTHS[p.m - 1]}`;
  if (p.y !== year) s += ` ${p.y}`;
  if (p.time && p.time !== '00:00') s += ` ${p.time}`;
  return s;
}

/** "18 Jun 2027", "18–21 Jun 2027", "30 Jun – 2 Jul 2027", "30 Dec 2026 – 2 Jan 2027". */
export function fmtDayRange(start: string, end: string): string {
  const a = parts(start);
  const b = parts(end);
  const ma = MONTHS[a.m - 1];
  const mb = MONTHS[b.m - 1];
  if (start.slice(0, 10) >= end.slice(0, 10)) return `${a.d} ${ma} ${a.y}`;
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${ma} ${a.y}`;
  if (a.y === b.y) return `${a.d} ${ma} – ${b.d} ${mb} ${a.y}`;
  return `${a.d} ${ma} ${a.y} – ${b.d} ${mb} ${b.y}`;
}

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function link(url: string | null, label: string): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return `<a href="${esc(url)}">${label}</a>`;
}

/**
 * Festivals that gain an upcoming entry while having none already processed:
 * `known` holds the festival_url of every upcoming entry with alert_pending = 0.
 */
export function newEditions(
  pending: AlertEvent[],
  known: Set<string>
): Edition[] {
  const groups = new Map<string, AlertEvent[]>();
  for (const e of pending) {
    if (!e.festival_url || known.has(e.festival_url)) continue;
    const g = groups.get(e.festival_url) || [];
    g.push(e);
    groups.set(e.festival_url, g);
  }
  const out: Edition[] = [];
  for (const [festival_url, list] of groups) {
    list.sort((x, y) => (x.start_time < y.start_time ? -1 : 1));
    const first = list[0];
    const end = list
      .map(e => e.end_time || e.start_time)
      .reduce((m, t) => (t > m ? t : m));
    out.push({
      festival_url,
      name: list.find(e => e.festival_name)?.festival_name || first.title,
      start: first.start_time,
      end,
      place: first.venue_name || first.address || null,
    });
  }
  return out.sort((x, y) => (x.start < y.start ? -1 : 1));
}

/** What one member gets, or null when there is nothing for them. */
export function digestFor(
  r: Recipient,
  shows: AlertEvent[],
  editions: Edition[]
): { shows: AlertEvent[]; editions: Edition[] } | null {
  const followed = new Set(r.bands.map(bandKey));
  const mine = shows.filter(e => e.act_url && followed.has(bandKey(e.act_url)));
  const eds = r.radar ? editions : [];
  return mine.length || eds.length ? { shows: mine, editions: eds } : null;
}

/** The Telegram HTML message for one member. */
export function formatDigest(
  shows: AlertEvent[],
  editions: Edition[],
  opts: { year: number; publicWebUrl?: string }
): string {
  let used = 0;
  let omitted = 0;
  const take = () =>
    used < MAX_DIGEST_LINES ? (used++, true) : (omitted++, false);
  const blocks: string[] = [];

  if (shows.length) {
    const byBand = new Map<string, { name: string; list: AlertEvent[] }>();
    for (const e of shows) {
      const k = bandKey(e.act_url!);
      const b = byBand.get(k) || { name: e.act_name || e.act_url!, list: [] };
      b.list.push(e);
      byBand.set(k, b);
    }
    const lines = ['🎸 <b>New shows</b>'];
    const bands = [...byBand.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const b of bands) {
      b.list.sort((x, y) => (x.start_time < y.start_time ? -1 : 1));
      const items: string[] = [];
      for (const e of b.list) {
        if (!take()) continue;
        const place = [e.venue_name, e.address].filter(Boolean).join(', ');
        const bits = [fmtAlertDate(e.start_time, opts.year)];
        if (place) bits.push(esc(place));
        const a = link(e.url, 'page');
        if (a) bits.push(a);
        items.push('• ' + bits.join(' · '));
      }
      if (items.length) lines.push(`<b>${esc(b.name)}</b>`, ...items);
    }
    if (lines.length > 1) blocks.push(lines.join('\n'));
  }

  if (editions.length) {
    const lines = ['🎪 <b>New festival editions</b>'];
    for (const ed of editions) {
      if (!take()) continue;
      const bits = [`<b>${esc(ed.name)}</b>`, fmtDayRange(ed.start, ed.end)];
      if (ed.place) bits.push(esc(ed.place));
      const a = link(ed.festival_url, 'site');
      if (a) bits.push(a);
      lines.push('• ' + bits.join(' · '));
    }
    if (lines.length > 1) blocks.push(lines.join('\n'));
  }

  if (omitted) blocks.push(`…and ${omitted} more`);

  if (opts.publicWebUrl) {
    const base = opts.publicWebUrl.replace(/\/+$/, '');
    const links: string[] = [];
    if (shows.length)
      links.push(`<a href="${esc(base)}/tours.html">All shows</a>`);
    if (editions.length)
      links.push(`<a href="${esc(base)}/festivals.html">Festivals</a>`);
    blocks.push(links.join(' · '));
  }
  return blocks.join('\n\n');
}

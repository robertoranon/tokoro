// Daily Telegram digest for tours members: new shows of followed bands and,
// with radar alerts on, newly announced festival editions. See
// worker/SPECS.md (Telegram alerts).

import type { Env } from './index';
import { nowIso } from './members';

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
/** Visible-text budget; Telegram rejects messages over 4096 characters. */
export const MAX_DIGEST_CHARS = 3800;
/** Worker subrequest ceiling (50 on the free plan) minus DB and slack. */
export const MAX_SENDS_PER_RUN = 45;

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

const clip = (s: string, n = 80) =>
  s.length > n ? s.slice(0, n - 1) + '…' : s;

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
 * `known` holds the bandKey of the festival_url of every processed
 * entry (alert_pending = 0); expiry deletes old entries, so any left means the
 * edition is current.
 */
export function newEditions(
  pending: AlertEvent[],
  known: Set<string>
): Edition[] {
  const groups = new Map<string, AlertEvent[]>();
  for (const e of pending) {
    if (!e.festival_url) continue;
    const k = bandKey(e.festival_url);
    if (known.has(k)) continue;
    const g = groups.get(k) || [];
    g.push(e);
    groups.set(k, g);
  }
  const out: Edition[] = [];
  for (const list of groups.values()) {
    list.sort((x, y) => (x.start_time < y.start_time ? -1 : 1));
    const first = list[0];
    const festival_url = first.festival_url!;
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
  let chars = 0;
  let omitted = 0;
  const take = (cost: number) => {
    if (used < MAX_DIGEST_LINES && chars + cost <= MAX_DIGEST_CHARS) {
      used++;
      chars += cost;
      return true;
    }
    omitted++;
    return false;
  };
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
      const name = clip(b.name);
      for (const e of b.list) {
        const place = clip(
          [e.venue_name, e.address].filter(Boolean).join(', ')
        );
        const date = esc(
          e.end_time && e.end_time.slice(0, 10) > e.start_time.slice(0, 10)
            ? fmtDayRange(e.start_time, e.end_time)
            : fmtAlertDate(e.start_time, opts.year)
        );
        const a = link(e.url, 'page');
        const cost =
          2 +
          date.length +
          (place ? 3 + place.length : 0) +
          (a ? 7 : 0) +
          (items.length ? 0 : name.length + 1);
        if (!take(cost)) continue;
        const bits = [date];
        if (place) bits.push(esc(place));
        if (a) bits.push(a);
        items.push('• ' + bits.join(' · '));
      }
      if (items.length) lines.push(`<b>${esc(name)}</b>`, ...items);
    }
    if (lines.length > 1) blocks.push(lines.join('\n'));
  }

  if (editions.length) {
    const lines = ['🎪 <b>New festival editions</b>'];
    for (const ed of editions) {
      const name = clip(ed.name);
      const range = esc(fmtDayRange(ed.start, ed.end));
      const place = ed.place ? clip(ed.place) : '';
      const a = link(ed.festival_url, 'site');
      const cost =
        2 +
        name.length +
        3 +
        range.length +
        (place ? 3 + place.length : 0) +
        (a ? 7 : 0);
      if (!take(cost)) continue;
      const bits = [`<b>${esc(name)}</b>`, range];
      if (place) bits.push(esc(place));
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

export interface DigestOptions {
  fetchFn?: typeof fetch;
  today?: string; // "YYYY-MM-DDT00:00:00"; default: the current UTC date
  sleep?: (ms: number) => Promise<void>;
}

type SendResult = 'ok' | 'blocked' | 'error';

async function sendTelegram(
  fetchFn: typeof fetch,
  token: string,
  chatId: string,
  text: string,
  sleep: (ms: number) => Promise<void>
): Promise<SendResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
    } catch {
      return 'error';
    }
    if (res.ok) return 'ok';
    if (res.status === 403) return 'blocked';
    if (res.status === 429 && attempt === 0) {
      let wait = 1;
      try {
        const data = (await res.json()) as any;
        wait = Number(data?.parameters?.retry_after) || 1;
      } catch {}
      await sleep(Math.min(wait, 5) * 1000);
      continue;
    }
    return 'error';
  }
  return 'error';
}

async function loadRecipients(env: Env): Promise<Recipient[]> {
  const members =
    (
      await env.DB.prepare(
        `SELECT pubkey, name, telegram_chat_id, radar_alerts FROM members
         WHERE telegram_chat_id IS NOT NULL AND revoked_at IS NULL`
      ).all<{
        pubkey: string;
        name: string;
        telegram_chat_id: string;
        radar_alerts: number;
      }>()
    ).results || [];
  const follows =
    (
      await env.DB.prepare(
        `SELECT b.pubkey, b.act_url FROM member_bands b
         JOIN members m ON m.pubkey = b.pubkey
         WHERE m.telegram_chat_id IS NOT NULL AND m.revoked_at IS NULL`
      ).all<{ pubkey: string; act_url: string }>()
    ).results || [];
  const byMember = new Map<string, string[]>();
  for (const f of follows) {
    const l = byMember.get(f.pubkey) || [];
    l.push(f.act_url);
    byMember.set(f.pubkey, l);
  }
  return members.map(m => ({
    pubkey: m.pubkey,
    name: m.name,
    chat_id: m.telegram_chat_id,
    radar: m.radar_alerts === 1,
    bands: byMember.get(m.pubkey) || [],
  }));
}

/** The daily job: one digest per linked member, then every pending flag is cleared. */
export async function sendAlertDigests(
  env: Env,
  opts: DigestOptions = {}
): Promise<{ sent: number; cleared: number }> {
  if (!env.TELEGRAM_BOT_TOKEN) return { sent: 0, cleared: 0 };
  const fetchFn = opts.fetchFn ?? fetch;
  const today =
    opts.today ?? new Date().toISOString().slice(0, 10) + 'T00:00:00';
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));

  // Claim the flags first: events flagged while sending stay pending for tomorrow.
  await env.DB.prepare(
    'UPDATE events SET alert_pending = 2 WHERE alert_pending = 1'
  ).run();
  const pending =
    (
      await env.DB.prepare(
        `SELECT id, title, start_time, end_time, venue_name, address, url,
                act_name, act_url, festival_name, festival_url
         FROM events WHERE alert_pending = 2 AND start_time >= ?`
      )
        .bind(today)
        .all<AlertEvent>()
    ).results || [];
  const known = new Set(
    (
      (
        await env.DB.prepare(
          `SELECT DISTINCT festival_url FROM events
           WHERE alert_pending = 0 AND festival_url IS NOT NULL AND festival_url != ''`
        ).all<{ festival_url: string }>()
      ).results || []
    ).map(r => bandKey(r.festival_url))
  );
  const shows = pending.filter(e => e.act_url);
  const editions = newEditions(pending, known);
  const year = Number(today.slice(0, 4));

  let sent = 0;
  const targets = (await loadRecipients(env))
    .map(r => ({ r, d: digestFor(r, shows, editions) }))
    .filter(t => t.d);
  if (targets.length > MAX_SENDS_PER_RUN) {
    console.warn(
      `[alerts] ${targets.length} recipients exceed MAX_SENDS_PER_RUN; extra members are skipped this run`
    );
  }
  for (const { r, d: dg } of targets.slice(0, MAX_SENDS_PER_RUN)) {
    const d = dg!;
    const text = formatDigest(d.shows, d.editions, {
      year,
      publicWebUrl: env.PUBLIC_WEB_URL,
    });
    const result = await sendTelegram(
      fetchFn,
      env.TELEGRAM_BOT_TOKEN,
      r.chat_id,
      text,
      sleep
    );
    if (result === 'ok') sent++;
    else if (result === 'blocked') {
      await env.DB.prepare(
        'UPDATE members SET telegram_chat_id = NULL WHERE pubkey = ?'
      )
        .bind(r.pubkey)
        .run();
    } else {
      console.error(`[alerts] sending to ${r.pubkey.slice(0, 8)} failed`);
    }
  }

  const cleared = (
    await env.DB.prepare(
      'UPDATE events SET alert_pending = 0 WHERE alert_pending = 2'
    ).run()
  ).meta.changes;
  await env.DB.prepare('DELETE FROM telegram_link_codes WHERE expires_at < ?')
    .bind(nowIso())
    .run();
  return { sent, cleared };
}

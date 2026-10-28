import { normalizeName } from './tour-shows.js';

export type PlaylistFormat = 'apple-xml' | 'spotify-csv' | 'spotify-url';

export interface PlaylistArtists {
  format: PlaylistFormat;
  /** Artist names, most tracks first (ties keep playlist order). */
  artists: { name: string; tracks: number }[];
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X'
          ? parseInt(e.slice(2), 16)
          : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : m;
    }
    return XML_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Minimal CSV reader: quoted fields, doubled quotes, commas/newlines inside quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** "A feat. B" -> "A": the featured act is not the playlist's artist. */
function mainArtist(name: string): string {
  return name.replace(/\s+[([]?(?:feat\.?|featuring|ft\.?)\s.*$/i, '').trim();
}

function rank(names: string[]): { name: string; tracks: number }[] {
  const byKey = new Map<string, { name: string; tracks: number }>();
  for (const raw of names) {
    // '|' separates a site hint in the band list format.
    const name = raw
      .replace(/[|\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const key = normalizeName(name);
    if (!key) continue;
    const entry = byKey.get(key);
    if (entry) entry.tracks++;
    else byKey.set(key, { name, tracks: 1 });
  }
  // Array.prototype.sort is stable, so ties keep playlist order.
  return [...byKey.values()].sort((a, b) => b.tracks - a.tracks);
}

/**
 * Recognizes an Apple Music / iTunes XML playlist export or a Spotify CSV
 * export (Exportify) and returns its artists. Returns null for anything else
 * (the caller then treats the text as a plain band list).
 */
export function parsePlaylist(text: string): PlaylistArtists | null {
  const t = text.replace(/^﻿/, '');
  const head = t.trimStart();

  if (head.startsWith('<') && /<plist[\s>]/.test(t)) {
    const names: string[] = [];
    const re = /<key>Artist<\/key>\s*<string>([\s\S]*?)<\/string>/g;
    for (const m of t.matchAll(re)) names.push(mainArtist(decodeXml(m[1])));
    return { format: 'apple-xml', artists: rank(names) };
  }

  const firstLine = head.split(/\r?\n/, 1)[0];
  if (firstLine.includes(',') && /artist name/i.test(firstLine)) {
    const rows = parseCsv(head);
    const col = rows[0].findIndex(h => /^artist name/i.test(h.trim()));
    if (col === -1) return null;
    const names: string[] = [];
    for (const row of rows.slice(1)) {
      // Several artists on one track are separated by ';'. The first is the main one.
      const first = (row[col] ?? '').split(';')[0];
      names.push(mainArtist(first));
    }
    return { format: 'spotify-csv', artists: rank(names) };
  }

  return null;
}

/** Artists with at least `minTracks` tracks, as band-list text (one name per line). */
export function playlistToBandListText(
  p: PlaylistArtists,
  minTracks: number
): string {
  return p.artists
    .filter(a => a.tracks >= minTracks)
    .map(a => a.name)
    .join('\n');
}

/** The playlist id of an open.spotify.com playlist link (or spotify:playlist: URI), else null. */
export function spotifyPlaylistId(input: string): string | null {
  const s = input.trim();
  const uri = s.match(/^spotify:playlist:([A-Za-z0-9]+)$/);
  if (uri) return uri[1];
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.hostname !== 'open.spotify.com') return null;
    const m = u.pathname.match(/\/playlist\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Artists of a public Spotify playlist, read from its embed page (no
 * credentials needed). The embed page is unofficial and lists only the first
 * tracks (observed: at most 100), and gives each track's artists as one ", "-joined string,
 * of which the first is used.
 */
export async function fetchSpotifyPlaylist(
  input: string,
  fetchFn: typeof fetch = fetch
): Promise<PlaylistArtists> {
  const id = spotifyPlaylistId(input);
  if (!id) throw new Error(`Not a Spotify playlist link: ${input}`);
  const res = await fetchFn(`https://open.spotify.com/embed/playlist/${id}`, {
    headers: { 'user-agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(
      `Spotify returned HTTP ${res.status} for the playlist (is it public?)`
    );
  }
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  let trackList: unknown;
  try {
    trackList = JSON.parse(m![1]).props.pageProps.state.data.entity.trackList;
  } catch {
    throw new Error(
      'Could not read the playlist from Spotify (the page format may have changed). Export it with Exportify and pass the CSV instead.'
    );
  }
  if (!Array.isArray(trackList)) {
    throw new Error('The Spotify playlist has no track list.');
  }
  const names = trackList.map(t =>
    mainArtist(
      String((t as { subtitle?: unknown })?.subtitle ?? '').split(', ')[0]
    )
  );
  return { format: 'spotify-url', artists: rank(names) };
}

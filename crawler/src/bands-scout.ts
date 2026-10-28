import { fileURLToPath } from 'url';
import { createInterface } from 'readline/promises';
import { loadEnv, buildLLM } from './setup.js';
import { HTMLFetcher, type BrowserEngine } from './extractors/html-fetcher.js';
import { JinaFetcher } from './extractors/jina-fetcher.js';
import { parseBandList } from './tours/band-list.js';
import {
  fetchSpotifyPlaylist,
  parsePlaylist,
  playlistToBandListText,
  spotifyPlaylistId,
  type PlaylistArtists,
} from './tours/playlist.js';
import { parseBandsConfig, type BandsConfig } from './tours/bands-config.js';
import {
  appendBands,
  knownBandName,
  type NewBand,
} from './tours/bands-append.js';
import { findBand, type FinderDeps } from './tours/band-finder.js';
import { braveSearch } from './utils/brave-search.js';
import { assertNotBlocked } from './utils/block-page.js';
import { readIfExists, writeFileAtomic } from './scout/files.js';

export interface ScoutArgs {
  inputFile?: string;
  bandsFile: string;
  dryRun: boolean;
  fetcher: 'playwright' | 'jina';
  /** Playlist input only: skip artists with fewer tracks than this. */
  minTracks: number;
  /** Playlist input only: add every found band without asking. */
  yes: boolean;
}

export function parseArgs(argv: string[]): ScoutArgs {
  const args: ScoutArgs = {
    bandsFile: 'bands.yaml',
    dryRun: false,
    fetcher: 'playwright',
    minTracks: 1,
    yes: false,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--yes') args.yes = true;
    else if (a === '--bands') args.bandsFile = rest[++i] ?? '';
    else if (a === '--min-tracks') {
      const v = rest[++i];
      const n = Number(v);
      if (!v || !Number.isInteger(n) || n < 1) {
        throw new Error(
          `Invalid --min-tracks "${v}". Must be a whole number >= 1`
        );
      }
      args.minTracks = n;
    } else if (a === '--fetcher') {
      const v = rest[++i];
      if (v !== 'playwright' && v !== 'jina') {
        throw new Error(`Invalid --fetcher "${v}". Must be: playwright, jina`);
      }
      args.fetcher = v;
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown option ${a}`);
    } else if (args.inputFile === undefined) {
      args.inputFile = a;
    } else {
      throw new Error(`Unexpected argument ${a}`);
    }
  }
  if (!args.bandsFile) throw new Error('--bands needs a path');
  return args;
}

/**
 * Asks, band by band, whether to add it. Answers: y (yes), n or empty (no),
 * a (yes to this and all the rest), q (no to this and all the rest).
 */
export async function confirmBands(
  found: NewBand[],
  ask: (question: string) => Promise<string>
): Promise<{ accepted: NewBand[]; declined: string[] }> {
  const accepted: NewBand[] = [];
  const declined: string[] = [];
  let mode: 'ask' | 'all' | 'none' = 'ask';
  for (let i = 0; i < found.length; i++) {
    const b = found[i];
    if (mode === 'ask') {
      console.log(
        `\n${b.name}\n  site: ${b.url}\n  tour page: ${b.tourUrl ?? '(none found)'}\n  ${b.note}`
      );
      const answer = (
        await ask(
          `Add ${b.name} (${i + 1}/${found.length})? [y/N/a=all/q=quit] `
        )
      )
        .trim()
        .toLowerCase();
      if (answer === 'a' || answer === 'all') mode = 'all';
      else if (answer === 'q' || answer === 'quit') mode = 'none';
      else if (answer === 'y' || answer === 'yes') {
        accepted.push(b);
        continue;
      } else {
        declined.push(b.name);
        continue;
      }
    }
    if (mode === 'all') accepted.push(b);
    else declined.push(b.name);
  }
  return { accepted, declined };
}

export interface ScoutReport {
  dryRun: boolean;
  added: NewBand[];
  alreadyPresent: { name: string; existing: string }[];
  noSite: string[];
  notSearched: string[];
  errors: { name: string; error: string }[];
  sourceSkipped: { name: string; tourUrl: string }[];
  invalidLines: string[];
  /** Found, but the user declined to add them (playlist input). */
  declined: string[];
}

export function formatReport(r: ScoutReport): string {
  const out: string[] = [];
  if (r.dryRun) out.push('DRY RUN: nothing was written.\n');
  for (const b of r.added) {
    out.push(
      b.tourUrl
        ? `+ ${b.name} — ${b.url} — tour: ${b.tourUrl}`
        : `+ ${b.name} — ${b.url} — no tour page found (add a source by hand)`
    );
  }
  for (const s of r.sourceSkipped) {
    out.push(
      `  ${s.name}: tour page ${s.tourUrl} was already a source, not added again`
    );
  }
  if (r.alreadyPresent.length) {
    out.push('\nAlready in bands.yaml (skipped):');
    for (const a of r.alreadyPresent)
      out.push(`  - ${a.name} (matches ${a.existing})`);
  }
  if (r.noSite.length) {
    out.push(
      '\nNo site found (not added; try "Name | https://site" in the list):'
    );
    for (const n of r.noSite) out.push(`  - ${n}`);
  }
  if (r.notSearched.length) {
    out.push(
      '\nNot searched: set BRAVE_SEARCH_API_KEY, or give "Name | https://site":'
    );
    for (const n of r.notSearched) out.push(`  - ${n}`);
  }
  if (r.declined.length) {
    out.push('\nDeclined (not added):');
    for (const n of r.declined) out.push(`  - ${n}`);
  }
  if (r.errors.length) {
    out.push('\nErrors:');
    for (const e of r.errors) out.push(`  - ${e.name}: ${e.error}`);
  }
  if (r.invalidLines.length) {
    out.push('\nIgnored input lines:');
    for (const l of r.invalidLines) out.push(`  - ${l}`);
  }
  out.push(
    `\n${r.added.length} added, ${r.alreadyPresent.length} already present, ${r.noSite.length} no site, ${r.notSearched.length} not searched, ${r.errors.length} errors${r.declined.length ? `, ${r.declined.length} declined` : ''}`
  );
  return out.join('\n');
}

export const USAGE = `Usage: npm run bands-scout -- <input> [options]   (note the --)

Finds each band's official site and tour page, and adds the missing entries
to bands.yaml.

<input> is one of:
  bands.txt               one band per line; "Name | https://site" skips the search
  playlist.xml            Apple Music / iTunes XML playlist export
  playlist.csv            Spotify playlist exported with Exportify (all tracks)
  <spotify link>          public playlist, https://open.spotify.com/playlist/<id>
                          (only the first ~100 tracks; use the CSV for more)

Options:
  --bands <path>          bands.yaml to extend (default: bands.yaml, must exist)
  --dry-run               look everything up and report, but write nothing
  --min-tracks <n>        playlists only: skip artists with fewer than n tracks
  --yes                   playlists only: add every band found without asking
  --fetcher <engine>      playwright (default) or jina

With a playlist you are asked to confirm each band before it is added
(y / N / a = all / q = quit).

Needs: your LLM settings in .env, and BRAVE_SEARCH_API_KEY for bands without
a "| https://site" hint.

Examples:
  npm run bands-scout -- bands.txt --dry-run
  npm run bands-scout -- playlist.xml --min-tracks 2
  npm run bands-scout -- https://open.spotify.com/playlist/<id> --dry-run

Details: crawler/README.md, crawler/SPECS.md section 4.11`;

async function main() {
  await loadEnv();
  let args: ScoutArgs;
  try {
    args = parseArgs(process.argv);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  if (!args.inputFile) {
    console.error(USAGE);
    process.exit(1);
  }

  let playlist: PlaylistArtists | null = null;
  let listText: string | null = null;
  if (spotifyPlaylistId(args.inputFile)) {
    try {
      playlist = await fetchSpotifyPlaylist(args.inputFile);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  } else {
    listText = await readIfExists(args.inputFile);
    if (listText === null) {
      console.error(`Error: ${args.inputFile} not found.`);
      process.exit(1);
    }
    playlist = parsePlaylist(listText);
  }
  if (playlist && !args.dryRun && !args.yes && !process.stdin.isTTY) {
    console.error(
      'Error: a playlist needs your confirmation for each band, but this is not an interactive terminal. Run it in a terminal, or pass --yes to add every band found (or --dry-run to preview).'
    );
    process.exit(1);
  }
  const yamlText = await readIfExists(args.bandsFile);
  if (yamlText === null) {
    console.error(
      `Error: ${args.bandsFile} not found. Copy bands.example.yaml to bands.yaml first.`
    );
    process.exit(1);
  }
  let config: BandsConfig;
  try {
    config = parseBandsConfig(yamlText);
  } catch (error) {
    console.error(
      `Error reading ${args.bandsFile}: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }

  let listSource = listText ?? '';
  if (playlist) {
    listSource = playlistToBandListText(playlist, args.minTracks);
    const label = {
      'apple-xml': 'Apple Music/iTunes XML',
      'spotify-csv': 'Spotify CSV',
      'spotify-url': 'Spotify link',
    }[playlist.format];
    console.log(
      `Read ${label} playlist: ${playlist.artists.length} artists, ${listSource ? listSource.split('\n').length : 0} with at least ${args.minTracks} track(s).`
    );
  }
  const list = parseBandList(listSource);
  const report: ScoutReport = {
    dryRun: args.dryRun,
    added: [],
    alreadyPresent: [],
    noSite: [],
    notSearched: [],
    errors: [],
    sourceSkipped: [],
    invalidLines: list.invalid,
    declined: [],
  };

  // Names already in bands.yaml need no search at all.
  const todo = list.bands.filter(b => {
    const existing = knownBandName(config, b.name);
    if (existing === undefined) return true;
    report.alreadyPresent.push({ name: b.name, existing });
    return false;
  });

  const found: NewBand[] = [];
  // The LLM and the fetcher are only set up when there is something to look up.
  if (todo.length > 0) {
    const braveKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!braveKey && todo.some(b => !b.hint)) {
      console.warn(
        'BRAVE_SEARCH_API_KEY is not set: bands without a "| https://site" hint cannot be searched.'
      );
    }

    let llm: FinderDeps['llm'];
    try {
      llm = buildLLM();
    } catch (error) {
      console.error(
        `Error: cannot set up the LLM: ${error instanceof Error ? error.message : error}. Configure LLM_PROVIDER / the API key in .env (defaults: shared/llm/defaults.ts).`
      );
      process.exit(1);
    }

    const browser = (process.env.BROWSER_ENGINE as BrowserEngine) || 'chrome';
    const fetcher =
      args.fetcher === 'jina'
        ? new JinaFetcher(process.env.JINA_API_KEY)
        : new HTMLFetcher(browser);
    const deps: FinderDeps = {
      llm,
      search: braveKey ? braveSearch(braveKey) : undefined,
      fetchPage: async (url: string) =>
        assertNotBlocked(await fetcher.fetchPage(url)),
    };

    await fetcher.initialize();
    try {
      for (let i = 0; i < todo.length; i++) {
        const b = todo[i];
        console.log(`\n[${i + 1}/${todo.length}] ${b.name}`);
        const o = await findBand(b, deps);
        console.log(`→ ${o.status}`);
        if (o.status === 'found') {
          found.push({
            name: o.name,
            url: o.siteUrl,
            tourUrl: o.tourUrl,
            note: o.note,
          });
        } else if (o.status === 'no_tour_page') {
          found.push({ name: o.name, url: o.siteUrl, note: o.note });
        } else if (o.status === 'no_site') report.noSite.push(o.name);
        else if (o.status === 'not_searched') report.notSearched.push(o.name);
        else report.errors.push({ name: o.name, error: o.error });
      }
    } finally {
      await fetcher.close();
    }
  }

  // Playlist input finds many bands the user never named, so each one is
  // confirmed before it is written (a dry run writes nothing, so no questions).
  let toAdd = found;
  if (playlist && !args.dryRun && !args.yes && found.length > 0) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const r = await confirmBands(found, q => rl.question(q));
      toAdd = r.accepted;
      report.declined = r.declined;
    } finally {
      rl.close();
    }
  }

  try {
    const result = appendBands(
      yamlText,
      toAdd,
      new Date().toISOString().slice(0, 10)
    );
    report.added = result.added;
    report.sourceSkipped = result.sourceSkipped;
    for (const s of result.skipped) {
      report.alreadyPresent.push({ name: s.name, existing: s.existing });
    }
    if (!args.dryRun && result.added.length > 0) {
      await writeFileAtomic(args.bandsFile, result.text);
    }
  } catch (error) {
    console.error(
      `\nError: ${error instanceof Error ? error.message : error}\nNothing was changed.`
    );
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}\n${formatReport(report)}`);
}

// Only run when executed directly, not when imported as a module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

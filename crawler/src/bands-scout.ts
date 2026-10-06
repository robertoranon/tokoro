import { fileURLToPath } from 'url';
import { loadEnv, buildLLM } from './setup.js';
import { HTMLFetcher, type BrowserEngine } from './extractors/html-fetcher.js';
import { JinaFetcher } from './extractors/jina-fetcher.js';
import { parseBandList } from './tours/band-list.js';
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
}

export function parseArgs(argv: string[]): ScoutArgs {
  const args: ScoutArgs = {
    bandsFile: 'bands.yaml',
    dryRun: false,
    fetcher: 'playwright',
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--bands') args.bandsFile = rest[++i] ?? '';
    else if (a === '--fetcher') {
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

export interface ScoutReport {
  dryRun: boolean;
  added: NewBand[];
  alreadyPresent: { name: string; existing: string }[];
  noSite: string[];
  notSearched: string[];
  errors: { name: string; error: string }[];
  sourceSkipped: { name: string; tourUrl: string }[];
  invalidLines: string[];
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
  if (r.errors.length) {
    out.push('\nErrors:');
    for (const e of r.errors) out.push(`  - ${e.name}: ${e.error}`);
  }
  if (r.invalidLines.length) {
    out.push('\nIgnored input lines:');
    for (const l of r.invalidLines) out.push(`  - ${l}`);
  }
  out.push(
    `\n${r.added.length} added, ${r.alreadyPresent.length} already present, ${r.noSite.length} no site, ${r.notSearched.length} not searched, ${r.errors.length} errors`
  );
  return out.join('\n');
}

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
    console.error(
      'Usage: npm run bands-scout -- <bands.txt> [--bands bands.yaml] [--dry-run] [--fetcher playwright|jina]'
    );
    process.exit(1);
  }

  const listText = await readIfExists(args.inputFile);
  if (listText === null) {
    console.error(`Error: ${args.inputFile} not found.`);
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

  const list = parseBandList(listText);
  const report: ScoutReport = {
    dryRun: args.dryRun,
    added: [],
    alreadyPresent: [],
    noSite: [],
    notSearched: [],
    errors: [],
    sourceSkipped: [],
    invalidLines: list.invalid,
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

  try {
    const result = appendBands(
      yamlText,
      found,
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

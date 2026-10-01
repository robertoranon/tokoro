import { fileURLToPath } from 'url';
import { HTMLFetcher, type BrowserEngine } from './extractors/html-fetcher.js';
import { JinaFetcher } from './extractors/jina-fetcher.js';
import { loadEnv, buildLLM } from './setup.js';
import { isDebugRequested } from './utils/debug-flag.js';
import { appendRunLog, defaultLogsDir } from './utils/run-log.js';
import { parseFestivalsConfig } from './radar/festivals-config.js';
import {
  parseScoutConfig,
  type ScoutConfig,
  type ScoutSource,
} from './scout/sources-config.js';
import {
  candidateKeys,
  knownKeysFromFestivals,
  parseCandidates,
  parseState,
  serializeCandidates,
  serializeState,
  type Candidate,
  type RawCandidate,
  type ScoutState,
} from './scout/candidates.js';
import { extractLinks } from './scout/links.js';
import { ScoutExtractor } from './scout/scout-extractor.js';
import { scoutSources, summarizeScout } from './scout/run.js';
import { pathArg, readIfExists, writeFileAtomic } from './scout/files.js';

async function main() {
  const startedAt = new Date();
  await loadEnv();

  const sourcesFile = pathArg('--sources', 'scout-sources.yaml');
  const candidatesFile = pathArg('--candidates', 'candidates.yaml');
  const stateFile = pathArg('--state', 'scout-state.json');
  const festivalsFile = pathArg('--festivals', 'festivals.yaml');
  const { debug, fromNpm } = isDebugRequested(process.argv, process.env);
  if (fromNpm) {
    console.log(
      'Note: --debug was picked up from npm (npm_config_debug). Use "npm run scout -- --debug" next time.'
    );
  }

  // Fail fast on malformed config, before any fetching.
  const sourcesText = await readIfExists(sourcesFile);
  if (sourcesText === null) {
    console.error(
      `Error: ${sourcesFile} not found. Copy scout-sources.example.yaml to scout-sources.yaml and edit it.`
    );
    process.exit(1);
  }
  let config: ScoutConfig;
  let existing: Candidate[];
  let state: ScoutState;
  let known: Set<string>;
  try {
    config = parseScoutConfig(sourcesText);
    existing = parseCandidates((await readIfExists(candidatesFile)) ?? '');
    state = parseState((await readIfExists(stateFile)) ?? '');

    const festivalsText = await readIfExists(festivalsFile);
    if (festivalsText === null) {
      console.warn(
        `Warning: ${festivalsFile} not found — festivals already on your watchlist cannot be filtered out.`
      );
    }
    known = knownKeysFromFestivals(
      festivalsText === null
        ? []
        : parseFestivalsConfig(festivalsText).festivals
    );
    for (const c of existing) for (const k of candidateKeys(c)) known.add(k);
  } catch (error) {
    console.error(
      `Error reading scout files: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }

  if (config.sources.length === 0) {
    console.warn(`No sources in ${sourcesFile} — nothing to do`);
    process.exit(0);
  }

  // The scout needs no signing keys and never talks to the Tokoro API.
  const jinaKey = process.env.JINA_API_KEY;
  const today = new Date().toISOString().slice(0, 10);
  const defaultBrowser =
    (process.env.BROWSER_ENGINE as BrowserEngine) || 'chrome';
  console.log(
    `Scout: ${config.sources.length} source(s)${debug ? ' (DEBUG: no files are written)' : ''}. The scout never publishes anything.`
  );

  const scoutOne = async (source: ScoutSource): Promise<RawCandidate[]> => {
    const fetcher =
      source.fetcher === 'jina'
        ? new JinaFetcher(jinaKey)
        : new HTMLFetcher(source.browser ?? defaultBrowser);
    await fetcher.initialize();
    try {
      const page = await fetcher.fetchPage(source.url);
      const extractor = new ScoutExtractor({
        llm: buildLLM(source.model),
        referenceDate: today,
      });
      return await extractor.extract(page, extractLinks(page), {
        taste: config.taste,
        sourceName: source.name,
      });
    } finally {
      await fetcher.close();
    }
  };

  const result = await scoutSources({
    sources: config.sources,
    scoutOne,
    existing,
    state,
    known,
    today,
  });
  const summary = summarizeScout(result.outcomes);
  const added = result.candidates.slice(existing.length);

  console.log(
    `\nScout complete: ${summary.candidates_found} found, ${summary.candidates_new} new, ${summary.sources_failed} of ${summary.sources_total} source(s) failed`
  );
  for (const c of added) {
    console.log(
      `  + ${c.name}${c.url ? ` — ${c.url}` : ' (no url yet)'}${c.dates_hint ? ` — ${c.dates_hint}` : ''}\n      ${c.why}`
    );
  }

  if (debug) {
    console.log('\n(debug: nothing was written)');
  } else {
    // State first: if the second write fails, nothing is proposed twice.
    await writeFileAtomic(stateFile, serializeState(result.state));
    await writeFileAtomic(
      candidatesFile,
      serializeCandidates(result.candidates)
    );
    if (added.length > 0) {
      console.log(
        `\nReview ${candidatesFile}: set status to approved or rejected, then run: npm run scout-promote`
      );
    }
    const finishedAt = new Date();
    await appendRunLog(defaultLogsDir(), {
      kind: 'scout',
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_s:
        Math.round(((finishedAt.getTime() - startedAt.getTime()) / 1000) * 10) /
        10,
      status:
        summary.sources_failed === 0
          ? 'ok'
          : summary.sources_failed === summary.sources_total
            ? 'failed'
            : 'partial',
      ...summary,
      sources: result.outcomes,
    });
  }

  if (summary.sources_failed > 0) process.exit(1);
}

// Only run when executed directly, not when imported as a module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

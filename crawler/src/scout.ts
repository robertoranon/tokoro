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
import { scoutSources, summarizeScout, mergeForWrite } from './scout/run.js';
import { pathArg, readIfExists, writeFileAtomic } from './scout/files.js';

async function main() {
  const startedAt = new Date();
  await loadEnv();

  const sourcesFile = pathArg('--sources', 'scout-sources.yaml');
  const candidatesFile = pathArg('--candidates', 'candidates.yaml');
  const stateFile = pathArg('--state', 'scout-state.json');
  const festivalsFile = pathArg('--festivals', 'festivals.yaml');
  const logsDir = pathArg('--logs-dir', defaultLogsDir());
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
  let excludeNames: string[];
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
    const festivals =
      festivalsText === null
        ? []
        : parseFestivalsConfig(festivalsText).festivals;
    known = knownKeysFromFestivals(festivals);
    // Names the LLM should not return again: watchlist, inbox and everything
    // ever proposed (the `n:` state keys), deduplicated.
    excludeNames = [
      ...new Set([
        ...festivals.map(f => f.name ?? ''),
        ...existing.map(c => c.name),
        ...Object.keys(state)
          .filter(k => k.startsWith('n:'))
          .map(k => k.slice(2)),
      ]),
    ].filter(Boolean);
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

  // Fail before fetching anything if the LLM cannot be set up. Per-source
  // models still go through buildLLM(source.model) below.
  try {
    buildLLM();
  } catch (error) {
    console.error(
      `Error: cannot set up the LLM: ${error instanceof Error ? error.message : error}. Configure LLM_PROVIDER / the API key in .env (defaults: shared/llm/defaults.ts).`
    );
    process.exit(1);
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
        excludeNames,
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
    if (added.length > 0) {
      // The run can take minutes; re-read the files and merge, so edits or a
      // scout-promote done meanwhile are never reverted.
      const merged = mergeForWrite(
        {
          candidates: parseCandidates(
            (await readIfExists(candidatesFile)) ?? ''
          ),
          state: parseState((await readIfExists(stateFile)) ?? ''),
        },
        { added, state: result.state }
      );
      // Inbox first, then state: if the second write fails, the new candidates
      // are in the inbox and their keys are re-added to `known` on the next
      // run, so nothing is proposed twice.
      await writeFileAtomic(
        candidatesFile,
        serializeCandidates(merged.candidates)
      );
      await writeFileAtomic(stateFile, serializeState(merged.state));
      console.log(
        `\nReview ${candidatesFile}: set status to approved or rejected, then run: npm run scout-promote`
      );
    }
    const finishedAt = new Date();
    await appendRunLog(logsDir, {
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

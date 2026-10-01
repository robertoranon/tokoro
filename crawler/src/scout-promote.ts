import { fileURLToPath } from 'url';
import { parseFestivalsConfig } from './radar/festivals-config.js';
import {
  knownKeysFromFestivals,
  parseCandidates,
  parseState,
  serializeCandidates,
  serializeState,
} from './scout/candidates.js';
import { promoteCandidates, type PromoteResult } from './scout/promote.js';
import { pathArg, readIfExists, writeFileAtomic } from './scout/files.js';

async function main() {
  const candidatesFile = pathArg('--candidates', 'candidates.yaml');
  const stateFile = pathArg('--state', 'scout-state.json');
  const festivalsFile = pathArg('--festivals', 'festivals.yaml');

  const festivalsText = await readIfExists(festivalsFile);
  if (festivalsText === null) {
    console.error(
      `Error: ${festivalsFile} not found. Copy festivals.example.yaml to festivals.yaml first.`
    );
    process.exit(1);
  }
  const candidatesText = await readIfExists(candidatesFile);
  if (candidatesText === null) {
    console.error(
      `Error: ${candidatesFile} not found. Run npm run scout first.`
    );
    process.exit(1);
  }

  let result: PromoteResult;
  try {
    result = promoteCandidates({
      candidates: parseCandidates(candidatesText),
      festivalsText,
      knownUrlKeys: knownKeysFromFestivals(
        parseFestivalsConfig(festivalsText).festivals
      ),
      state: parseState((await readIfExists(stateFile)) ?? ''),
      today: new Date().toISOString().slice(0, 10),
    });
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : error}\nNothing was changed.`
    );
    process.exit(1);
  }

  // Order matters: watchlist first, then state, then the inbox. If we crash
  // part-way, a re-run is harmless (already-known candidates are recognized).
  if (result.promoted.length > 0) {
    await writeFileAtomic(festivalsFile, result.festivalsText);
  }
  await writeFileAtomic(stateFile, serializeState(result.state));
  await writeFileAtomic(candidatesFile, serializeCandidates(result.candidates));

  console.log(
    `Promoted ${result.promoted.length} to ${festivalsFile}, rejected ${result.rejected.length}, already on the watchlist ${result.alreadyKnown.length}.`
  );
  for (const c of result.promoted) console.log(`  + ${c.name} — ${c.url}`);
  if (result.needsUrl.length > 0) {
    console.log(
      `\n${result.needsUrl.length} approved candidate(s) have no url yet — add one in ${candidatesFile}, then run this again:`
    );
    for (const c of result.needsUrl) console.log(`  - ${c.name}`);
  }
}

// Only run when executed directly, not when imported as a module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

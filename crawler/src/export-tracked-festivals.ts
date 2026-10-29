import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseFestivalsConfig } from './radar/festivals-config.js';
import {
  buildTrackedFestivals,
  yearInUrlWarnings,
} from './radar/tracked-festivals.js';
import { readIfExists, writeFileAtomic } from './scout/files.js';

export interface ExportArgs {
  festivals: string;
  out: string;
}

export function parseExportArgs(argv: string[]): ExportArgs {
  let festivals = 'festivals.yaml';
  let out = '';
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--festivals') festivals = rest[++i] ?? '';
    else if (a === '--out') out = rest[++i] ?? '';
    else throw new Error(`Unknown option ${a}`);
  }
  if (!festivals) throw new Error('--festivals needs a path');
  if (!out) throw new Error('--out <file> is required');
  return { festivals, out };
}

async function main() {
  let args: ExportArgs;
  try {
    args = parseExportArgs(process.argv);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    console.error(
      'Usage: npm run export-festivals -- --out <tracked-festivals.json> [--festivals festivals.yaml]'
    );
    process.exit(1);
  }
  const text = await readIfExists(path.resolve(args.festivals));
  if (text === null) {
    console.error(`Error: ${args.festivals} not found.`);
    process.exit(1);
  }
  let json: string;
  let count: number;
  try {
    const config = parseFestivalsConfig(text);
    for (const w of yearInUrlWarnings(config)) console.warn(w);
    const tracked = buildTrackedFestivals(
      config,
      new Date().toISOString().slice(0, 10)
    );
    count = tracked.festivals.length;
    json = JSON.stringify(tracked, null, 2) + '\n';
  } catch (error) {
    console.error(
      `Error reading ${args.festivals}: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }
  await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
  await writeFileAtomic(path.resolve(args.out), json);
  console.log(`Exported ${count} tracked festival(s) to ${args.out}`);
}

// Only run when executed directly, not when imported as a module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseBandsConfig } from './tours/bands-config.js';
import { buildTrackedBands } from './tours/tracked-bands.js';
import { readIfExists, writeFileAtomic } from './scout/files.js';

export interface ExportArgs {
  bands: string;
  out: string;
}

export function parseExportArgs(argv: string[]): ExportArgs {
  let bands = 'bands.yaml';
  let out = '';
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--bands') bands = rest[++i] ?? '';
    else if (a === '--out') out = rest[++i] ?? '';
    else throw new Error(`Unknown option ${a}`);
  }
  if (!bands) throw new Error('--bands needs a path');
  if (!out) throw new Error('--out <file> is required');
  return { bands, out };
}

async function main() {
  let args: ExportArgs;
  try {
    args = parseExportArgs(process.argv);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    console.error(
      'Usage: npm run export-bands -- --out <tracked-bands.json> [--bands bands.yaml]'
    );
    process.exit(1);
  }
  const text = await readIfExists(path.resolve(args.bands));
  if (text === null) {
    console.error(`Error: ${args.bands} not found.`);
    process.exit(1);
  }
  let json: string;
  let count: number;
  try {
    const tracked = buildTrackedBands(
      parseBandsConfig(text),
      new Date().toISOString().slice(0, 10)
    );
    count = tracked.bands.length;
    json = JSON.stringify(tracked, null, 2) + '\n';
  } catch (error) {
    console.error(
      `Error reading ${args.bands}: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }
  await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
  await writeFileAtomic(path.resolve(args.out), json);
  console.log(`Exported ${count} tracked band(s) to ${args.out}`);
}

// Only run when executed directly, not when imported as a module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

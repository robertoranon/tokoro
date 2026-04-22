#!/usr/bin/env node

/**
 * Duplicate detection test: runs event extraction on each HTML fixture and checks
 * that no duplicate events (same title + start_time) appear in a single extraction.
 *
 * Usage:
 *   npm run test:dedup
 *   npm run test:dedup -- --fixtures alcatraz-autechre-event,naon-event
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { HTMLFetcher } from '../src/extractors/html-fetcher.js';
import { EventExtractor } from '../src/extractors/event-extractor.js';
import { createLLMProvider } from '../../shared/llm/factory.js';
import { TestFixtureMetadata } from './types.js';

async function loadEnv() {
  try {
    const envPath = path.join(process.cwd(), '.env');
    const content = await fs.readFile(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length) {
          process.env[key.trim()] = valueParts.join('=').trim();
        }
      }
    }
  } catch {
    console.warn('No .env file found, using environment variables');
  }
}

async function main() {
  await loadEnv();

  const fixturesDir = path.join(process.cwd(), 'tests', 'fixtures');
  const args = process.argv.slice(2);

  // Parse --fixtures flag
  let fixtureFilter: string[] | undefined;
  const fixturesIndex = args.indexOf('--fixtures');
  if (fixturesIndex !== -1 && args[fixturesIndex + 1]) {
    fixtureFilter = args[fixturesIndex + 1].split(',').map(f => f.trim());
  }

  // Load HTML fixtures
  const files = await fs.readdir(fixturesDir);
  const metadataFiles = files.filter(f => f.endsWith('.metadata.json'));

  const fixtures: Array<{
    name: string;
    metadata: TestFixtureMetadata;
    htmlPath: string;
  }> = [];
  for (const metadataFile of metadataFiles) {
    const name = metadataFile.replace('.metadata.json', '');
    if (fixtureFilter && !fixtureFilter.includes(name)) continue;

    const metadata: TestFixtureMetadata = JSON.parse(
      await fs.readFile(path.join(fixturesDir, metadataFile), 'utf-8')
    );

    if (!metadata.htmlFile) continue; // image-only fixtures not applicable
    fixtures.push({
      name,
      metadata,
      htmlPath: path.join(fixturesDir, metadata.htmlFile),
    });
  }

  if (fixtures.length === 0) {
    console.log('No HTML fixtures found.');
    process.exit(0);
  }

  console.log(
    `\n🔍 Duplicate detection test (${fixtures.length} fixture(s))\n`
  );

  const provider = (process.env.LLM_PROVIDER || 'ollama') as any;
  let passed = 0;
  let failed = 0;

  for (const fixture of fixtures) {
    process.stdout.write(`  ${fixture.name} ... `);

    try {
      const html = await fs.readFile(fixture.htmlPath, 'utf-8');
      const llm = createLLMProvider({
        provider,
        apiKey:
          process.env.OPENROUTER_API_KEY ||
          process.env.OPENAI_API_KEY ||
          process.env.ANTHROPIC_API_KEY,
        model: process.env.OPENROUTER_MODEL || process.env.LLM_MODEL,
        ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
      });
      const referenceDate =
        fixture.metadata.captureDate ??
        fixture.metadata.capturedAt.split('T')[0];
      const extractor = new EventExtractor({ llm, referenceDate });

      const processed = HTMLFetcher.processHtml(html, fixture.metadata.url);
      const events = await extractor.extractEvents({
        url: fixture.metadata.url,
        html,
        text: processed.text,
        title: processed.title,
      });

      const seen = new Set<string>();
      const dupes: string[] = [];

      for (const event of events) {
        const key = `${event.title.toLowerCase().trim()}|${event.start_time}`;
        if (seen.has(key)) {
          dupes.push(event.title);
        } else {
          seen.add(key);
        }
      }

      if (dupes.length === 0) {
        console.log(`✅ PASS  (${events.length} events, no duplicates)`);
        passed++;
      } else {
        console.log(
          `❌ FAIL  (${dupes.length} duplicate(s): ${dupes.map(t => `"${t}"`).join(', ')})`
        );
        failed++;
      }
    } catch (error) {
      console.log(
        `❌ ERROR  ${error instanceof Error ? error.message : String(error)}`
      );
      failed++;
    }
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

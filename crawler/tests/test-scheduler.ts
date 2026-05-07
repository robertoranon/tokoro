import { parseJobsConfig } from '../src/scheduler.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

console.log('\n=== parseJobsConfig tests ===\n');

console.log('Valid config with all fields:');
{
  const raw = `
cron: "0 9 * * *"
jobs:
  - name: "Test Job"
    urls:
      - https://example.com
    mode: direct
    fetcher: jina
    browser: chrome
    model: gpt-4o-mini
    date: "2026-05-01"
    max_tokens: 1000
    no_jsonld: true
    group_by_day: true
    pdf_parser: pdfjs
    debug: false
    normalize: false
`;
  const config = parseJobsConfig(raw);
  assert(config.jobs.length === 1, 'parses one job');
  assert(config.cron === '0 9 * * *', 'parses cron expression');
  assert(config.jobs[0].name === 'Test Job', 'job name');
  assert(config.jobs[0].urls[0] === 'https://example.com', 'url');
  assert(config.jobs[0].mode === 'direct', 'mode');
  assert(config.jobs[0].fetcher === 'jina', 'fetcher');
  assert(config.jobs[0].max_tokens === 1000, 'max_tokens');
  assert(config.jobs[0].no_jsonld === true, 'no_jsonld');
}

console.log('\nMissing jobs key:');
{
  let threw = false;
  try {
    parseJobsConfig('cron: "0 9 * * *"');
  } catch {
    threw = true;
  }
  assert(threw, 'throws for missing jobs key');
}

console.log('\nJob missing urls:');
{
  let threw = false;
  try {
    parseJobsConfig('jobs:\n  - name: "bad"');
  } catch {
    threw = true;
  }
  assert(threw, 'throws for job missing urls');
}

console.log('\nEmpty urls array:');
{
  let threw = false;
  try {
    parseJobsConfig('jobs:\n  - name: "bad"\n    urls: []');
  } catch {
    threw = true;
  }
  assert(threw, 'throws for empty urls array');
}

console.log('\nMultiple jobs, no names:');
{
  const raw = `
jobs:
  - urls:
      - https://site1.com
  - name: "Second"
    urls:
      - https://site2.com
      - https://site3.com
`;
  const config = parseJobsConfig(raw);
  assert(config.jobs.length === 2, 'parses two jobs');
  assert(config.jobs[0].name === undefined, 'first job has no name');
  assert(config.jobs[1].urls.length === 2, 'second job has two URLs');
}

console.log('\nInvalid mode:');
{
  let threw = false;
  try {
    parseJobsConfig(
      'jobs:\n  - urls:\n      - https://example.com\n    mode: badmode'
    );
  } catch {
    threw = true;
  }
  assert(threw, 'throws for invalid mode');
}

console.log('\nInvalid fetcher:');
{
  let threw = false;
  try {
    parseJobsConfig(
      'jobs:\n  - urls:\n      - https://example.com\n    fetcher: badfetcher'
    );
  } catch {
    threw = true;
  }
  assert(threw, 'throws for invalid fetcher');
}

console.log('\nInvalid browser:');
{
  let threw = false;
  try {
    parseJobsConfig(
      'jobs:\n  - urls:\n      - https://example.com\n    browser: badbrowser'
    );
  } catch {
    threw = true;
  }
  assert(threw, 'throws for invalid browser');
}

console.log('\nInvalid pdf_parser:');
{
  let threw = false;
  try {
    parseJobsConfig(
      'jobs:\n  - urls:\n      - https://example.com\n    pdf_parser: badparser'
    );
  } catch {
    threw = true;
  }
  assert(threw, 'throws for invalid pdf_parser');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

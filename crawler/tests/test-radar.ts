import {
  parseFestivalsConfig,
  normalizeFestivalUrl,
  activeFestivals,
} from '../src/radar/festivals-config.js';

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

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

console.log('\n=== normalizeFestivalUrl ===\n');
{
  assert(
    normalizeFestivalUrl('https://Fest.Example/') === 'https://fest.example',
    'lowercases host and strips trailing slash'
  );
  assert(
    normalizeFestivalUrl('https://fest.example/en/?utm=1#top') ===
      'https://fest.example/en',
    'drops query and hash, keeps path without trailing slash'
  );
  assert(
    normalizeFestivalUrl('http://fest.example:8080/x//') ===
      'http://fest.example:8080/x',
    'keeps port, strips repeated trailing slashes'
  );
  assert(
    throws(() => normalizeFestivalUrl('not a url')),
    'rejects garbage'
  );
  assert(
    throws(() => normalizeFestivalUrl('ftp://fest.example')),
    'rejects non-http(s) protocols'
  );
}

console.log('\n=== parseFestivalsConfig ===\n');
{
  const cfg = parseFestivalsConfig(`
defaults:
  fetcher: jina
festivals:
  - url: https://www.terraforma.example/
    name: Terraforma
    added: 2026-07-22
    notes: "forest setting"
  - url: https://jazz.example
    status: paused
    fetcher: playwright
    browser: obscura
    model: some-model
`);
  assert(cfg.festivals.length === 2, 'parses two festivals');
  const [a, b] = cfg.festivals;
  assert(a.url === 'https://www.terraforma.example', 'url is normalized');
  assert(a.status === 'active', 'status defaults to active');
  assert(
    a.added === '2026-07-22',
    'unquoted YAML date becomes YYYY-MM-DD string'
  );
  assert(a.fetcher === 'jina', 'defaults.fetcher applies when entry has none');
  assert(a.notes === 'forest setting', 'notes preserved');
  assert(b.status === 'paused', 'explicit status kept');
  assert(b.fetcher === 'playwright', 'entry fetcher overrides default');
  assert(
    b.browser === 'obscura' && b.model === 'some-model',
    'browser/model overrides'
  );
  assert(
    activeFestivals(cfg).length === 1 &&
      activeFestivals(cfg)[0].url === 'https://www.terraforma.example',
    'activeFestivals skips paused entries'
  );
}
{
  assert(
    parseFestivalsConfig('festivals: []').festivals.length === 0,
    'empty festivals list is valid'
  );
  assert(
    throws(() => parseFestivalsConfig('')),
    'empty file throws'
  );
  assert(
    throws(() => parseFestivalsConfig('defaults: {}')),
    'missing festivals throws'
  );
  assert(
    throws(() => parseFestivalsConfig('festivals:\n  - name: x')),
    'entry without url throws'
  );
  assert(
    throws(() => parseFestivalsConfig('festivals:\n  - url: nope')),
    'invalid url throws'
  );
  assert(
    throws(() =>
      parseFestivalsConfig(
        'festivals:\n  - url: https://a.example\n    status: weird'
      )
    ),
    'invalid status throws'
  );
  assert(
    throws(() =>
      parseFestivalsConfig(
        'festivals:\n  - url: https://a.example\n    fetcher: nope'
      )
    ),
    'invalid fetcher throws'
  );
  assert(
    throws(() =>
      parseFestivalsConfig('defaults:\n  browser: nope\nfestivals: []')
    ),
    'invalid default browser throws'
  );
  assert(
    throws(() =>
      parseFestivalsConfig(
        'festivals:\n  - url: https://a.example/\n  - url: https://a.example'
      )
    ),
    'duplicate urls (after normalization) throw'
  );
}

// --- add new test sections above this line ---

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

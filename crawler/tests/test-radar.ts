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

console.log('\n=== parseFestivalsConfig strictness ===\n');
{
  const one = (extra: string) =>
    parseFestivalsConfig('festivals:\n  - url: https://a.example\n' + extra);
  assert(
    throws(() => one('    name: 5')),
    'non-string name throws'
  );
  assert(
    throws(() => one('    notes: 5')),
    'non-string notes throws'
  );
  assert(
    throws(() => one('    model: 5')),
    'non-string model throws'
  );
  assert(
    throws(() => parseFestivalsConfig('defaults:\n  model: 5\nfestivals: []')),
    'non-string defaults.model throws'
  );
  assert(
    throws(() => one('    status: null')),
    'null status throws'
  );
  assert(
    one('').festivals[0].status === 'active',
    'absent status defaults to active'
  );
  assert(
    parseFestivalsConfig('festivals:').festivals.length === 0,
    'null festivals is an empty list'
  );
  assert(
    throws(() => parseFestivalsConfig('festivals: notalist')),
    'string festivals throws'
  );
  assert(
    throws(() => parseFestivalsConfig('festivals:\n  a: 1')),
    'object festivals throws'
  );
  assert(
    parseFestivalsConfig('festivals:\n  - url: https://Upper.Example/x/')
      .festivals[0].url === 'https://upper.example/x',
    'config entry url is normalized to lowercase host'
  );
  let msg = '';
  try {
    one('').festivals.length;
    parseFestivalsConfig('festivals:\n  - url: ftp://a.example');
  } catch (e) {
    msg = (e as Error).message;
  }
  assert(msg.includes('Unsupported protocol'), 'bad url error includes reason');
}

// --- add new test sections above this line ---

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

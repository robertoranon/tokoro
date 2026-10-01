import { parseScoutConfig } from '../src/scout/sources-config.js';

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

console.log('\n=== parseScoutConfig ===\n');
{
  const cfg = parseScoutConfig(`
taste: >
  Small festivals.
  Not arena.
sources:
  - name: Agg
    url: https://example.com/list?year=2026
    fetcher: jina
  - url: https://www.mag.example/best
    browser: obscura
    model: some-model
`);
  assert(
    cfg.taste === 'Small festivals. Not arena.',
    'folded taste is trimmed to one line'
  );
  assert(cfg.sources.length === 2, 'parses two sources');
  assert(cfg.sources[0].name === 'Agg', 'keeps the name');
  assert(
    cfg.sources[0].url === 'https://example.com/list?year=2026',
    'keeps the query string (source pages may need it)'
  );
  assert(cfg.sources[0].fetcher === 'jina', 'fetcher override');
  assert(
    cfg.sources[1].name === 'www.mag.example',
    'name defaults to the hostname'
  );
  assert(
    cfg.sources[1].browser === 'obscura' &&
      cfg.sources[1].model === 'some-model',
    'browser and model overrides'
  );
}
{
  assert(
    parseScoutConfig('taste: x\nsources:\n').sources.length === 0,
    'a bare `sources:` key is an empty list'
  );
  assert(
    throws(() => parseScoutConfig('')),
    'empty file throws'
  );
  assert(
    throws(() => parseScoutConfig('- a\n- b')),
    'root array throws'
  );
  assert(
    throws(() => parseScoutConfig('sources: []')),
    'missing taste throws'
  );
  assert(
    throws(() => parseScoutConfig('taste: "  "\nsources: []')),
    'blank taste throws'
  );
  assert(
    throws(() => parseScoutConfig('taste: x')),
    'missing sources key throws'
  );
  assert(
    throws(() => parseScoutConfig('taste: x\nsources: nope')),
    'non-array sources throws'
  );
  assert(
    throws(() => parseScoutConfig('taste: x\nsources:\n  - name: a')),
    'source without url throws'
  );
  assert(
    throws(() => parseScoutConfig('taste: x\nsources:\n  - url: not a url')),
    'invalid url throws'
  );
  assert(
    throws(() =>
      parseScoutConfig('taste: x\nsources:\n  - url: ftp://a.example')
    ),
    'non-http(s) url throws'
  );
  assert(
    throws(() =>
      parseScoutConfig(
        'taste: x\nsources:\n  - url: https://a.example\n    fetcher: nope'
      )
    ),
    'invalid fetcher throws'
  );
  assert(
    throws(() =>
      parseScoutConfig(
        'taste: x\nsources:\n  - url: https://a.example\n    browser: nope'
      )
    ),
    'invalid browser throws'
  );
  assert(
    throws(() =>
      parseScoutConfig(
        'taste: x\nsources:\n  - url: https://a.example\n    name: 5'
      )
    ),
    'non-string name throws'
  );
  assert(
    throws(() =>
      parseScoutConfig(
        'taste: x\nsources:\n  - url: https://a.example/x\n  - url: https://a.example/x'
      )
    ),
    'duplicate source urls throw'
  );
}

// --- add new test sections above this line ---

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

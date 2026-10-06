import { parseBandList } from '../src/tours/band-list.js';
import {
  appendBands,
  knownBandName,
  type NewBand,
} from '../src/tours/bands-append.js';
import { parseBandsConfig } from '../src/tours/bands-config.js';

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
void throws; // used by later sections

async function main() {
  console.log('\n=== parseBandList ===\n');
  {
    const r = parseBandList(
      [
        '﻿# my list',
        '',
        'Test Band',
        '  Sigur Rós  ',
        'Other Band | https://other.example/',
        'Hinted Band|https://hinted.example',
        'test band', // duplicate of the first (case-insensitive)
        'Sigur Ros', // duplicate (accent-insensitive)
        'Bad Hint | not a url',
        '   |https://nameless.example',
        '!!!',
        'Band # with hash',
      ].join('\n')
    );
    assert(
      r.bands.map(b => b.name).join(',') ===
        'Test Band,Sigur Rós,Other Band,Hinted Band,Band # with hash',
      'names kept in order, trimmed; comments/blank/BOM ignored'
    );
    assert(
      r.bands[2].hint === 'https://other.example/',
      'hint parsed and trimmed'
    );
    assert(
      r.bands[3].hint === 'https://hinted.example',
      'hint without spaces around |'
    );
    assert(r.bands[0].hint === undefined, 'no hint when absent');
    assert(
      r.duplicates.join(',') === 'test band,Sigur Ros',
      'in-file duplicates reported (first wins)'
    );
    assert(
      r.invalid.length === 3,
      'bad hint, empty name and name without letters are invalid'
    );
    assert(
      r.invalid.some(l => l.includes('Bad Hint')),
      'invalid lines are reported verbatim'
    );
    assert(parseBandList('').bands.length === 0, 'empty input → no bands');
    assert(
      parseBandList('\r\nA\r\nB\r\n').bands.length === 2,
      'CRLF line endings'
    );
  }

  console.log('\n=== appendBands ===\n');
  {
    const base = `# header comment
defaults:
  fetcher: playwright

# The registry
bands:
  - name: Test Band
    url: https://testband.example
    aliases: ["The Test Band"]
    # a curator note
    status: active

# The pages to read
sources:
  - url: https://testband.example/live
    mode: band
    band: Test Band
`;
    const nb = (over: Partial<NewBand> = {}): NewBand => ({
      name: 'New Band',
      url: 'https://newband.example',
      tourUrl: 'https://newband.example/live',
      note: 'bands-scout: test',
      ...over,
    });

    // adds a band and its source, keeping comments and section order
    {
      const r = appendBands(base, [nb()], '2030-10-07');
      const cfg = parseBandsConfig(r.text);
      assert(r.added.length === 1 && r.skipped.length === 0, 'one band added');
      assert(
        cfg.bands.length === 2 && cfg.sources.length === 2,
        'band and source present after re-parse'
      );
      assert(
        cfg.bands[1].name === 'New Band' && cfg.bands[1].added === '2030-10-07',
        'name and added date written'
      );
      assert(cfg.bands[1].notes === 'bands-scout: test', 'note written');
      assert(
        cfg.sources[1].mode === 'band' &&
          cfg.sources[1].url === 'https://newband.example/live',
        'band-mode source written'
      );
      for (const c of [
        '# header comment',
        '# The registry',
        '# a curator note',
        '# The pages to read',
      ]) {
        assert(r.text.includes(c), `comment kept: ${c}`);
      }
      const iNew = r.text.indexOf('New Band');
      assert(
        iNew > r.text.indexOf('# a curator note') &&
          iNew < r.text.indexOf('# The pages to read'),
        'new band lands at the end of the bands block, before the next section comment'
      );
      assert(
        r.text.indexOf('newband.example/live') >
          r.text.indexOf('band: Test Band'),
        'new source lands at the end of sources'
      );
      assert(
        r.text.endsWith('\n') && !r.text.endsWith('\n\n'),
        'exactly one trailing newline'
      );
    }

    // duplicates: by name, alias, accent-insensitive name, url, and within the batch
    {
      const r = appendBands(
        base,
        [
          nb({ name: 'test band', url: 'https://x1.example' }),
          nb({ name: 'The Test Band', url: 'https://x2.example' }),
          nb({ name: 'Different Name', url: 'https://testband.example/' }),
          nb({
            name: 'Fresh',
            url: 'https://fresh.example',
            tourUrl: undefined,
          }),
          nb({ name: 'FRESH', url: 'https://fresh2.example' }),
          nb({ name: 'Third', url: 'https://fresh.example' }),
        ],
        '2030-10-07'
      );
      assert(
        r.added.map(a => a.name).join() === 'Fresh',
        'only the genuinely new band is added'
      );
      assert(r.skipped.length === 5, 'five duplicates skipped');
      assert(
        r.skipped[0].reason === 'name' && r.skipped[0].existing === 'Test Band',
        'name duplicate names the existing band'
      );
      assert(r.skipped[1].reason === 'name', 'alias duplicate');
      assert(
        r.skipped[2].reason === 'url',
        'url duplicate (trailing slash ignored)'
      );
      assert(
        r.skipped[3].reason === 'name' && r.skipped[4].reason === 'url',
        'in-batch duplicates by name and by url'
      );
      const cfg = parseBandsConfig(r.text);
      assert(
        cfg.bands.length === 2 && cfg.sources.length === 1,
        'no source added for a band without a tour page'
      );
    }

    // a tour page already used as a source is not added twice
    {
      const r = appendBands(
        base,
        [nb({ tourUrl: 'https://testband.example/live/' })],
        '2030-10-07'
      );
      assert(r.added.length === 1, 'band still added');
      assert(
        r.sourceSkipped.length === 1 && r.sourceSkipped[0].name === 'New Band',
        'duplicate source reported'
      );
      assert(
        parseBandsConfig(r.text).sources.length === 1,
        'duplicate source not written'
      );
    }

    // nothing to add → text untouched
    {
      const r = appendBands(base, [nb({ name: 'Test Band' })], '2030-10-07');
      assert(
        r.text === base && r.added.length === 0,
        'unchanged text when nothing is added'
      );
    }

    // empty flow lists
    {
      const r = appendBands('bands: []\nsources: []\n', [nb()], '2030-10-07');
      const cfg = parseBandsConfig(r.text);
      assert(
        cfg.bands.length === 1 && cfg.sources.length === 1,
        'bands: [] and sources: [] converted to block form'
      );
      assert(!r.text.includes('[]'), 'no leftover []');
    }
    {
      const r = appendBands(
        'bands: [] # none yet\nsources:\n',
        [nb()],
        '2030-10-07'
      );
      assert(
        r.text.includes('bands: # none yet') &&
          parseBandsConfig(r.text).bands.length === 1,
        'trailing comment on a [] key is kept'
      );
    }

    // sources key absent
    {
      const r = appendBands(
        'bands:\n  - name: A\n    url: https://a.example\n',
        [nb()],
        '2030-10-07'
      );
      const cfg = parseBandsConfig(r.text);
      assert(
        cfg.bands.length === 2 && cfg.sources.length === 1,
        'missing sources: key is created'
      );
    }

    // bands key absent
    {
      const r = appendBands(
        'sources:\n  - url: https://s.example\n    mode: listing\n',
        [nb()],
        '2030-10-07'
      );
      const cfg = parseBandsConfig(r.text);
      assert(
        cfg.bands.length === 1 && cfg.sources.length === 2,
        'missing bands: key is created before sources'
      );
      assert(
        r.text.indexOf('bands:') < r.text.indexOf('sources:'),
        'bands precede sources'
      );
    }

    // special characters survive
    {
      const r = appendBands(
        base,
        [nb({ name: 'Sigur "Rós": the #1 band', note: 'a: b # c' })],
        '2030-10-07'
      );
      const cfg = parseBandsConfig(r.text);
      assert(
        cfg.bands[1].name === 'Sigur "Rós": the #1 band' &&
          cfg.bands[1].notes === 'a: b # c',
        'quotes, colons and # are escaped'
      );
    }

    // refuses to write something it cannot prove safe
    {
      assert(
        throws(() =>
          appendBands(
            'bands: [{name: A, url: "https://a.example"}]\nsources: []\n',
            [nb()],
            '2030-10-07'
          )
        ),
        'a non-empty flow-style list is refused (re-parse check)'
      );
      assert(
        throws(() => appendBands('not: [valid', [nb()], '2030-10-07')),
        'invalid input YAML is refused'
      );
    }
  }

  console.log('\n=== knownBandName ===\n');
  {
    const cfg = parseBandsConfig(
      'bands:\n  - name: Sigur Rós\n    url: https://sigur.example\n    aliases: ["SR"]\nsources:\n'
    );
    assert(
      knownBandName(cfg, 'sigur ros') === 'Sigur Rós',
      'accent/case-insensitive name'
    );
    assert(knownBandName(cfg, 'SR') === 'Sigur Rós', 'alias');
    assert(knownBandName(cfg, 'Nobody') === undefined, 'unknown');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

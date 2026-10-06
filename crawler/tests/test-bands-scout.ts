import { parseBandList } from '../src/tours/band-list.js';

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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

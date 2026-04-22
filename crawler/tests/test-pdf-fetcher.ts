import { isTextDense } from '../src/extractors/pdf-fetcher.js';

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

console.log('\n=== isTextDense tests ===\n');

console.log('empty string → sparse');
assert(!isTextDense(''), 'empty string is sparse');

console.log('\nwhitespace only → sparse');
assert(!isTextDense('   \n\t   '), 'whitespace-only is sparse');

console.log('\n199 non-whitespace chars → sparse');
assert(!isTextDense('a'.repeat(199)), '199 chars is sparse');

console.log('\n200 non-whitespace chars → dense');
assert(isTextDense('a'.repeat(200)), '200 chars is dense');

console.log('\n201 non-whitespace chars → dense');
assert(isTextDense('a'.repeat(201)), '201 chars is dense');

console.log('\n200 real chars embedded in lots of whitespace → dense');
assert(
  isTextDense('  \n' + 'a'.repeat(200) + '\n  '),
  '200 real chars + whitespace is dense'
);

console.log('\n199 real chars + 1000 whitespace chars → sparse');
assert(
  !isTextDense('a'.repeat(199) + ' '.repeat(1000)),
  '199 real chars + whitespace is sparse'
);

if (failed > 0) {
  console.error(`\n${passed} passed, ${failed} FAILED`);
  process.exit(1);
} else {
  console.log(`\n${passed} passed`);
}

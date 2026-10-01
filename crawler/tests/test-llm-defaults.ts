import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  DEFAULT_LLM_PROVIDER,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_MODELS,
  DEFAULT_OLLAMA_BASE_URL,
  defaultModelFor,
} from '../../shared/llm/defaults.js';
import { createLLMProvider } from '../../shared/llm/factory.js';

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

console.log('\n=== defaultModelFor ===\n');
for (const p of ['openrouter', 'openai', 'anthropic', 'ollama'] as const) {
  assert(
    defaultModelFor(p) === DEFAULT_LLM_MODELS[p],
    `defaultModelFor('${p}') returns config value`
  );
}
assert(defaultModelFor('nope') === undefined, 'unknown provider -> undefined');
assert(
  defaultModelFor('toString') === undefined,
  'Object.prototype key -> undefined'
);
assert(
  DEFAULT_LLM_MODEL === DEFAULT_LLM_MODELS[DEFAULT_LLM_PROVIDER],
  'DEFAULT_LLM_MODEL matches default provider'
);
assert(DEFAULT_OLLAMA_BASE_URL.startsWith('http'), 'ollama base URL is set');

console.log('\n=== createLLMProvider uses defaults ===\n');
assert(
  createLLMProvider({ apiKey: 'x' }).name === DEFAULT_LLM_MODEL,
  'no provider/model -> DEFAULT_LLM_MODEL'
);
assert(
  createLLMProvider({ provider: 'openrouter', apiKey: 'x' }).name ===
    DEFAULT_LLM_MODELS.openrouter,
  'openrouter default model'
);
assert(
  createLLMProvider({ provider: 'openai', apiKey: 'x' }).name ===
    DEFAULT_LLM_MODELS.openai,
  'openai default model'
);
assert(
  createLLMProvider({ provider: 'anthropic', apiKey: 'x' }).name ===
    DEFAULT_LLM_MODELS.anthropic,
  'anthropic default model'
);
assert(
  createLLMProvider({ provider: 'ollama' }).name === DEFAULT_LLM_MODELS.ollama,
  'ollama default model'
);
assert(
  createLLMProvider({ apiKey: 'x', model: 'custom/model' }).name ===
    'custom/model',
  'explicit model overrides'
);

console.log(
  '\n=== source guard: defaults live only in shared/llm/defaults.ts ===\n'
);
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const dirs = [
  'shared',
  'crawler/src',
  'crawler/tests',
  'worker/src',
  'worker/scripts',
  'crawler-worker/src',
];
const skipDirs = new Set(['node_modules', 'snapshots', 'benchmark-results']);
const skipFiles = new Set([
  path.join(root, 'shared/llm/defaults.ts'),
  fileURLToPath(import.meta.url), // this guard names the literals it forbids
]);

function walk(dir: string, out: string[]) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walk(full, out);
    } else if (entry.name.endsWith('.ts') && !skipFiles.has(full)) {
      out.push(full);
    }
  }
}

const files: string[] = [];
for (const d of dirs) walk(path.join(root, d), files);

const forbidden = [
  'gpt-6-luna',
  'gpt-4o-mini',
  'claude-3-5-sonnet-20241022',
  'llama3.1',
  "|| 'ollama'",
  "|| 'openrouter'",
  "?? 'openrouter'",
];
const violations: string[] = [];
for (const file of files) {
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      for (const f of forbidden) {
        if (line.includes(f))
          violations.push(
            `${path.relative(root, file)}:${i + 1} contains ${f}`
          );
      }
    });
}
assert(files.length > 10, `scanned ${files.length} files`);
for (const v of violations) console.error(`    ${v}`);
assert(
  violations.length === 0,
  'no hard-coded LLM defaults outside shared/llm/defaults.ts'
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

import { extractAddressFromSearchPage } from '../src/utils/normalizer.js';
import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMResponse,
} from '../../shared/types/llm.js';
import type { FetchedPage } from '../src/extractors/html-fetcher.js';

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

function makePage(text: string): FetchedPage {
  return { url: 'https://example.com', html: '', text, title: 'Search' };
}

function makeLlm(returnAddress: string): LLMProvider {
  return {
    name: 'stub',
    async complete(
      _messages: LLMMessage[],
      _opts?: LLMOptions
    ): Promise<LLMResponse> {
      return { content: returnAddress, model: 'stub' };
    },
  };
}

console.log('\n=== extractAddressFromSearchPage tests ===\n');

console.log('Returns address from LLM response');
{
  const page = makePage('Berghain is at Am Wriezener Bahnhof, 10243 Berlin');
  const llm = makeLlm('Am Wriezener Bahnhof, 10243 Berlin');
  const result = await extractAddressFromSearchPage(page, 'Berghain', llm);
  assert(result === 'Am Wriezener Bahnhof, 10243 Berlin', `got: "${result}"`);
}

console.log('\nTrims whitespace from LLM response');
{
  const page = makePage('Some venue at 1 Main St, Portland');
  const llm = makeLlm('  1 Main St, Portland  \n');
  const result = await extractAddressFromSearchPage(page, 'Some Venue', llm);
  assert(result === '1 Main St, Portland', `got: "${result}"`);
}

console.log('\nReturns empty string when LLM finds nothing');
{
  const page = makePage('No address info here');
  const llm = makeLlm('');
  const result = await extractAddressFromSearchPage(page, 'Unknown Venue', llm);
  assert(result === '', `got: "${result}"`);
}

console.log('\nTruncates long page text to 4000 chars before sending to LLM');
{
  let capturedText = '';
  const longText = 'x'.repeat(10000);
  const page = makePage(longText);
  const llm: LLMProvider = {
    name: 'capture',
    async complete(messages: LLMMessage[]): Promise<LLMResponse> {
      const userMsg = messages.find(m => m.role === 'user');
      capturedText =
        typeof userMsg?.content === 'string' ? userMsg.content : '';
      return { content: '', model: 'capture' };
    },
  };
  await extractAddressFromSearchPage(page, 'Test Venue', llm);
  assert(
    capturedText.includes('x'.repeat(4000)),
    'page text included up to 4000 chars'
  );
  assert(
    !capturedText.includes('x'.repeat(4001)),
    'page text not longer than 4000 chars'
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

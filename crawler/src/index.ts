#!/usr/bin/env node

import * as fs from 'fs/promises';
import * as path from 'path';
import { EventCrawler, CrawlerMode, FetcherType } from './crawler.js';
import { createLLMProvider } from '../../shared/llm/factory.js';
import * as ed from '@noble/ed25519';

// Configure SHA-512 for Node.js
if (typeof crypto !== 'undefined' && crypto.subtle) {
  ed.etc.sha512Async = async (...m) => {
    const buffer = await crypto.subtle.digest('SHA-512', m[0] as BufferSource);
    return new Uint8Array(buffer);
  };
}

async function loadEnv() {
  // Simple .env loader
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
  } catch (error) {
    console.warn('No .env file found, using environment variables');
  }
}

async function generateKeypair() {
  console.log('Generating new Ed25519 keypair...\n');

  const privKey = ed.utils.randomPrivateKey();
  const pubKey = await ed.getPublicKeyAsync(privKey);

  const privkeyHex = Array.from(privKey)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  const pubkeyHex = Array.from(pubKey)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  console.log('Add these to your .env file:\n');
  console.log(`CRAWLER_PRIVKEY=${privkeyHex}`);
  console.log(`CRAWLER_PUBKEY=${pubkeyHex}\n`);

  process.exit(0);
}

async function loadSeedUrls(seedFile: string): Promise<string[]> {
  const content = await fs.readFile(seedFile, 'utf-8');
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

async function main() {
  const args = process.argv.slice(2);

  // Generate keypair mode
  if (args.includes('--generate-keypair')) {
    await generateKeypair();
    return;
  }

  // Load .env
  await loadEnv();

  // Parse mode flag
  let mode: CrawlerMode = 'direct'; // default

  // Check for --image shorthand flag first
  if (args.includes('--image')) {
    mode = 'image';
  }

  // Check for --pdf shorthand flag
  if (args.includes('--pdf')) {
    mode = 'pdf';
  }

  // Check for --mode flag (overrides --image if both are present)
  const modeIndex = args.indexOf('--mode');
  if (modeIndex !== -1 && args[modeIndex + 1]) {
    const modeArg = args[modeIndex + 1];
    if (
      modeArg === 'direct' ||
      modeArg === 'discover' ||
      modeArg === 'image' ||
      modeArg === 'festival' ||
      modeArg === 'pdf'
    ) {
      mode = modeArg;
    } else {
      console.error(
        `Error: Invalid mode "${modeArg}". Must be "direct", "discover", "image", "festival", or "pdf"`
      );
      process.exit(1);
    }
  }

  // Parse fetcher flag
  let fetcher: FetcherType = 'playwright'; // default
  const fetcherIndex = args.indexOf('--fetcher');
  if (fetcherIndex !== -1 && args[fetcherIndex + 1]) {
    const fetcherArg = args[fetcherIndex + 1];
    if (fetcherArg === 'playwright' || fetcherArg === 'jina') {
      fetcher = fetcherArg;
    } else {
      console.error(
        `Error: Invalid fetcher "${fetcherArg}". Must be "playwright" or "jina"`
      );
      process.exit(1);
    }
  }

  // Parse text-file flag (debug mode: skip fetching, pass file content directly to LLM)
  let textFilePath: string | undefined;
  const textFileIndex = args.indexOf('--text-file');
  if (textFileIndex !== -1 && args[textFileIndex + 1]) {
    textFilePath = args[textFileIndex + 1];
  }

  // Parse debug flag
  const debug = args.includes('--debug');

  // Parse --normalize flag (only meaningful with --debug: run full normalization even in debug mode)
  const normalize = args.includes('--normalize');

  // Parse --group-by-day flag
  const groupByDay = args.includes('--group-by-day');

  // Parse --no-jsonld flag
  const useJsonLd = !args.includes('--no-jsonld');

  // Parse model flag
  let model: string | undefined;
  const modelIndex = args.indexOf('--model');
  if (modelIndex !== -1 && args[modelIndex + 1]) {
    model = args[modelIndex + 1];
  }
  model = model || process.env.OPENROUTER_MODEL || process.env.LLM_MODEL;

  // Parse max-tokens flag (override output token budget for LLM extraction)
  let maxTokensOverride: number | undefined;
  const maxTokensIndex = args.indexOf('--max-tokens');
  if (maxTokensIndex !== -1 && args[maxTokensIndex + 1]) {
    const parsed = parseInt(args[maxTokensIndex + 1], 10);
    if (isNaN(parsed) || parsed <= 0) {
      console.error(
        `Error: Invalid --max-tokens value "${args[maxTokensIndex + 1]}". Must be a positive integer.`
      );
      process.exit(1);
    }
    maxTokensOverride = parsed;
  }

  // Parse date flag (optional reference date for LLM, format: YYYY-MM-DD)
  let referenceDate: string | undefined;
  const dateIndex = args.indexOf('--date');
  if (dateIndex !== -1 && args[dateIndex + 1]) {
    referenceDate = args[dateIndex + 1];
    // Validate date format (basic check)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)) {
      console.error(
        `Error: Invalid date format "${referenceDate}". Expected YYYY-MM-DD`
      );
      process.exit(1);
    }
  }

  // Get seed URLs (filter out --mode, --fetcher, --debug, --image, --pdf, --model, --date and their values)
  let urls: string[] = [];
  const urlArgs = args.filter((arg, i) => {
    // Skip --mode, --fetcher, --debug, --image, --pdf, --model, --date flags and their values
    if (arg === '--mode' || (i > 0 && args[i - 1] === '--mode')) {
      return false;
    }
    if (arg === '--fetcher' || (i > 0 && args[i - 1] === '--fetcher')) {
      return false;
    }
    if (arg === '--model' || (i > 0 && args[i - 1] === '--model')) {
      return false;
    }
    if (arg === '--date' || (i > 0 && args[i - 1] === '--date')) {
      return false;
    }
    if (arg === '--max-tokens' || (i > 0 && args[i - 1] === '--max-tokens')) {
      return false;
    }
    if (arg === '--text-file' || (i > 0 && args[i - 1] === '--text-file')) {
      return false;
    }
    if (
      arg === '--debug' ||
      arg === '--no-jsonld' ||
      arg === '--normalize' ||
      arg === '--group-by-day'
    ) {
      return false;
    }
    if (arg === '--image') {
      return false;
    }
    if (arg === '--pdf') {
      return false;
    }
    return !arg.startsWith('--');
  });

  if (textFilePath) {
    // text-file mode: no URLs needed
  } else if (urlArgs.length > 0) {
    // URLs from command line
    urls = urlArgs;
  } else {
    // Load from seeds.txt
    const seedFile = path.join(process.cwd(), 'seeds.txt');
    try {
      urls = await loadSeedUrls(seedFile);
      console.log(`Loaded ${urls.length} URLs from seeds.txt`);
    } catch (error) {
      console.error('Error: No URLs provided and seeds.txt not found');
      console.log('\nUsage:');
      console.log(
        '  npm run crawl <url1> <url2> ...                      # Crawl specific URLs'
      );
      console.log(
        '  npm run crawl -- --mode direct <url>                 # Direct extraction (no link following)'
      );
      console.log(
        '  npm run crawl -- --mode discover <url>               # Discover & extract (default)'
      );
      console.log(
        '  npm run crawl -- --image <file|url>                  # Extract events from image flyer/poster (shorthand for --mode image)'
      );
      console.log(
        '  npm run crawl -- --mode image <file|url>             # Extract events from image (alternative syntax)'
      );
      console.log(
        '  npm run crawl -- --pdf <file|url>                    # Extract events from PDF (shorthand for --mode pdf)'
      );
      console.log(
        '  npm run crawl -- --mode pdf <file|url>               # Extract events from PDF'
      );
      console.log(
        '  npm run crawl -- --mode festival <url>                # Festival mode: discover program pages + extract all events'
      );
      console.log(
        '  npm run crawl -- --fetcher jina <url>                # Use Jina AI Reader (faster, no browser)'
      );
      console.log(
        '  npm run crawl -- --fetcher playwright <url>          # Use Playwright + clean HTML (default)'
      );
      console.log(
        '  npm run crawl -- --model <model-name> <url>          # Use specific OpenRouter model (overrides .env)'
      );
      console.log(
        '  npm run crawl -- --date <YYYY-MM-DD> <url>           # Use specific reference date for extraction (default: today)'
      );
      console.log(
        '  npm run crawl -- --max-tokens <N> <url>              # Override output token budget (default: auto-scaled from content length)'
      );
      console.log(
        '  npm run crawl -- --debug <url>                       # Debug mode: print raw LLM output, skip normalization/geocoding'
      );
      console.log(
        '  npm run crawl -- --debug --normalize <url>           # Debug mode: run full normalization (geocoding) but skip publishing'
      );
      console.log(
        '  npm run crawl -- --no-jsonld <url>                   # Disable JSON-LD extraction, use LLM only'
      );
      console.log(
        '  npm run crawl -- --group-by-day <url>                # Group extracted events into one per calendar day'
      );
      console.log(
        '  npm run crawl -- --text-file <path>                  # Skip fetching, pass text file directly to LLM (debug prompt testing)'
      );
      console.log(
        '  npm run crawl                                        # Crawl URLs from seeds.txt'
      );
      console.log(
        '  npm run crawl -- --generate-keypair                  # Generate new keypair'
      );
      process.exit(1);
    }
  }

  if (!textFilePath && urls.length === 0) {
    console.error('Error: No URLs to crawl');
    process.exit(1);
  }

  // Validate configuration
  const provider = (process.env.LLM_PROVIDER || 'ollama') as any;
  const apiUrl = process.env.TOKORO_API_URL || 'http://localhost:8787';
  const privkey = process.env.CRAWLER_PRIVKEY;
  const pubkey = process.env.CRAWLER_PUBKEY;
  const jinaKey = process.env.JINA_API_KEY; // Optional

  if (!privkey || !pubkey) {
    console.error(
      'Error: CRAWLER_PRIVKEY and CRAWLER_PUBKEY must be set in .env'
    );
    console.log('Run: npm run crawl -- --generate-keypair');
    process.exit(1);
  }

  // Create LLM provider
  const apiKey =
    process.env.OPENROUTER_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY;
  const llm = createLLMProvider({
    provider,
    apiKey,
    model,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
  });
  console.log(`LLM Provider: ${provider}`);
  console.log(`LLM Model: ${llm.name}`);

  // Create crawler
  const crawler = new EventCrawler({
    llm,
    keypair: { privkey, pubkey },
    apiUrl,
    mode,
    fetcher,
    jinaKey,
    debug,
    normalize,
    referenceDate,
    useJsonLd,
    maxTokens: maxTokensOverride,
    groupByDay,
  });

  // Start crawling
  if (textFilePath) {
    const resolvedPath = path.resolve(textFilePath);
    const text = await fs.readFile(resolvedPath, 'utf-8');
    await crawler.crawlTextFile(resolvedPath, text);
  } else {
    await crawler.crawl(urls);
  }
}

main().catch(console.error);

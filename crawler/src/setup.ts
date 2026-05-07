import * as fs from 'fs/promises';
import * as path from 'path';
import * as ed from '@noble/ed25519';
import { createLLMProvider } from '../../shared/llm/factory.js';
import { LLMProvider } from '../../shared/types/llm.js';

// Configure SHA-512 for Node.js (required by @noble/ed25519)
if (typeof crypto !== 'undefined' && crypto.subtle) {
  ed.etc.sha512Async = async (...m) => {
    const buffer = await crypto.subtle.digest('SHA-512', m[0] as BufferSource);
    return new Uint8Array(buffer);
  };
}

export async function loadEnv(): Promise<void> {
  try {
    const envPath = path.join(process.cwd(), '.env');
    const content = await fs.readFile(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length) {
          const k = key.trim();
          if (!process.env[k]) {
            process.env[k] = valueParts.join('=').trim();
          }
        }
      }
    }
  } catch {
    console.warn('No .env file found, using environment variables');
  }
}

export interface CrawlerEnv {
  privkey: string;
  pubkey: string;
  apiUrl: string;
  jinaKey: string | undefined;
}

export function loadCrawlerEnv(): CrawlerEnv {
  const privkey = process.env.CRAWLER_PRIVKEY;
  const pubkey = process.env.CRAWLER_PUBKEY;

  if (!privkey || !pubkey) {
    console.error(
      'Error: CRAWLER_PRIVKEY and CRAWLER_PUBKEY must be set in .env'
    );
    console.log('Run: npm run crawl -- --generate-keypair');
    process.exit(1);
  }

  return {
    privkey,
    pubkey,
    apiUrl: process.env.TOKORO_API_URL || 'http://localhost:8787',
    jinaKey: process.env.JINA_API_KEY,
  };
}

export function buildLLM(modelOverride?: string): LLMProvider {
  const provider = process.env.LLM_PROVIDER || 'ollama';
  const apiKey =
    process.env.OPENROUTER_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY;
  const model =
    modelOverride || process.env.OPENROUTER_MODEL || process.env.LLM_MODEL;

  const llm = createLLMProvider({
    provider,
    apiKey,
    model,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
  });

  console.log(`LLM Provider: ${provider}`);
  console.log(`LLM Model: ${llm.name}`);

  return llm;
}

/**
 * Tokoro Crawler Worker — extraction only.
 *
 * Extracts, geocodes, and normalises events from URLs.
 * Returns PreparedEvent[] for the client to sign and publish.
 *
 * Endpoints:
 * - POST /crawl   — extract events (requires API key)
 * - POST /extract-text — debug: LLM-only extraction from plain text
 * - GET /         — API info
 */

import { validateApiKey, unauthorizedResponse } from './auth';
import { WorkerCrawler } from './crawler-adapter';
import { createLLMProvider } from '../../shared/llm/factory';
import { EventExtractor } from './event-extractor';
import type { Env, CrawlRequest, CrawlResponse, ExtractTextRequest } from './types';
import { extractCleanText } from '../../shared/extractors/html-cleaner';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === 'GET' && path === '/') {
        return jsonResponse({
          name: 'Tokoro Crawler Worker',
          version: '2.0.0',
          description: 'Event extraction service. Returns PreparedEvent[] for client-side signing.',
          endpoints: {
            'GET /': { description: 'API info and health check' },
            'POST /crawl': {
              description: 'Extract events from a URL (requires API key). Returns PreparedEvent[] — client signs and publishes.',
              headers: { Authorization: 'Bearer <api_key>' },
              body: {
                url: 'URL to crawl (required)',
                mode: '"direct", "discover", or "image" (default: discover)',
                html: 'Optional rendered HTML from Chrome extension',
                title: 'Optional page title from Chrome extension',
                imageData: 'Base64 image data (required for mode=image)',
                imageMimeType: 'MIME type e.g. "image/jpeg" (optional, for mode=image)',
              },
            },
            'POST /extract-text': {
              description: 'Debug: LLM-only extraction from plain text (requires API key)',
              headers: { Authorization: 'Bearer <api_key>' },
              body: {
                text: 'Clean text content (required)',
                url: 'Optional source URL',
                title: 'Optional page title',
                referenceDate: 'Optional reference date YYYY-MM-DD',
              },
            },
          },
        });
      }

      if (request.method === 'POST' && path === '/crawl') {
        return await handleCrawl(request, env);
      }

      if (request.method === 'POST' && path === '/extract-text') {
        return await handleExtractText(request, env);
      }

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (error) {
      console.error('Error:', error);
      return jsonResponse({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }, 500);
    }
  },
};

async function handleCrawl(request: Request, env: Env): Promise<Response> {
  const authResult = validateApiKey(request, env.CRAWLER_API_KEYS);
  if (!authResult.authorized) {
    return unauthorizedResponse(authResult.error || 'Unauthorized');
  }

  let body: CrawlRequest;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body', message: 'Request body must be valid JSON' }, 400);
  }

  if (!body.url) {
    return jsonResponse({ error: 'Missing required field', message: 'The "url" field is required' }, 400);
  }

  try {
    new URL(body.url);
  } catch {
    return jsonResponse({ error: 'Invalid URL', message: 'The "url" field must be a valid URL' }, 400);
  }

  const mode = body.mode || 'discover';
  if (mode !== 'direct' && mode !== 'discover' && mode !== 'image') {
    return jsonResponse({ error: 'Invalid mode', message: 'mode must be "direct", "discover", or "image"' }, 400);
  }

  if (mode === 'image' && !body.imageData) {
    return jsonResponse({ error: 'Missing required field', message: '"imageData" is required when mode is "image"' }, 400);
  }

  try {
    const crawler = new WorkerCrawler({
      env,
      mode,
      providedHtml: body.html,
      providedTitle: body.title,
      imageData: body.imageData,
      imageMimeType: body.imageMimeType,
    });

    const result = await crawler.crawl(body.url);

    const response: CrawlResponse = {
      success: true,
      message: 'Extraction complete',
      stats: {
        urls_processed: result.urls_processed,
        events_extracted: result.events_extracted,
      },
      events: result.events,
    };

    if (body.html) {
      response.cleaned_text = extractCleanText(body.html).text;
    }

    if (result.dropped_events && result.dropped_events.length > 0) {
      response.dropped_events = result.dropped_events;
    }

    return jsonResponse(response, 200);
  } catch (error) {
    console.error('Crawl error:', error);
    return jsonResponse({
      success: false,
      error: 'Crawl failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
}

async function handleExtractText(request: Request, env: Env): Promise<Response> {
  const authResult = validateApiKey(request, env.CRAWLER_API_KEYS);
  if (!authResult.authorized) return unauthorizedResponse(authResult.error || 'Unauthorized');

  let body: ExtractTextRequest;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body', message: 'Request body must be valid JSON' }, 400);
  }

  if (!body.text) return jsonResponse({ error: 'Missing required field', message: '"text" is required' }, 400);

  if (body.referenceDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.referenceDate)) {
    return jsonResponse({ error: 'Invalid referenceDate', message: 'Expected format: YYYY-MM-DD' }, 400);
  }

  const llm = createLLMProvider({ provider: env.LLM_PROVIDER, apiKey: env.LLM_API_KEY!, model: env.LLM_MODEL });
  const extractor = new EventExtractor({ llm, referenceDate: body.referenceDate });

  const page = { url: body.url || 'about:blank', html: '', text: body.text, title: body.title || 'Untitled' };
  const events = await extractor.extractEvents(page);
  return jsonResponse({ model: llm.name, events });
}

function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/**
 * Tokoro Crawler Worker
 *
 * Remote crawler service that extracts events from URLs via authenticated API requests
 * and publishes them to the Tokoro API.
 *
 * Endpoints:
 * - POST /crawl - Submit a crawl job (requires API key authentication)
 * - POST /extract-text - Debug: LLM-only extraction from plain text (bypasses JSON-LD)
 * - GET / - API info and health check
 */

import { validateApiKey, unauthorizedResponse } from './auth';
import { WorkerCrawler } from './crawler-adapter';
import { createLLMProvider } from '../../shared/llm/factory';
import { EventExtractor } from './event-extractor';
import type { Env, CrawlRequest, CrawlResponse, ExtractTextRequest } from './types';
import { extractCleanText } from '../../shared/extractors/html-cleaner';

// CORS headers for all responses
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: CORS_HEADERS,
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Route: GET / (API info)
      if (request.method === 'GET' && path === '/') {
        return jsonResponse({
          name: 'Tokoro Crawler Worker',
          version: '1.0.0',
          description: 'Remote crawler service for extracting events from URLs',
          endpoints: {
            'GET /': {
              description: 'API info and health check',
            },
            'POST /crawl': {
              description: 'Submit a crawl job (requires API key authentication)',
              headers: {
                Authorization: 'Bearer <api_key>',
              },
              body: {
                url: 'URL to crawl (required) - web page URL or image source URL',
                mode: 'Crawl mode: "direct", "discover", or "image" (default: discover)',
                preview: 'If true, extract events but do not publish (default: false)',
                html: 'Optional rendered HTML from Chrome extension (cleaned server-side)',
                title: 'Optional page title from Chrome extension',
                events: 'Optional pre-extracted events from cache (skips extraction, goes straight to publishing)',
                imageData: 'Base64-encoded image data (required for mode=image)',
                imageMimeType: 'MIME type of the image, e.g. "image/jpeg" (optional, for mode=image)',
                apiUrl: 'Optional override for the Tokoro API URL',
              },
              example: {
                url: 'https://example.com/events',
                mode: 'discover',
                preview: true,
              },
              imageExample: {
                url: 'https://example.com/flyer.jpg',
                mode: 'image',
                imageData: '<base64-encoded-image-data>',
                imageMimeType: 'image/jpeg',
                preview: true,
              },
            },
            'POST /extract-text': {
              description: 'Debug endpoint: LLM-only event extraction from plain text (bypasses JSON-LD, requires API key)',
              headers: {
                Authorization: 'Bearer <api_key>',
              },
              body: {
                text: 'Clean text content to extract events from (required)',
                url: 'Optional source URL (used as fallback event URL)',
                title: 'Optional page title',
                referenceDate: 'Optional reference date for date inference (YYYY-MM-DD, default: today)',
              },
              example: {
                text: 'Giovedì all aperitivo concerto acustico...',
                url: 'https://www.instagram.com/p/example/',
                title: 'abetonemusicbar',
                referenceDate: '2026-03-10',
              },
            },
          },
        });
      }

      // Route: POST /crawl
      if (request.method === 'POST' && path === '/crawl') {
        return await handleCrawl(request, env);
      }

      // Route: POST /extract-text (debug: LLM-only extraction, bypasses JSON-LD)
      if (request.method === 'POST' && path === '/extract-text') {
        return await handleExtractText(request, env);
      }

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (error) {
      console.error('Error:', error);
      return jsonResponse(
        {
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
        500
      );
    }
  },
};

/**
 * Handle POST /crawl requests
 */
async function handleCrawl(request: Request, env: Env): Promise<Response> {
  // Step 1: Validate API key
  const authResult = validateApiKey(request, env.CRAWLER_API_KEYS);

  if (!authResult.authorized) {
    return unauthorizedResponse(authResult.error || 'Unauthorized');
  }

  // Step 2: Parse and validate request body
  let body: CrawlRequest;
  try {
    body = await request.json();
  } catch (error) {
    return jsonResponse(
      {
        error: 'Invalid request body',
        message: 'Request body must be valid JSON',
      },
      400
    );
  }

  // Validate required fields
  if (!body.url) {
    return jsonResponse(
      {
        error: 'Missing required field',
        message: 'The "url" field is required',
      },
      400
    );
  }

  // Validate URL format
  try {
    new URL(body.url);
  } catch (error) {
    return jsonResponse(
      {
        error: 'Invalid URL',
        message: 'The "url" field must be a valid URL',
      },
      400
    );
  }

  // Validate mode
  const mode = body.mode || 'discover';
  if (mode !== 'direct' && mode !== 'discover' && mode !== 'image') {
    return jsonResponse(
      {
        error: 'Invalid mode',
        message: 'The "mode" field must be "direct", "discover", or "image"',
      },
      400
    );
  }

  // Validate image mode requirements
  if (mode === 'image' && !body.imageData) {
    return jsonResponse(
      {
        error: 'Missing required field',
        message: 'The "imageData" field is required when mode is "image"',
      },
      400
    );
  }

  // Validate environment configuration
  if (!env.CRAWLER_PRIVKEY || !env.CRAWLER_PUBKEY) {
    return jsonResponse(
      {
        error: 'Service configuration error',
        message: 'Crawler keypair not configured',
      },
      500
    );
  }

  // Step 3: Execute the crawl
  try {
    const apiUrl = body.apiUrl || env.TOKORO_API_URL || 'http://localhost:8787';
    const preview = body.preview || false;

    const crawler = new WorkerCrawler({
      env,
      apiUrl,
      mode,
      preview,
      providedHtml: body.html, // Pass HTML from Chrome extension if provided
      providedTitle: body.title, // Pass page title from Chrome extension if provided
      providedEvents: body.events, // Pass pre-extracted events from cache if provided
      previewToken: body.preview_token,
      imageData: body.imageData, // Pass base64 image data if provided (for mode=image)
      imageMimeType: body.imageMimeType, // Pass image MIME type if provided
    });

    const result = await crawler.crawl(body.url);

    const response: CrawlResponse = {
      success: true,
      message: preview ? 'Preview completed successfully' : 'Crawl completed successfully',
      stats: {
        urls_processed: result.urls_processed,
        events_extracted: result.events_extracted,
        events_published: result.events_published,
      },
    };

    // Include events in response if preview mode
    if (preview && result.events) {
      response.events = result.events;
    }

    if (result.preview_token) {
      response.preview_token = result.preview_token;
    }

    // Include cleaned text when HTML was provided by the client (e.g. Chrome extension debug logging)
    if (body.html) {
      response.cleaned_text = extractCleanText(body.html).text;
    }

    // Always include dropped events so the client can report failures
    if (result.dropped_events && result.dropped_events.length > 0) {
      response.dropped_events = result.dropped_events;
    }

    return jsonResponse(response, 200);
  } catch (error) {
    console.error('Crawl error:', error);

    const response: CrawlResponse = {
      success: false,
      error: 'Crawl failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    };

    return jsonResponse(response, 500);
  }
}

/**
 * Handle POST /extract-text requests (debug: LLM-only extraction, bypasses JSON-LD)
 */
async function handleExtractText(request: Request, env: Env): Promise<Response> {
  const authResult = validateApiKey(request, env.CRAWLER_API_KEYS);
  if (!authResult.authorized) {
    return unauthorizedResponse(authResult.error || 'Unauthorized');
  }

  let body: ExtractTextRequest;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body', message: 'Request body must be valid JSON' }, 400);
  }

  if (!body.text) {
    return jsonResponse({ error: 'Missing required field', message: 'The "text" field is required' }, 400);
  }

  if (body.referenceDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.referenceDate)) {
    return jsonResponse({ error: 'Invalid referenceDate', message: 'Expected format: YYYY-MM-DD' }, 400);
  }

  const llm = createLLMProvider({ provider: env.LLM_PROVIDER, apiKey: env.LLM_API_KEY!, model: env.LLM_MODEL });
  const extractor = new EventExtractor({ llm, referenceDate: body.referenceDate });

  const page = {
    url: body.url || 'about:blank',
    html: '', // Empty HTML: skips JSON-LD extraction entirely, goes straight to LLM
    text: body.text,
    title: body.title || 'Untitled',
  };

  const events = await extractor.extractEvents(page);
  return jsonResponse({ model: llm.name, events });
}

/**
 * Create a JSON response with CORS headers
 */
function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

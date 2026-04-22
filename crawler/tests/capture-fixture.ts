#!/usr/bin/env node

import * as fs from 'fs/promises';
import * as path from 'path';
import { chromium } from 'playwright';
import { TestFixtureMetadata } from './types.js';
import { EventExtractor } from '../src/extractors/event-extractor.js';
import { HTMLFetcher } from '../src/extractors/html-fetcher.js';
import { createLLMProvider } from '../../shared/llm/factory.js';
import {
  FESTIVAL_MAX_CONTENT_LENGTH,
  FESTIVAL_MAX_TOKENS,
} from '../../shared/extractors/extraction-limits.js';

interface CaptureOptions {
  url: string;
  name: string;
  expectedEventCount?: { min: number; max: number };
  notes?: string;
  tags?: string[];
  difficulty?: 'easy' | 'medium' | 'hard';
  imagePath?: string; // Path to an image file (for image mode fixtures)
  festival?: boolean; // Use festival mode (larger limits, modes: ['festival'])
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

async function captureFixture(options: CaptureOptions): Promise<void> {
  const {
    url,
    name,
    expectedEventCount,
    notes,
    tags,
    difficulty,
    imagePath,
    festival,
  } = options;

  console.log(`\n📸 Capturing fixture: ${name}`);
  console.log(`URL: ${url}\n`);

  // Create fixtures directory if it doesn't exist
  const fixturesDir = path.join(process.cwd(), 'tests', 'fixtures');
  await fs.mkdir(fixturesDir, { recursive: true });

  // Handle image mode
  if (imagePath) {
    console.log(`Mode: Image extraction`);
    console.log(`Image: ${imagePath}\n`);

    // Load .env for LLM provider configuration
    await loadEnv();

    try {
      // Read the image file
      const imageBuffer = await fs.readFile(imagePath);
      const imageData = imageBuffer.toString('base64');

      // Determine MIME type from file extension
      const ext = path.extname(imagePath).toLowerCase();
      const imageMimeType =
        ext === '.png'
          ? 'image/png'
          : ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : 'image/jpeg';

      // Copy image to fixtures directory
      const imageFileName = `${name}${ext}`;
      const imageDestPath = path.join(fixturesDir, imageFileName);
      await fs.copyFile(imagePath, imageDestPath);

      console.log(
        `✅ Saved image: ${imageFileName} (${(imageBuffer.length / 1024).toFixed(1)} KB)`
      );

      // Extract events using the crawler
      console.log('\n🤖 Extracting events from image...');
      let extractedEvents = [];

      try {
        // Create LLM provider
        const provider = (process.env.LLM_PROVIDER || 'ollama') as any;
        const llm = createLLMProvider({
          provider,
          apiKey:
            process.env.OPENROUTER_API_KEY ||
            process.env.OPENAI_API_KEY ||
            process.env.ANTHROPIC_API_KEY,
          model: process.env.OPENROUTER_MODEL || process.env.LLM_MODEL,
          ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
        });

        // Create event extractor
        const extractor = new EventExtractor({ llm });

        // Extract events from image
        extractedEvents = await extractor.extractEventsFromImage(
          imageData,
          imageMimeType,
          url
        );

        console.log(`✅ Extracted ${extractedEvents.length} event(s)`);

        // Display extracted events
        if (extractedEvents.length > 0) {
          console.log('\nExtracted events:');
          extractedEvents.forEach((event, i) => {
            console.log(`\n  ${i + 1}. ${event.title}`);
            console.log(`     Start: ${event.start_time}`);
            if (event.venue_name) {
              console.log(`     Venue: ${event.venue_name}`);
            }
            if (event.category) {
              console.log(`     Category: ${event.category}`);
            }
          });
        }
      } catch (error) {
        console.warn(
          `⚠️  Event extraction failed: ${error instanceof Error ? error.message : String(error)}`
        );
        console.log('Metadata will be created with empty expectedEvents array');
      }

      // Create metadata file
      const captureDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const metadata: TestFixtureMetadata = {
        url,
        capturedAt: new Date().toISOString(),
        captureDate, // Store the date used for extraction
        imageFile: imageFileName,
        imageMimeType,
        expectedEvents: extractedEvents,
        minExpectedEvents:
          expectedEventCount?.min ?? (extractedEvents.length || 1),
        maxExpectedEvents:
          expectedEventCount?.max ?? (extractedEvents.length || 10),
        notes,
        tags: tags || ['image'],
        difficulty,
      };

      const metadataFileName = `${name}.metadata.json`;
      const metadataPath = path.join(fixturesDir, metadataFileName);
      await fs.writeFile(
        metadataPath,
        JSON.stringify(metadata, null, 2),
        'utf-8'
      );

      console.log(`\n✅ Saved metadata: ${metadataFileName}`);
      console.log(`\n⚠️  Next steps:`);
      console.log(`1. Review the captured image at: ${imageDestPath}`);
      console.log(
        `2. Review and edit ${metadataPath} to verify expected events`
      );
      console.log(`3. Run tests with: npm run test -- --modes image\n`);

      return;
    } catch (error) {
      console.error(
        `❌ Error creating image fixture: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  // HTML mode (existing logic)
  console.log(`Mode: ${festival ? 'Festival' : 'Web'} page capture\n`);

  // Launch browser
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    // Navigate to page
    console.log('Loading page...');
    // Use 'domcontentloaded' instead of 'networkidle' for slow sites
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for any dynamic content to load
    console.log('Waiting for dynamic content...');
    await page.waitForTimeout(5000);

    // Get the full HTML
    const html = await page.content();

    // Save HTML file
    const htmlFileName = `${name}.html`;
    const htmlPath = path.join(fixturesDir, htmlFileName);
    await fs.writeFile(htmlPath, html, 'utf-8');

    console.log(
      `✅ Saved HTML: ${htmlFileName} (${(html.length / 1024).toFixed(1)} KB)`
    );

    // Extract events using the crawler
    console.log('\n🤖 Extracting events from captured HTML...');
    let extractedEvents = [];

    try {
      // Load .env for LLM provider configuration
      await loadEnv();

      // Create LLM provider
      const provider = (process.env.LLM_PROVIDER || 'ollama') as any;
      const llm = createLLMProvider({ provider });

      // Create event extractor (use festival limits when festival flag is set)
      const extractor = new EventExtractor({
        llm,
        maxContentLength: festival ? FESTIVAL_MAX_CONTENT_LENGTH : undefined,
        maxTokens: festival ? FESTIVAL_MAX_TOKENS : undefined,
      });

      // Process HTML to extract clean text
      const { text, title } = HTMLFetcher.processHtml(html, url);

      // Extract events
      extractedEvents = await extractor.extractEvents({
        url,
        html,
        text,
        title,
      });

      console.log(`✅ Extracted ${extractedEvents.length} event(s)`);

      // Display extracted events
      if (extractedEvents.length > 0) {
        console.log('\nExtracted events:');
        extractedEvents.forEach((event, i) => {
          console.log(`\n  ${i + 1}. ${event.title}`);
          console.log(`     Start: ${event.start_time}`);
          if (event.venue_name) {
            console.log(`     Venue: ${event.venue_name}`);
          }
          if (event.category) {
            console.log(`     Category: ${event.category}`);
          }
        });
      }
    } catch (error) {
      console.warn(
        `⚠️  Event extraction failed: ${error instanceof Error ? error.message : String(error)}`
      );
      console.log('Metadata will be created with empty expectedEvents array');
    }

    // Create metadata file
    const captureDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const metadata: TestFixtureMetadata = {
      url,
      capturedAt: new Date().toISOString(),
      captureDate, // Store the date used for extraction
      htmlFile: htmlFileName,
      ...(festival ? { modes: ['festival'] as const } : {}),
      expectedEvents: extractedEvents, // Now populated by the crawler
      minExpectedEvents:
        expectedEventCount?.min ?? (extractedEvents.length || 1),
      maxExpectedEvents:
        expectedEventCount?.max ?? (extractedEvents.length || 10),
      notes,
      tags: festival ? [...(tags || []), 'festival'] : tags,
      difficulty,
    };

    const metadataFileName = `${name}.metadata.json`;
    const metadataPath = path.join(fixturesDir, metadataFileName);
    await fs.writeFile(
      metadataPath,
      JSON.stringify(metadata, null, 2),
      'utf-8'
    );

    console.log(`\n✅ Saved metadata: ${metadataFileName}`);
    console.log(`\n⚠️  Next steps:`);
    console.log(`1. Review the captured HTML at: ${htmlPath}`);
    console.log(`2. Review and edit ${metadataPath} to verify expected events`);
    console.log(
      `3. Run tests with: npm run test${festival ? ' -- --modes festival' : ''}\n`
    );
  } finally {
    await browser.close();
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: tsx tests/capture-fixture.ts <url> <name> [options]');
    console.error('\nOptions:');
    console.error('  --min <n>         Minimum expected events (default: 1)');
    console.error('  --max <n>         Maximum expected events (default: 10)');
    console.error('  --notes <text>    Notes about this fixture');
    console.error('  --tags <t1,t2>    Comma-separated tags');
    console.error('  --difficulty <d>  Difficulty: easy, medium, or hard');
    console.error('  --image-path <p>  Path to image file (for image mode)');
    console.error(
      '  --festival        Use festival mode (larger limits, modes: [festival])'
    );
    console.error('\nExamples:');
    console.error('  # Capture a web page:');
    console.error('  tsx tests/capture-fixture.ts \\');
    console.error(
      '    "https://www.eventbrite.com/d/ca--san-francisco/events/" \\'
    );
    console.error('    eventbrite-sf-listing \\');
    console.error(
      '    --min 5 --max 20 --tags listing-page,eventbrite --difficulty medium'
    );
    console.error('\n  # Create an image fixture:');
    console.error('  tsx tests/capture-fixture.ts \\');
    console.error('    "https://example.com/event" \\');
    console.error('    event-flyer \\');
    console.error('    --image-path ./event-flyer.jpg \\');
    console.error('    --tags image,flyer --difficulty easy');
    process.exit(1);
  }

  const url = args[0];
  const name = args[1];

  // Parse options
  const expectedEventCount = {
    min: parseInt(args[args.indexOf('--min') + 1] || '1'),
    max: parseInt(args[args.indexOf('--max') + 1] || '10'),
  };

  const notesIndex = args.indexOf('--notes');
  const notes = notesIndex !== -1 ? args[notesIndex + 1] : undefined;

  const tagsIndex = args.indexOf('--tags');
  const tags =
    tagsIndex !== -1
      ? args[tagsIndex + 1].split(',').map(t => t.trim())
      : undefined;

  const difficultyIndex = args.indexOf('--difficulty');
  const difficulty =
    difficultyIndex !== -1 ? (args[difficultyIndex + 1] as any) : undefined;

  const imagePathIndex = args.indexOf('--image-path');
  const imagePath =
    imagePathIndex !== -1 ? args[imagePathIndex + 1] : undefined;

  const festival = args.includes('--festival');

  await captureFixture({
    url,
    name,
    expectedEventCount,
    notes,
    tags,
    difficulty,
    imagePath,
    festival,
  });
}

main().catch(console.error);

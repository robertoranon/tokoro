#!/usr/bin/env node

import * as fs from 'fs/promises';
import * as path from 'path';
import { HTMLFetcher } from '../src/extractors/html-fetcher.js';
import { JinaFetcher } from '../src/extractors/jina-fetcher.js';
import { EventExtractor } from '../src/extractors/event-extractor.js';
import { PageDiscovery } from '../src/extractors/page-discovery.js';
import { createLLMProvider } from '../../shared/llm/factory.js';
import { LLMProvider } from '../../shared/types/llm.js';
import { ExtractedEvent } from '../src/types/event.js';
import { TestFixtureMetadata, TestResult, TestReport } from './types.js';
import { TestEvaluator } from './evaluator.js';
import { CrawlerMode, FetcherType } from '../src/crawler.js';
import {
  FESTIVAL_MAX_CONTENT_LENGTH,
  FESTIVAL_MAX_TOKENS,
} from '../../shared/extractors/extraction-limits.js';

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

interface TestRunnerOptions {
  fixtures?: string[]; // Specific fixtures to test, or all if not specified
  modes?: CrawlerMode[]; // Override modes to test (overrides fixture-level modes)
  fetchers?: FetcherType[]; // Fetchers to test, defaults to ['playwright']
  models?: string[]; // Model(s) to test with (e.g., ['google/gemini-3.1-flash-lite-preview'])
}

export class TestRunner {
  private evaluator = new TestEvaluator();
  private fixturesDir = path.join(process.cwd(), 'tests', 'fixtures');
  private snapshotsDir = path.join(process.cwd(), 'tests', 'snapshots');

  async run(options: TestRunnerOptions = {}): Promise<TestReport> {
    console.log('\n🧪 Running crawler tests\n');

    // Ensure snapshots directory exists
    await fs.mkdir(this.snapshotsDir, { recursive: true });

    // Get all fixtures
    const allFixtures = await this.loadFixtures();
    const fixturesToTest = options.fixtures
      ? allFixtures.filter(f => options.fixtures!.includes(f.name))
      : allFixtures;

    console.log(`Found ${fixturesToTest.length} fixture(s) to test\n`);

    // Determine fetchers, and models to test
    const fetchers: FetcherType[] = options.fetchers || ['playwright'];
    const models: string[] = options.models || [
      process.env.OPENROUTER_MODEL || 'default',
    ];

    console.log(`Testing fetchers: ${fetchers.join(', ')}`);
    console.log(`Testing models: ${models.join(', ')}\n`);

    const results: TestResult[] = [];

    // Run tests for each fixture
    for (const fixture of fixturesToTest) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Testing fixture: ${fixture.name}`);
      console.log(`${'='.repeat(60)}\n`);

      // Determine which modes to run for this fixture
      const isImageFixture = !!fixture.metadata.imageFile;
      const isHtmlFixture = !!fixture.metadata.htmlFile;

      let fixtureModes: CrawlerMode[];
      if (options.modes) {
        // CLI override: filter to modes that make sense for this fixture type
        fixtureModes = options.modes.filter(m => {
          if (m === 'image') return isImageFixture;
          return isHtmlFixture;
        });
      } else if (fixture.metadata.modes) {
        fixtureModes = fixture.metadata.modes as CrawlerMode[];
      } else {
        // Default: image fixtures → image, HTML fixtures → direct
        fixtureModes =
          isImageFixture && !isHtmlFixture ? ['image'] : ['direct'];
      }

      if (fixtureModes.length === 0) {
        console.log(`  ⚠️  No applicable modes for this fixture, skipping.`);
        continue;
      }

      console.log(`  Modes: ${fixtureModes.join(', ')}\n`);

      // Test each combination of mode, model, and fetcher
      for (const model of models) {
        if (models.length > 1) {
          console.log(`\n  Testing with model: ${model}\n`);
        }

        const llm = this.createLLMForModel(model);

        for (const mode of fixtureModes) {
          // Image mode uses its own fetcher
          if (mode === 'image') {
            const result = await this.runTest(
              fixture,
              mode,
              'image',
              model,
              llm
            );
            results.push(result);
            await this.displayResultWithDiagnostic(
              result,
              fixture.metadata.expectedEvents,
              llm
            );
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          }

          // HTML modes: test with each fetcher
          for (const fetcher of fetchers) {
            const result = await this.runTest(
              fixture,
              mode,
              fetcher,
              model,
              llm
            );
            results.push(result);
            await this.displayResultWithDiagnostic(
              result,
              fixture.metadata.expectedEvents,
              llm
            );
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }
    }

    // Generate report
    const report = this.generateReport(results);

    // Save report
    const reportPath = path.join(
      this.snapshotsDir,
      `report-${new Date().toISOString().replace(/:/g, '-')}.json`
    );
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`\n📊 Report saved to: ${reportPath}\n`);

    // Display summary
    this.displaySummary(report);

    return report;
  }

  private async loadFixtures(): Promise<
    Array<{
      name: string;
      metadata: TestFixtureMetadata;
      htmlPath?: string;
      imagePath?: string;
    }>
  > {
    const files = await fs.readdir(this.fixturesDir);
    const metadataFiles = files.filter(f => f.endsWith('.metadata.json'));

    const fixtures = [];

    for (const metadataFile of metadataFiles) {
      const name = metadataFile.replace('.metadata.json', '');
      const metadataPath = path.join(this.fixturesDir, metadataFile);
      const metadataContent = await fs.readFile(metadataPath, 'utf-8');
      const metadata: TestFixtureMetadata = JSON.parse(metadataContent);

      const htmlPath = metadata.htmlFile
        ? path.join(this.fixturesDir, metadata.htmlFile)
        : undefined;
      const imagePath = metadata.imageFile
        ? path.join(this.fixturesDir, metadata.imageFile)
        : undefined;

      fixtures.push({ name, metadata, htmlPath, imagePath });
    }

    return fixtures;
  }

  private createLLMForModel(model: string): LLMProvider {
    const provider = (process.env.LLM_PROVIDER || 'ollama') as any;
    const apiKey =
      process.env.OPENROUTER_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY;
    return createLLMProvider({
      provider,
      apiKey,
      model:
        model !== 'default'
          ? model
          : process.env.OPENROUTER_MODEL || process.env.LLM_MODEL,
      ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
    });
  }

  private async runTest(
    fixture: {
      name: string;
      metadata: TestFixtureMetadata;
      htmlPath?: string;
      imagePath?: string;
    },
    mode: CrawlerMode,
    fetcher: FetcherType,
    model: string,
    llm: LLMProvider
  ): Promise<TestResult> {
    const startTime = Date.now();

    try {
      // Handle image mode separately
      if (mode === 'image') {
        if (!fixture.imagePath) {
          throw new Error('Image mode requires an image fixture');
        }

        // Load image as base64
        const imageBuffer = await fs.readFile(fixture.imagePath);
        const imageData = imageBuffer.toString('base64');
        const imageMimeType = fixture.metadata.imageMimeType || 'image/jpeg';

        // Get reference date from metadata (use captureDate if available, otherwise derive from capturedAt)
        const referenceDate =
          fixture.metadata.captureDate ||
          fixture.metadata.capturedAt.split('T')[0]; // Extract YYYY-MM-DD from ISO timestamp

        // Create event extractor
        const eventExtractor = new EventExtractor({ llm, referenceDate });

        // Extract events from image
        const extractedEvents = await eventExtractor.extractEventsFromImage(
          imageData,
          imageMimeType,
          fixture.metadata.url
        );

        const executionTimeMs = Date.now() - startTime;

        // Calculate metrics
        const metrics = await this.evaluator.calculateMetrics(
          extractedEvents,
          fixture.metadata,
          llm
        );

        return {
          fixtureName: fixture.name,
          mode: 'image',
          fetcher: 'image',
          model: model !== 'default' ? model : undefined,
          executionTimeMs,
          extractedEvents,
          metrics,
        };
      }

      // For non-image modes, require HTML
      if (!fixture.htmlPath) {
        throw new Error('HTML mode requires an HTML fixture');
      }

      // Load HTML
      const html = await fs.readFile(fixture.htmlPath, 'utf-8');

      // Get reference date from metadata (use captureDate if available, otherwise derive from capturedAt)
      const referenceDate =
        fixture.metadata.captureDate ||
        fixture.metadata.capturedAt.split('T')[0]; // Extract YYYY-MM-DD from ISO timestamp

      // Create extractors
      const discovery = new PageDiscovery(llm);
      const isFestivalMode = mode === 'festival';
      const eventExtractor = new EventExtractor({
        llm,
        referenceDate,
        maxContentLength: isFestivalMode
          ? FESTIVAL_MAX_CONTENT_LENGTH
          : undefined,
        maxTokens: isFestivalMode ? FESTIVAL_MAX_TOKENS : undefined,
      });

      // Process HTML using the selected fetcher's strategy
      let readableText: string;
      let pageTitle: string;

      if (fetcher === 'playwright') {
        // Use Readability (same as real Playwright fetcher)
        const processed = HTMLFetcher.processHtml(html, fixture.metadata.url);
        readableText = processed.text;
        pageTitle = processed.title;
      } else {
        // Jina fetcher: can't test offline (requires Jina API)
        // Fall back to simple text extraction
        readableText = this.extractText(html);
        pageTitle = '';
      }

      // Extract events based on mode
      let extractedEvents;

      if (mode === 'direct' || mode === 'festival') {
        // Direct/festival mode: extract from cleaned content (festival uses larger limits)
        extractedEvents = await eventExtractor.extractEvents({
          url: fixture.metadata.url,
          html,
          text: readableText,
          title: pageTitle,
        });
      } else {
        // Discover mode: find event URLs first, then extract
        const eventUrls = await discovery.discoverEventUrls(
          html,
          fixture.metadata.url
        );

        if (eventUrls.length > 0) {
          // In real test, we'd fetch each URL, but here we just extract from the seed
          extractedEvents = await eventExtractor.extractEvents({
            url: fixture.metadata.url,
            html,
            text: readableText,
            title: pageTitle,
          });
        } else {
          // No URLs found, treat as single event page
          extractedEvents = await eventExtractor.extractEvents({
            url: fixture.metadata.url,
            html,
            text: readableText,
            title: pageTitle,
          });
        }
      }

      const executionTimeMs = Date.now() - startTime;

      // Calculate metrics
      const metrics = await this.evaluator.calculateMetrics(
        extractedEvents,
        fixture.metadata,
        llm
      );

      return {
        fixtureName: fixture.name,
        mode,
        fetcher,
        model: model !== 'default' ? model : undefined,
        executionTimeMs,
        extractedEvents,
        metrics,
      };
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;
      return {
        fixtureName: fixture.name,
        mode,
        fetcher,
        model: model !== 'default' ? model : undefined,
        executionTimeMs,
        extractedEvents: [],
        error: error instanceof Error ? error.message : String(error),
        metrics: {
          eventsExtracted: 0,
          expectedEventsFound: 0,
          recall: 0,
          duplicates: 0,
          fieldCompleteness: 0,
          missingFields: [],
        },
      };
    }
  }

  /**
   * Simple text extraction from HTML (for testing without full fetcher)
   */
  private extractText(html: string): string {
    // Very basic text extraction (strip tags)
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private displayResult(result: TestResult): void {
    const modelSuffix = result.model ? `/${result.model}` : '';
    const modeLabel = `[${result.mode}/${result.fetcher}${modelSuffix}]`.padEnd(
      25
    );

    if (result.error) {
      console.log(`  ${modeLabel} ❌ ERROR: ${result.error}`);
      return;
    }

    const { metrics } = result;
    const recallPct = (metrics.recall * 100).toFixed(0);
    const completenessPct = (metrics.fieldCompleteness * 100).toFixed(0);

    const missingNote =
      metrics.missingFields.length > 0
        ? ` (missing: ${metrics.missingFields.join(', ')})`
        : '';

    console.log(
      `  ${modeLabel} ` +
        `📊 ${metrics.eventsExtracted} events | ` +
        `✓ ${metrics.expectedEventsFound}/${metrics.eventsExtracted} expected | ` +
        `📈 ${recallPct}% recall | ` +
        `📝 ${completenessPct}% complete${missingNote} | ` +
        `⏱️  ${result.executionTimeMs}ms` +
        (metrics.duplicates > 0
          ? ` | ⚠️  ${metrics.duplicates} duplicates`
          : '')
    );
  }

  private async displayResultWithDiagnostic(
    result: TestResult,
    expectedEvents: Partial<ExtractedEvent>[],
    llm?: LLMProvider
  ): Promise<void> {
    this.displayResult(result);

    // Show diagnostic if recall is zero
    if (!result.error && result.metrics.recall === 0) {
      console.log(`\n  🔍 Zero recall diagnostic:`);
      const diagnostic = await this.evaluator.generateRecallDiagnostic(
        result.extractedEvents,
        expectedEvents,
        llm
      );
      console.log(diagnostic);
      console.log();
    }
  }

  private generateReport(results: TestResult[]): TestReport {
    // Group by mode
    const byMode: { [mode: string]: TestResult[] } = {};

    for (const result of results) {
      if (!byMode[result.mode]) {
        byMode[result.mode] = [];
      }
      byMode[result.mode].push(result);
    }

    // Group by fetcher
    const byFetcher: { [fetcher: string]: TestResult[] } = {};

    for (const result of results) {
      if (!byFetcher[result.fetcher]) {
        byFetcher[result.fetcher] = [];
      }
      byFetcher[result.fetcher].push(result);
    }

    // Calculate summaries by mode
    const summaryByMode: TestReport['summaryByMode'] = {};

    for (const [mode, modeResults] of Object.entries(byMode)) {
      const validResults = modeResults.filter(r => !r.error);

      if (validResults.length === 0) {
        continue;
      }

      const avgRecall =
        validResults.reduce((sum, r) => sum + r.metrics.recall, 0) /
        validResults.length;

      const avgExecutionTimeMs =
        validResults.reduce((sum, r) => sum + r.executionTimeMs, 0) /
        validResults.length;

      const avgFieldCompleteness =
        validResults.reduce((sum, r) => sum + r.metrics.fieldCompleteness, 0) /
        validResults.length;

      const totalErrors = modeResults.filter(r => r.error).length;

      summaryByMode[mode] = {
        avgRecall,
        avgExecutionTimeMs,
        avgFieldCompleteness,
        totalErrors,
      };
    }

    // Calculate summaries by fetcher
    const summaryByFetcher: TestReport['summaryByFetcher'] = {};

    for (const [fetcher, fetcherResults] of Object.entries(byFetcher)) {
      const validResults = fetcherResults.filter(r => !r.error);

      if (validResults.length === 0) {
        continue;
      }

      const avgRecall =
        validResults.reduce((sum, r) => sum + r.metrics.recall, 0) /
        validResults.length;

      const avgExecutionTimeMs =
        validResults.reduce((sum, r) => sum + r.executionTimeMs, 0) /
        validResults.length;

      const avgFieldCompleteness =
        validResults.reduce((sum, r) => sum + r.metrics.fieldCompleteness, 0) /
        validResults.length;

      const totalErrors = fetcherResults.filter(r => r.error).length;

      summaryByFetcher[fetcher] = {
        avgRecall,
        avgExecutionTimeMs,
        avgFieldCompleteness,
        totalErrors,
      };
    }

    // Calculate summaries by model (if multiple models tested)
    const byModel: { [model: string]: TestResult[] } = {};

    for (const result of results) {
      if (result.model) {
        if (!byModel[result.model]) {
          byModel[result.model] = [];
        }
        byModel[result.model].push(result);
      }
    }

    let summaryByModel: TestReport['summaryByModel'];

    if (Object.keys(byModel).length > 1) {
      summaryByModel = {};

      for (const [model, modelResults] of Object.entries(byModel)) {
        const validResults = modelResults.filter(r => !r.error);

        if (validResults.length === 0) {
          continue;
        }

        const avgRecall =
          validResults.reduce((sum, r) => sum + r.metrics.recall, 0) /
          validResults.length;

        const avgExecutionTimeMs =
          validResults.reduce((sum, r) => sum + r.executionTimeMs, 0) /
          validResults.length;

        const avgFieldCompleteness =
          validResults.reduce(
            (sum, r) => sum + r.metrics.fieldCompleteness,
            0
          ) / validResults.length;

        const totalErrors = modelResults.filter(r => r.error).length;

        summaryByModel[model] = {
          avgRecall,
          avgExecutionTimeMs,
          avgFieldCompleteness,
          totalErrors,
        };
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      totalFixtures: new Set(results.map(r => r.fixtureName)).size,
      results,
      summaryByMode,
      summaryByFetcher,
      summaryByModel,
    };
  }

  private displaySummary(report: TestReport): void {
    console.log(`\n${'='.repeat(60)}`);
    console.log('📊 TEST SUMMARY');
    console.log(`${'='.repeat(60)}\n`);

    console.log('BY MODE:\n');
    for (const [mode, summary] of Object.entries(report.summaryByMode)) {
      console.log(`${mode.toUpperCase()}:`);
      console.log(
        `  Average Recall:       ${(summary.avgRecall * 100).toFixed(1)}%`
      );
      console.log(
        `  Average Completeness: ${(summary.avgFieldCompleteness * 100).toFixed(1)}%`
      );
      console.log(
        `  Average Time:         ${summary.avgExecutionTimeMs.toFixed(0)}ms`
      );
      if (summary.totalErrors > 0) {
        console.log(`  Errors:               ${summary.totalErrors}`);
      }
      console.log();
    }

    console.log('BY FETCHER:\n');
    for (const [fetcher, summary] of Object.entries(report.summaryByFetcher)) {
      console.log(`${fetcher.toUpperCase()}:`);
      console.log(
        `  Average Recall:       ${(summary.avgRecall * 100).toFixed(1)}%`
      );
      console.log(
        `  Average Completeness: ${(summary.avgFieldCompleteness * 100).toFixed(1)}%`
      );
      console.log(
        `  Average Time:         ${summary.avgExecutionTimeMs.toFixed(0)}ms`
      );
      if (summary.totalErrors > 0) {
        console.log(`  Errors:               ${summary.totalErrors}`);
      }
      console.log();
    }

    // Display model comparison if multiple models tested
    if (
      report.summaryByModel &&
      Object.keys(report.summaryByModel).length > 0
    ) {
      console.log('BY MODEL (COMPARISON):\n');
      for (const [model, summary] of Object.entries(report.summaryByModel)) {
        console.log(`${model}:`);
        console.log(
          `  Average Recall:       ${(summary.avgRecall * 100).toFixed(1)}%`
        );
        console.log(
          `  Average Completeness: ${(summary.avgFieldCompleteness * 100).toFixed(1)}%`
        );
        console.log(
          `  Average Time:         ${summary.avgExecutionTimeMs.toFixed(0)}ms`
        );
        if (summary.totalErrors > 0) {
          console.log(`  Errors:               ${summary.totalErrors}`);
        }
        console.log();
      }
    }
  }
}

// CLI interface
async function main() {
  // Load .env file
  await loadEnv();

  const args = process.argv.slice(2);

  const options: TestRunnerOptions = {};

  // Parse --fixtures flag
  const fixturesIndex = args.indexOf('--fixtures');
  if (fixturesIndex !== -1 && args[fixturesIndex + 1]) {
    options.fixtures = args[fixturesIndex + 1].split(',').map(f => f.trim());
  }

  // Parse --modes flag
  const modesIndex = args.indexOf('--modes');
  if (modesIndex !== -1 && args[modesIndex + 1]) {
    options.modes = args[modesIndex + 1].split(',') as CrawlerMode[];
  }

  // Parse --fetchers flag
  const fetchersIndex = args.indexOf('--fetchers');
  if (fetchersIndex !== -1 && args[fetchersIndex + 1]) {
    options.fetchers = args[fetchersIndex + 1].split(',') as FetcherType[];
  }

  // Parse --model or --models flag
  const modelIndex = args.indexOf('--model');
  const modelsIndex = args.indexOf('--models');
  if (modelIndex !== -1 && args[modelIndex + 1]) {
    options.models = args[modelIndex + 1].split(',').map(m => m.trim());
  } else if (modelsIndex !== -1 && args[modelsIndex + 1]) {
    options.models = args[modelsIndex + 1].split(',').map(m => m.trim());
  }

  const runner = new TestRunner();
  await runner.run(options);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

#!/usr/bin/env node

import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { TestReport, TestResult, HumanReviewSession } from './types.js';

export class HumanReviewer {
  private snapshotsDir = path.join(process.cwd(), 'tests', 'snapshots');
  private reviewsPath = path.join(this.snapshotsDir, 'human-reviews.json');
  private rl: readline.Interface;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  async reviewLatestReport(): Promise<void> {
    // Find latest report
    const files = await fs.readdir(this.snapshotsDir);
    const reportFiles = files.filter(
      f => f.startsWith('report-') && f.endsWith('.json')
    );

    if (reportFiles.length === 0) {
      console.error(
        'No test reports found. Run tests first with: npm run test'
      );
      return;
    }

    // Sort by filename (ISO timestamp) to get latest
    reportFiles.sort();
    const latestReportFile = reportFiles[reportFiles.length - 1];
    const reportPath = path.join(this.snapshotsDir, latestReportFile);

    console.log(`\n📋 Loading report: ${latestReportFile}\n`);

    const reportContent = await fs.readFile(reportPath, 'utf-8');
    const report: TestReport = JSON.parse(reportContent);

    // Load existing reviews if any
    const existingReviews = await this.loadExistingReviews();

    // Group results by fixture
    const resultsByFixture = new Map<string, TestResult[]>();
    for (const result of report.results) {
      if (!resultsByFixture.has(result.fixtureName)) {
        resultsByFixture.set(result.fixtureName, []);
      }
      resultsByFixture.get(result.fixtureName)!.push(result);
    }

    // Review each fixture
    for (const [fixtureName, results] of resultsByFixture.entries()) {
      await this.reviewFixture(fixtureName, results, existingReviews);
    }

    // Save reviews
    await this.saveReviews(existingReviews);

    console.log(`\n✅ Reviews saved to: ${this.reviewsPath}\n`);
    this.rl.close();
  }

  private async reviewFixture(
    fixtureName: string,
    results: TestResult[],
    existingReviews: Map<string, TestResult['humanReview']>
  ): Promise<void> {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Reviewing fixture: ${fixtureName}`);
    console.log(`${'='.repeat(60)}\n`);

    // Filter out results with errors
    const validResults = results.filter(r => !r.error);

    if (validResults.length === 0) {
      console.log('⚠️  No valid results to review (all failed)\n');
      return;
    }

    // Review each mode
    for (const result of validResults) {
      const reviewKey = `${fixtureName}:${result.mode}:${result.fetcher}`;

      // Skip if already reviewed
      if (existingReviews.has(reviewKey)) {
        console.log(
          `  [${result.mode}/${result.fetcher}] Already reviewed, skipping...\n`
        );
        continue;
      }

      console.log(`\n  Mode: ${result.mode} | Fetcher: ${result.fetcher}`);
      console.log(`  Extracted ${result.extractedEvents.length} event(s)\n`);

      // Show extracted events
      for (let i = 0; i < result.extractedEvents.length; i++) {
        const event = result.extractedEvents[i];
        console.log(`  Event ${i + 1}/${result.extractedEvents.length}:`);
        console.log(`    Title:       ${event.title}`);
        console.log(`    Venue:       ${event.venue_name || 'N/A'}`);
        console.log(`    Address:     ${event.address || 'N/A'}`);
        console.log(
          `    Start:       ${typeof event.start_time === 'number' ? new Date(event.start_time * 1000).toISOString().slice(0, 19) : event.start_time}`
        );
        console.log(`    Category:    ${event.category}`);
        console.log(`    Tags:        ${event.tags?.join(', ') || 'N/A'}`);
        console.log(`    URL:         ${event.url || 'N/A'}`);
        console.log(
          `    Description: ${event.description?.substring(0, 100) || 'N/A'}${event.description && event.description.length > 100 ? '...' : ''}`
        );
        console.log();
      }

      // Get human judgment
      const review = await this.getHumanJudgment(result.extractedEvents.length);
      existingReviews.set(reviewKey, review);
    }
  }

  private async getHumanJudgment(
    totalEvents: number
  ): Promise<TestResult['humanReview']> {
    console.log(`  Please review the ${totalEvents} event(s) above:\n`);

    const correctEvents = await this.promptNumber(
      '  How many events are CORRECT (all info accurate)?',
      0,
      totalEvents
    );

    const partiallyCorrectEvents = await this.promptNumber(
      '  How many events are PARTIALLY CORRECT (some info wrong)?',
      0,
      totalEvents - correctEvents
    );

    const incorrectEvents = await this.promptNumber(
      '  How many events are INCORRECT (mostly wrong)?',
      0,
      totalEvents - correctEvents - partiallyCorrectEvents
    );

    const hallucinatedEvents = await this.promptNumber(
      '  How many events are HALLUCINATED (not on page)?',
      0,
      totalEvents
    );

    const notes = await this.promptString(
      '  Any additional notes? (optional, press Enter to skip)'
    );

    return {
      correctEvents,
      partiallyCorrectEvents,
      incorrectEvents,
      hallucinatedEvents,
      notes: notes || undefined,
    };
  }

  private promptNumber(
    question: string,
    min: number,
    max: number
  ): Promise<number> {
    return new Promise(resolve => {
      const ask = () => {
        this.rl.question(`${question} [${min}-${max}]: `, answer => {
          const num = parseInt(answer.trim());
          if (isNaN(num) || num < min || num > max) {
            console.log(
              `  ⚠️  Please enter a number between ${min} and ${max}`
            );
            ask();
          } else {
            resolve(num);
          }
        });
      };
      ask();
    });
  }

  private promptString(question: string): Promise<string> {
    return new Promise(resolve => {
      this.rl.question(`${question}: `, answer => {
        resolve(answer.trim());
      });
    });
  }

  private async loadExistingReviews(): Promise<
    Map<string, TestResult['humanReview']>
  > {
    try {
      const content = await fs.readFile(this.reviewsPath, 'utf-8');
      const data = JSON.parse(content);
      return new Map(Object.entries(data));
    } catch (error) {
      // File doesn't exist yet
      return new Map();
    }
  }

  private async saveReviews(
    reviews: Map<string, TestResult['humanReview']>
  ): Promise<void> {
    const obj = Object.fromEntries(reviews);
    await fs.writeFile(this.reviewsPath, JSON.stringify(obj, null, 2), 'utf-8');
  }
}

// CLI interface
async function main() {
  const reviewer = new HumanReviewer();
  await reviewer.reviewLatestReport();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

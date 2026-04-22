#!/usr/bin/env node

import * as fs from 'fs/promises';
import * as path from 'path';
import { TestReport, TestResult } from './types.js';

export class ReportGenerator {
  private snapshotsDir = path.join(process.cwd(), 'tests', 'snapshots');
  private reviewsPath = path.join(this.snapshotsDir, 'human-reviews.json');

  async generateReport(reportFile?: string): Promise<void> {
    // Find report file
    let reportPath: string;

    if (reportFile) {
      reportPath = path.join(this.snapshotsDir, reportFile);
    } else {
      // Find latest report
      const files = await fs.readdir(this.snapshotsDir);
      const reportFiles = files
        .filter(f => f.startsWith('report-') && f.endsWith('.json'))
        .sort();

      if (reportFiles.length === 0) {
        console.error(
          'No test reports found. Run tests first with: npm run test'
        );
        return;
      }

      reportPath = path.join(
        this.snapshotsDir,
        reportFiles[reportFiles.length - 1]
      );
    }

    console.log(`\n📊 Generating report from: ${path.basename(reportPath)}\n`);

    const reportContent = await fs.readFile(reportPath, 'utf-8');
    const report: TestReport = JSON.parse(reportContent);

    // Load human reviews if available
    const humanReviews = await this.loadHumanReviews();

    // Merge human reviews into results
    for (const result of report.results) {
      const reviewKey = `${result.fixtureName}:${result.mode}:${result.fetcher}`;
      if (humanReviews.has(reviewKey)) {
        result.humanReview = humanReviews.get(reviewKey);
      }
    }

    // Generate markdown report
    const markdown = this.generateMarkdown(report);

    // Save markdown report
    const markdownPath = reportPath.replace('.json', '.md');
    await fs.writeFile(markdownPath, markdown, 'utf-8');

    console.log(`✅ Markdown report saved to: ${markdownPath}\n`);

    // Display to console
    console.log(markdown);
  }

  private generateMarkdown(report: TestReport): string {
    let md = `# Crawler Test Report\n\n`;
    md += `**Generated:** ${new Date(report.generatedAt).toLocaleString()}\n`;
    md += `**Total Fixtures:** ${report.totalFixtures}\n\n`;

    // Summary by mode
    md += `## Summary by Mode\n\n`;
    md += `| Mode | Avg Recall | Avg Completeness | Avg Time (ms) | Errors |\n`;
    md += `|------|------------|------------------|---------------|--------|\n`;

    for (const [mode, summary] of Object.entries(report.summaryByMode)) {
      md += `| ${mode} | ${(summary.avgRecall * 100).toFixed(1)}% | ${(summary.avgFieldCompleteness * 100).toFixed(1)}% | ${summary.avgExecutionTimeMs.toFixed(0)} | ${summary.totalErrors} |\n`;
    }

    md += `\n`;

    // Summary by fetcher
    md += `## Summary by Fetcher\n\n`;
    md += `| Fetcher | Avg Recall | Avg Completeness | Avg Time (ms) | Errors |\n`;
    md += `|---------|------------|------------------|---------------|--------|\n`;

    for (const [fetcher, summary] of Object.entries(report.summaryByFetcher)) {
      md += `| ${fetcher} | ${(summary.avgRecall * 100).toFixed(1)}% | ${(summary.avgFieldCompleteness * 100).toFixed(1)}% | ${summary.avgExecutionTimeMs.toFixed(0)} | ${summary.totalErrors} |\n`;
    }

    md += `\n`;

    // Group results by fixture
    const resultsByFixture = new Map<string, TestResult[]>();
    for (const result of report.results) {
      if (!resultsByFixture.has(result.fixtureName)) {
        resultsByFixture.set(result.fixtureName, []);
      }
      resultsByFixture.get(result.fixtureName)!.push(result);
    }

    // Detailed results by fixture
    md += `## Detailed Results\n\n`;

    for (const [fixtureName, results] of resultsByFixture.entries()) {
      md += `### ${fixtureName}\n\n`;

      // Comparison table
      md += `| Mode | Fetcher | Events | Expected Found | Recall | Completeness | Duplicates | Time (ms) | Status |\n`;
      md += `|------|---------|--------|----------------|--------|--------------|------------|-----------|--------|\n`;

      for (const result of results) {
        const status = result.error ? '❌ Error' : '✅ OK';
        const recall = result.error
          ? '-'
          : `${(result.metrics.recall * 100).toFixed(0)}%`;
        const completeness = result.error
          ? '-'
          : `${(result.metrics.fieldCompleteness * 100).toFixed(0)}%`;

        md += `| ${result.mode} | ${result.fetcher} | ${result.metrics.eventsExtracted} | ${result.metrics.expectedEventsFound} | ${recall} | ${completeness} | ${result.metrics.duplicates} | ${result.executionTimeMs} | ${status} |\n`;
      }

      md += `\n`;

      // Human reviews if available
      const reviewedResults = results.filter(r => r.humanReview);
      if (reviewedResults.length > 0) {
        md += `#### Human Review\n\n`;
        md += `| Mode | Fetcher | Correct | Partial | Incorrect | Hallucinated | Precision |\n`;
        md += `|------|---------|---------|---------|-----------|--------------|----------|\n`;

        for (const result of reviewedResults) {
          const review = result.humanReview!;
          const total = result.extractedEvents.length;
          const precision =
            total > 0
              ? ((review.correctEvents + review.partiallyCorrectEvents * 0.5) /
                  total) *
                100
              : 0;

          md += `| ${result.mode} | ${result.fetcher} | ${review.correctEvents} | ${review.partiallyCorrectEvents} | ${review.incorrectEvents} | ${review.hallucinatedEvents} | ${precision.toFixed(0)}% |\n`;
        }

        md += `\n`;

        // Add notes if any
        for (const result of reviewedResults) {
          if (result.humanReview?.notes) {
            md += `**Notes (${result.mode}/${result.fetcher}):** ${result.humanReview.notes}\n\n`;
          }
        }
      }

      // Show errors if any
      const errorResults = results.filter(r => r.error);
      if (errorResults.length > 0) {
        md += `#### Errors\n\n`;
        for (const result of errorResults) {
          md += `- **${result.mode}/${result.fetcher}:** ${result.error}\n`;
        }
        md += `\n`;
      }
    }

    // Recommendations
    md += `## Recommendations\n\n`;
    md += this.generateRecommendations(report);

    return md;
  }

  private generateRecommendations(report: TestReport): string {
    let recommendations = '';

    // Find best mode by recall
    const modes = Object.entries(report.summaryByMode).sort(
      (a, b) => b[1].avgRecall - a[1].avgRecall
    );

    if (modes.length > 0) {
      const [bestMode, bestStats] = modes[0];
      recommendations += `- **Best mode for recall:** \`${bestMode}\` (${(bestStats.avgRecall * 100).toFixed(1)}% average recall)\n`;
    }

    // Find fastest mode
    const fastestMode = Object.entries(report.summaryByMode).sort(
      (a, b) => a[1].avgExecutionTimeMs - b[1].avgExecutionTimeMs
    )[0];

    if (fastestMode) {
      const [mode, stats] = fastestMode;
      recommendations += `- **Fastest mode:** \`${mode}\` (${stats.avgExecutionTimeMs.toFixed(0)}ms average)\n`;
    }

    // Check for duplicates
    const totalDuplicates = report.results.reduce(
      (sum, r) => sum + r.metrics.duplicates,
      0
    );

    if (totalDuplicates > 0) {
      recommendations += `- ⚠️  **Duplicate detection needed:** ${totalDuplicates} duplicate events found across tests\n`;
    }

    // Check for errors
    const totalErrors = Object.values(report.summaryByMode).reduce(
      (sum, s) => sum + s.totalErrors,
      0
    );

    if (totalErrors > 0) {
      recommendations += `- ⚠️  **Error handling needed:** ${totalErrors} tests failed with errors\n`;
    }

    // Human review recommendations
    const humanReviewedCount = report.results.filter(r => r.humanReview).length;
    const totalTests = report.results.length;

    if (humanReviewedCount < totalTests) {
      recommendations += `- 📝 **Human review needed:** ${totalTests - humanReviewedCount} tests not yet reviewed (run \`npm run test:review\`)\n`;
    }

    if (recommendations === '') {
      recommendations = '- All tests passing with no issues detected!\n';
    }

    return recommendations;
  }

  private async loadHumanReviews(): Promise<
    Map<string, TestResult['humanReview']>
  > {
    try {
      const content = await fs.readFile(this.reviewsPath, 'utf-8');
      const data = JSON.parse(content);
      return new Map(Object.entries(data));
    } catch (error) {
      return new Map();
    }
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const reportFile = args[0]; // Optional: specific report file

  const generator = new ReportGenerator();
  await generator.generateReport(reportFile);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

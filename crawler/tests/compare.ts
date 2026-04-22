#!/usr/bin/env node

/**
 * Compare two test snapshot reports to identify improvements and regressions.
 *
 * Usage:
 *   npm run test:compare -- <baseline-report.json> <new-report.json>
 *   npm run test:compare  # compares the two most recent snapshots
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { TestReport, TestResult } from './types.js';

interface ResultKey {
  fixtureName: string;
  mode: string;
  fetcher: string;
  model: string;
}

interface ComparisonEntry {
  key: ResultKey;
  baseline: TestResult | null;
  current: TestResult | null;
  recallDelta: number;
  completenessDelta: number;
  status: 'improvement' | 'regression' | 'same' | 'new' | 'removed';
}

const IMPROVEMENT_THRESHOLD = 0.05; // 5% change = meaningful

function resultKey(r: TestResult): string {
  return `${r.fixtureName}::${r.mode}::${r.fetcher}::${r.model ?? 'default'}`;
}

function compareReports(
  baseline: TestReport,
  current: TestReport
): ComparisonEntry[] {
  const baselineMap = new Map<string, TestResult>();
  for (const r of baseline.results) {
    baselineMap.set(resultKey(r), r);
  }

  const currentMap = new Map<string, TestResult>();
  for (const r of current.results) {
    currentMap.set(resultKey(r), r);
  }

  const allKeys = new Set([...baselineMap.keys(), ...currentMap.keys()]);
  const entries: ComparisonEntry[] = [];

  for (const key of allKeys) {
    const b = baselineMap.get(key) ?? null;
    const c = currentMap.get(key) ?? null;

    const bRecall = b?.metrics.recall ?? 0;
    const cRecall = c?.metrics.recall ?? 0;
    const recallDelta = cRecall - bRecall;

    const bCompleteness = b?.metrics.fieldCompleteness ?? 0;
    const cCompleteness = c?.metrics.fieldCompleteness ?? 0;
    const completenessDelta = cCompleteness - bCompleteness;

    let status: ComparisonEntry['status'];
    if (!b) {
      status = 'new';
    } else if (!c) {
      status = 'removed';
    } else if (recallDelta > IMPROVEMENT_THRESHOLD) {
      status = 'improvement';
    } else if (recallDelta < -IMPROVEMENT_THRESHOLD) {
      status = 'regression';
    } else {
      status = 'same';
    }

    const parsed = key.split('::');
    entries.push({
      key: {
        fixtureName: parsed[0],
        mode: parsed[1],
        fetcher: parsed[2],
        model: parsed[3],
      },
      baseline: b,
      current: c,
      recallDelta,
      completenessDelta,
      status,
    });
  }

  // Sort: regressions first, then improvements, then same, then new/removed
  const order: Record<ComparisonEntry['status'], number> = {
    regression: 0,
    improvement: 1,
    same: 2,
    new: 3,
    removed: 4,
  };
  entries.sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      a.key.fixtureName.localeCompare(b.key.fixtureName)
  );

  return entries;
}

function formatDelta(delta: number): string {
  if (delta === 0) return '  0.0%';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${(delta * 100).toFixed(1)}%`;
}

function statusIcon(status: ComparisonEntry['status']): string {
  switch (status) {
    case 'improvement':
      return '✅';
    case 'regression':
      return '❌';
    case 'same':
      return '  ';
    case 'new':
      return '🆕';
    case 'removed':
      return '🗑️ ';
  }
}

async function loadSnapshot(
  snapshotsDir: string,
  nameOrPath: string
): Promise<{ report: TestReport; label: string }> {
  let filePath: string;

  if (path.isAbsolute(nameOrPath) || nameOrPath.includes('/')) {
    filePath = nameOrPath;
  } else {
    filePath = path.join(snapshotsDir, nameOrPath);
  }

  const content = await fs.readFile(filePath, 'utf-8');
  return { report: JSON.parse(content), label: path.basename(filePath) };
}

async function findLatestSnapshots(
  snapshotsDir: string
): Promise<[string, string]> {
  const files = (await fs.readdir(snapshotsDir))
    .filter(f => f.startsWith('report-') && f.endsWith('.json'))
    .sort();

  if (files.length < 2) {
    throw new Error(
      `Need at least 2 snapshots to compare. Found: ${files.length}`
    );
  }

  return [files[files.length - 2], files[files.length - 1]];
}

async function main() {
  const snapshotsDir = path.join(process.cwd(), 'tests', 'snapshots');
  const args = process.argv.slice(2);

  let baselineName: string;
  let currentName: string;

  if (args.length >= 2) {
    [baselineName, currentName] = [args[0], args[1]];
  } else if (args.length === 0) {
    [baselineName, currentName] = await findLatestSnapshots(snapshotsDir);
  } else {
    console.error('Usage: npm run test:compare [<baseline.json> <new.json>]');
    process.exit(1);
  }

  const { report: baseline, label: baselineLabel } = await loadSnapshot(
    snapshotsDir,
    baselineName
  );
  const { report: current, label: currentLabel } = await loadSnapshot(
    snapshotsDir,
    currentName
  );

  console.log(`\n📊 Snapshot Comparison\n`);
  console.log(
    `  Baseline : ${baselineLabel}  (${new Date(baseline.generatedAt).toLocaleString()})`
  );
  console.log(
    `  Current  : ${currentLabel}  (${new Date(current.generatedAt).toLocaleString()})`
  );
  console.log();

  const entries = compareReports(baseline, current);

  // Header
  const fixtureW = 38;
  const modeW = 10;
  const fetcherW = 12;
  console.log(
    `${'Fixture'.padEnd(fixtureW)} ${'Mode'.padEnd(modeW)} ${'Fetcher'.padEnd(fetcherW)}` +
      `  ${'Base Recall'.padStart(10)}  ${'New Recall'.padStart(10)}  ${'Δ Recall'.padStart(8)}  ${'Δ Compl.'.padStart(8)}  Status`
  );
  console.log('-'.repeat(110));

  for (const entry of entries) {
    const {
      key,
      baseline: b,
      current: c,
      recallDelta,
      completenessDelta,
      status,
    } = entry;

    const baseRecall = b ? `${(b.metrics.recall * 100).toFixed(0)}%` : '-';
    const newRecall = c ? `${(c.metrics.recall * 100).toFixed(0)}%` : '-';
    const dRecall = b && c ? formatDelta(recallDelta) : '   -';
    const dCompl = b && c ? formatDelta(completenessDelta) : '   -';

    const modelSuffix =
      key.model !== 'default' ? ` (${key.model.split('/').pop()})` : '';
    const label = `${key.fixtureName}${modelSuffix}`;

    console.log(
      `${label.slice(0, fixtureW).padEnd(fixtureW)} ${key.mode.padEnd(modeW)} ${key.fetcher.padEnd(fetcherW)}` +
        `  ${baseRecall.padStart(10)}  ${newRecall.padStart(10)}  ${dRecall.padStart(8)}  ${dCompl.padStart(8)}  ${statusIcon(status)} ${status}`
    );
  }

  console.log('-'.repeat(110));

  // Summary counts
  const improvements = entries.filter(e => e.status === 'improvement').length;
  const regressions = entries.filter(e => e.status === 'regression').length;
  const same = entries.filter(e => e.status === 'same').length;
  const added = entries.filter(e => e.status === 'new').length;
  const removed = entries.filter(e => e.status === 'removed').length;

  console.log();
  console.log(
    `Summary: ✅ ${improvements} improved  ❌ ${regressions} regressed  ${same} unchanged  🆕 ${added} new  🗑️  ${removed} removed`
  );

  // Overall recall change
  const baseOverall =
    baseline.results.length > 0
      ? baseline.results.reduce((s, r) => s + r.metrics.recall, 0) /
        baseline.results.length
      : 0;
  const curOverall =
    current.results.length > 0
      ? current.results.reduce((s, r) => s + r.metrics.recall, 0) /
        current.results.length
      : 0;
  console.log(
    `Overall recall: ${(baseOverall * 100).toFixed(1)}% → ${(curOverall * 100).toFixed(1)}% (${formatDelta(curOverall - baseOverall).trim()})`
  );
  console.log();

  process.exit(regressions > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

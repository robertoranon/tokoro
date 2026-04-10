#!/usr/bin/env npx tsx
/**
 * check-duplicate.ts
 *
 * Usage:
 *   npx tsx scripts/check-duplicate.ts --local  <event-id-1> <event-id-2>
 *   npx tsx scripts/check-duplicate.ts --remote <event-id-1> <event-id-2>
 *
 * Applies the same duplicate-detection logic used in the worker POST handler
 * and explains exactly why two events are or are not considered duplicates.
 *
 * LLM usage: set LLM_API_KEY (and optionally LLM_PROVIDER, LLM_MODEL) in env.
 * Without these, falls back to Levenshtein similarity only.
 */

import { execSync } from 'child_process';
import { encode as geohashEncode, neighbors } from '../src/geohash';
import { isDuplicate } from '../../shared/llm/duplicate-check';
import { createLLMProvider } from '../../shared/llm/factory';
import type { LLMProvider } from '../../shared/types/llm';
import {
  DEDUP_DISTANCE_KM,
  DEDUP_TIME_WINDOW_MS,
  LEVENSHTEIN_FAST_PATH,
  LEVENSHTEIN_FALLBACK,
  LLM_PROBABILITY_THRESHOLD,
} from '../../shared/dedup-config';

// ── argument parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const localIdx = args.indexOf('--local');
const remoteIdx = args.indexOf('--remote');

if (localIdx === -1 && remoteIdx === -1) {
  console.error('Usage: npx tsx scripts/check-duplicate.ts --local|--remote <id1> <id2>');
  process.exit(1);
}

const isRemote = remoteIdx !== -1;
const flagIdx = isRemote ? remoteIdx : localIdx;
const ids = args.filter((_, i) => i !== flagIdx);

if (ids.length !== 2) {
  console.error('Provide exactly two event IDs.');
  process.exit(1);
}

const [id1, id2] = ids;

// ── helpers ──────────────────────────────────────────────────────────────────

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function duplicateCandidateCells(geohash6: string): string[] {
  return [geohash6, ...neighbors(geohash6)];
}

function levenshteinSimilarity(a: string, b: string): number {
  const s1 = a.toLowerCase(), s2 = b.toLowerCase();
  if (s1 === s2) return 1;
  const len1 = s1.length, len2 = s2.length;
  if (!len1 || !len2) return 0;
  const m: number[][] = Array.from({ length: len1 + 1 }, (_, i) =>
    Array.from({ length: len2 + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= len1; i++)
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + cost);
    }
  return 1 - m[len1][len2] / Math.max(len1, len2);
}

// ── DB query ─────────────────────────────────────────────────────────────────

interface DbEvent {
  id: string;
  title: string;
  description: string | null;
  lat: number;
  lng: number;
  start_time: string;
  geohash6: string;
}

function fetchEvents(id1: string, id2: string, remote: boolean): DbEvent[] {
  const flag = remote ? '--remote' : '--local';
  // Escape single quotes in IDs just in case
  const safe1 = id1.replace(/'/g, "''");
  const safe2 = id2.replace(/'/g, "''");
  const sql = `SELECT id, title, description, lat, lng, start_time, geohash6 FROM events WHERE id IN ('${safe1}', '${safe2}')`;
  const cmd = `npx wrangler d1 execute happenings-db ${flag} --json --command "${sql}"`;

  let raw: string;
  try {
    raw = execSync(cmd, { cwd: process.cwd(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    console.error('wrangler d1 execute failed:');
    console.error(err.stderr || err.message);
    process.exit(1);
  }

  // wrangler --json output: array of statement results
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any[];
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('Could not parse wrangler JSON output:\n', raw);
    process.exit(1);
  }

  const results = parsed?.[0]?.results;
  if (!Array.isArray(results)) {
    console.error('Unexpected wrangler output shape:', JSON.stringify(parsed, null, 2));
    process.exit(1);
  }
  return results as DbEvent[];
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dbLabel = isRemote ? 'remote' : 'local';
  console.log(`\nFetching events from ${dbLabel} DB…`);

  const rows = fetchEvents(id1, id2, isRemote);

  const a = rows.find(r => r.id === id1);
  const b = rows.find(r => r.id === id2);

  if (!a) { console.error(`Event not found: ${id1}`); process.exit(1); }
  if (!b) { console.error(`Event not found: ${id2}`); process.exit(1); }

  console.log('\n── Event A ──────────────────────────────────────────');
  console.log(`  ID:         ${a.id}`);
  console.log(`  Title:      ${a.title}`);
  console.log(`  Start:      ${a.start_time}`);
  console.log(`  Location:   (${a.lat}, ${a.lng})  geohash6=${a.geohash6}`);
  console.log(`  Desc:       ${a.description?.slice(0, 80) ?? '(none)'}`);

  console.log('\n── Event B ──────────────────────────────────────────');
  console.log(`  ID:         ${b.id}`);
  console.log(`  Title:      ${b.title}`);
  console.log(`  Start:      ${b.start_time}`);
  console.log(`  Location:   (${b.lat}, ${b.lng})  geohash6=${b.geohash6}`);
  console.log(`  Desc:       ${b.description?.slice(0, 80) ?? '(none)'}`);

  console.log('\n── Duplicate checks (same logic as worker POST) ─────');

  // 1. Geohash6 neighbor check
  const cellsForA = duplicateCandidateCells(geohashEncode(a.lat, a.lng, 6));
  const geohash6B = geohashEncode(b.lat, b.lng, 6);
  const inNeighborhood = cellsForA.includes(geohash6B);
  console.log(`\n[1] Geohash6 neighborhood`);
  console.log(`    A candidate cells: ${cellsForA.join(', ')}`);
  console.log(`    B geohash6:        ${geohash6B}`);
  console.log(`    B in A's neighborhood: ${inNeighborhood ? 'YES' : 'NO ← would be missed by old single-cell query'}`);
  if (!inNeighborhood) {
    console.log('\nResult: NOT DUPLICATE — events are in different geohash6 neighborhoods (too far apart).');
    return;
  }

  // 2. Distance check
  const distKm = haversineKm(a.lat, a.lng, b.lat, b.lng);
  const withinDistance = distKm <= DEDUP_DISTANCE_KM;
  console.log(`\n[2] Distance`);
  console.log(`    Haversine: ${(distKm * 1000).toFixed(1)} m  (threshold: ${DEDUP_DISTANCE_KM * 1000} m)`);
  console.log(`    Within threshold: ${withinDistance ? 'YES' : 'NO'}`);
  if (!withinDistance) {
    console.log('\nResult: NOT DUPLICATE — events are more than 100 m apart.');
    return;
  }

  // 3. Time difference check (≤ 1 hour)
  const timeA = new Date(a.start_time).getTime();
  const timeB = new Date(b.start_time).getTime();
  const timeDiffMs = Math.abs(timeA - timeB);
  const timeDiffMin = timeDiffMs / 60000;
  const withinTimeWindow = timeDiffMs <= DEDUP_TIME_WINDOW_MS;
  console.log(`\n[3] Time difference`);
  console.log(`    |start_time A − start_time B|: ${timeDiffMin.toFixed(1)} min  (threshold: ${DEDUP_TIME_WINDOW_MS / 60000} min)`);
  console.log(`    Within threshold: ${withinTimeWindow ? 'YES' : 'NO'}`);
  if (!withinTimeWindow) {
    console.log('\nResult: NOT DUPLICATE — start times differ by more than 1 hour.');
    return;
  }

  // 4. Title similarity (Levenshtein fast path — same as isDuplicate internals)
  const titleSim = levenshteinSimilarity(a.title, b.title);
  console.log(`\n[4] Title similarity (Levenshtein)`);
  console.log(`    Similarity: ${titleSim.toFixed(3)}  (fast-path threshold: ≥ ${LEVENSHTEIN_FAST_PATH})`);

  if (titleSim >= LEVENSHTEIN_FAST_PATH) {
    console.log('    Method used: Levenshtein fast-path (no LLM call needed)');
    console.log('\nResult: DUPLICATE — titles are nearly identical (Levenshtein ≥ 0.9).');
    return;
  }

  // 5. LLM check (or Levenshtein fallback if no LLM configured)
  let llm: LLMProvider | undefined;
  const apiKey = process.env.LLM_API_KEY;
  const provider = process.env.LLM_PROVIDER;
  const model = process.env.LLM_MODEL;

  if (apiKey) {
    try {
      llm = createLLMProvider({ apiKey, provider, model });
      console.log(`\n[5] LLM similarity check`);
      console.log(`    Provider: ${provider || 'openrouter'}  Model: ${model || 'google/gemini-2.5-flash-lite'}`);
    } catch (e) {
      console.warn('    Could not create LLM provider:', (e as Error).message);
    }
  } else {
    console.log(`\n[5] LLM similarity check`);
    console.log('    LLM_API_KEY not set — falling back to Levenshtein only');
    console.log(`    Levenshtein similarity: ${titleSim.toFixed(3)}  (fallback threshold: ≥ ${LEVENSHTEIN_FALLBACK})`);
    const isDup = titleSim >= LEVENSHTEIN_FALLBACK;
    console.log(`\nResult: ${isDup ? 'DUPLICATE' : 'NOT DUPLICATE'} — Levenshtein ${isDup ? '≥' : '<'} 0.8 (no LLM).`);
    return;
  }

  const dup = await isDuplicate(
    { title: a.title, description: a.description ?? undefined },
    { title: b.title, description: b.description ?? undefined },
    llm
  );

  console.log(`    isDuplicate result: ${dup}`);
  console.log(`\nResult: ${dup ? 'DUPLICATE' : 'NOT DUPLICATE'} — LLM probability ${dup ? '≥' : '<'} ${LLM_PROBABILITY_THRESHOLD}.`);
}

main().catch(err => { console.error(err); process.exit(1); });

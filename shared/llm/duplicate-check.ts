import { LLMProvider } from '../types/llm';
import { LEVENSHTEIN_FAST_PATH, LEVENSHTEIN_FALLBACK, LLM_PROBABILITY_THRESHOLD } from '../dedup-config';

interface EventSummary {
  title: string;
  description?: string;
}

function levenshteinSimilarity(a: string, b: string): number {
  const s1 = a.toLowerCase();
  const s2 = b.toLowerCase();
  if (s1 === s2) return 1.0;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0.0;
  const matrix: number[][] = Array.from({ length: len1 + 1 }, (_, i) =>
    Array.from({ length: len2 + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return 1 - matrix[len1][len2] / Math.max(len1, len2);
}

function buildPrompt(a: EventSummary, b: EventSummary): string {
  return `Two events are described below. They may be in different languages.
Return ONLY a JSON object: {"probability": <float 0-1>}
where 1.0 means certainly the same real-world event, 0.0 means certainly different.

Event A:
  Title: ${a.title}
  Description: ${a.description || '(none)'}

Event B:
  Title: ${b.title}
  Description: ${b.description || '(none)'}`;
}

/**
 * Returns true if two events are likely duplicates.
 *
 * Pipeline:
 *   1. Levenshtein fast path: title similarity >= LEVENSHTEIN_FAST_PATH → true immediately (no LLM call).
 *   2. LLM check (if llm provided): probability >= LLM_PROBABILITY_THRESHOLD → true.
 *   3. If no LLM provided, falls back to Levenshtein >= LEVENSHTEIN_FALLBACK.
 *   4. Any LLM error → false (fail open, let the event through).
 */
export async function isDuplicate(
  a: EventSummary,
  b: EventSummary,
  llm?: LLMProvider
): Promise<boolean> {
  const sim = levenshteinSimilarity(a.title, b.title);

  if (sim >= LEVENSHTEIN_FAST_PATH) return true;

  if (!llm) return sim >= LEVENSHTEIN_FALLBACK;

  try {
    const response = await llm.complete(
      [{ role: 'user', content: buildPrompt(a, b) }],
      { responseFormat: 'json', maxTokens: 50, temperature: 0 }
    );
    const parsed = JSON.parse(response.content);
    const probability = typeof parsed.probability === 'number' ? parsed.probability : 0;
    return probability >= LLM_PROBABILITY_THRESHOLD;
  } catch {
    return false;
  }
}

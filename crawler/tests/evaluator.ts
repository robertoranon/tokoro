import { ExtractedEvent } from '../src/types/event.js';
import { LLMProvider } from '../../shared/types/llm.js';
import { TestFixtureMetadata, TestResult } from './types.js';

export class TestEvaluator {
  /**
   * Calculate metrics for a test result
   */
  async calculateMetrics(
    extractedEvents: ExtractedEvent[],
    metadata: TestFixtureMetadata,
    llm?: LLMProvider
  ): Promise<TestResult['metrics']> {
    const expectedEventsFound = await this.countExpectedEventsFound(
      extractedEvents,
      metadata.expectedEvents,
      llm
    );

    const recall =
      metadata.expectedEvents.length > 0
        ? expectedEventsFound / metadata.expectedEvents.length
        : 0;

    const duplicates = this.countDuplicates(extractedEvents);
    const { completeness: fieldCompleteness, missingFields } =
      this.calculateFieldCompleteness(extractedEvents, metadata.expectedEvents);

    return {
      eventsExtracted: extractedEvents.length,
      expectedEventsFound,
      recall,
      duplicates,
      fieldCompleteness,
      missingFields,
    };
  }

  /**
   * Generate diagnostic information for why recall is low
   */
  async generateRecallDiagnostic(
    extractedEvents: ExtractedEvent[],
    expectedEvents: Partial<ExtractedEvent>[],
    llm?: LLMProvider
  ): Promise<string> {
    const lines: string[] = [];

    lines.push(
      `  Expected ${expectedEvents.length} event(s), extracted ${extractedEvents.length} event(s)`
    );

    if (extractedEvents.length === 0) {
      lines.push(`  ⚠️  No events were extracted`);
      return lines.join('\n');
    }

    lines.push(`  Expected event titles:`);
    for (const expected of expectedEvents) {
      lines.push(`    - "${expected.title}"`);
    }

    lines.push(`  Extracted event titles:`);
    for (const extracted of extractedEvents) {
      lines.push(`    - "${extracted.title}"`);
    }

    // Show why each expected event wasn't found
    lines.push(`  Match failures:`);
    for (const expected of expectedEvents) {
      const matchResult = await this.findBestMatchWithReason(
        expected,
        extractedEvents,
        llm
      );
      if (matchResult.matched) {
        lines.push(`    ✓ "${expected.title}" - matched`);
      } else {
        lines.push(`    ✗ "${expected.title}" - ${matchResult.reason}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Find the best match for an expected event and explain why it didn't match
   */
  private async findBestMatchWithReason(
    expected: Partial<ExtractedEvent>,
    extractedEvents: ExtractedEvent[],
    llm?: LLMProvider
  ): Promise<{ matched: boolean; reason: string }> {
    if (extractedEvents.length === 0) {
      return { matched: false, reason: 'no events extracted' };
    }

    // Check each extracted event and find the closest match
    for (const extracted of extractedEvents) {
      // Time check first (cheap discriminator)
      if (expected.start_time) {
        const expectedTimestamp = this.normalizeTimestamp(expected.start_time);
        const extractedTimestamp = this.normalizeTimestamp(
          extracted.start_time
        );
        const timeDiff = Math.abs(expectedTimestamp - extractedTimestamp);
        if (timeDiff > 86400) continue;
      }

      // Text fields check (title + venue)
      if (expected.title) {
        const textMatch = await this.textFieldsMatchAsync(
          extracted,
          expected,
          llm
        );
        if (!textMatch) continue;

        if (expected.lat !== undefined && expected.lng !== undefined) {
          if (extracted.lat === undefined || extracted.lng === undefined) {
            return {
              matched: false,
              reason: `title matches but no coordinates extracted`,
            };
          }
          const distance = this.haversineDistance(
            extracted.lat,
            extracted.lng,
            expected.lat,
            expected.lng
          );
          if (distance > 1) {
            return {
              matched: false,
              reason: `title matches but location too far (${distance.toFixed(2)}km away)`,
            };
          }
        }

        // All checks passed
        return { matched: true, reason: 'matched' };
      }
    }

    // No title matches found
    return {
      matched: false,
      reason: `no title match found among extracted events`,
    };
  }

  /**
   * Count how many expected events were found in the extracted events
   */
  private async countExpectedEventsFound(
    extractedEvents: ExtractedEvent[],
    expectedEvents: Partial<ExtractedEvent>[],
    llm?: LLMProvider
  ): Promise<number> {
    let found = 0;

    for (const expected of expectedEvents) {
      let isFound = false;
      for (const extracted of extractedEvents) {
        if (await this.eventsMatchAsync(extracted, expected, llm)) {
          isFound = true;
          break;
        }
      }
      if (isFound) {
        found++;
      }
    }

    return found;
  }

  /**
   * Check if two events match using LLM for ambiguous text field comparisons.
   *
   * Pipeline:
   *   1. Time check first (cheap, unique discriminator — filters wrong pairs on multi-event pages).
   *   2. Title similarity < 0.3 → no match (fast path, no LLM).
   *   3. Title similarity >= 0.9 AND venue algorithmically matches → match (fast path, no LLM).
   *   4. Otherwise → LLM judges title+venue similarity (probability >= 0.7 → match).
   *   5. No LLM provided → fall back to title similarity >= 0.8 AND venue algorithmic match.
   */
  private async eventsMatchAsync(
    extracted: ExtractedEvent,
    expected: Partial<ExtractedEvent>,
    llm?: LLMProvider
  ): Promise<boolean> {
    // Time proximity first — cheap check that eliminates most wrong pairs before any LLM call
    if (expected.start_time) {
      const expectedTimestamp = this.normalizeTimestamp(expected.start_time);
      const extractedTimestamp = this.normalizeTimestamp(extracted.start_time);
      const timeDiff = Math.abs(expectedTimestamp - extractedTimestamp);
      if (timeDiff > 86400) return false;
    }

    // Text fields (title + venue) — may invoke LLM for ambiguous cases
    if (expected.title) {
      const textMatch = await this.textFieldsMatchAsync(
        extracted,
        expected,
        llm
      );
      if (!textMatch) return false;
    }

    // Location proximity
    if (expected.lat !== undefined && expected.lng !== undefined) {
      if (extracted.lat === undefined || extracted.lng === undefined)
        return false;
      const distance = this.haversineDistance(
        extracted.lat,
        extracted.lng,
        expected.lat,
        expected.lng
      );
      if (distance > 1) return false;
    }

    return true;
  }

  /**
   * Match text fields (title and venue_name) using a two-stage approach:
   * fast algorithmic paths first, then LLM for the ambiguous middle.
   */
  private async textFieldsMatchAsync(
    extracted: ExtractedEvent,
    expected: Partial<ExtractedEvent>,
    llm?: LLMProvider
  ): Promise<boolean> {
    if (!expected.title) return true;

    const titleSim = this.stringSimilarity(
      this.normalizeText(extracted.title),
      this.normalizeText(expected.title)
    );

    // Fast path: clearly different title — no LLM
    if (titleSim < 0.3) return false;

    const venueOK = expected.venue_name
      ? this.fuzzyMatch(extracted.venue_name || '', expected.venue_name)
      : true;

    // Fast path: high title similarity AND venue matches — no LLM
    if (titleSim >= 0.9 && venueOK) return true;

    // No LLM available: fall back to pure algorithmic
    if (!llm) return titleSim >= 0.8 && venueOK;

    // Ambiguous middle: ask the LLM
    try {
      const response = await llm.complete(
        [{ role: 'user', content: this.buildMatchPrompt(expected, extracted) }],
        { responseFormat: 'json', maxTokens: 50, temperature: 0 }
      );
      const parsed = JSON.parse(response.content);
      const probability =
        typeof parsed.probability === 'number' ? parsed.probability : 0;
      const matched = probability >= 0.7;

      const expLabel = expected.venue_name
        ? `"${expected.title}" @ ${expected.venue_name.trim()}`
        : `"${expected.title}"`;
      const extLabel = extracted.venue_name
        ? `"${extracted.title}" @ ${extracted.venue_name.trim()}`
        : `"${extracted.title}"`;
      console.log(
        `  🤖 LLM match: ${expLabel} ↔ ${extLabel} → ${(probability * 100).toFixed(0)}% ${matched ? '✓' : '✗'}`
      );

      return matched;
    } catch {
      // On LLM error, fall back to algorithmic
      return titleSim >= 0.8 && venueOK;
    }
  }

  /**
   * Build LLM prompt to judge whether two event entries refer to the same real-world event.
   * Only covers text fields (title, venue); time/location are checked algorithmically.
   */
  private buildMatchPrompt(
    expected: Partial<ExtractedEvent>,
    extracted: ExtractedEvent
  ): string {
    const lines = [
      'Two event entries may refer to the same real-world event.',
      'Venue names may be abbreviated or have extra words (e.g. "Naon Pub" vs "Naon Beer Pub" — same place).',
      'Penalize misspellings: they should reduce match probability.',
      'Return ONLY a JSON object: {"probability": <float 0-1>}',
      'where 1.0 = certainly the same event, 0.0 = certainly different.',
      '',
      'Expected event:',
      `  Title: ${expected.title}`,
    ];
    if (expected.venue_name) lines.push(`  Venue: ${expected.venue_name}`);

    lines.push('', 'Extracted event:', `  Title: ${extracted.title}`);
    if (extracted.venue_name) lines.push(`  Venue: ${extracted.venue_name}`);

    return lines.join('\n');
  }

  /**
   * Normalize text for comparison (lowercase, strip punctuation, collapse whitespace)
   */
  private normalizeText(s: string): string {
    return this.decodeHtmlEntities(s)
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Decode common HTML entities
   */
  private decodeHtmlEntities(text: string): string {
    const entities: { [key: string]: string } = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'",
      '&#8217;': "'", // Right single quotation mark
      '&#8216;': "'", // Left single quotation mark
      '&#8220;': '"', // Left double quotation mark
      '&#8221;': '"', // Right double quotation mark
      '&#8211;': '-', // En dash
      '&#8212;': '-', // Em dash
      '&nbsp;': ' ',
      '&apos;': "'",
    };

    let decoded = text;
    for (const [entity, char] of Object.entries(entities)) {
      decoded = decoded.replace(new RegExp(entity, 'g'), char);
    }

    decoded = decoded.replace(/&#(\d+);/g, (_, dec) =>
      String.fromCharCode(parseInt(dec, 10))
    );
    decoded = decoded.replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );

    return decoded;
  }

  /**
   * Simple fuzzy match for venue: one normalized string contains the other
   */
  private fuzzyMatch(value1: string, value2: string): boolean {
    const normalize = (s: string) => s.toLowerCase().trim();
    return (
      normalize(value1).includes(normalize(value2)) ||
      normalize(value2).includes(normalize(value1))
    );
  }

  /**
   * Calculate string similarity (Levenshtein ratio)
   */
  private stringSimilarity(s1: string, s2: string): number {
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;

    if (longer.length === 0) return 1.0;

    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  /**
   * Levenshtein distance
   */
  private levenshteinDistance(s1: string, s2: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= s2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= s1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= s2.length; i++) {
      for (let j = 1; j <= s1.length; j++) {
        if (s2.charAt(i - 1) === s1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[s2.length][s1.length];
  }

  /**
   * Count duplicate events (same title and date)
   */
  private countDuplicates(events: ExtractedEvent[]): number {
    const seen = new Set<string>();
    let duplicates = 0;

    for (const event of events) {
      const key = this.generateEventKey(event);
      if (seen.has(key)) {
        duplicates++;
      } else {
        seen.add(key);
      }
    }

    return duplicates;
  }

  /**
   * Generate a unique key for an event (for duplicate detection)
   */
  private generateEventKey(event: ExtractedEvent): string {
    const normalizedTitle = event.title.toLowerCase().trim();
    const timestamp = this.normalizeTimestamp(event.start_time);
    return `${normalizedTitle}|${timestamp}`;
  }

  /**
   * Calculate average field completeness across all events, and collect fields missing in any event.
   * Only considers optional fields that appear in at least one expectedEvent.
   */
  private calculateFieldCompleteness(
    events: ExtractedEvent[],
    expectedEvents: Partial<ExtractedEvent>[]
  ): { completeness: number; missingFields: string[] } {
    if (events.length === 0) return { completeness: 0, missingFields: [] };

    const allOptionalFields = [
      'description',
      'url',
      'venue_name',
      'address',
      'end_time',
      'tags',
    ];

    // Only check fields present in at least one expectedEvent
    const optionalFields = allOptionalFields.filter(field =>
      expectedEvents.some(e => (e as any)[field] !== undefined)
    );

    if (optionalFields.length === 0)
      return { completeness: 1, missingFields: [] };

    let totalCompleteness = 0;
    const missingFieldsSet = new Set<string>();

    for (const event of events) {
      let filledFields = 0;

      for (const field of optionalFields) {
        const value = (event as any)[field];
        const filled =
          value !== undefined &&
          value !== null &&
          value !== '' &&
          (!Array.isArray(value) || value.length > 0);
        if (filled) {
          filledFields++;
        } else {
          missingFieldsSet.add(field);
        }
      }

      totalCompleteness += filledFields / optionalFields.length;
    }

    return {
      completeness: totalCompleteness / events.length,
      missingFields: [...missingFieldsSet],
    };
  }

  /**
   * Normalize timestamp to Unix timestamp
   */
  private normalizeTimestamp(time: string | number): number {
    if (typeof time === 'number') {
      return time;
    }
    return Math.floor(new Date(time).getTime() / 1000);
  }

  /**
   * Calculate distance between two coordinates (Haversine formula)
   * Returns distance in kilometers
   */
  private haversineDistance(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number
  ): number {
    const R = 6371;
    const dLat = this.toRadians(lat2 - lat1);
    const dLng = this.toRadians(lng2 - lng1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) *
        Math.cos(this.toRadians(lat2)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }
}

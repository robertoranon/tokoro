import { NormalizedEvent } from '../types/event.js';
import { isDuplicate } from '../../../shared/llm/duplicate-check.js';
import type { LLMProvider } from '../../../shared/types/llm.js';

export class APIPublisher {
  constructor(
    private apiUrl: string,
    private debug: boolean = false,
    private llm?: LLMProvider
  ) {}

  private async fetchNearbyEvents(
    lat: number,
    lng: number,
    startTime: string
  ): Promise<Array<{ id: string; title: string; description?: string }>> {
    try {
      const from = new Date(new Date(startTime).getTime() - 60 * 60 * 1000)
        .toISOString()
        .slice(0, 19);
      const to = new Date(new Date(startTime).getTime() + 60 * 60 * 1000)
        .toISOString()
        .slice(0, 19);
      const url = `${this.apiUrl}/events?lat=${lat}&lng=${lng}&radius=0.1&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const response = await fetch(url);
      if (!response.ok) return [];
      const data = (await response.json()) as {
        events?: Array<{ id: string; title: string; description?: string }>;
      };
      return data.events || [];
    } catch {
      return [];
    }
  }

  async publishEvent(event: NormalizedEvent): Promise<boolean> {
    // Debug mode: output to console only, skip API call
    if (this.debug) {
      console.log('\n' + '='.repeat(80));
      console.log('DEBUG MODE - Extracted Event:');
      console.log('='.repeat(80));
      console.log(JSON.stringify(event, null, 2));
      console.log('='.repeat(80) + '\n');
      return true;
    }

    // Pre-publish duplicate check (skipped in debug mode and when no LLM configured)
    if (this.llm) {
      const candidates = await this.fetchNearbyEvents(
        event.lat,
        event.lng,
        event.start_time
      );
      for (const candidate of candidates) {
        const dup = await isDuplicate(
          { title: event.title, description: event.description || '' },
          { title: candidate.title, description: candidate.description || '' },
          this.llm
        );
        if (dup) {
          console.log(
            `⊘ Skipped duplicate (pre-check): ${event.title} (existing: ${candidate.id})`
          );
          return true;
        }
      }
    }

    // Normal mode: publish to API
    console.log(`Publishing event: ${event.title}`);

    try {
      const response = await fetch(`${this.apiUrl}/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
      });

      if (!response.ok) {
        const error = await response.json();

        // Handle duplicate events (409 Conflict) as a success case
        if (response.status === 409) {
          console.log(
            `⊘ Skipped duplicate: ${event.title} (already exists as ${error.existing_event_id})`
          );
          return true; // Count as success - event already exists
        }

        console.error(`API error (${response.status}):`, error);
        return false;
      }

      const result = (await response.json()) as { id: string };
      console.log(`✓ Published: ${event.title} (ID: ${result.id})`);
      return true;
    } catch (error) {
      console.error('Failed to publish event:', error);
      return false;
    }
  }

  async publishMultiple(events: NormalizedEvent[]): Promise<number> {
    let successCount = 0;

    for (const event of events) {
      const success = await this.publishEvent(event);
      if (success) {
        successCount++;
      }

      // Rate limiting: wait a bit between requests (skip in debug mode)
      if (!this.debug) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    if (this.debug) {
      console.log(
        `\n[DEBUG] Extracted ${successCount}/${events.length} events successfully (not published to API)`
      );
    } else {
      console.log(
        `\nPublished ${successCount}/${events.length} events successfully`
      );
    }
    return successCount;
  }
}

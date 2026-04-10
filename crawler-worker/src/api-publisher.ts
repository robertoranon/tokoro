import { NormalizedEvent } from './event-types';
import { Fetcher } from './types';

export interface APIPublisherConfig {
  binding?: Fetcher; // Service binding (preferred)
  apiUrl?: string; // HTTP URL (fallback)
}

export class APIPublisher {
  private binding?: Fetcher;
  private apiUrl?: string;

  constructor(config: APIPublisherConfig) {
    this.binding = config.binding;
    this.apiUrl = config.apiUrl;

    if (!this.binding && !this.apiUrl) {
      throw new Error('APIPublisher requires either a service binding or an API URL');
    }
  }

  async publishEvent(event: NormalizedEvent): Promise<boolean> {
    console.log(`Publishing event: ${event.title}`);

    // Prepare the request
    const request = new Request('https://tokoro-api/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
    });

    try {
      let response: Response;

      if (this.binding) {
        // Use service binding (direct worker-to-worker)
        console.log('[DEBUG] Using service binding');
        response = await this.binding.fetch(request);
      } else {
        // Fallback to HTTP
        const url = `${this.apiUrl}/events`;
        console.log(`[DEBUG] Using HTTP: POST ${url}`);
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(event),
        });
      }

      console.log(`[DEBUG] Response status: ${response.status}`);

      if (!response.ok) {
        const responseText = await response.text();
        let error;

        try {
          error = JSON.parse(responseText);
        } catch (e) {
          console.error(`API returned non-JSON error (${response.status}):`, responseText);
          return false;
        }

        // Handle duplicate events (409 Conflict) as a success case
        if (response.status === 409) {
          console.log(`⊘ Skipped duplicate: ${event.title} (already exists as ${error.existing_event_id})`);
          return true; // Count as success - event already exists
        }

        console.error(`API error (${response.status}):`, error);
        return false;
      }

      const result = await response.json() as { id: string };
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

      // Rate limiting: wait a bit between requests
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`\nPublished ${successCount}/${events.length} events successfully`);
    return successCount;
  }
}

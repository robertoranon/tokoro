import { ExtractedEvent, FetchedPage } from '../types/event.js';
import {
  EventExtractor as EventExtractorBase,
  EventExtractorConfig,
} from '../../../shared/extractors/event-extractor.js';
import { extractJsonLd } from './jsonld-extractor.js';
import { DEFAULT_MAX_CONTENT_LENGTH } from '../../../shared/extractors/extraction-limits.js';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Crawler-specific event extractor with file logging
 * Wraps the shared EventExtractor and adds logging capabilities for Node.js environment
 */
export class EventExtractor extends EventExtractorBase {
  constructor(config: EventExtractorConfig) {
    // Create a JSDOM-based JSON-LD parser for the crawler environment
    const jsdomJsonLdParser = (html: string): string[] => {
      const result = extractJsonLd(html, 'https://placeholder.com');
      // This is a workaround - extractJsonLd expects to parse and return events,
      // but the base EventExtractor expects raw JSON-LD text strings
      // For now, we'll let the base class use its default regex parser
      return [];
    };

    super(config); // Pass config to base class
  }

  async extractEvents(page: FetchedPage): Promise<ExtractedEvent[]> {
    // Log the raw extracted content to a file for debugging
    await this.logPageContent(page);

    // Call parent implementation
    const events = await super.extractEvents(page);

    return events;
  }

  async extractEventsFromImage(
    imageData: string,
    imageMimeType: string,
    imageSource?: string
  ): Promise<ExtractedEvent[]> {
    // Call parent implementation
    const events = await super.extractEventsFromImage(
      imageData,
      imageMimeType,
      imageSource
    );

    // Log the response
    await this.logImageResponse(events, imageSource);

    return events;
  }

  private async logPageContent(page: FetchedPage): Promise<void> {
    try {
      const logsDir = path.join(process.cwd(), 'logs');
      await fs.mkdir(logsDir, { recursive: true });

      // Remove empty lines to reduce whitespace bloat
      const contentWithoutEmptyLines = (page.text || '')
        .split('\n')
        .filter(line => line.trim().length > 0)
        .join('\n');

      const rawContent = contentWithoutEmptyLines.slice(
        0,
        DEFAULT_MAX_CONTENT_LENGTH
      );
      const today = new Date();
      const todayISO = today.toISOString().split('T')[0];

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const urlSlug = page.url.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 50);
      const logFilename = `${timestamp}_${urlSlug}.txt`;
      const logPath = path.join(logsDir, logFilename);

      const logContent = `=== RAW EXTRACTED CONTENT ===
URL: ${page.url}
Title: ${page.title}
Date: ${todayISO}
Content Length: ${rawContent.length} characters

=== CONTENT ===
${rawContent}

=== END OF CONTENT ===
`;

      await fs.writeFile(logPath, logContent, 'utf-8');
      console.log(`📝 Raw content logged to: ${logPath}`);
    } catch (error) {
      console.warn('Failed to write log file:', error);
    }
  }

  private async logImageResponse(
    events: ExtractedEvent[],
    imageSource?: string
  ): Promise<void> {
    try {
      const logsDir = path.join(process.cwd(), 'logs');
      await fs.mkdir(logsDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const sourceSlug = imageSource
        ? imageSource.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 50)
        : 'image';
      const responseLogFilename = `${timestamp}_${sourceSlug}_image_response.json`;
      const responseLogPath = path.join(logsDir, responseLogFilename);

      await fs.writeFile(
        responseLogPath,
        JSON.stringify(events, null, 2),
        'utf-8'
      );
      console.log(`📝 Image extraction result logged to: ${responseLogPath}`);
    } catch (error) {
      console.warn('Failed to write image log file:', error);
    }
  }
}

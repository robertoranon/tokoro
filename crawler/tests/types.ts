import { ExtractedEvent } from '../src/types/event.js';

export interface TestFixtureMetadata {
  // Source information
  url: string;
  capturedAt: string; // ISO timestamp
  captureDate?: string; // Date used for extraction (YYYY-MM-DD format). If not specified, tests use capturedAt date
  htmlFile?: string; // relative path to HTML file (not used for image mode)
  imageFile?: string; // relative path to image file (for image mode)
  imageMimeType?: string; // MIME type of the image (e.g., "image/jpeg", "image/png")

  // Which modes this fixture should be tested with.
  // Defaults: image fixtures → ['image'], HTML fixtures → ['direct']
  modes?: ('direct' | 'discover' | 'image' | 'festival')[];

  // Expected results for validation
  expectedEvents: Partial<ExtractedEvent>[];
  minExpectedEvents: number;
  maxExpectedEvents: number;

  // Test metadata
  notes?: string;
  tags?: string[]; // e.g., ['listing-page', 'single-event', 'calendar', 'image']
  difficulty?: 'easy' | 'medium' | 'hard'; // extraction difficulty
}

export interface TestResult {
  fixtureName: string;
  mode: 'direct' | 'discover' | 'llm-raw' | 'image' | 'festival';
  fetcher: 'playwright' | 'jina' | 'image';
  model?: string; // LLM model used for this test

  // Execution metrics
  executionTimeMs: number;
  llmTokensUsed?: number;
  error?: string;

  // Extracted events
  extractedEvents: ExtractedEvent[];

  // Automated metrics
  metrics: {
    eventsExtracted: number;
    expectedEventsFound: number; // How many expected events were found
    recall: number; // expectedEventsFound / totalExpectedEvents
    duplicates: number;
    fieldCompleteness: number; // % of optional fields populated
    missingFields: string[]; // optional fields absent across all extracted events
  };

  // Human evaluation (filled in during review)
  humanReview?: {
    correctEvents: number;
    partiallyCorrectEvents: number;
    incorrectEvents: number;
    hallucinatedEvents: number; // events not on page
    notes?: string;
  };
}

export interface TestReport {
  generatedAt: string;
  totalFixtures: number;
  results: TestResult[];

  // Aggregate metrics by mode
  summaryByMode: {
    [mode: string]: {
      avgRecall: number;
      avgExecutionTimeMs: number;
      avgTokensUsed?: number;
      avgFieldCompleteness: number;
      totalErrors: number;
    };
  };

  // Aggregate metrics by fetcher
  summaryByFetcher: {
    [fetcher: string]: {
      avgRecall: number;
      avgExecutionTimeMs: number;
      avgTokensUsed?: number;
      avgFieldCompleteness: number;
      totalErrors: number;
    };
  };

  // Aggregate metrics by model (if multiple models tested)
  summaryByModel?: {
    [model: string]: {
      avgRecall: number;
      avgExecutionTimeMs: number;
      avgTokensUsed?: number;
      avgFieldCompleteness: number;
      totalErrors: number;
    };
  };
}

export interface HumanReviewSession {
  fixtureName: string;
  results: TestResult[];
  currentIndex: number;
  reviews: Map<string, TestResult['humanReview']>;
}

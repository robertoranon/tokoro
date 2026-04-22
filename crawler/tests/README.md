# Crawler Test Suite

Comprehensive testing framework for evaluating and comparing different crawler extraction modes and fetchers.

## Overview

This test suite enables:

1. **Mode Comparison** - Compare `direct`, `discover`, and `image` extraction modes
2. **Fetcher Comparison** - Compare `playwright` vs `jina` fetchers (for HTML modes)
3. **Model Comparison** - Test and compare different LLM models (OpenRouter)
4. **Image Mode Testing** - Test event extraction from flyers, posters, and screenshots
5. **Duplicate Detection** - Verify that repeated extraction doesn't create duplicates
6. **Quality Metrics** - Automated calculation of recall, precision, and field completeness
7. **Human Evaluation** - Interactive review workflow for qualitative assessment
8. **Reproducibility** - Saved HTML/image snapshots with capture dates ensure consistent test conditions
9. **DB Benchmark** - Re-crawl live event URLs from the production D1 database to compare fetcher performance at scale

## Quick Start

```bash
# Run all tests (compares all modes and fetchers)
npm run test

# Run tests for specific fixtures
npm run test -- --fixtures example-music-venue

# Run tests for specific modes
npm run test -- --modes direct,discover,image

# Test only image mode
npm run test -- --modes image

# Run tests for specific fetchers
npm run test -- --fetchers playwright

# Test with specific OpenRouter model(s)
npm run test -- --model google/gemini-2.0-flash-exp:free
npm run test -- --models "meta-llama/llama-3.1-8b-instruct:free,google/gemini-2.0-flash-exp:free"

# Review results with human judgment
npm run test:review

# Generate detailed report
npm run test:report

# Run deduplication tests
npm run test:dedup

# Compare results across runs
npm run test:compare
```

## Creating Test Fixtures

### Option 1: Capture from Live Site

```bash
npm run test:capture -- \
  "https://www.eventbrite.com/d/ca--san-francisco/events/" \
  eventbrite-sf-listing \
  --min 5 --max 20 \
  --tags listing-page,eventbrite \
  --difficulty medium \
  --notes "Eventbrite listing page for San Francisco"
```

This will:

1. Fetch the page HTML using Playwright
2. Save it to `tests/fixtures/eventbrite-sf-listing.html`
3. Create `tests/fixtures/eventbrite-sf-listing.metadata.json` with current date as `captureDate`
4. Extract events using the crawler and populate expectedEvents

### Option 2: Capture Image Fixture

```bash
npm run test:capture -- \
  "https://www.instagram.com/p/example/" \
  event-flyer \
  --image-path ./path/to/flyer.jpg \
  --tags image,flyer,instagram \
  --difficulty medium \
  --notes "Instagram event flyer with date and venue details"
```

This will:

1. Copy the image to `tests/fixtures/event-flyer.jpg`
2. Create `tests/fixtures/event-flyer.metadata.json` with current date as `captureDate`
3. Extract events from the image using vision LLM
4. Auto-tag the fixture as `image`

### Reference Date for Tests

All test fixtures store a `captureDate` field (YYYY-MM-DD format) that represents the date when the fixture was captured. When tests run, they pass this date to the LLM as the reference date for interpreting relative time expressions.

**Why this matters:**

- Event pages often use relative dates like "tomorrow", "next Friday", "this weekend"
- Without a fixed reference date, these expressions would produce different results each time tests run
- By using the capture date, we ensure tests remain consistent and reproducible over time

**Example:** If a fixture was captured on 2026-03-02 and the page says "Concert next Friday", the LLM will always interpret this as 2026-03-06, regardless of when you run the tests.

### Option 3: Create Manually

**For HTML fixtures:**

1. Save HTML file: `tests/fixtures/my-test.html`
2. Create metadata file: `tests/fixtures/my-test.metadata.json`

```json
{
  "url": "https://example.com/events",
  "capturedAt": "2026-03-02T10:00:00Z",
  "captureDate": "2026-03-02",
  "htmlFile": "my-test.html",
  "expectedEvents": [
    {
      "title": "Expected Event Title",
      "venue_name": "Venue Name",
      "start_time": "2026-03-15T20:00:00Z",
      "category": "music",
      "tags": ["jazz", "live-music"]
    }
  ],
  "minExpectedEvents": 1,
  "maxExpectedEvents": 5,
  "notes": "Description of what makes this fixture interesting",
  "tags": ["listing-page", "music"],
  "difficulty": "easy"
}
```

**Important:** The `captureDate` field (YYYY-MM-DD format) is used as the reference date when running tests. This ensures consistent extraction results regardless of when tests are executed. The LLM receives this date to properly infer event dates from relative time expressions like "next Friday" or "tomorrow".

**For image fixtures:**

1. Save image file: `tests/fixtures/my-flyer.jpg`
2. Create metadata file: `tests/fixtures/my-flyer.metadata.json`

```json
{
  "url": "https://instagram.com/p/example/",
  "capturedAt": "2026-03-02T10:00:00Z",
  "captureDate": "2026-03-02",
  "imageFile": "my-flyer.jpg",
  "imageMimeType": "image/jpeg",
  "expectedEvents": [
    {
      "title": "Expected Event Title",
      "venue_name": "Venue Name",
      "start_time": "2026-03-15T20:00:00Z",
      "category": "music"
    }
  ],
  "minExpectedEvents": 1,
  "maxExpectedEvents": 1,
  "notes": "Event flyer with date and venue information",
  "tags": ["image", "flyer", "instagram"],
  "difficulty": "medium"
}
```

**Note:** When `test:capture` creates fixtures, it automatically stores the current date as `captureDate`, ensuring tests can reproduce the same extraction results over time.

## DB Benchmark

The DB benchmark (`tests/db-benchmark.ts`) measures fetcher recall against real-world event URLs pulled directly from the production Cloudflare D1 database. Unlike fixture-based tests that use saved HTML snapshots, this tool fetches live pages and checks whether the crawler can re-extract the event that was originally published.

### What it does

For each event sampled from D1 (filtered to rows that have a URL):

1. Fetches the live page with **both** `playwright` and `jina` fetchers in sequence
2. Runs the LLM extractor and checks whether the original event title/time is found in the results
3. Streams a CSV row per fetcher immediately (so partial results survive crashes)
4. Prints a statistical summary and writes a JSON report on completion

### Quick Start

```bash
# Benchmark the last 50 events with URLs (default)
npx tsx tests/db-benchmark.ts

# Benchmark a larger sample
npx tsx tests/db-benchmark.ts --limit 200

# Test a specific list of event IDs (one ID per line)
npx tsx tests/db-benchmark.ts --ids path/to/ids.txt

# Override which D1 database to query
npx tsx tests/db-benchmark.ts --db tokoro-db --config ../worker/wrangler.toml

# Save results to a custom directory
npx tsx tests/db-benchmark.ts --output ./my-results
```

### CLI Options

| Flag            | Default                    | Description                                                         |
| --------------- | -------------------------- | ------------------------------------------------------------------- |
| `--limit N`     | `50`                       | Number of events to sample (ordered by `start_time DESC`)           |
| `--ids FILE`    | —                          | Path to a text file with one event ID per line; overrides `--limit` |
| `--db NAME`     | `tokoro-db`                | Wrangler D1 database name                                           |
| `--config PATH` | `../worker/wrangler.toml`  | Path to the Wrangler config file                                    |
| `--output DIR`  | `tests/benchmark-results/` | Directory where CSV and JSON output are written                     |

### Output

Results are written to `tests/benchmark-results/` (or the path set by `--output`):

- **`benchmark-<timestamp>.csv`** — one row per event per fetcher with columns:
  `event_id`, `fetcher`, `db_title`, `db_url`, `db_start_time`, `db_category`, `db_venue`,
  `match`, `events_extracted`, `best_match_title`, `best_match_start_time`, `best_match_venue`,
  `field_completeness`, `execution_ms`, `error`
- **`benchmark-<timestamp>.json`** — statistical summary with per-fetcher recall, error rate, avg events extracted, avg field completeness, avg execution time, and a head-to-head comparison

The CSV is written incrementally, so you can inspect partial results if the run is interrupted.

### Example Report Output

```
════════════════════════════════════════════════════════════
BENCHMARK REPORT
════════════════════════════════════════════════════════════
Sample: 50 events

PLAYWRIGHT
  Recall:               82.0% (41/50)
  Error rate:           4.0% (2 errors)
  Avg events extracted: 3.2
  Avg field completeness (matched): 68.5%
  Avg execution time:   3450ms

JINA
  Recall:               74.0% (37/50)
  Error rate:           2.0% (1 errors)
  Avg events extracted: 2.8
  Avg field completeness (matched): 65.1%
  Avg execution time:   1820ms

COMPARISON
  Recall delta (playwright − jina): +8.0%
  Winner: playwright
  Playwright matched, jina didn't: 6
  Jina matched, playwright didn't: 2
════════════════════════════════════════════════════════════
```

### Prerequisites

- `wrangler` must be on your `PATH` and authenticated (`wrangler whoami`)
- LLM provider configured in `.env` (same as fixture tests)
- `JINA_API_KEY` in `.env` if benchmarking the Jina fetcher

## Directory Structure

```
tests/
├── fixtures/               # Test HTML/image snapshots and metadata
│   ├── example-music-venue.html
│   ├── example-music-venue.metadata.json
│   ├── event-flyer.jpg
│   ├── event-flyer.metadata.json
│   └── ... (more fixtures)
├── snapshots/              # Test results and reports
│   ├── report-2026-03-02T10-00-00.json
│   ├── report-2026-03-02T10-00-00.md
│   └── human-reviews.json
├── benchmark-results/      # DB benchmark output (CSV + JSON)
│   ├── benchmark-2026-04-13T19-37-10.csv
│   └── benchmark-2026-04-13T19-37-10.json
├── types.ts                # TypeScript type definitions
├── capture-fixture.ts      # Tool to capture live sites or create image fixtures
├── test-runner.ts          # Main test orchestrator
├── evaluator.ts            # Metrics calculation
├── human-review.ts         # Interactive review CLI
├── report.ts               # Report generation
├── db-benchmark.ts         # Live DB benchmark tool
└── README.md               # This file
```

## Test Workflow

### 1. Run Tests

```bash
npm run test
```

This runs all fixtures through all modes and generates:

- Automated metrics (recall, completeness, duplicates)
- Execution timing
- Error tracking
- JSON report in `tests/snapshots/`

### 2. Review Results

```bash
npm run test:review
```

Interactive CLI that:

- Shows extracted events for each mode
- Prompts for human judgment:
  - How many events are correct?
  - How many are partially correct?
  - How many are incorrect?
  - How many are hallucinated (not on page)?
- Saves reviews to `tests/snapshots/human-reviews.json`

### 3. Generate Report

```bash
npm run test:report
```

Generates:

- Summary by mode (avg recall, time, completeness)
- Detailed per-fixture results
- Human review precision scores
- Recommendations for improvement
- Markdown report in `tests/snapshots/`

## Metrics Explained

### Automated Metrics

**Recall**: What percentage of expected events were found?

```
recall = expectedEventsFound / totalExpectedEvents
```

**Field Completeness**: What percentage of optional fields are populated?

```
completeness = filledOptionalFields / totalOptionalFields
```

Optional fields: `description`, `url`, `venue_name`, `address`, `end_time`, `tags`

**Duplicates**: Number of duplicate events extracted (same title + date)

### Human Review Metrics

**Precision**: What percentage of extracted events are correct?

```
precision = (correct + partial * 0.5) / totalExtracted
```

**Hallucination Rate**: Percentage of events not actually on the page

```
hallucinationRate = hallucinated / totalExtracted
```

## Evaluation Strategy

### What Makes a Good Test Fixture?

1. **Listing Pages** - Multiple events (tests recall)
2. **Single Event Pages** - Rich detail (tests completeness)
3. **Complex Layouts** - Navigation, ads, etc. (tests noise filtering)
4. **Image Fixtures** - Flyers, posters, screenshots (tests vision extraction)
5. **Edge Cases** - Unusual formats, missing data (tests robustness)

### Recommended Fixture Tags

- `listing-page` - Multiple events on one page
- `single-event` - Individual event page
- `calendar` - Calendar/schedule format
- `image` - Image-based fixture (flyer, poster, screenshot)
- `flyer` - Event flyer or poster
- `screenshot` - Screenshot from social media or website
- `complex-layout` - Lots of non-event content
- `minimal-info` - Sparse event details
- Site-specific: `eventbrite`, `dice`, `meetup`, `instagram`, etc.

### Difficulty Levels

- **Easy** - Clean HTML, clear structure, all fields present
- **Medium** - Some noise, missing fields, moderate complexity
- **Hard** - Complex layout, heavy JS, unusual format, sparse data

## Example Test Report Output

```
==========================================================
📊 TEST SUMMARY
==========================================================

DIRECT:
  Average Recall:       85.0%
  Average Completeness: 72.5%
  Average Time:         1250ms
  Errors:               0

DISCOVER:
  Average Recall:       92.3%
  Average Completeness: 68.0%
  Average Time:         2100ms
  Errors:               0
```

## Tips for Effective Testing

### Before Making Changes

1. Run tests to establish baseline: `npm run test`
2. Review and save human judgments: `npm run test:review`
3. Generate baseline report: `npm run test:report`

### After Making Changes

1. Run tests again: `npm run test`
2. Review new results: `npm run test:review`
3. Generate comparison report: `npm run test:report`
4. Compare metrics to baseline

### Tracking Progress

- Keep old reports in `tests/snapshots/` for comparison
- Name reports descriptively if testing specific features
- Document significant changes in fixture notes

## Advanced Usage

### Test Specific Combinations

```bash
# Test only discover mode with Jina fetcher
npm run test -- --modes discover --fetchers jina

# Test only image mode
npm run test -- --modes image

# Test multiple specific fixtures
npm run test -- --fixtures eventbrite-listing,dice-calendar,event-flyer

# Test image fixtures only
npm run test -- --fixtures event-flyer --modes image

# Test with a specific model
npm run test -- --model google/gemini-2.0-flash-exp:free

# Compare multiple models
npm run test -- --models "meta-llama/llama-3.1-8b-instruct:free,google/gemini-2.0-flash-exp:free,anthropic/claude-3.5-sonnet"

```

### Capture Fixtures from Multiple Pages

Create a script:

```bash
#!/bin/bash

npm run test:capture -- "https://dice.fm/events" dice-listing
npm run test:capture -- "https://www.eventbrite.com/d/ca--sf/events/" eventbrite-sf
npm run test:capture -- "https://www.meetup.com/find/" meetup-find
```

### Continuous Testing

Add to your development workflow:

```bash
# Run tests on every significant change
git add -A
npm run test
npm run test:review
git commit -m "Improved extraction accuracy"
```

## Troubleshooting

### Tests Failing to Run

- Ensure LLM provider is configured in `.env` (`LLM_PROVIDER`, `OPENROUTER_MODEL`, or equivalent)
- Verify fixtures directory exists with valid `.metadata.json` files

### Low Recall Scores

- Check that `expectedEvents` in metadata matches actual page content
- Verify metadata uses correct date formats (ISO 8601)
- Ensure fuzzy matching tolerances are appropriate

### Review Tool Not Working

- Make sure test has been run first (`npm run test`)
- Check that report exists in `tests/snapshots/`
- Verify terminal supports interactive input

## Contributing Fixtures

Good test fixtures help everyone! When adding fixtures:

1. Choose diverse, real-world event pages
2. Fill in complete metadata with accurate expected events
3. Add descriptive notes about what makes the fixture interesting
4. Tag appropriately for easy filtering
5. Test both easy and hard cases

## License

Same as parent project.

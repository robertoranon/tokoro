/**
 * Parameters governing duplicate event detection.
 * All distance, time, and similarity thresholds live here so they can be
 * tuned in one place. Used by the worker POST handler, the crawler-worker
 * pre-publish check, and the check-duplicate diagnostic script.
 */

/** Haversine distance below which two events are considered co-located (km). */
export const DEDUP_DISTANCE_KM = 0.5;

/**
 * Half-width of the time window used when searching for duplicate candidates (ms).
 * Applied as ±DEDUP_TIME_WINDOW_MS around the incoming event's start_time.
 * Used by the crawler-worker API query and the worker's code-level time filter.
 */
export const DEDUP_TIME_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Half-width of the broader SQL query window in the worker (ms).
 * Must be ≥ DEDUP_TIME_WINDOW_MS; the stricter DEDUP_TIME_WINDOW_MS filter
 * is applied in code after the DB query returns.
 */
export const DEDUP_SQL_BUFFER_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Title Levenshtein similarity at or above which events are immediately flagged
 *  as duplicates without consulting the LLM. */
export const LEVENSHTEIN_FAST_PATH = 0.9;

/** Title Levenshtein similarity threshold used when no LLM is available. */
export const LEVENSHTEIN_FALLBACK = 0.8;

/** LLM probability at or above which two events are considered duplicates. */
export const LLM_PROBABILITY_THRESHOLD = 0.7;

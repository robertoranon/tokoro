/**
 * Token and content length limits for LLM-based extraction.
 * Centralised here so crawler, crawler-worker, and shared extractors stay in sync.
 *
 * Usage scope:
 *   - DEFAULT_*        : crawler (direct/discover modes) + crawler-worker (no overrides)
 *   - FESTIVAL_*       : crawler festival mode only
 *   - IMAGE_MAX_TOKENS : shared EventExtractor (crawler + crawler-worker)
 *   - PAGE_DISCOVERY_* : crawler PageDiscovery + crawler-worker PageDiscovery
 */

/** Max characters of cleaned page text sent to the LLM for regular page extraction.
 *  Used by: crawler (direct/discover), crawler-worker */
export const DEFAULT_MAX_CONTENT_LENGTH = 30000;

/** Max characters of cleaned page text sent to the LLM in festival mode (larger pages).
 *  Used by: crawler (festival mode only) */
export const FESTIVAL_MAX_CONTENT_LENGTH = 50000;

/** Max output tokens for regular event extraction.
 *  Used by: crawler (direct/discover), crawler-worker */
export const DEFAULT_MAX_TOKENS = 10000;

/** Max output tokens for festival mode extraction (more events per page).
 *  Used by: crawler (festival mode only) */
export const FESTIVAL_MAX_TOKENS = 20000;

/** Max output tokens for image/flyer extraction.
 *  Used by: shared EventExtractor (crawler + crawler-worker) */
export const IMAGE_MAX_TOKENS = 4000;

/** Max output tokens for page discovery (link list, not full events).
 *  Used by: crawler PageDiscovery, crawler-worker PageDiscovery */
export const PAGE_DISCOVERY_MAX_TOKENS = 2000;

/** Max output tokens for festival listing discovery (identifying program sub-pages).
 *  Used by: crawler PageDiscovery (festival mode only) */
export const FESTIVAL_LISTING_MAX_TOKENS = 1000;

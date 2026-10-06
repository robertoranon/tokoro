import type { FetchedPage } from '../types/event.js';

// Bot-protection interstitials are tiny pages; a long page that merely
// mentions "captcha" is real content.
const MAX_BLOCK_PAGE_CHARS = 3000;

const BLOCK_TITLE =
  /attention required|just a moment|access denied|you have been blocked|are you a (?:robot|human)|human verification|security check/i;

const BLOCK_TEXT =
  /sorry, you have been blocked|verify (?:that )?you are (?:a )?human|checking your browser before accessing|enable javascript and cookies to continue|unusual traffic from your computer|complete the captcha/i;

/** True when a fetched page looks like a bot-protection page, not content. */
export function looksBlocked(title: string, text: string): boolean {
  const body = text ?? '';
  if (body.length > MAX_BLOCK_PAGE_CHARS) return false;
  return BLOCK_TITLE.test(title ?? '') || BLOCK_TEXT.test(body);
}

/**
 * Throws when the page is a bot-protection block, so the source is reported
 * as failed instead of silently yielding "no shows" (or no links).
 */
export function assertNotBlocked(page: FetchedPage): FetchedPage {
  if (looksBlocked(page.title, page.text)) {
    throw new Error(
      `Blocked by bot protection ("${(page.title || 'no title').slice(0, 60)}") at ${page.url}`
    );
  }
  return page;
}

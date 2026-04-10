/**
 * HTML cleaning utilities shared between the standalone crawler and crawler-worker.
 * Uses regex-based parsing (no DOM dependency) so it works in any JS environment,
 * including Cloudflare Workers.
 */

// Tags whose entire content should be removed (not just the tags themselves)
const CONTENT_TAGS = ['script', 'style', 'noscript', 'iframe', 'canvas', 'svg'];

/**
 * Strips HTML tags and decodes common entities from a string.
 * Used to clean description fields that may contain HTML markup (e.g. from JSON-LD).
 */
export function stripHtmlTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    // Decode numeric HTML entities (e.g. &#8217; → ' and &#x2019; → ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    // Decode common named entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * Extract clean text and title from rendered HTML.
 * Removes non-content elements (scripts, styles, etc.) and strips all markup.
 */
export function extractCleanText(html: string): { text: string; title: string } {
  let cleaned = html;

  // Remove content tags along with their inner content
  for (const tag of CONTENT_TAGS) {
    cleaned = cleaned.replace(new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  }

  // Remove void/self-closing non-content tags
  cleaned = cleaned.replace(/<(?:img|meta)[^>]*>/gi, ' ');

  // Remove link[rel=stylesheet]
  cleaned = cleaned.replace(/<link[^>]*\brel=["']?stylesheet["']?[^>]*>/gi, ' ');

  // Extract title before stripping all remaining tags
  const titleMatch = cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : '';

  // Strip all remaining HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  cleaned = cleaned
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Remove empty lines and collapse excess whitespace
  const text = cleaned
    .split('\n')
    .map(line => line.replace(/ {2,}/g, ' ').trim())
    .filter(line => line.length > 0)
    .join('\n')
    .trim();

  return { title, text };
}

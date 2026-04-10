/**
 * Simple HTML to markdown converter for Cloudflare Workers
 * No JSDOM dependency - works with plain HTML strings
 */

/**
 * Convert HTML content to simple markdown-like text
 * This is a simplified converter that focuses on preserving structure for event extraction
 *
 * @param html - HTML content
 * @returns Simplified markdown text
 */
export function htmlToMarkdown(html: string): string {
  // Simple HTML to markdown conversion
  // Replace common HTML tags with markdown equivalents
  let text = html
    // Headers
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<h4[^>]*>(.*?)<\/h4>/gi, '\n#### $1\n')
    .replace(/<h5[^>]*>(.*?)<\/h5>/gi, '\n##### $1\n')
    .replace(/<h6[^>]*>(.*?)<\/h6>/gi, '\n###### $1\n')

    // Bold and italic
    .replace(/<(strong|b)[^>]*>(.*?)<\/(strong|b)>/gi, '**$2**')
    .replace(/<(em|i)[^>]*>(.*?)<\/(em|i)>/gi, '*$2*')

    // Links
    .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)')

    // Lists
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<\/?[ou]l[^>]*>/gi, '\n')

    // Paragraphs and breaks
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')

    // Remove all other HTML tags
    .replace(/<[^>]+>/g, '')

    // Decode HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")

    // Clean up whitespace
    .replace(/\n\s*\n\s*\n/g, '\n\n') // Max 2 consecutive newlines
    .trim();

  return text;
}

/**
 * Extract title from HTML and convert to markdown
 * Note: HTML processing happens in the Chrome extension,
 * this just does basic HTML to markdown conversion
 *
 * @param html - cleaened HTML string (already processed in extension)
 * @param url - The URL of the page
 * @returns Object with title and markdown content
 */
export function extractAndConvertToMarkdown(
  html: string,
  url: string
): { title: string; markdown: string } {
  // Extract title from HTML
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : 'Untitled';

  // Convert HTML to markdown
  const markdown = htmlToMarkdown(html);

  return {
    title,
    markdown,
  };
}

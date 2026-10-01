import { JSDOM, VirtualConsole } from 'jsdom';
import type { FetchedPage } from '../types/event.js';

const silentConsole = new VirtualConsole();

export interface PageLink {
  text: string;
  url: string;
}

// Social profiles are never a festival's official site.
const SOCIAL_HOSTS = [
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'linkedin.com',
  'pinterest.com',
  't.me',
  'wa.me',
];

function isSocial(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return SOCIAL_HOSTS.some(d => host === d || host.endsWith(`.${d}`));
}

/**
 * Anchor text + absolute URL for every outbound link of a fetched page.
 * The fetchers' `text` has no URLs (the HTML cleaner strips tags), so links
 * come from `html`; Jina's markdown `text` is the fallback.
 */
export function extractLinks(page: FetchedPage, max = 300): PageLink[] {
  const out = new Map<string, PageLink>();
  const self = page.url.replace(/#.*$/, '').replace(/\/$/, '');

  const add = (rawText: string, href: string) => {
    let u: URL;
    try {
      u = new URL(href, page.url);
    } catch {
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (isSocial(u.hostname)) return;
    u.hash = '';
    const url = u.href;
    if (url.replace(/\/$/, '') === self) return;
    if (out.has(url)) return;
    const text = rawText.replace(/\s+/g, ' ').trim().slice(0, 80);
    out.set(url, { text: text || u.hostname, url });
  };

  if (page.html) {
    const dom = new JSDOM(page.html, {
      url: page.url,
      virtualConsole: silentConsole,
    });
    for (const a of Array.from(
      dom.window.document.querySelectorAll('a[href]')
    )) {
      add(a.textContent ?? '', a.getAttribute('href') ?? '');
    }
  }

  if (out.size === 0 && page.text) {
    for (const m of page.text.matchAll(
      /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g
    )) {
      add(m[1], m[2]);
    }
  }

  return [...out.values()].slice(0, max);
}

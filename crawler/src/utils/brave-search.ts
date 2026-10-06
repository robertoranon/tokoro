export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type SearchFn = (query: string) => Promise<SearchResult[]>;

interface BraveResponse {
  web?: {
    results?: { title?: string; url?: string; description?: string }[];
  };
}

/** Brave Search web API as a SearchFn (top 8 results, tags stripped from snippets). */
export function braveSearch(
  apiKey: string,
  fetchFn: typeof fetch = fetch
): SearchFn {
  return async query => {
    const res = await fetchFn(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`,
      {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': apiKey,
        },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) throw new Error(`Brave search failed (${res.status})`);
    const data = (await res.json()) as BraveResponse;
    return (data.web?.results ?? [])
      .filter(r => !!r.url)
      .map(r => ({
        title: r.title ?? '',
        url: r.url as string,
        snippet: (r.description ?? '').replace(/<[^>]*>/g, ''),
      }));
  };
}

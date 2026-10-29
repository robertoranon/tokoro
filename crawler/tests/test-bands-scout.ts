import { parseBandList } from '../src/tours/band-list.js';
import {
  fetchSpotifyPlaylist,
  parsePlaylist,
  playlistToBandListText,
  spotifyPlaylistId,
} from '../src/tours/playlist.js';
import {
  countDateMentions,
  looksLikeShowListing,
  saysNoEvents,
} from '../src/tours/page-signals.js';
import {
  appendBands,
  knownBandName,
  type NewBand,
} from '../src/tours/bands-append.js';
import { parseBandsConfig } from '../src/tours/bands-config.js';
import { braveSearch } from '../src/utils/brave-search.js';
import {
  findBand,
  isDeniedHost,
  type FinderDeps,
  type SearchResult,
} from '../src/tours/band-finder.js';
import {
  parseArgs,
  confirmBands,
  formatReport,
  type ScoutReport,
} from '../src/bands-scout.js';
import type { FetchedPage } from '../src/types/event.js';
import type { LLMProvider } from '../../shared/types/llm.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
void throws; // used by later sections

type FakeLLM = LLMProvider & { calls: number; prompts: string[] };

/** `answer(system, user)` returns the raw reply for each call. */
function fakeLLM(answer: (system: string, user: string) => string): FakeLLM {
  const llm: FakeLLM = {
    name: 'fake',
    calls: 0,
    prompts: [],
    async complete(messages: any) {
      llm.calls++;
      const system = String(messages[0].content);
      const user = String(messages[1].content);
      llm.prompts.push(user);
      return { content: answer(system, user), model: 'fake' };
    },
  };
  return llm;
}

const page = (url: string, html: string, text = 'x'): FetchedPage => ({
  url,
  html,
  text,
  title: 'T',
});

async function main() {
  console.log('\n=== parseBandList ===\n');
  {
    const r = parseBandList(
      [
        '﻿# my list',
        '',
        'Test Band',
        '  Sigur Rós  ',
        'Other Band | https://other.example/',
        'Hinted Band|https://hinted.example',
        'test band', // duplicate of the first (case-insensitive)
        'Sigur Ros', // duplicate (accent-insensitive)
        'Bad Hint | not a url',
        '   |https://nameless.example',
        '!!!',
        'Band # with hash',
      ].join('\n')
    );
    assert(
      r.bands.map(b => b.name).join(',') ===
        'Test Band,Sigur Rós,Other Band,Hinted Band,Band # with hash',
      'names kept in order, trimmed; comments/blank/BOM ignored'
    );
    assert(
      r.bands[2].hint === 'https://other.example/',
      'hint parsed and trimmed'
    );
    assert(
      r.bands[3].hint === 'https://hinted.example',
      'hint without spaces around |'
    );
    assert(r.bands[0].hint === undefined, 'no hint when absent');
    assert(
      r.duplicates.join(',') === 'test band,Sigur Ros',
      'in-file duplicates reported (first wins)'
    );
    assert(
      r.invalid.length === 3,
      'bad hint, empty name and name without letters are invalid'
    );
    assert(
      r.invalid.some(l => l.includes('Bad Hint')),
      'invalid lines are reported verbatim'
    );
    assert(parseBandList('').bands.length === 0, 'empty input → no bands');
    assert(
      parseBandList('\r\nA\r\nB\r\n').bands.length === 2,
      'CRLF line endings'
    );
  }

  console.log('\n=== appendBands ===\n');
  {
    const base = `# header comment
defaults:
  fetcher: playwright

# The registry
bands:
  - name: Test Band
    url: https://testband.example
    aliases: ["The Test Band"]
    # a curator note
    status: active

# The pages to read
sources:
  - url: https://testband.example/live
    mode: band
    band: Test Band
`;
    const nb = (over: Partial<NewBand> = {}): NewBand => ({
      name: 'New Band',
      url: 'https://newband.example',
      tourUrl: 'https://newband.example/live',
      note: 'bands-scout: test',
      ...over,
    });

    // adds a band and its source, keeping comments and section order
    {
      const r = appendBands(base, [nb()], '2030-10-07');
      const cfg = parseBandsConfig(r.text);
      assert(r.added.length === 1 && r.skipped.length === 0, 'one band added');
      assert(
        cfg.bands.length === 2 && cfg.sources.length === 2,
        'band and source present after re-parse'
      );
      assert(
        cfg.bands[0].name === 'New Band' && cfg.bands[0].added === '2030-10-07',
        'name and added date written (sorted before Test Band)'
      );
      assert(cfg.bands[0].notes === 'bands-scout: test', 'note written');
      assert(
        cfg.sources[0].mode === 'band' &&
          cfg.sources[0].url === 'https://newband.example/live',
        'band-mode source written (sorted before Test Band)'
      );
      for (const c of [
        '# header comment',
        '# The registry',
        '# a curator note',
        '# The pages to read',
      ]) {
        assert(r.text.includes(c), `comment kept: ${c}`);
      }
      const iNew = r.text.indexOf('New Band');
      assert(
        iNew > r.text.indexOf('# The registry') &&
          iNew < r.text.indexOf('- name: Test Band') &&
          r.text.indexOf('# a curator note') <
            r.text.indexOf('# The pages to read'),
        'new band sorted inside the bands block, before the next section comment'
      );
      assert(
        r.text.indexOf('newband.example/live') <
          r.text.indexOf('band: Test Band'),
        'new source sorted inside sources'
      );
      assert(
        r.text.endsWith('\n') && !r.text.endsWith('\n\n'),
        'exactly one trailing newline'
      );
    }

    // duplicates: by name, alias, accent-insensitive name, url, and within the batch
    {
      const r = appendBands(
        base,
        [
          nb({ name: 'test band', url: 'https://x1.example' }),
          nb({ name: 'The Test Band', url: 'https://x2.example' }),
          nb({ name: 'Different Name', url: 'https://testband.example/' }),
          nb({
            name: 'Fresh',
            url: 'https://fresh.example',
            tourUrl: undefined,
          }),
          nb({ name: 'FRESH', url: 'https://fresh2.example' }),
          nb({ name: 'Third', url: 'https://fresh.example' }),
        ],
        '2030-10-07'
      );
      assert(
        r.added.map(a => a.name).join() === 'Fresh',
        'only the genuinely new band is added'
      );
      assert(r.skipped.length === 5, 'five duplicates skipped');
      assert(
        r.skipped[0].reason === 'name' && r.skipped[0].existing === 'Test Band',
        'name duplicate names the existing band'
      );
      assert(r.skipped[1].reason === 'name', 'alias duplicate');
      assert(
        r.skipped[2].reason === 'url',
        'url duplicate (trailing slash ignored)'
      );
      assert(
        r.skipped[3].reason === 'name' && r.skipped[4].reason === 'url',
        'in-batch duplicates by name and by url'
      );
      const cfg = parseBandsConfig(r.text);
      assert(
        cfg.bands.length === 2 && cfg.sources.length === 1,
        'no source added for a band without a tour page'
      );
    }

    // a tour page already used as a source is not added twice
    {
      const r = appendBands(
        base,
        [nb({ tourUrl: 'https://testband.example/live/' })],
        '2030-10-07'
      );
      assert(r.added.length === 1, 'band still added');
      assert(
        r.sourceSkipped.length === 1 && r.sourceSkipped[0].name === 'New Band',
        'duplicate source reported'
      );
      assert(
        parseBandsConfig(r.text).sources.length === 1,
        'duplicate source not written'
      );
    }

    // nothing to add → text untouched
    {
      const r = appendBands(base, [nb({ name: 'Test Band' })], '2030-10-07');
      assert(
        r.text === base && r.added.length === 0,
        'unchanged text when nothing is added'
      );
    }

    // empty flow lists
    {
      const r = appendBands('bands: []\nsources: []\n', [nb()], '2030-10-07');
      const cfg = parseBandsConfig(r.text);
      assert(
        cfg.bands.length === 1 && cfg.sources.length === 1,
        'bands: [] and sources: [] converted to block form'
      );
      assert(!r.text.includes('[]'), 'no leftover []');
    }
    {
      const r = appendBands(
        'bands: [] # none yet\nsources:\n',
        [nb()],
        '2030-10-07'
      );
      assert(
        r.text.includes('bands: # none yet') &&
          parseBandsConfig(r.text).bands.length === 1,
        'trailing comment on a [] key is kept'
      );
    }

    // sources key absent
    {
      const r = appendBands(
        'bands:\n  - name: A\n    url: https://a.example\n',
        [nb()],
        '2030-10-07'
      );
      const cfg = parseBandsConfig(r.text);
      assert(
        cfg.bands.length === 2 && cfg.sources.length === 1,
        'missing sources: key is created'
      );
    }

    // bands key absent
    {
      const r = appendBands(
        'sources:\n  - url: https://s.example\n    mode: listing\n',
        [nb()],
        '2030-10-07'
      );
      const cfg = parseBandsConfig(r.text);
      assert(
        cfg.bands.length === 1 && cfg.sources.length === 2,
        'missing bands: key is created before sources'
      );
      assert(
        r.text.indexOf('bands:') < r.text.indexOf('sources:'),
        'bands precede sources'
      );
    }

    // special characters survive
    {
      const r = appendBands(
        base,
        [nb({ name: 'Sigur "Rós": the #1 band', note: 'a: b # c' })],
        '2030-10-07'
      );
      const cfg = parseBandsConfig(r.text);
      const sigur = cfg.bands.find(b => b.name.startsWith('Sigur'));
      assert(
        sigur?.name === 'Sigur "Rós": the #1 band' &&
          sigur.notes === 'a: b # c',
        'quotes, colons and # are escaped'
      );
    }

    // both lists are sorted alphabetically, entries keep their comments
    {
      const messy = `defaults:
  fetcher: playwright

bands:
  # registry header comment
  - name: Zeta
    url: https://zeta.example

  # Moved here from the old list
  - name: alpha
    url: https://alpha.example
    # inner note
    status: paused

  - name: The Cure
    url: https://thecure.example

# Column-0 comment before sources
sources:
  - url: https://venue.example/agenda
    mode: listing

  - url: https://zeta.example/live
    mode: band
    band: Zeta

  - url: https://alpha.example/tour
    mode: band
    band: alpha
`;
      const r = appendBands(
        messy,
        [
          nb({
            name: 'Mogwai',
            url: 'https://mogwai.example',
            tourUrl: 'https://mogwai.example/live',
          }),
        ],
        '2030-10-07'
      );
      const cfg = parseBandsConfig(r.text);
      assert(
        cfg.bands.map(b => b.name).join() === 'alpha,Mogwai,The Cure,Zeta',
        'bands sorted by name, case-insensitive'
      );
      assert(
        cfg.sources.map(s => s.url).join() ===
          'https://alpha.example/tour,https://mogwai.example/live,https://zeta.example/live,https://venue.example/agenda',
        'band sources by band name, then listing sources'
      );
      assert(
        cfg.bands[0].status === 'paused',
        'item fields move with the item'
      );
      assert(
        r.text.indexOf('# Moved here from the old list') <
          r.text.indexOf('- name: alpha') &&
          r.text.indexOf('# Moved here from the old list') >
            r.text.indexOf('# registry header comment'),
        'comment above an item moves with it'
      );
      assert(
        r.text.indexOf('# inner note') > r.text.indexOf('- name: alpha') &&
          r.text.indexOf('# inner note') < r.text.indexOf('- name: "Mogwai"'),
        'comment inside an item stays inside it'
      );
      assert(
        r.text.indexOf('# registry header comment') < r.text.indexOf('- name:'),
        'comment above the first item stays at the top of the section'
      );
      assert(
        r.text.indexOf('# Column-0 comment before sources') >
          r.text.indexOf('- name: Zeta') &&
          r.text.indexOf('# Column-0 comment before sources') <
            r.text.indexOf('sources:'),
        'column-0 comment before the next key stays put'
      );
      assert(
        r.text.includes('url: https://thecure.example\n\n  - name: Zeta'),
        'items stay separated by a blank line'
      );
    }

    // refuses to write something it cannot prove safe
    {
      assert(
        throws(() =>
          appendBands(
            'bands: [{name: A, url: "https://a.example"}]\nsources: []\n',
            [nb()],
            '2030-10-07'
          )
        ),
        'a non-empty flow-style list is refused (re-parse check)'
      );
      assert(
        throws(() => appendBands('not: [valid', [nb()], '2030-10-07')),
        'invalid input YAML is refused'
      );
    }
  }

  console.log('\n=== knownBandName ===\n');
  {
    const cfg = parseBandsConfig(
      'bands:\n  - name: Sigur Rós\n    url: https://sigur.example\n    aliases: ["SR"]\nsources:\n'
    );
    assert(
      knownBandName(cfg, 'sigur ros') === 'Sigur Rós',
      'accent/case-insensitive name'
    );
    assert(knownBandName(cfg, 'SR') === 'Sigur Rós', 'alias');
    assert(knownBandName(cfg, 'Nobody') === undefined, 'unknown');
  }

  console.log('\n=== braveSearch ===\n');
  {
    const calls: { url: string; headers: any }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          web: {
            results: [
              {
                title: 'Test Band',
                url: 'https://testband.example',
                description: 'The <strong>official</strong> site',
              },
              { title: 'no url' },
            ],
          },
        }),
      } as Response;
    }) as unknown as typeof fetch;
    const results = await braveSearch(
      'KEY',
      fakeFetch
    )('"Test Band" official site');
    assert(results.length === 1, 'results without a url are dropped');
    assert(
      results[0].snippet === 'The official site',
      'html tags stripped from the snippet'
    );
    assert(
      calls[0].url.includes('q=%22Test%20Band%22%20official%20site'),
      'query is url-encoded'
    );
    assert(
      (calls[0].headers as any)['X-Subscription-Token'] === 'KEY',
      'subscription token header'
    );
    const failing = braveSearch(
      'KEY',
      (async () =>
        ({ ok: false, status: 429 }) as Response) as unknown as typeof fetch
    );
    assert(
      await failing('x').then(
        () => false,
        e => /429/.test(String(e))
      ),
      'non-2xx rejects with the status'
    );
    const empty = braveSearch(
      'KEY',
      (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({}),
        }) as Response) as unknown as typeof fetch
    );
    assert((await empty('x')).length === 0, 'no web results → empty list');
  }

  console.log('\n=== isDeniedHost ===\n');
  {
    for (const u of [
      'https://www.facebook.com/testband',
      'https://open.spotify.com/artist/1',
      'https://testband.bandcamp.com/',
      'https://en.wikipedia.org/wiki/Test',
      'https://www.songkick.com/artists/1',
      'https://x.com/testband',
      'https://music.apple.com/it/artist/x',
    ]) {
      assert(isDeniedHost(u), `denied: ${u}`);
    }
    for (const u of [
      'https://testband.example',
      'https://last.example/',
      'https://www.testband.it/live',
      'https://notfacebook.com',
    ]) {
      assert(!isDeniedHost(u), `allowed: ${u}`);
    }
    assert(isDeniedHost('not a url'), 'unparseable urls are denied');
  }

  console.log('\n=== findBand ===\n');
  {
    const results: SearchResult[] = [
      {
        title: 'Test Band - Facebook',
        url: 'https://www.facebook.com/testband',
        snippet: '',
      },
      {
        title: 'Test Band',
        url: 'https://testband.example/en/home?utm=1',
        snippet: 'official site',
      },
    ];
    const homeHtml =
      '<a href="/live">Live</a><a href="/music">Music</a><a href="https://shop.example/x">Shop</a>';
    const llmFor = (opts: {
      site?: string | null;
      tour?: string | null;
      homepageShows?: boolean;
    }) =>
      fakeLLM((system, _user) => {
        if (/search results/i.test(system))
          return JSON.stringify({ url: opts.site ?? null });
        return JSON.stringify({
          tour_url: opts.tour ?? null,
          homepage_lists_shows: !!opts.homepageShows,
        });
      });
    const mkDeps = (
      llm: LLMProvider,
      over: Partial<FinderDeps> = {}
    ): FinderDeps => ({
      llm,
      search: async () => results,
      fetchPage: async url => page(url, homeHtml, 'some text'),
      ...over,
    });

    // happy path: search → site → tour page
    {
      const llm = llmFor({
        site: 'https://testband.example/en/home?utm=1',
        tour: 'https://testband.example/live',
      });
      const o = await findBand({ name: 'Test Band' }, mkDeps(llm));
      assert(o.status === 'found', 'found');
      if (o.status === 'found') {
        assert(
          o.siteUrl === 'https://testband.example/en/home',
          'site normalised (query dropped)'
        );
        assert(
          o.tourUrl === 'https://testband.example/live',
          'tour page is the chosen link'
        );
        assert(
          /search/.test(o.note) && /links/.test(o.note),
          'note says how it was found'
        );
      }
    }

    // the LLM cannot invent a url that was not in the results
    {
      const llm = llmFor({ site: 'https://invented.example' });
      assert(
        (await findBand({ name: 'Test Band' }, mkDeps(llm))).status ===
          'no_site',
        'url outside the results is rejected'
      );
    }
    // nor pick a denied host even if it is in the results
    {
      const llm = llmFor({ site: 'https://www.facebook.com/testband' });
      assert(
        (await findBand({ name: 'Test Band' }, mkDeps(llm))).status ===
          'no_site',
        'denied host is rejected after the LLM answer'
      );
    }
    // LLM says none
    assert(
      (await findBand({ name: 'Test Band' }, mkDeps(llmFor({ site: null }))))
        .status === 'no_site',
      'LLM picks nothing → no_site'
    );
    // empty search results → no LLM call
    {
      const llm = llmFor({ site: 'x' });
      const o = await findBand(
        { name: 'Test Band' },
        mkDeps(llm, { search: async () => [] })
      );
      assert(
        o.status === 'no_site' && llm.calls === 0,
        'no results → no_site without an LLM call'
      );
    }
    // not searched
    {
      const o = await findBand(
        { name: 'Test Band' },
        mkDeps(llmFor({}), { search: undefined })
      );
      assert(
        o.status === 'not_searched',
        'no search configured and no hint → not_searched'
      );
    }
    // hint skips the search
    {
      let searched = 0;
      const llm = llmFor({ tour: 'https://hinted.example/live' });
      const o = await findBand(
        { name: 'Hinted', hint: 'https://hinted.example/' },
        mkDeps(llm, {
          search: async () => {
            searched++;
            return [];
          },
          fetchPage: async u => page(u, '<a href="/live">Live</a>'),
        })
      );
      assert(searched === 0, 'a hint skips the search');
      assert(
        o.status === 'found' &&
          o.siteUrl === 'https://hinted.example' &&
          /given/.test(o.note),
        'hint used as the site'
      );
    }
    // tour link must be one of the page's links
    {
      const llm = llmFor({
        site: 'https://testband.example/en/home?utm=1',
        tour: 'https://testband.example/invented',
      });
      const o = await findBand({ name: 'Test Band' }, mkDeps(llm));
      assert(
        o.status === 'no_tour_page',
        'a tour url that is not a link on the page is rejected'
      );
    }
    // no tour link but the homepage itself lists shows
    {
      const llm = llmFor({
        site: 'https://testband.example/en/home?utm=1',
        tour: null,
        homepageShows: true,
      });
      const o = await findBand({ name: 'Test Band' }, mkDeps(llm));
      assert(
        o.status === 'found' &&
          o.tourUrl === 'https://testband.example/en/home',
        'single-page site: the homepage is the tour page'
      );
    }
    // no tour page at all
    {
      const llm = llmFor({
        site: 'https://testband.example/en/home?utm=1',
        tour: null,
        homepageShows: false,
      });
      const o = await findBand({ name: 'Test Band' }, mkDeps(llm));
      assert(
        o.status === 'no_tour_page' &&
          o.siteUrl === 'https://testband.example/en/home',
        'site known, no tour page'
      );
      if (o.status === 'no_tour_page')
        assert(
          /by hand/.test(o.note),
          'note tells the curator to add a source by hand'
        );
    }
    // tour page that does not load / is empty
    {
      const llm = llmFor({
        site: 'https://testband.example/en/home?utm=1',
        tour: 'https://testband.example/live',
      });
      const o1 = await findBand(
        { name: 'Test Band' },
        mkDeps(llm, {
          fetchPage: async u => {
            if (u.endsWith('/live')) throw new Error('404');
            return page(u, homeHtml);
          },
        })
      );
      assert(
        o1.status === 'found' &&
          o1.tourUrl === 'https://testband.example/live' &&
          /not verified/.test(o1.note),
        'tour link whose page fails to load is still used, flagged as not verified'
      );
      const o2 = await findBand(
        { name: 'Test Band' },
        mkDeps(llm, {
          fetchPage: async u =>
            u.endsWith('/live') ? page(u, '', '   ') : page(u, homeHtml),
        })
      );
      assert(
        o2.status === 'found' &&
          o2.tourUrl === 'https://testband.example/live' &&
          /not verified/.test(o2.note),
        'tour link whose page is empty is still used, flagged as not verified'
      );
    }
    // aggregator fallback: blocked site, or no tour page on it
    {
      const bitUrl = 'https://www.bandsintown.com/a/123-test-band';
      const withAgg: SearchResult[] = [
        ...results,
        { title: 'Test Band Tour Dates', url: bitUrl, snippet: 'concerts' },
      ];
      const aggLLM = (pick: string | null) =>
        fakeLLM((system, _user) => {
          if (/Bandsintown or Songkick/.test(system))
            return JSON.stringify({ url: pick });
          if (/search results/i.test(system))
            return JSON.stringify({
              url: 'https://testband.example/en/home?utm=1',
            });
          return JSON.stringify({
            tour_url: null,
            homepage_lists_shows: false,
          });
        });
      const blockedSite = async (url: string) => {
        if (url.includes('bandsintown'))
          return page(url, '', 'Test Band concerts');
        throw new Error('Blocked by bot protection');
      };

      const o = await findBand(
        { name: 'Test Band' },
        mkDeps(aggLLM(bitUrl), {
          search: async () => withAgg,
          fetchPage: blockedSite,
        })
      );
      assert(
        o.status === 'found' && o.tourUrl === bitUrl,
        'blocked site → aggregator page used as tour page'
      );
      if (o.status === 'found')
        assert(
          o.siteUrl === 'https://testband.example/en/home' &&
            /aggregator/.test(o.note),
          'site kept, note says aggregator'
        );

      const noTour = await findBand(
        { name: 'Test Band' },
        mkDeps(aggLLM(bitUrl), {
          search: async () => withAgg,
          fetchPage: async url =>
            page(url, '<a href="/music">M</a>', 'Test Band concerts'),
        })
      );
      assert(
        noTour.status === 'found' && noTour.tourUrl === bitUrl,
        'no tour page on the site → aggregator page'
      );

      const wrongBand = await findBand(
        { name: 'Test Band' },
        mkDeps(aggLLM(bitUrl), {
          search: async () => withAgg,
          fetchPage: async url =>
            url.includes('bandsintown')
              ? page(url, '', 'Other Artist events')
              : blockedSite(url),
        })
      );
      assert(
        wrongBand.status === 'error',
        'aggregator page not naming the band is rejected (original error kept)'
      );

      const invented = await findBand(
        { name: 'Test Band' },
        mkDeps(aggLLM('https://www.songkick.com/artists/999'), {
          search: async () => withAgg,
          fetchPage: blockedSite,
        })
      );
      assert(
        invented.status === 'error',
        'aggregator url outside the results is rejected'
      );

      const noAgg = await findBand(
        { name: 'Test Band' },
        mkDeps(aggLLM(null), {
          search: async () => results,
          fetchPage: async url =>
            page(url, '<a href="/music">M</a>', 'some text'),
        })
      );
      assert(
        noAgg.status === 'no_tour_page',
        'no aggregator in results → unchanged no_tour_page'
      );
    }
    // errors are contained
    {
      const o = await findBand(
        { name: 'Test Band' },
        mkDeps(llmFor({}), {
          search: async () => {
            throw new Error('boom');
          },
        })
      );
      assert(
        o.status === 'error' && /boom/.test(o.error),
        'search error → error outcome'
      );
      const llmBad = fakeLLM(() => 'not json');
      const o2 = await findBand({ name: 'Test Band' }, mkDeps(llmBad));
      assert(o2.status === 'error', 'malformed LLM json → error outcome');
      const o3 = await findBand(
        { name: 'Test Band' },
        mkDeps(llmFor({ site: 'https://testband.example/en/home?utm=1' }), {
          fetchPage: async () => {
            throw new Error('dns');
          },
        })
      );
      assert(
        o3.status === 'error' && /dns/.test(o3.error),
        'homepage fetch failure → error outcome'
      );
    }
    // the LLM only ever sees fetched data
    {
      const llm = llmFor({
        site: 'https://testband.example/en/home?utm=1',
        tour: null,
      });
      await findBand({ name: 'Test Band' }, mkDeps(llm));
      assert(
        llm.prompts[0].includes('https://testband.example/en/home?utm=1') &&
          llm.prompts[0].includes('Test Band'),
        'site prompt carries the name and the search results'
      );
      assert(
        llm.prompts[1].includes('https://testband.example/live'),
        'tour prompt carries the homepage links'
      );
    }

    // the LLM gets the whole homepage and every link, not a prefix
    {
      const longText = 'intro '.repeat(2000) + 'FAR-END-MARKER';
      const manyLinks = Array.from(
        { length: 300 },
        (_, i) => `<a href="/p${i}">Page ${i}</a>`
      ).join('');
      const llm = llmFor({
        site: 'https://testband.example/en/home?utm=1',
        tour: null,
      });
      await findBand(
        { name: 'Test Band' },
        mkDeps(llm, {
          fetchPage: async u => page(u, manyLinks, longText),
        })
      );
      assert(
        llm.prompts[1].includes('FAR-END-MARKER'),
        'text beyond the first few thousand characters reaches the LLM'
      );
      assert(
        llm.prompts[1].includes('/p299'),
        'links beyond the first 200 reach the LLM'
      );
    }

    // dates far down the homepage count even when the LLM says no
    {
      const text =
        'Welcome to the band site. '.repeat(900) +
        ' Live dates: 12 Nov 2030 Udine, 20 Nov 2030 Ljubljana';
      const llm = llmFor({
        site: 'https://testband.example/en/home?utm=1',
        tour: null,
        homepageShows: false,
      });
      const o = await findBand(
        { name: 'Test Band' },
        mkDeps(llm, { fetchPage: async u => page(u, '', text) })
      );
      assert(
        o.status === 'found' &&
          o.tourUrl === 'https://testband.example/en/home',
        'several dates + tour wording anywhere on the homepage → the homepage is the tour page'
      );
    }

    // "no upcoming events" is still the page to check
    {
      const llm = llmFor({
        site: 'https://testband.example/en/home?utm=1',
        tour: null,
        homepageShows: false,
      });
      const o = await findBand(
        { name: 'Test Band' },
        mkDeps(llm, {
          fetchPage: async u =>
            page(u, '', 'Latest news. Tour: No upcoming events at the moment.'),
        })
      );
      assert(
        o.status === 'found' &&
          o.tourUrl === 'https://testband.example/en/home' &&
          /no events are scheduled/.test(o.note),
        'a homepage saying there are no upcoming events is used as the tour page'
      );
    }

    // news dates without tour wording are not a show listing
    {
      const llm = llmFor({
        site: 'https://testband.example/en/home?utm=1',
        tour: null,
        homepageShows: false,
      });
      const o = await findBand(
        { name: 'Test Band' },
        mkDeps(llm, {
          fetchPage: async u =>
            page(
              u,
              '',
              'Album news 3 Mar 2030. Interview 14 Apr 2030. Press kit.'
            ),
        })
      );
      assert(
        o.status === 'no_tour_page',
        'dates alone (news archive) are not enough'
      );
    }
  }

  console.log('\n=== page signals ===\n');
  {
    assert(
      countDateMentions(
        '12 Nov 2030, Nov 20, 3rd March, 12.11.2030, 2030-11-12'
      ) === 5,
      'five date forms counted'
    );
    assert(
      countDateMentions('12 novembre, 3 février, 5. März, 7 juil') === 4,
      'Italian, French and German month names'
    );
    assert(
      countDateMentions('We played 300 shows and 12 cities') === 0,
      'numbers alone are not dates'
    );
    assert(
      looksLikeShowListing('Tour dates: 12 Nov Udine, 20 Nov Ljubljana'),
      'dates + tour wording'
    );
    assert(
      !looksLikeShowListing('News 12 Nov, interview 20 Nov'),
      'dates without tour wording'
    );
    assert(
      !looksLikeShowListing('Live at 12 Nov'),
      'one date is not a listing'
    );
    for (const t of [
      'No upcoming events',
      'There are no upcoming shows',
      'no events scheduled',
      'Nothing scheduled right now',
      'Keine aktuellen Termine',
      'Nessun concerto in programma',
      'Aucune date pour le moment',
      'No Upcoming Shows',
    ]) {
      assert(saysNoEvents(t), `says no events: "${t}"`);
    }
    assert(
      !saysNoEvents('Upcoming events: 12 Nov Udine'),
      'a real listing does not say none'
    );
    assert(!saysNoEvents('We have no idea what comes next'), 'unrelated "no"');
  }

  console.log('\n=== parsePlaylist ===\n');
  {
    const track = (artist: string) =>
      `<key>1</key><dict><key>Name</key><string>Song</string><key>Album Artist</key><string>VA</string><key>Artist</key><string>${artist}</string></dict>`;
    const xml = `<?xml version="1.0"?><plist version="1.0"><dict><key>Tracks</key><dict>${[
      'Sigur R&#243;s',
      'Mogwai',
      'Mogwai feat. Someone',
      'Godspeed You! Black Emperor',
      'Sigur Ros',
      'Mogwai',
      'Nick &amp; June | x',
    ]
      .map(track)
      .join('')}</dict></dict></plist>`;
    const a = parsePlaylist(xml);
    assert(a?.format === 'apple-xml', 'Apple XML detected');
    assert(
      a?.artists.map(x => `${x.name}:${x.tracks}`).join(',') ===
        'Mogwai:3,Sigur Rós:2,Godspeed You! Black Emperor:1,Nick & June x:1',
      'artists ranked by tracks, entities decoded, feat. stripped, accents merged, | removed, Album Artist ignored'
    );
    assert(
      playlistToBandListText(a!, 2) === 'Mogwai\nSigur Rós',
      'min tracks filters'
    );

    const csv = [
      'Track URI,Track Name,Album Name,Artist Name(s),Release Date',
      'spotify:track:1,"Hello, World",Alb,Low;Other,2020',
      'spotify:track:2,Two,Alb,"Low",2020',
      'spotify:track:3,"Multi\nline",Alb,"Tool",2020',
    ].join('\r\n');
    const c = parsePlaylist(csv);
    assert(c?.format === 'spotify-csv', 'Spotify CSV detected');
    assert(
      c?.artists.map(x => `${x.name}:${x.tracks}`).join(',') === 'Low:2,Tool:1',
      'first artist of a track used, quoted fields handled'
    );

    assert(
      parsePlaylist('Mogwai\nLow\n') === null,
      'plain list is not a playlist'
    );
    assert(parsePlaylist('') === null, 'empty is not a playlist');
    assert(
      parsePlaylist('<html><body>x</body></html>') === null,
      'non-plist XML is not a playlist'
    );
  }

  console.log('\n=== Spotify playlist link ===\n');
  {
    assert(
      spotifyPlaylistId(
        'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc'
      ) === '37i9dQZF1DXcBWIGoYBM5M',
      'id from link'
    );
    assert(
      spotifyPlaylistId('https://open.spotify.com/intl-it/playlist/AbC123') ===
        'AbC123',
      'id from localized link'
    );
    assert(
      spotifyPlaylistId('spotify:playlist:AbC123') === 'AbC123',
      'id from URI'
    );
    assert(
      spotifyPlaylistId('https://evil.example/playlist/AbC123') === null,
      'other hosts rejected'
    );
    assert(spotifyPlaylistId('list.txt') === null, 'file name is not a link');
    const data = {
      props: {
        pageProps: {
          state: {
            data: {
              entity: {
                trackList: [
                  { subtitle: 'Low, Other' },
                  { subtitle: 'Low' },
                  { subtitle: 'Tool' },
                ],
              },
            },
          },
        },
      },
    };
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;
    let url = '';
    const ok = (async (u: string) => {
      url = u;
      return new Response(html);
    }) as unknown as typeof fetch;
    const r = await fetchSpotifyPlaylist(
      'https://open.spotify.com/playlist/AbC123',
      ok
    );
    assert(
      url === 'https://open.spotify.com/embed/playlist/AbC123',
      'embed page requested'
    );
    assert(
      r.format === 'spotify-url' &&
        r.artists.map(x => `${x.name}:${x.tracks}`).join(',') ===
          'Low:2,Tool:1',
      'artists read, first of each track'
    );
    const bad = (async () =>
      new Response('<html></html>')) as unknown as typeof fetch;
    let msg = '';
    try {
      await fetchSpotifyPlaylist('spotify:playlist:AbC123', bad);
    } catch (e) {
      msg = String(e);
    }
    assert(
      /Exportify/.test(msg),
      'unreadable page → error pointing to the CSV route'
    );
    const nf = (async () =>
      new Response('', { status: 404 })) as unknown as typeof fetch;
    msg = '';
    try {
      await fetchSpotifyPlaylist('spotify:playlist:AbC123', nf);
    } catch (e) {
      msg = String(e);
    }
    assert(/404/.test(msg), 'HTTP error reported');
  }

  console.log('\n=== confirmBands ===\n');
  {
    const mk = (n: string) => ({
      name: n,
      url: `https://${n}.example`,
      tourUrl: `https://${n}.example/live`,
      note: 'n',
    });
    const run = async (answers: string[]) => {
      const asked: string[] = [];
      const r = await confirmBands([mk('a'), mk('b'), mk('c')], async q => {
        asked.push(q);
        return answers.shift() ?? 'n';
      });
      return { ...r, asked: asked.length };
    };
    let r = await run(['y', 'n', 'y']);
    assert(
      r.accepted.map(b => b.name).join() === 'a,c' && r.declined.join() === 'b',
      'y/n per band'
    );
    r = await run(['', 'yes', 'N']);
    assert(
      r.accepted.map(b => b.name).join() === 'b' && r.declined.join() === 'a,c',
      'empty answer means no'
    );
    r = await run(['a']);
    assert(
      r.accepted.length === 3 && r.asked === 1,
      '"a" accepts this and all remaining'
    );
    r = await run(['y', 'q']);
    assert(
      r.accepted.map(b => b.name).join() === 'a' && r.declined.join() === 'b,c',
      '"q" declines the rest'
    );
  }

  console.log('\n=== parseArgs ===\n');
  {
    const a = parseArgs(['node', 'x', 'list.txt']);
    assert(
      a.inputFile === 'list.txt' && a.bandsFile === 'bands.yaml' && !a.dryRun,
      'defaults'
    );
    const b = parseArgs([
      'node',
      'x',
      '--dry-run',
      '--bands',
      'my.yaml',
      'in.txt',
      '--fetcher',
      'jina',
    ]);
    assert(
      b.inputFile === 'in.txt' &&
        b.bandsFile === 'my.yaml' &&
        b.dryRun &&
        b.fetcher === 'jina',
      'flags and positional in any order'
    );
    assert(parseArgs(['node', 'x']).inputFile === undefined, 'no input file');
    assert(
      throws(() => parseArgs(['node', 'x', 'a.txt', '--fetcher', 'weird'])),
      'invalid fetcher rejected'
    );
    assert(
      throws(() => parseArgs(['node', 'x', 'a.txt', '--nope'])),
      'unknown flag rejected'
    );
  }

  console.log('\n=== formatReport ===\n');
  {
    const report: ScoutReport = {
      dryRun: false,
      added: [
        {
          name: 'A Band',
          url: 'https://a.example',
          tourUrl: 'https://a.example/live',
          note: 'n',
        },
        { name: 'B Band', url: 'https://b.example', note: 'n' },
      ],
      alreadyPresent: [{ name: 'C Band', existing: 'C Band (alias)' }],
      noSite: ['D Band'],
      notSearched: ['E Band'],
      errors: [{ name: 'F Band', error: 'boom' }],
      sourceSkipped: [{ name: 'A Band', tourUrl: 'https://a.example/live' }],
      invalidLines: ['!!!'],
      declined: ['G Band'],
    };
    const out = formatReport(report);
    assert(
      out.includes('A Band') && out.includes('https://a.example/live'),
      'added band with its tour page'
    );
    assert(
      /B Band.*no tour page/s.test(out),
      'band without a tour page is flagged'
    );
    assert(out.includes('C Band'), 'already present listed');
    assert(out.includes('D Band') && /no site/i.test(out), 'no site listed');
    assert(
      out.includes('E Band') && /BRAVE_SEARCH_API_KEY/.test(out),
      'not searched explains the missing key'
    );
    assert(out.includes('F Band') && out.includes('boom'), 'errors listed');
    assert(out.includes('!!!'), 'invalid input lines listed');
    assert(
      /Declined/.test(out) && out.includes('G Band') && /1 declined/.test(out),
      'declined bands listed'
    );
    assert(!/dry run/i.test(out), 'no dry-run banner on a real run');
    assert(
      /dry run/i.test(formatReport({ ...report, dryRun: true })),
      'dry-run banner on a dry run'
    );
    assert(/2 added/.test(out), 'totals');
  }

  {
    assert(
      parseArgs(['node', 'x', 'p.xml', '--min-tracks', '3']).minTracks === 3,
      '--min-tracks parsed'
    );
    assert(
      parseArgs(['node', 'x', 'p.xml']).minTracks === 1,
      '--min-tracks defaults to 1'
    );
    let threw = false;
    try {
      parseArgs(['node', 'x', 'p.xml', '--min-tracks', '0']);
    } catch {
      threw = true;
    }
    assert(threw, '--min-tracks 0 rejected');
    assert(
      parseArgs(['node', 'x', 'p.xml', '--yes']).yes === true,
      '--yes parsed'
    );
    assert(
      parseArgs(['node', 'x', 'p.xml']).yes === false,
      '--yes off by default'
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

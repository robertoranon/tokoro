import { parseBandList } from '../src/tours/band-list.js';
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
        cfg.bands[1].name === 'New Band' && cfg.bands[1].added === '2030-10-07',
        'name and added date written'
      );
      assert(cfg.bands[1].notes === 'bands-scout: test', 'note written');
      assert(
        cfg.sources[1].mode === 'band' &&
          cfg.sources[1].url === 'https://newband.example/live',
        'band-mode source written'
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
        iNew > r.text.indexOf('# a curator note') &&
          iNew < r.text.indexOf('# The pages to read'),
        'new band lands at the end of the bands block, before the next section comment'
      );
      assert(
        r.text.indexOf('newband.example/live') >
          r.text.indexOf('band: Test Band'),
        'new source lands at the end of sources'
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
      assert(
        cfg.bands[1].name === 'Sigur "Rós": the #1 band' &&
          cfg.bands[1].notes === 'a: b # c',
        'quotes, colons and # are escaped'
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
        o1.status === 'no_tour_page',
        'tour page fetch failure → no_tour_page'
      );
      const o2 = await findBand(
        { name: 'Test Band' },
        mkDeps(llm, {
          fetchPage: async u =>
            u.endsWith('/live') ? page(u, '', '   ') : page(u, homeHtml),
        })
      );
      assert(o2.status === 'no_tour_page', 'empty tour page → no_tour_page');
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
    assert(!/dry run/i.test(out), 'no dry-run banner on a real run');
    assert(
      /dry run/i.test(formatReport({ ...report, dryRun: true })),
      'dry-run banner on a dry run'
    );
    assert(/2 added/.test(out), 'totals');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

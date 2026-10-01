import {
  matchEdition,
  differs,
  RadarPublisher,
  type ExistingEntry,
} from '../src/radar/radar-publisher.js';
import { EventNormalizer } from '../src/utils/normalizer.js';
import type { NormalizedEvent } from '../src/types/event.js';
import {
  parseFestivalEntry,
  hasDates,
  normalizeRadarDates,
  applyYearCorrection,
  mergeEntries,
  isPastEntry,
  stripEdition,
  finalizeRadarEntry,
  resolveEntryDraft,
  hasYearEvidence,
  type FestivalEntryDraft,
} from '../src/radar/festival-entry.js';
import type { FetchedPage } from '../src/types/event.js';
import { FestivalEntryExtractor } from '../src/extractors/festival-entry-extractor.js';
import { PageDiscovery } from '../src/extractors/page-discovery.js';
import type { LLMProvider } from '../../shared/types/llm.js';
import {
  parseFestivalsConfig,
  normalizeFestivalUrl,
  activeFestivals,
} from '../src/radar/festivals-config.js';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as nodePath from 'path';
import {
  findStaleFestivals,
  appendRunLog,
  readRunRecords,
  STALE_WINDOW,
  type RunRecord,
} from '../src/utils/run-log.js';
import { tallyOutcomes } from '../src/radar.js';

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

console.log('\n=== normalizeFestivalUrl ===\n');
{
  assert(
    normalizeFestivalUrl('https://Fest.Example/') === 'https://fest.example',
    'lowercases host and strips trailing slash'
  );
  assert(
    normalizeFestivalUrl('https://fest.example/en/?utm=1#top') ===
      'https://fest.example/en',
    'drops query and hash, keeps path without trailing slash'
  );
  assert(
    normalizeFestivalUrl('http://fest.example:8080/x//') ===
      'http://fest.example:8080/x',
    'keeps port, strips repeated trailing slashes'
  );
  assert(
    throws(() => normalizeFestivalUrl('not a url')),
    'rejects garbage'
  );
  assert(
    throws(() => normalizeFestivalUrl('ftp://fest.example')),
    'rejects non-http(s) protocols'
  );
}

console.log('\n=== parseFestivalsConfig ===\n');
{
  const cfg = parseFestivalsConfig(`
defaults:
  fetcher: jina
festivals:
  - url: https://www.terraforma.example/
    name: Terraforma
    added: 2026-07-22
    notes: "forest setting"
  - url: https://jazz.example
    status: paused
    fetcher: playwright
    browser: obscura
    model: some-model
`);
  assert(cfg.festivals.length === 2, 'parses two festivals');
  const [a, b] = cfg.festivals;
  assert(a.url === 'https://www.terraforma.example', 'url is normalized');
  assert(a.status === 'active', 'status defaults to active');
  assert(
    a.added === '2026-07-22',
    'unquoted YAML date becomes YYYY-MM-DD string'
  );
  assert(a.fetcher === 'jina', 'defaults.fetcher applies when entry has none');
  assert(a.notes === 'forest setting', 'notes preserved');
  assert(b.status === 'paused', 'explicit status kept');
  assert(b.fetcher === 'playwright', 'entry fetcher overrides default');
  assert(
    b.browser === 'obscura' && b.model === 'some-model',
    'browser/model overrides'
  );
  assert(
    activeFestivals(cfg).length === 1 &&
      activeFestivals(cfg)[0].url === 'https://www.terraforma.example',
    'activeFestivals skips paused entries'
  );
}
{
  assert(
    parseFestivalsConfig('festivals: []').festivals.length === 0,
    'empty festivals list is valid'
  );
  assert(
    throws(() => parseFestivalsConfig('')),
    'empty file throws'
  );
  assert(
    throws(() => parseFestivalsConfig('defaults: {}')),
    'missing festivals throws'
  );
  assert(
    throws(() => parseFestivalsConfig('festivals:\n  - name: x')),
    'entry without url throws'
  );
  assert(
    throws(() => parseFestivalsConfig('festivals:\n  - url: nope')),
    'invalid url throws'
  );
  assert(
    throws(() =>
      parseFestivalsConfig(
        'festivals:\n  - url: https://a.example\n    status: weird'
      )
    ),
    'invalid status throws'
  );
  assert(
    throws(() =>
      parseFestivalsConfig(
        'festivals:\n  - url: https://a.example\n    fetcher: nope'
      )
    ),
    'invalid fetcher throws'
  );
  assert(
    throws(() =>
      parseFestivalsConfig('defaults:\n  browser: nope\nfestivals: []')
    ),
    'invalid default browser throws'
  );
  assert(
    throws(() =>
      parseFestivalsConfig(
        'festivals:\n  - url: https://a.example/\n  - url: https://a.example'
      )
    ),
    'duplicate urls (after normalization) throw'
  );
}

console.log('\n=== parseFestivalsConfig strictness ===\n');
{
  const one = (extra: string) =>
    parseFestivalsConfig('festivals:\n  - url: https://a.example\n' + extra);
  assert(
    throws(() => one('    name: 5')),
    'non-string name throws'
  );
  assert(
    throws(() => one('    notes: 5')),
    'non-string notes throws'
  );
  assert(
    throws(() => one('    model: 5')),
    'non-string model throws'
  );
  assert(
    throws(() => parseFestivalsConfig('defaults:\n  model: 5\nfestivals: []')),
    'non-string defaults.model throws'
  );
  assert(
    throws(() => one('    status: null')),
    'null status throws'
  );
  assert(
    one('').festivals[0].status === 'active',
    'absent status defaults to active'
  );
  assert(
    parseFestivalsConfig('festivals:').festivals.length === 0,
    'null festivals is an empty list'
  );
  assert(
    throws(() => parseFestivalsConfig('festivals: notalist')),
    'string festivals throws'
  );
  assert(
    throws(() => parseFestivalsConfig('festivals:\n  a: 1')),
    'object festivals throws'
  );
  assert(
    parseFestivalsConfig('festivals:\n  - url: https://Upper.Example/x/')
      .festivals[0].url === 'https://upper.example/x',
    'config entry url is normalized to lowercase host'
  );
  let msg = '';
  try {
    one('').festivals.length;
    parseFestivalsConfig('festivals:\n  - url: ftp://a.example');
  } catch (e) {
    msg = (e as Error).message;
  }
  assert(msg.includes('Unsupported protocol'), 'bad url error includes reason');
}

console.log('\n=== parseFestivalEntry ===\n');
{
  const d = parseFestivalEntry(
    {
      title: 'Terraforma 2026',
      description: null,
      start_time: '2026-06-18T00:00:00',
      end_time: '2026-06-21T23:59:59',
      category: 'music',
      lat: null,
      tags: ['Electronic'],
    },
    'https://terra.example'
  );
  assert(d !== null && d.title === 'Terraforma 2026', 'parses a valid object');
  assert(
    d?.description === undefined && d?.lat === undefined,
    'null fields become undefined'
  );
  assert(d?.url === 'https://terra.example', 'url defaults to the page url');
  assert(
    parseFestivalEntry([{ title: 'A', category: 'music' }], 'https://x.example')
      ?.title === 'A',
    'takes the first element of an array'
  );
  assert(
    parseFestivalEntry({ title: 'No cat' }, 'https://x.example')?.category ===
      'other',
    'missing category defaults to other'
  );
  assert(parseFestivalEntry(null, 'https://x.example') === null, 'null → null');
  assert(
    parseFestivalEntry({}, 'https://x.example') === null,
    'missing title → null'
  );
  assert(
    parseFestivalEntry({ title: 'Bad', category: 'weird' }, 'https://x.example')
      ?.category === 'other',
    'unknown category → entry kept with category other'
  );
  assert(
    parseFestivalEntry({ title: 'F', category: 'food' }, 'https://x.example')
      ?.category === 'other',
    'food → other'
  );
  assert(
    parseFestivalEntry({ title: 'F', category: 'music' }, 'https://x.example')
      ?.category === 'music',
    'music stays music'
  );
  assert(
    parseFestivalEntry({ title: 'F' }, 'https://x.example')?.category ===
      'other',
    'missing category → other'
  );
  assert(
    parseFestivalEntry(
      { festival: { title: 'Wrapped', category: 'art' } },
      'https://x.example'
    )?.title === 'Wrapped',
    'single-key wrapper object is unwrapped'
  );
  assert(
    parseFestivalEntry({ title: 'X' }, 'https://x.example')?.title === 'X',
    'single-key that is a known field is not unwrapped'
  );
}

console.log('\n=== hasDates / normalizeRadarDates ===\n');
{
  const base = { title: 'F', category: 'music' as const };
  assert(!hasDates(null), 'null has no dates');
  assert(
    !hasDates({ ...base, start_time: '2026-06-18T00:00:00' }),
    'start only → no dates'
  );
  assert(
    hasDates({
      ...base,
      start_time: '2026-06-18T00:00:00',
      end_time: '2026-06-21T23:59:59',
    }),
    'start+end → dates'
  );
  assert(
    !hasDates({
      ...base,
      start_time: '2026-06-21T00:00:00',
      end_time: '2026-06-18T23:59:59',
    }),
    'end before start → no dates'
  );
  assert(
    !hasDates({ ...base, start_time: 'June 18', end_time: 'June 21' }),
    'non-ISO strings → no dates'
  );
  const n = normalizeRadarDates({
    ...base,
    start_time: '2026-06-18T19:30:00',
    end_time: '2026-06-21T22:00:00',
  });
  assert(
    n.start_time === '2026-06-18T00:00:00' &&
      n.end_time === '2026-06-21T23:59:59',
    'forces T00:00:00 / T23:59:59 conventions'
  );
  const partial = normalizeRadarDates({
    ...base,
    start_time: '2026-06-18T19:30:00',
  });
  assert(
    partial.start_time === '2026-06-18T19:30:00',
    'leaves partial dates untouched'
  );
}

console.log('\n=== applyYearCorrection ===\n');
{
  const base = { title: 'F', category: 'music' as const };
  // 2026-06-18 is a Thursday.
  const ok = applyYearCorrection({
    ...base,
    start_time: '2026-06-18T00:00:00',
    end_time: '2026-06-21T23:59:59',
    day_name: 'Thursday',
  });
  assert(
    ok.start_time === '2026-06-18T00:00:00' && !('day_name' in ok),
    'matching day_name kept, field stripped'
  );
  // 2026-06-17 is a Wednesday but 2027-06-17 is a Thursday, so the year is off by one.
  const shifted = applyYearCorrection({
    ...base,
    start_time: '2026-06-17T00:00:00', // Wednesday in 2026, Thursday in 2027
    end_time: '2026-06-20T23:59:59',
    day_name: 'Thursday',
  });
  assert(
    shifted.start_time === '2027-06-17T00:00:00' &&
      shifted.end_time === '2027-06-20T23:59:59',
    'day_name matching next year shifts both dates'
  );
  const dropped = applyYearCorrection({
    ...base,
    start_time: '2026-06-18T00:00:00',
    end_time: '2026-06-21T23:59:59',
    day_name: 'Tuesday', // matches neither 2026 nor 2027 nor 2025
  });
  assert(
    dropped.start_time === undefined &&
      dropped.end_time === undefined &&
      dropped.title === 'F',
    'unresolvable day_name strips dates but keeps the rest'
  );
  const noDates = applyYearCorrection({ ...base, day_name: 'Monday' });
  assert(!('day_name' in noDates), 'no start_time: day_name is just stripped');
}

console.log('\n=== mergeEntries ===\n');
{
  const home: FestivalEntryDraft = {
    title: 'Terraforma',
    category: 'other',
    description: 'Homepage blurb',
  };
  const info: FestivalEntryDraft = {
    title: 'Terraforma 2026 – Info',
    category: 'music',
    description: 'Other blurb',
    address: 'Villa Arconati, Bollate',
    start_time: '2026-06-18T00:00:00',
    end_time: '2026-06-21T23:59:59',
  };
  const m = mergeEntries(home, info)!;
  assert(m.title === 'Terraforma', 'never overwrites existing title');
  assert(
    m.description === 'Homepage blurb',
    'never overwrites existing description'
  );
  assert(m.address === 'Villa Arconati, Bollate', 'fills missing address');
  assert(m.category === 'music', "treats category 'other' as empty");
  assert(
    m.start_time === '2026-06-18T00:00:00' &&
      m.end_time === '2026-06-21T23:59:59',
    'fills dates as a pair'
  );
  assert(mergeEntries(null, info) === info, 'null base → extra');
  assert(mergeEntries(home, null) === home, 'null extra → base');
  const withDates = {
    ...home,
    start_time: '2026-08-01T00:00:00',
    end_time: '2026-08-02T23:59:59',
  };
  assert(
    mergeEntries(withDates, info)!.start_time === '2026-08-01T00:00:00',
    'existing dates are not replaced'
  );
}

console.log('\n=== isPastEntry / stripEdition / finalizeRadarEntry ===\n');
{
  const dated = {
    title: 'Terraforma 2026',
    category: 'music' as const,
    start_time: '2026-06-18T00:00:00',
    end_time: '2026-06-21T23:59:59',
  };
  assert(!isPastEntry(dated, '2026-06-21'), 'ends today → not past');
  assert(!isPastEntry(dated, '2026-06-19'), 'running now → not past');
  assert(isPastEntry(dated, '2026-06-22'), 'ended yesterday → past');

  assert(
    stripEdition('Terraforma 2026') === 'Terraforma',
    'strips trailing year'
  );
  assert(stripEdition('Sónar 2026/27') === 'Sónar', 'strips year range');
  assert(
    stripEdition('Jazz em Agosto') === 'Jazz em Agosto',
    'leaves names without a year'
  );
  assert(stripEdition('2026') === '2026', 'never returns an empty name');

  const e = finalizeRadarEntry(
    {
      ...dated,
      tags: ['Electronic', 'festival'],
      festival_name: 'Terraforma 2026',
    },
    'https://terra.example'
  );
  assert(
    e.festival_url === 'https://terra.example',
    'festival_url is the watchlist url'
  );
  assert(e.festival_name === 'Terraforma', 'festival_name has no year');
  assert(
    e.tags!.length === 2 &&
      e.tags!.includes('electronic') &&
      e.tags!.includes('festival'),
    "tags lowercased, deduplicated, always include 'festival'"
  );
  assert(e.url === 'https://terra.example', 'url falls back to the homepage');
  const e2 = finalizeRadarEntry(dated, 'https://terra.example');
  assert(
    e2.festival_name === 'Terraforma',
    'festival_name falls back to the title minus year'
  );
  assert(
    JSON.stringify(e2.tags) === '["festival"]',
    "tags default to ['festival']"
  );
}

console.log('\n=== resolveEntryDraft ===\n');
{
  const page = (url: string): FetchedPage => ({
    url,
    html: '',
    text: '',
    title: url,
  });
  const dated: FestivalEntryDraft = {
    title: 'F',
    category: 'music',
    start_time: '2026-06-18T00:00:00',
    end_time: '2026-06-21T23:59:59',
  };
  const undated: FestivalEntryDraft = { title: 'F', category: 'music' };

  // Dates on the homepage: no discovery, no extra fetches.
  {
    let discovered = 0;
    const r = await resolveEntryDraft(page('https://f.example'), {
      extract: async () => dated,
      discoverInfoPages: async () => {
        discovered++;
        return [];
      },
      fetchPage: async u => page(u),
    });
    assert(r === dated && discovered === 0, 'dates on homepage → no discovery');
  }
  // Dates on the second info page: stops there, never touches a third.
  {
    const fetched: string[] = [];
    const responses: Record<string, FestivalEntryDraft> = {
      'https://f.example': undated,
      'https://f.example/a': undated,
      'https://f.example/b': { ...undated, address: 'Somewhere', ...dated },
    };
    const r = await resolveEntryDraft(page('https://f.example'), {
      extract: async p => responses[p.url] ?? undated,
      discoverInfoPages: async () => [
        'https://f.example/a',
        'https://f.example/b',
        'https://f.example/c',
      ],
      fetchPage: async u => {
        fetched.push(u);
        return page(u);
      },
    });
    assert(hasDates(r), 'merged draft has dates');
    assert(
      fetched.join() === 'https://f.example/a,https://f.example/b',
      'fetches at most two info pages and stops once dates are found'
    );
  }
  // Nothing ever has dates: returns the undated draft.
  {
    const r = await resolveEntryDraft(page('https://f.example'), {
      extract: async () => undated,
      discoverInfoPages: async () => ['https://f.example/a'],
      fetchPage: async u => page(u),
    });
    assert(r !== null && !hasDates(r), 'no dates anywhere → undated draft');
  }
  // A failing info page does not fail the entry.
  {
    const r = await resolveEntryDraft(page('https://f.example'), {
      extract: async p => (p.url === 'https://f.example/b' ? dated : undated),
      discoverInfoPages: async () => [
        'https://f.example/a',
        'https://f.example/b',
      ],
      fetchPage: async u => {
        if (u.endsWith('/a')) throw new Error('boom');
        return page(u);
      },
    });
    assert(hasDates(r), 'skips a broken info page and keeps going');
  }
}

console.log('\n=== review fixes: sanitizing / real dates / finalize ===\n');
{
  const P = 'https://page.example';
  const pf = (o: Record<string, unknown>) =>
    parseFestivalEntry({ title: 'T', category: 'music', ...o }, P);
  assert(
    pf({ url: 'not a url' })?.url === P,
    'invalid url falls back to page url'
  );
  assert(
    pf({ lat: '45.5', lng: '9.2' })?.lat === 45.5,
    'numeric-string lat coerced'
  );
  const oor = pf({ lat: 123, lng: 9 });
  assert(
    oor !== null && oor.lat === undefined && oor.lng === 9,
    'out-of-range lat dropped, entry survives'
  );
  assert(pf({ lat: 'abc' })?.lat === undefined, 'NaN lat dropped');
  assert(
    JSON.stringify(pf({ tags: 'a, b ,,c' })?.tags) === '["a","b","c"]',
    'tags string split on commas'
  );
  assert(
    JSON.stringify(pf({ tags: ['a', 3, ' ', null, ' b '] })?.tags) ===
      '["a","b"]',
    'tags filtered to non-empty strings'
  );
  assert(pf({ tags: [1, ''] })?.tags === undefined, 'empty tags dropped');
  const junk = pf({
    festival_url: 'junk',
    start_time_utc: 5,
    end_time_utc: {},
  });
  assert(
    junk !== null &&
      junk.festival_url === undefined &&
      junk.start_time_utc === undefined,
    'junk festival_url / utc fields ignored'
  );
  assert(
    pf({ start_time: 20260618 })?.start_time === '20260618',
    'numeric start_time coerced to string'
  );
  assert(pf({ title: '' }) === null, 'empty title still null');

  const b = { title: 'F', category: 'music' as const };
  assert(
    !hasDates({
      ...b,
      start_time: '2026-02-31T00:00:00',
      end_time: '2026-03-05T00:00:00',
    }),
    '2026-02-31 → no dates'
  );
  assert(
    !hasDates({ ...b, start_time: '2026-13-45', end_time: '2026-13-46' }),
    '2026-13-45 → no dates'
  );
  assert(
    hasDates({ ...b, start_time: '2026-06-18', end_time: '2026-06-21' }),
    'date-only strings count'
  );
  const nd = normalizeRadarDates({
    ...b,
    start_time: '2026-06-18',
    end_time: '2026-06-21',
  });
  assert(
    nd.start_time === '2026-06-18T00:00:00' &&
      nd.end_time === '2026-06-21T23:59:59',
    'date-only normalizes'
  );
  const bad = normalizeRadarDates({
    ...b,
    start_time: '2026-02-31',
    end_time: '2026-03-01',
  });
  assert(bad.start_time === '2026-02-31', 'impossible date left untouched');

  const f = finalizeRadarEntry(
    {
      ...b,
      start_time: '2026-06-18T00:00:00',
      end_time: '2026-06-21T23:59:59',
      tags: [' Jazz ', '', '  ', 'JAZZ'],
      festival_name: '',
    },
    'https://terra.example'
  );
  assert(
    JSON.stringify(f.tags) === '["jazz","festival"]',
    'tags trimmed, empties dropped, deduped'
  );
  assert(f.festival_name === 'F', 'empty festival_name falls back to title');
}

type FakeLLM = LLMProvider & {
  calls: number;
  messages: { role: string; content: string }[][];
  options: any[];
};

function fakeLLM(reply: string | (() => string)): FakeLLM {
  const llm: FakeLLM = {
    name: 'fake',
    calls: 0,
    messages: [],
    options: [],
    async complete(messages: any, options?: any) {
      llm.calls++;
      llm.messages.push(messages);
      llm.options.push(options);
      return {
        content: typeof reply === 'function' ? reply() : reply,
        model: 'fake',
      };
    },
  };
  return llm;
}

console.log('\n=== FestivalEntryExtractor ===\n');
{
  const page: FetchedPage = {
    url: 'https://terra.example',
    html: '',
    text: 'Terraforma 2026\n\n\n18-21 June, Villa Arconati',
    title: 'Terraforma',
  };
  const good = fakeLLM(
    JSON.stringify({
      title: 'Terraforma 2026',
      festival_name: 'Terraforma',
      start_time: '2026-06-18T10:00:00',
      end_time: '2026-06-21T18:00:00',
      day_name: 'Thursday',
      category: 'music',
      tags: ['electronic'],
    })
  );
  const draft = await new FestivalEntryExtractor({
    llm: good,
    referenceDate: '2026-04-01',
  }).extract(page);
  assert(draft?.title === 'Terraforma 2026', 'returns the parsed draft');
  assert(
    draft?.start_time === '2026-06-18T00:00:00' &&
      draft?.end_time === '2026-06-21T23:59:59',
    'applies the radar date convention'
  );
  assert(
    !('day_name' in (draft ?? {})),
    'day_name is consumed by year validation'
  );

  assert(good.calls === 1, 'exactly one LLM call per extract');
  assert(
    good.messages[0][0].role === 'system' &&
      good.messages[0][0].content.includes('exactly ONE record'),
    'system message is the festival-entry prompt'
  );
  assert(
    good.options[0]?.responseFormat === 'json',
    'requests json response format'
  );

  const emptyLlm = fakeLLM('null');
  const emptyRes = await new FestivalEntryExtractor({ llm: emptyLlm }).extract({
    ...page,
    text: '\n  \n\n',
  });
  assert(
    emptyRes === null && emptyLlm.calls === 0,
    'empty page text → null without calling the LLM'
  );

  const nothing = await new FestivalEntryExtractor({
    llm: fakeLLM('null'),
  }).extract(page);
  assert(nothing === null, 'LLM null → null');

  let threw = false;
  try {
    await new FestivalEntryExtractor({ llm: fakeLLM('{oops') }).extract(page);
  } catch {
    threw = true;
  }
  assert(threw, 'malformed JSON throws (caller counts the entry as failed)');
}

console.log('\n=== PageDiscovery.discoverFestivalInfoPages ===\n');
{
  const html = `<html><body>
    <a href="/info">Info</a><a href="/tickets/">Tickets</a>
    <a href="https://facebook.com/x">FB</a><a href="#top">top</a>
    <a href="/info/">Info again</a><a href="/artists/x">Artist</a>
  </body></html>`;
  const llm = fakeLLM(
    JSON.stringify({
      infoUrls: ['/info', '/tickets/', '/info/', 'http://[bad'],
    })
  );
  const urls = await new PageDiscovery(llm).discoverFestivalInfoPages(
    html,
    'https://f.example'
  );
  assert(
    urls.join() === 'https://f.example/info,https://f.example/tickets/',
    'returns absolute, de-duplicated (trailing-slash-insensitive) urls and skips unparseable ones'
  );
  const sent = llm.messages[0].find(m => m.role === 'user')?.content ?? '';
  assert(
    sent.includes('/info') &&
      !sent.includes('facebook.com') &&
      !sent.includes('#top'),
    'link filter: social and anchor links are not sent to the LLM'
  );
  const none = await new PageDiscovery(
    fakeLLM('{"infoUrls":[]}')
  ).discoverFestivalInfoPages('<html></html>', 'https://f.example');
  assert(none.length === 0, 'no links → empty list');
  const broken = await new PageDiscovery(
    fakeLLM('not json')
  ).discoverFestivalInfoPages(html, 'https://f.example');
  assert(broken.length === 0, 'LLM failure → empty list (never throws)');
}

console.log('\n=== EventNormalizer createdAt option ===\n');
{
  const normalizer = new EventNormalizer({
    keypair: { privkey: '11'.repeat(32), pubkey: '22'.repeat(32) },
  });
  const event = {
    title: 'Terraforma 2026',
    lat: 45.5,
    lng: 9.1,
    start_time: '2026-06-18T00:00:00',
    end_time: '2026-06-21T23:59:59',
    category: 'music' as const,
  };
  const fixed = await normalizer.normalize(event, {
    createdAt: '2026-01-02T03:04:05',
  });
  assert(
    fixed?.created_at === '2026-01-02T03:04:05',
    'createdAt option is used verbatim'
  );
  const fresh = await normalizer.normalize(event);
  assert(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(fresh?.created_at ?? ''),
    'default created_at is still generated'
  );
  assert(
    fixed?.signature !== fresh?.signature,
    'signature depends on created_at'
  );
}

console.log('\n=== matchEdition ===\n');
{
  const entry = (over: Partial<ExistingEntry>): ExistingEntry => ({
    id: 'id',
    title: 'Terraforma 2026',
    lat: 45.5,
    lng: 9.1,
    start_time: '2026-06-18T00:00:00',
    end_time: '2026-06-21T23:59:59',
    category: 'music',
    tags: ['festival'],
    created_at: '2026-01-01T00:00:00',
    ...over,
  });

  assert(
    matchEdition([], '2026-06-18T00:00:00') === undefined,
    'empty list → no match'
  );
  assert(
    matchEdition([entry({ id: 'a' })], '2026-06-25T00:00:00')?.id === 'a',
    'shifted dates within the window still match (same edition)'
  );
  assert(
    matchEdition([entry({ id: 'a' })], '2027-06-17T00:00:00') === undefined,
    'a next-year edition (~365 days) does not match'
  );
  assert(
    matchEdition(
      [
        entry({ id: 'far', start_time: '2026-03-01T00:00:00' }),
        entry({ id: 'near' }),
      ],
      '2026-06-20T00:00:00'
    )?.id === 'near',
    'the closest start_time wins'
  );
  // Collision guard: festival-mode program events share festival_url and pubkey.
  const concert = entry({ id: 'concert', tags: [], end_time: null });
  assert(
    matchEdition([concert], '2026-06-18T00:00:00') === undefined,
    'program events (no end_time, no festival tag) are never matched'
  );
  assert(
    matchEdition(
      [entry({ id: 'tagless', tags: ['jazz'] })],
      '2026-06-18T00:00:00'
    ) === undefined,
    'entries without the festival tag are never matched'
  );
  assert(
    matchEdition(
      [entry({ id: 'open', end_time: null })],
      '2026-06-18T00:00:00'
    ) === undefined,
    'entries without an end_time are never matched'
  );
  assert(
    matchEdition(
      [
        entry({
          id: 'tagged-concert',
          tags: ['jazz', 'festival'],
          start_time: '2027-03-20T21:00:00',
          end_time: '2027-03-20T23:00:00',
        }),
      ],
      '2027-03-20T00:00:00'
    ) === undefined,
    'a concert tagged festival with an end_time but not the radar date shape is never matched'
  );
  assert(
    matchEdition(
      [entry({ id: 'half', end_time: '2026-06-21T22:00:00' })],
      '2026-06-18T00:00:00'
    ) === undefined,
    'festival tag + T00:00:00 start but end not T23:59:59 is never matched'
  );
  assert(
    matchEdition([entry({ id: 'real' })], '2026-06-18T00:00:00')?.id === 'real',
    'a radar-shaped entry still matches'
  );
}

console.log('\n=== differs ===\n');
{
  const existing: ExistingEntry = {
    id: 'id',
    title: 'Terraforma 2026',
    description: null, // the worker stores '' as null
    url: 'https://terra.example',
    venue_name: null,
    address: 'Bollate',
    lat: 45.5,
    lng: 9.1,
    start_time: '2026-06-18T00:00:00',
    end_time: '2026-06-21T23:59:59',
    category: 'music',
    tags: ['festival', 'electronic'],
    festival_name: 'Terraforma',
    festival_url: 'https://terra.example',
    created_at: '2026-01-01T00:00:00',
  };
  const same: NormalizedEvent = {
    pubkey: 'p',
    signature: 's',
    title: 'Terraforma 2026',
    description: '',
    url: 'https://terra.example',
    venue_name: '',
    address: 'Bollate',
    lat: 45.5,
    lng: 9.1,
    start_time: '2026-06-18T00:00:00',
    end_time: '2026-06-21T23:59:59',
    category: 'music',
    tags: ['electronic', 'festival'],
    festival_name: 'Terraforma',
    festival_url: 'https://terra.example',
    created_at: '2026-01-01T00:00:00',
  };
  assert(
    !differs(existing, same),
    "null vs '' and tag order are not differences"
  );
  assert(
    !differs(existing, { ...same, lat: 45.503, lng: 9.103 }),
    'a move within ~500 m (geocoder jitter) is not a difference'
  );
  assert(
    differs(existing, { ...same, lat: 45.52 }),
    'a real move (lat) is a difference'
  );
  assert(
    differs(existing, { ...same, lng: 9.12 }),
    'a real move (lng) is a difference'
  );
  assert(
    differs(existing, { ...same, end_time: '2026-06-22T23:59:59' }),
    'changed end_time'
  );
  assert(
    differs(existing, { ...same, start_time: '2026-06-19T00:00:00' }),
    'changed start_time'
  );
  assert(differs(existing, { ...same, category: 'art' }), 'changed category');
  assert(
    differs(existing, { ...same, description: 'New blurb' }),
    'stored description empty + new non-empty → gap fill is a difference'
  );
  assert(
    !differs(
      { ...existing, description: 'Old blurb' },
      { ...same, description: '' }
    ),
    'stored description non-empty + new empty → not a difference'
  );
  assert(
    !differs(
      { ...existing, description: 'Old blurb' },
      { ...same, description: 'Reworded blurb' }
    ),
    'reworded description is not a difference'
  );
  assert(
    !differs(existing, { ...same, tags: ['festival'] }),
    'changed tags are not a difference'
  );
  assert(
    !differs(existing, { ...same, festival_name: 'Terra' }),
    'changed festival_name is not a difference'
  );
  assert(
    !differs(existing, {
      ...same,
      title: 'Terraforma Festival 2026',
      url: 'https://terra.example/en',
      venue_name: 'Villa Arconati',
      address: 'Bollate (MI)',
      tags: ['festival', 'techno'],
    }),
    'reworded title/url/venue_name/address/tags together are not a difference'
  );
}

console.log('\n=== RadarPublisher ===\n');
{
  type Call = { url: string; method: string };
  function fakeFetch(
    respond: (call: Call) => { status: number; body?: unknown }
  ) {
    const calls: Call[] = [];
    const fn = (async (url: unknown, init?: RequestInit) => {
      const call = { url: String(url), method: init?.method ?? 'GET' };
      calls.push(call);
      const r = respond(call);
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
    }) as typeof fetch;
    return { fn, calls };
  }
  const event: NormalizedEvent = {
    pubkey: 'p',
    signature: 's',
    title: 'Terraforma 2026',
    lat: 45.5,
    lng: 9.1,
    start_time: '2026-06-18T00:00:00',
    end_time: '2026-06-21T23:59:59',
    category: 'music',
    tags: ['festival'],
    festival_name: 'Terraforma',
    festival_url: 'https://terra.example',
    created_at: '2026-01-01T00:00:00',
  };
  const match: ExistingEntry = {
    id: 'abc',
    title: 'Terraforma 2026',
    lat: 45.5,
    lng: 9.1,
    start_time: '2026-06-18T00:00:00',
    end_time: '2026-06-21T23:59:59',
    category: 'music',
    tags: ['festival'],
    festival_name: 'Terraforma',
    created_at: '2026-01-01T00:00:00',
  };

  {
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: [match] }));
    const existing = await new RadarPublisher('http://api', 'pk', fn).lookup(
      'https://terra.example'
    );
    const url = new URL(calls[0].url);
    assert(existing.length === 1, 'lookup returns the array');
    assert(
      url.pathname === '/events' &&
        url.searchParams.get('pubkey') === 'pk' &&
        url.searchParams.get('festival_url') === 'https://terra.example' &&
        url.searchParams.get('from') === '1970-01-01T00:00:00' &&
        url.searchParams.get('to') === '2999-12-31T23:59:59',
      'lookup sends pubkey, festival_url and an explicit wide time window'
    );
  }
  {
    const { fn } = fakeFetch(() => ({ status: 200, body: { events: [] } }));
    let threw = false;
    try {
      await new RadarPublisher('http://api', 'pk', fn).lookup(
        'https://terra.example'
      );
    } catch {
      threw = true;
    }
    assert(threw, 'lookup throws on an unexpected response shape');
  }
  {
    const { fn, calls } = fakeFetch(() => ({
      status: 201,
      body: { id: 'new' },
    }));
    const outcome = await new RadarPublisher('http://api', 'pk', fn).apply(
      event,
      undefined
    );
    assert(
      outcome === 'published' &&
        calls.length === 1 &&
        calls[0].method === 'POST',
      'no match → POST → published'
    );
  }
  {
    const { fn, calls } = fakeFetch(() => ({ status: 200 }));
    const outcome = await new RadarPublisher('http://api', 'pk', fn).apply(
      event,
      match
    );
    assert(
      outcome === 'unchanged' && calls.length === 0,
      'identical match → no API call → unchanged'
    );
  }
  {
    const { fn, calls } = fakeFetch(() => ({ status: 200 }));
    const outcome = await new RadarPublisher('http://api', 'pk', fn).apply(
      { ...event, end_time: '2026-06-22T23:59:59' },
      match
    );
    assert(
      outcome === 'updated' &&
        calls.length === 1 &&
        calls[0].method === 'PUT' &&
        calls[0].url === 'http://api/events/abc',
      'changed match → PUT /events/:id → updated'
    );
  }
  {
    const { fn, calls } = fakeFetch(c =>
      c.method === 'PUT' ? { status: 404 } : { status: 201 }
    );
    const outcome = await new RadarPublisher('http://api', 'pk', fn).apply(
      { ...event, end_time: '2026-06-22T23:59:59' },
      match
    );
    assert(
      outcome === 'published' && calls.map(c => c.method).join() === 'PUT,POST',
      'PUT 404 (expired mid-run) falls back to POST'
    );
  }
  for (const status of [401, 403, 409, 500]) {
    const { fn, calls } = fakeFetch(() => ({
      status,
      body: { error: 'nope' },
    }));
    const outcome = await new RadarPublisher('http://api', 'pk', fn).apply(
      { ...event, end_time: '2026-06-22T23:59:59' },
      match
    );
    assert(
      outcome === 'failed' && calls.length === 1,
      `PUT ${status} → failed, no fallback POST`
    );
  }
  {
    const { fn } = fakeFetch(() => ({
      status: 409,
      body: { existing_event_id: 'x' },
    }));
    const outcome = await new RadarPublisher('http://api', 'pk', fn).apply(
      event,
      undefined
    );
    assert(
      outcome === 'failed',
      'POST 409 (duplicate of a foreign event) → failed, loudly'
    );
  }
  {
    const fn = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const outcome = await new RadarPublisher('http://api', 'pk', fn).apply(
      event,
      undefined
    );
    assert(outcome === 'failed', 'network error → failed, never throws');
  }
}

console.log('\n=== tallyOutcomes ===\n');
{
  const t = tallyOutcomes([
    { url: 'a', outcome: 'published' },
    { url: 'b', outcome: 'updated' },
    { url: 'c', outcome: 'updated' },
    { url: 'd', outcome: 'unchanged' },
    { url: 'e', outcome: 'skipped_no_dates' },
    { url: 'f', outcome: 'failed' },
  ]);
  assert(
    t.published === 1 &&
      t.updated === 2 &&
      t.unchanged === 1 &&
      t.skipped_no_dates === 1 &&
      t.failed === 1,
    'counts each outcome'
  );
  assert(tallyOutcomes([]).failed === 0, 'empty list → zeros');
}

console.log('\n=== findStaleFestivals ===\n');
{
  const radarRun = (entries: Record<string, string>): RunRecord => ({
    kind: 'radar',
    entries: Object.entries(entries).map(([url, outcome]) => ({
      url,
      outcome,
    })),
  });
  const jobsRun: RunRecord = { started_at: 'x' }; // legacy record without `kind`

  const dead = {
    'https://dead.example': 'skipped_no_dates',
    'https://ok.example': 'unchanged',
  };
  const runs = [
    radarRun(dead),
    radarRun(dead),
    radarRun(dead),
    radarRun(dead),
    jobsRun,
  ];
  const stale = findStaleFestivals(
    runs,
    ['https://dead.example', 'https://ok.example'],
    4
  );
  assert(
    stale.length === 1 && stale[0] === 'https://dead.example',
    'flags a festival with no healthy outcome in the last 4 runs; ignores non-radar records'
  );
  assert(
    findStaleFestivals(runs.slice(0, 3), ['https://dead.example'], 4).length ===
      0,
    'needs at least N runs of history before flagging'
  );
  const recovered = [
    radarRun({ 'https://dead.example': 'updated' }),
    radarRun(dead),
    radarRun(dead),
    radarRun(dead),
  ];
  assert(
    findStaleFestivals(recovered, ['https://dead.example'], 4).length === 0,
    'one healthy outcome in the window clears it'
  );
  const newlyAdded = [
    radarRun({ 'https://new.example': 'failed' }),
    radarRun({ 'https://ok.example': 'unchanged' }),
    radarRun({ 'https://ok.example': 'unchanged' }),
    radarRun({ 'https://ok.example': 'unchanged' }),
  ];
  assert(
    findStaleFestivals(newlyAdded, ['https://new.example'], 4).length === 0,
    'a newly added festival is not flagged until it has N runs of its own'
  );
}

console.log('\n=== findStaleFestivals window uses newest runs ===\n');
{
  const u = 'https://x.example';
  const runsOf = (outcomes: string[]): RunRecord[] =>
    outcomes.map(o => ({ kind: 'radar', entries: [{ url: u, outcome: o }] }));
  assert(
    findStaleFestivals(
      runsOf(['dead', 'dead', 'updated', 'dead', 'dead', 'dead']).map(r => r),
      [u],
      4
    ).length === 0,
    'healthy outcome inside the last 4 of 6 → not stale'
  );
  assert(
    findStaleFestivals(
      runsOf(['updated', 'dead', 'dead', 'dead', 'dead']),
      [u],
      4
    ).length === 1,
    'healthy outcome older than the last 4 → stale'
  );
  assert(
    findStaleFestivals(runsOf(['failed', 'failed', 'failed', 'failed']), [u])
      .length === 1,
    'four failed runs → stale (default window)'
  );
  assert(STALE_WINDOW === 4, 'STALE_WINDOW is 4');
}

console.log('\n=== appendRunLog / readRunRecords ===\n');
{
  const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'runlog-'));
  try {
    await appendRunLog(dir, { kind: 'radar', n: 1 });
    await appendRunLog(dir, { kind: 'jobs', n: 2 });
    const recs = await readRunRecords(dir);
    assert(
      recs.length === 2 && recs[0].n === 1 && recs[1].n === 2,
      'appended records read back in order'
    );

    const dir2 = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'runlog-'));
    try {
      await fsp.writeFile(
        nodePath.join(dir2, 'runs.jsonl'),
        '{"kind":"radar","n":7}\nnot json{\n\n'
      );
      const r2 = await readRunRecords(dir2);
      assert(
        r2.length === 1 && r2[0].n === 7,
        'garbage and blank lines are skipped'
      );
    } finally {
      await fsp.rm(dir2, { recursive: true, force: true });
    }

    const dir3 = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'runlog-'));
    try {
      assert(
        (await readRunRecords(dir3)).length === 0,
        'missing runs.jsonl → []'
      );
    } finally {
      await fsp.rm(dir3, { recursive: true, force: true });
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

console.log('\n=== Radar year-evidence guard ===\n');
{
  const yearPage = (
    text: string,
    url = 'https://fest.example/',
    title = 'Fest'
  ): FetchedPage => ({ url, html: '', text, title });
  const run = async (
    fields: Record<string, unknown>,
    page: FetchedPage
  ): Promise<FestivalEntryDraft | null> =>
    new FestivalEntryExtractor({
      llm: fakeLLM(
        JSON.stringify({ title: 'Fest', category: 'music', ...fields })
      ),
      referenceDate: '2026-10-01',
    }).extract(page);
  const d27 = { start_time: '2027-06-18', end_time: '2027-06-21' };

  const phantom = await run(d27, yearPage('Fest 2026\n18-21 June'));
  assert(
    phantom?.title === 'Fest' && !phantom.start_time && !phantom.end_time,
    'phantom next-year dates without year evidence are stripped, draft kept'
  );
  const inText = await run(d27, yearPage('Fest 2027\n18-21 June'));
  assert(
    inText?.start_time === '2027-06-18T00:00:00' &&
      inText?.end_time === '2027-06-21T23:59:59',
    'year in page text keeps dates'
  );
  const inUrl = await run(
    d27,
    yearPage('18-21 June', 'https://fest.example/2027/')
  );
  assert(
    inUrl?.start_time === '2027-06-18T00:00:00',
    'year in url keeps dates'
  );
  const viaDay = await run(
    { start_time: '2027-06-17', end_time: '2027-06-20', day_name: 'Thursday' },
    yearPage('17-20 June')
  );
  assert(
    viaDay?.start_time === '2027-06-17T00:00:00',
    'validated day_name substitutes for year evidence'
  );
  const badDay = await run(
    { start_time: '2027-06-17', end_time: '2027-06-20', day_name: 'Monday' },
    yearPage('Fest 2027\n17-20 June')
  );
  assert(
    !badDay?.start_time && !badDay?.end_time,
    'unresolvable day_name still strips dates'
  );
  const shifted = await run(
    { start_time: '2026-06-17', end_time: '2026-06-20', day_name: 'Thursday' },
    yearPage('17-20 June')
  );
  assert(
    shifted?.start_time === '2027-06-17T00:00:00',
    'day_name-shifted dates are kept without year in page'
  );
  const cur = await run(
    { start_time: '2026-06-18', end_time: '2026-06-21' },
    yearPage('Terraforma 2026\n18-21 June')
  );
  assert(
    cur?.start_time === '2026-06-18T00:00:00',
    'current-year evidence keeps dates'
  );

  const dr = {
    title: 't',
    category: 'music',
    start_time: '2027-06-18T00:00:00',
  } as FestivalEntryDraft;
  const pg = (o: Partial<FetchedPage>) => ({
    url: 'https://a.example/',
    title: 'a',
    text: 'b',
    ...o,
  });
  assert(
    hasYearEvidence(dr, pg({ text: 'x 2027 y' }), false),
    'hasYearEvidence: text'
  );
  assert(
    hasYearEvidence(dr, pg({ url: 'https://a.example/2027' }), false),
    'hasYearEvidence: url'
  );
  assert(
    hasYearEvidence(dr, pg({ title: 'Fest 2027' }), false),
    'hasYearEvidence: title'
  );
  assert(
    !hasYearEvidence(dr, pg({ text: 'only 2026' }), false),
    'hasYearEvidence: none -> false'
  );
  assert(
    hasYearEvidence(dr, pg({}), true),
    'hasYearEvidence: dayNameValidated -> true'
  );
  for (const t of ['Postcode 20271 Milano', 'Price 12027 EUR']) {
    assert(
      !hasYearEvidence(dr, pg({ text: t }), false),
      `hasYearEvidence: "${t}" is not the year`
    );
  }
  for (const t of ['Terraforma 2027', '2027-06-18', 'June 2027.', '(2027)']) {
    assert(
      hasYearEvidence(dr, pg({ text: t }), false),
      `hasYearEvidence: standalone "${t}"`
    );
  }
  assert(
    hasYearEvidence(dr, pg({ url: 'https://a.example/edition-2027/' }), false),
    'hasYearEvidence: /edition-2027/ in url'
  );
  assert(
    !hasYearEvidence(
      { ...dr, start_time: undefined },
      pg({ text: '2027' }),
      false
    ),
    'hasYearEvidence: missing start_time -> false'
  );
}

// --- add new test sections above this line ---

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

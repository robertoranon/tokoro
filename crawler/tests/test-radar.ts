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
  type FestivalEntryDraft,
} from '../src/radar/festival-entry.js';
import type { FetchedPage } from '../src/types/event.js';
import {
  parseFestivalsConfig,
  normalizeFestivalUrl,
  activeFestivals,
} from '../src/radar/festivals-config.js';

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
    parseFestivalEntry(
      { title: 'Bad', category: 'weird' },
      'https://x.example'
    ) === null,
    'invalid category → null'
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

// --- add new test sections above this line ---

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

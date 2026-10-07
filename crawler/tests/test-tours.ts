import * as ed from '@noble/ed25519';
import { signAdoption, adoptMessage } from '../src/tours/adopt.js';
import { getTourShowsPrompt } from '../../shared/extractors/tour-prompt.js';
import { selectRetrySources } from '../src/tours/retry.js';
import { looksBlocked, assertNotBlocked } from '../src/utils/block-page.js';
import { EventNormalizer } from '../src/utils/normalizer.js';
import { ExtractedEventSchema } from '../src/types/event.js';
import {
  parseBandsConfig,
  normalizeActUrl,
  activeBands,
  activeSources,
  effectiveRegion,
} from '../src/tours/bands-config.js';
import {
  parseTourShows,
  normalizeName,
  matchBand,
  toLocalDateTime,
  isPastShow,
  inRegion,
  finalizeTourShow,
  buildAddress,
  placeQuery,
  type TourShowDraft,
} from '../src/tours/tour-shows.js';
import type { BandConfig } from '../src/tours/bands-config.js';
import {
  matchShow,
  differs,
  TourPublisher,
  type ExistingShow,
} from '../src/tours/tour-publisher.js';
import type { NormalizedEvent } from '../src/types/event.js';
import { isDebugRequested, buildTourRunRecord } from '../src/tours.js';
import type { TourSourceResult } from '../src/crawler.js';
import { TourExtractor } from '../src/extractors/tour-extractor.js';
import type { LLMProvider } from '../../shared/types/llm.js';
import {
  findStaleSources,
  findStaleFestivals,
  STALE_WINDOW,
  type RunRecord,
} from '../src/utils/run-log.js';
import type { FetchedPage } from '../src/types/event.js';
import {
  processTourSourcePage,
  tallyShows,
  sourceOutcome,
  type TourSourceDeps,
  type ShowResult,
} from '../src/tours/tour-source.js';
import { parseBandsConfig as parseCfg } from '../src/tours/bands-config.js';
import { buildTrackedBands } from '../src/tours/tracked-bands.js';
import { formatFailures } from '../src/tours/failure-report.js';
import { parseExportArgs } from '../src/export-tracked-bands.js';
import type { ExtractedEvent } from '../src/types/event.js';
import {
  geocodeCandidates,
  geocodeAddress,
  pickCandidate,
  medianBias,
  clearGeocodeCache,
  setGeocodeMinIntervalMs,
  type GeoCandidate,
  type GeoBias,
} from '../../shared/utils/geocode.js';

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

const bytesToHex = (b: Uint8Array) =>
  Array.from(b)
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');
const hexToBytes = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/g)!.map(h => parseInt(h, 16)));

type FakeLLM = LLMProvider & {
  calls: number;
  messages: { role: string; content: any }[][];
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

async function main() {
  console.log('\n=== act fields through the normalizer ===\n');
  {
    const privkey = bytesToHex(ed.utils.randomPrivateKey());
    const pubkey = bytesToHex(await ed.getPublicKeyAsync(hexToBytes(privkey)));
    const normalizer = new EventNormalizer({ keypair: { privkey, pubkey } });
    const base = {
      title: 'Test Band live',
      lat: 46.06,
      lng: 13.23,
      start_time: '2030-11-12T21:00:00',
      category: 'music' as const,
    };
    const withAct = (await normalizer.normalize({
      ...base,
      act_name: 'Test Band',
      act_url: 'https://band.example',
    }))!;
    assert(withAct.act_name === 'Test Band', 'act_name copied');
    assert(withAct.act_url === 'https://band.example', 'act_url copied');

    const without = (await normalizer.normalize(base))!;
    assert(!('act_name' in without), 'no act_name key when absent');
    assert(!('act_url' in without), 'no act_url key when absent');

    const parsed = ExtractedEventSchema.safeParse({
      ...base,
      act_name: 'Test Band',
      act_url: 'https://band.example',
    });
    assert(parsed.success, 'schema accepts act fields');
  }

  console.log('\n=== normalizeActUrl ===\n');
  {
    assert(
      normalizeActUrl('https://Band.example/') === 'https://band.example',
      'host lowercased, trailing slash stripped'
    );
    assert(
      normalizeActUrl('https://band.example/live/?utm=1#x') ===
        'https://band.example/live',
      'query and hash dropped'
    );
    assert(
      throws(() => normalizeActUrl('ftp://band.example')),
      'non-http rejected'
    );
    assert(
      throws(() => normalizeActUrl('nonsense')),
      'garbage rejected'
    );
  }

  console.log('\n=== parseBandsConfig ===\n');
  {
    const ok = parseBandsConfig(`
defaults:
  fetcher: jina
  region: { south: 34, west: -11, north: 72, east: 45 }
bands:
  - name: Test Band
    url: https://testband.example/
    aliases: ["The Test Band"]
    added: 2026-10-06
  - name: Far Band
    url: https://farband.example
    region: none
  - name: Paused Band
    url: https://paused.example
    status: paused
sources:
  - url: https://testband.example/live
    mode: band
    band: Test Band
  - url: https://venue.example/programme
    mode: listing
    only: [Test Band]
  - url: https://agg.example/gigs
    mode: listing
    fetcher: playwright
`);
    assert(ok.bands.length === 3, 'three bands parsed');
    assert(
      ok.bands[0].url === 'https://testband.example',
      'band url normalised'
    );
    assert(ok.bands[0].aliases?.[0] === 'The Test Band', 'aliases kept');
    assert(ok.bands[0].added === '2026-10-06', 'yaml date → string');
    assert(ok.bands[2].status === 'paused', 'status parsed');
    assert(ok.sources.length === 3, 'three sources parsed');
    assert(ok.sources[0].fetcher === 'jina', 'default fetcher applied');
    assert(
      ok.sources[2].fetcher === 'playwright',
      'per-source fetcher override'
    );
    assert(
      ok.sources[0].mode === 'band' && ok.sources[0].band === 'Test Band',
      'band source'
    );
    assert(
      ok.sources[1].mode === 'listing' &&
        ok.sources[1].only?.[0] === 'Test Band',
      'listing source with only'
    );
    assert(
      activeBands(ok).length === 2,
      'paused band excluded from activeBands'
    );
    assert(activeSources(ok).length === 3, 'all sources active');
    assert(
      effectiveRegion(ok, ok.bands[0])?.north === 72,
      'default region applies to a band without its own'
    );
    assert(
      effectiveRegion(ok, ok.bands[1]) === undefined,
      'region: none → worldwide'
    );

    assert(
      parseBandsConfig('bands:\nsources:\n').bands.length === 0,
      'null sections → empty'
    );

    const bad = (yaml: string) => throws(() => parseBandsConfig(yaml));
    assert(bad('foo: 1'), 'missing bands/sources rejected');
    assert(bad('bands: [{name: A}]\nsources: []'), 'band without url rejected');
    assert(
      bad('bands: [{url: "https://a.example"}]\nsources: []'),
      'band without name rejected'
    );
    assert(
      bad(
        'bands: [{name: A, url: "https://a.example"}, {name: a, url: "https://b.example"}]\nsources: []'
      ),
      'duplicate band name (case-insensitive) rejected'
    );
    assert(
      bad(
        'bands: [{name: A, url: "https://a.example"}, {name: B, url: "https://a.example/"}]\nsources: []'
      ),
      'duplicate band url rejected'
    );
    assert(
      bad(
        'bands: [{name: A, url: "https://a.example"}]\nsources: [{url: "https://s.example", mode: band}]'
      ),
      'band-mode source without band rejected'
    );
    assert(
      bad(
        'bands: [{name: A, url: "https://a.example"}]\nsources: [{url: "https://s.example", mode: band, band: Nope}]'
      ),
      'band-mode source referencing an unknown band rejected'
    );
    assert(
      bad(
        'bands: [{name: A, url: "https://a.example"}]\nsources: [{url: "https://s.example", mode: listing, only: [Nope]}]'
      ),
      'listing "only" naming an unknown band rejected'
    );
    assert(
      bad('bands: []\nsources: [{url: "https://s.example", mode: weird}]'),
      'invalid mode rejected'
    );
    assert(
      bad(
        'bands: []\nsources: [{url: "https://s.example", mode: listing}, {url: "https://s.example/", mode: listing}]'
      ),
      'duplicate source url rejected'
    );
    assert(
      bad(
        'bands: [{name: A, url: "https://a.example", region: {south: 10, west: 0, north: 5, east: 9}}]\nsources: []'
      ),
      'region with south >= north rejected'
    );
    assert(
      bad(
        'bands: [{name: A, url: "https://a.example", status: sleepy}]\nsources: []'
      ),
      'invalid status rejected'
    );
  }

  console.log('\n=== normalizeName / matchBand ===\n');
  {
    assert(normalizeName('  The  Cure ') === 'the cure', 'case and spaces');
    assert(normalizeName('Sigur Rós') === 'sigur ros', 'accents stripped');
    assert(normalizeName('AC/DC') === 'ac dc', 'punctuation → space');
    assert(
      normalizeName("Guns N' Roses") === 'guns n roses',
      'apostrophe dropped'
    );

    const bands: BandConfig[] = [
      { name: 'Sigur Rós', url: 'https://sigur.example', status: 'active' },
      {
        name: 'Test Band',
        url: 'https://testband.example',
        aliases: ['TB', 'The Test Band'],
        status: 'active',
      },
      { name: 'Cure', url: 'https://cure.example', status: 'active' },
    ];
    assert(
      matchBand(['sigur ros'], bands)?.name === 'Sigur Rós',
      'accent-insensitive match'
    );
    assert(
      matchBand(['Support Act', 'the test band'], bands)?.name === 'Test Band',
      'alias match among several performers'
    );
    assert(matchBand(['TB'], bands)?.name === 'Test Band', 'short alias match');
    assert(
      matchBand(['Cured Meat Orchestra'], bands) === undefined,
      'no partial/substring match'
    );
    assert(matchBand([], bands) === undefined, 'empty bill → no match');
    assert(
      matchBand(['Test Band'], []) === undefined,
      'empty registry → no match'
    );
  }

  console.log('\n=== parseTourShows ===\n');
  {
    const page = 'https://testband.example/live';
    const shows = parseTourShows(
      {
        shows: [
          {
            title: 'Test Band live',
            performers: ['Test Band', 'Opener'],
            start_time: '2030-11-12T21:00:00',
            venue_name: 'Club X',
            address: 'Via Roma 1, Udine',
            city: 'Udine',
            url: 'https://tickets.example/1',
          },
          { title: 'No date', performers: ['Test Band'] },
          { title: '', performers: ['x'], start_time: '2030-11-13' },
          {
            title: 'Date only',
            start_time: '2030-11-14',
            performers: 'Test Band, Guest',
            lat: '46.1',
            lng: 13.2,
            url: 'not a url',
          },
        ],
      },
      page
    );
    assert(
      shows.length === 2,
      'invalid shows dropped (no date / empty title), others kept'
    );
    assert(
      shows[0].performers.join('|') === 'Test Band|Opener',
      'performers list kept'
    );
    assert(
      shows[1].performers.join('|') === 'Test Band|Guest',
      'performers string split on commas'
    );
    assert(
      shows[1].lat === 46.1 && shows[1].lng === 13.2,
      'numeric strings coerced'
    );
    assert(shows[1].url === undefined, 'invalid url dropped');
    assert(
      parseTourShows([{ title: 'A', start_time: '2030-01-01' }], page)
        .length === 1,
      'bare array accepted'
    );
    assert(
      parseTourShows({ shows: 'oops' }, page).length === 0,
      'junk → empty'
    );
    assert(parseTourShows(null, page).length === 0, 'null → empty');
    assert(
      parseTourShows(
        { shows: [{ title: 'Impossible', start_time: '2030-02-31' }] },
        page
      ).length === 0,
      'impossible calendar date dropped'
    );
  }

  console.log('\n=== toLocalDateTime / isPastShow ===\n');
  {
    assert(
      toLocalDateTime('2030-11-12') === '2030-11-12T00:00:00',
      'date-only → midnight'
    );
    assert(
      toLocalDateTime('2030-11-12T21:00') === '2030-11-12T21:00:00',
      'minutes-only padded'
    );
    assert(
      toLocalDateTime('2030-11-12T21:00:00Z') === '2030-11-12T21:00:00',
      'timezone suffix stripped'
    );
    assert(
      toLocalDateTime('2030-11-12 21:00:00') === '2030-11-12T21:00:00',
      'space separator accepted'
    );
    assert(toLocalDateTime('garbage') === undefined, 'garbage → undefined');
    assert(
      isPastShow('2030-11-12T21:00:00', '2030-11-13') === true,
      'day before today is past'
    );
    assert(
      isPastShow('2030-11-13T21:00:00', '2030-11-13') === false,
      'today is not past'
    );
  }

  console.log('\n=== inRegion ===\n');
  {
    const europe = { south: 34, west: -11, north: 72, east: 45 };
    assert(inRegion(46.06, 13.23, europe), 'Udine inside Europe box');
    assert(!inRegion(40.7, -74, europe), 'New York outside');
    assert(inRegion(40.7, -74, undefined), 'no region → everything inside');
    assert(inRegion(34, -11, europe), 'bounds are inclusive');
  }

  console.log('\n=== finalizeTourShow ===\n');
  {
    const band: BandConfig = {
      name: 'Test Band',
      url: 'https://testband.example',
      status: 'active',
    };
    const draft: TourShowDraft = {
      title: 'Test Band live',
      performers: ['Test Band', 'Opener'],
      start_time: '2030-11-12',
      venue_name: 'Club X',
      city: 'Udine',
      address: 'Via Roma 1',
      tags: ['Rock', ' indie '],
    };
    const e = finalizeTourShow(draft, band, 'https://testband.example/live');
    assert(
      e.act_name === 'Test Band' && e.act_url === 'https://testband.example',
      'act fields from the band'
    );
    assert(e.start_time === '2030-11-12T00:00:00', 'date normalised');
    assert(e.category === 'music', 'category fixed to music');
    assert(
      e.tags!.includes('band-tour') &&
        e.tags!.includes('rock') &&
        e.tags!.includes('indie'),
      'tags lowercased, trimmed, band-tour added'
    );
    assert(
      !e.tags!.includes('test band'),
      'band name is not duplicated into tags'
    );
    assert(
      e.url === 'https://testband.example/live',
      'page url fallback when the show has none'
    );
    assert(
      e.address === 'Via Roma 1, Udine',
      'city appended to address when missing from it'
    );
    assert(
      finalizeTourShow(
        { ...draft, address: 'Via Roma 1, Udine' },
        band,
        'https://x.example'
      ).address === 'Via Roma 1, Udine',
      'city not appended twice'
    );
    assert(
      finalizeTourShow(
        { ...draft, address: undefined },
        band,
        'https://x.example'
      ).address === 'Udine',
      'city alone becomes the address'
    );
    assert(
      finalizeTourShow(
        { ...draft, description: undefined },
        band,
        'https://x.example'
      ).description === 'With Opener.',
      'support acts summarised into a description'
    );
  }

  console.log('\n=== matchShow / differs ===\n');
  {
    const mk = (over: Partial<ExistingShow> = {}): ExistingShow => ({
      id: 'e1',
      title: 'Test Band live',
      description: 'With Opener.',
      url: 'https://x.example',
      venue_name: 'Club X',
      address: 'Udine',
      lat: 46.06,
      lng: 13.23,
      start_time: '2030-11-12T21:00:00',
      end_time: null,
      category: 'music',
      tags: ['band-tour'],
      act_name: 'Test Band',
      act_url: 'https://testband.example',
      created_at: '2030-01-01T10:00:00',
      ...over,
    });
    const existing = [
      mk({ id: 'a' }),
      mk({ id: 'b', start_time: '2030-11-13T21:00:00' }),
      mk({ id: 'c', lat: 45.43, lng: 12.33 }), // same day, other city
    ];
    assert(
      matchShow(existing, '2030-11-12T20:30:00', 46.0601, 13.2301)?.id === 'a',
      'same day + place matches even if the time changed'
    );
    assert(
      matchShow(existing, '2030-11-12T21:00:00', 45.43, 12.33)?.id === 'c',
      'same day, other city matches that show'
    );
    assert(
      matchShow(existing, '2030-11-14T21:00:00', 46.06, 13.23) === undefined,
      'other day: no match'
    );
    assert(
      matchShow(existing, '2030-11-12T21:00:00', 48.2, 16.4) === undefined,
      'same day, unknown place: no match'
    );
    assert(
      matchShow([], '2030-11-12T21:00:00', 46.06, 13.23) === undefined,
      'empty list'
    );

    const next = (over: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
      pubkey: 'p',
      signature: 's',
      title: 'Test Band live (rewording)',
      description: 'A different blurb entirely.',
      url: 'https://other.example',
      venue_name: 'Club X!',
      address: 'Via Roma 1, Udine',
      lat: 46.0602,
      lng: 13.2299,
      start_time: '2030-11-12T21:00:00',
      category: 'music',
      tags: ['x'],
      created_at: 'c',
      ...over,
    });
    const base = mk();
    assert(
      !differs(base, next()),
      'wording, url, venue text, tags never trigger an update'
    );
    assert(
      differs(base, next({ start_time: '2030-11-12T20:00:00' })),
      'start time change'
    );
    assert(
      differs(base, next({ end_time: '2030-11-12T23:00:00' })),
      'end time appears'
    );
    assert(differs(base, next({ lat: 46.07 })), 'coordinates moved > 500 m');
    assert(
      !differs(base, next({ lat: 46.063 })),
      'coordinates within tolerance'
    );
    assert(
      differs(mk({ description: null }), next()),
      'empty stored description gets filled'
    );
    assert(
      !differs(mk({ description: null }), next({ description: undefined })),
      'both empty → unchanged'
    );
    assert(differs(mk({ url: null }), next()), 'empty stored url gets filled');
    assert(
      !differs(
        mk({ end_time: '2030-11-12T23:00:00' }),
        next({ end_time: undefined })
      ),
      'a known end_time is not erased by a run that lost it'
    );
  }

  console.log('\n=== TourPublisher ===\n');
  {
    type Call = { url: string; method: string; body?: any };
    const calls: Call[] = [];
    const respond = (status: number, json: unknown = {}) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => json,
        text: async () => JSON.stringify(json),
      }) as Response;
    let nextStatus = 201;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if ((init?.method ?? 'GET') === 'GET')
        return respond(200, {
          events: [
            {
              id: 'e1',
              start_time: '2030-11-12T21:00:00',
              lat: 46.06,
              lng: 13.23,
              tags: [],
              category: 'music',
              title: 't',
              created_at: 'c',
            },
          ],
          has_more: false,
        });
      return respond(nextStatus);
    }) as unknown as typeof fetch;

    const pub = new TourPublisher('http://api.test', 'PUBKEY', fakeFetch);
    const found = await pub.lookup('https://testband.example');
    assert(found.length === 1, 'lookup returns the events of the page');
    const q = new URL(calls[0].url).searchParams;
    assert(
      !q.has('pubkey') && q.get('act_url') === 'https://testband.example',
      'lookup filters by act_url only (no pubkey)'
    );
    assert(
      q.get('from') === '1970-01-01T00:00:00' &&
        q.get('to') === '2999-12-31T23:59:59',
      'lookup uses an explicit wide range'
    );

    const ev = {
      pubkey: 'PUBKEY',
      signature: 's',
      title: 'T',
      lat: 46.06,
      lng: 13.23,
      start_time: '2030-11-12T21:00:00',
      category: 'music',
      created_at: 'c',
    } as NormalizedEvent;
    nextStatus = 201;
    assert(
      (await pub.apply(ev, undefined)) === 'published',
      'no match → POST → published'
    );
    assert(
      calls.at(-1)!.method === 'POST' &&
        calls.at(-1)!.url === 'http://api.test/events',
      'POST /events'
    );

    const match = found[0];
    assert(
      (await pub.apply(ev, match)) === 'unchanged',
      'match without meaningful change → unchanged (no request)'
    );
    const before = calls.length;
    nextStatus = 200;
    assert(
      (await pub.apply({ ...ev, start_time: '2030-11-12T20:00:00' }, match)) ===
        'updated',
      'changed time → PUT → updated'
    );
    assert(
      calls.at(-1)!.method === 'PUT' &&
        calls.at(-1)!.url === 'http://api.test/events/e1',
      'PUT /events/:id'
    );
    assert(calls.length === before + 1, 'exactly one request for the update');

    const calls404 = calls.length;
    const seq = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (init?.method === 'PUT') return respond(404);
      return respond(201);
    }) as unknown as typeof fetch;
    const pub404 = new TourPublisher('http://api.test', 'PUBKEY', seq);
    assert(
      (await pub404.apply(
        { ...ev, start_time: '2030-11-12T20:00:00' },
        match
      )) === 'published',
      'PUT 404 falls back to POST'
    );
    assert(calls.length === calls404 + 2, 'PUT then POST');

    for (const [status, label] of [
      [401, 'PUT 401'],
      [409, 'POST 409'],
      [500, 'POST 500'],
    ] as const) {
      const f = (async () => respond(status)) as unknown as typeof fetch;
      const p = new TourPublisher('http://api.test', 'PUBKEY', f);
      const outcome = label.startsWith('PUT')
        ? await p.apply({ ...ev, start_time: '2030-11-12T20:00:00' }, match)
        : await p.apply(ev, undefined);
      assert(outcome === 'failed', `${label} → failed`);
    }
    const netErr = new TourPublisher('http://api.test', 'PUBKEY', (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch);
    assert(
      (await netErr.apply(ev, undefined)) === 'failed',
      'network error → failed'
    );

    const badShape = new TourPublisher('http://api.test', 'PUBKEY', (async () =>
      respond(200, [])) as unknown as typeof fetch);
    assert(
      await badShape.lookup('https://x.example').then(
        () => false,
        () => true
      ),
      'lookup rejects a response without an events array (bare array)'
    );
    const notOk = new TourPublisher('http://api.test', 'PUBKEY', (async () =>
      respond(500)) as unknown as typeof fetch);
    assert(
      await notOk.lookup('https://x.example').then(
        () => false,
        () => true
      ),
      'lookup rejects a non-2xx response'
    );
  }

  console.log('\n=== TourExtractor ===\n');
  {
    const page: FetchedPage = {
      url: 'https://testband.example/live',
      title: 'Test Band — Live',
      html: '<html></html>',
      text: '12 NOV 2030  Udine  Club X\n20 NOV 2030  Ljubljana  Kino Šiška',
    };
    const reply = JSON.stringify({
      shows: [
        {
          title: 'Test Band live',
          performers: ['Test Band'],
          start_time: '2030-11-12T21:00:00',
          venue_name: 'Club X',
          city: 'Udine',
        },
        {
          title: 'Test Band live',
          performers: ['Test Band'],
          start_time: '2030-11-20',
          venue_name: 'Kino Šiška',
          city: 'Ljubljana',
        },
      ],
    });
    const llm = fakeLLM(reply);
    const shows = await new TourExtractor({
      llm,
      referenceDate: '2030-10-01',
    }).extract(page);
    assert(shows.length === 2, 'two shows extracted');
    assert(llm.calls === 1, 'one LLM call per page');
    assert(
      llm.options[0].responseFormat === 'json',
      'JSON response format requested'
    );
    const sys = String(llm.messages[0][0].content);
    assert(
      /performers/.test(sys) && /every/i.test(sys),
      'system prompt asks for every show with performers'
    );
    const user = JSON.stringify(llm.messages[0][1].content);
    assert(user.includes('2030-10-01'), "user prompt carries today's date");
    assert(user.includes('Club X'), 'user prompt carries the page text');

    const empty = fakeLLM(reply);
    assert(
      (
        await new TourExtractor({ llm: empty }).extract({
          ...page,
          text: '   ',
        })
      ).length === 0 && empty.calls === 0,
      'blank page → no shows, no LLM call'
    );
    const junk = fakeLLM('not json');
    assert(
      await new TourExtractor({ llm: junk }).extract(page).then(
        () => false,
        () => true
      ),
      'malformed JSON throws (the source is then reported failed)'
    );
    const none = fakeLLM(JSON.stringify({ shows: [] }));
    assert(
      (await new TourExtractor({ llm: none }).extract(page)).length === 0,
      'empty list → no shows'
    );
  }

  console.log('\n=== findStaleSources ===\n');
  {
    const run = (kind: 'radar' | 'tours', outcome: string): RunRecord => ({
      kind,
      entries: [{ url: 'https://s.example/live', outcome }],
    });
    const dead = Array.from({ length: STALE_WINDOW }, () =>
      run('tours', 'no_shows')
    );
    assert(
      findStaleSources(dead, ['https://s.example/live'], 'tours').length === 1,
      'dead source flagged after a full window'
    );
    assert(
      findStaleSources(dead.slice(1), ['https://s.example/live'], 'tours')
        .length === 0,
      'not flagged before a full window'
    );
    assert(
      findStaleSources(
        [...dead.slice(1), run('tours', 'unchanged')],
        ['https://s.example/live'],
        'tours'
      ).length === 0,
      'a healthy run inside the window clears it'
    );
    assert(
      findStaleSources(dead, ['https://s.example/live'], 'radar').length === 0,
      'other kinds are ignored'
    );
    assert(
      findStaleFestivals(
        Array.from({ length: STALE_WINDOW }, () => run('radar', 'failed')),
        ['https://s.example/live']
      ).length === 1,
      'findStaleFestivals still works (radar kind)'
    );
  }

  console.log('\n=== processTourSourcePage ===\n');
  {
    const cfg = parseCfg(`
defaults:
  region: { south: 34, west: -11, north: 72, east: 45 }
bands:
  - name: Test Band
    url: https://testband.example
    aliases: ["The Test Band"]
  - name: Other Band
    url: https://other.example
  - name: Far Band
    url: https://far.example
    region: none
sources:
  - { url: "https://testband.example/live", mode: band, band: Test Band }
  - { url: "https://venue.example/programme", mode: listing }
  - { url: "https://venue.example/only-other", mode: listing, only: [Other Band] }
`);
    const page: FetchedPage = {
      url: 'https://venue.example/programme',
      title: 'P',
      html: '',
      text: 'x',
    };
    const draft = (over: Partial<TourShowDraft>): TourShowDraft => ({
      title: 'Show',
      performers: ['Test Band'],
      start_time: '2030-11-12T21:00:00',
      venue_name: 'Club X',
      city: 'Udine',
      lat: 46.06,
      lng: 13.23,
      ...over,
    });

    const published: NormalizedEvent[] = [];
    const mkDeps = (
      drafts: TourShowDraft[],
      existing: ExistingShow[] = []
    ): TourSourceDeps => ({
      extract: async () => drafts,
      lookup: async () => existing,
      normalize: async (e: ExtractedEvent, opts) =>
        ({
          pubkey: 'p',
          signature: 's',
          title: e.title,
          lat: e.lat!,
          lng: e.lng!,
          start_time: String(e.start_time),
          category: e.category,
          created_at: opts?.createdAt ?? 'now',
          act_name: e.act_name,
          act_url: e.act_url,
          tags: e.tags,
          url: e.url,
          venue_name: e.venue_name,
          address: e.address,
          description: e.description,
        }) as NormalizedEvent,
      // A matched show is "unchanged" (what TourPublisher does when nothing
      // meaningful differs); only unmatched shows are posted.
      apply: async (ev, match) => {
        if (match) return 'unchanged';
        published.push(ev);
        return 'published';
      },
      today: '2030-10-01',
    });

    // band mode: every show belongs to the band, whatever the bill says
    published.length = 0;
    let res = await processTourSourcePage(
      page,
      cfg.sources[0],
      cfg,
      mkDeps([
        draft({}),
        draft({
          performers: ['Somebody Else'],
          start_time: '2030-11-13T21:00:00',
        }),
      ])
    );
    assert(
      res.length === 2 && res.every(r => r.outcome === 'published'),
      'band mode: all shows published'
    );
    assert(
      published.every(p => p.act_url === 'https://testband.example'),
      'band mode: attributed to the source band'
    );

    // listing mode: only registry bands (alias counts), others counted as unmatched
    published.length = 0;
    res = await processTourSourcePage(
      page,
      cfg.sources[1],
      cfg,
      mkDeps([
        draft({ performers: ['The Test Band'] }),
        draft({
          performers: ['Unknown Act'],
          start_time: '2030-11-14T21:00:00',
        }),
        draft({
          performers: ['Support', 'Other Band'],
          start_time: '2030-11-15T21:00:00',
        }),
      ])
    );
    assert(
      res.filter(r => r.outcome === 'published').length === 2,
      'listing: two registry bands published'
    );
    assert(
      res.filter(r => r.outcome === 'unmatched').length === 1,
      'listing: unknown act counted as unmatched'
    );
    assert(
      published
        .map(p => p.act_name)
        .sort()
        .join() === 'Other Band,Test Band',
      'listing: act attributed per show'
    );

    // listing with `only`
    published.length = 0;
    res = await processTourSourcePage(
      page,
      cfg.sources[2],
      cfg,
      mkDeps([
        draft({ performers: ['Test Band'] }),
        draft({
          performers: ['Other Band'],
          start_time: '2030-11-15T21:00:00',
        }),
      ])
    );
    assert(
      published.length === 1 && published[0].act_name === 'Other Band',
      'listing "only" restricts matching to the subset'
    );
    assert(
      res.filter(r => r.outcome === 'unmatched').length === 1,
      'registry band outside "only" counts as unmatched'
    );

    // past, region, no-location
    published.length = 0;
    res = await processTourSourcePage(
      page,
      cfg.sources[0],
      cfg,
      mkDeps([
        draft({ start_time: '2030-09-01T21:00:00' }),
        draft({
          lat: 40.7,
          lng: -74,
          city: 'New York',
          start_time: '2030-11-16T21:00:00',
        }),
      ])
    );
    assert(
      res
        .map(r => r.outcome)
        .sort()
        .join() === 'skipped_out_of_region,skipped_past',
      'past and out-of-region shows skipped'
    );
    assert(published.length === 0, 'nothing published for skipped shows');

    // region: none → worldwide for that band
    published.length = 0;
    const farCfg = parseCfg(`
defaults:
  region: { south: 34, west: -11, north: 72, east: 45 }
bands:
  - { name: Far Band, url: "https://far.example", region: none }
sources:
  - { url: "https://far.example/live", mode: band, band: Far Band }
`);
    res = await processTourSourcePage(
      page,
      farCfg.sources[0],
      farCfg,
      mkDeps([draft({ performers: ['Far Band'], lat: 40.7, lng: -74 })])
    );
    assert(
      published.length === 1,
      'region: none lets a worldwide band through the default region'
    );

    // existing match → created_at preserved, update path
    published.length = 0;
    const existing: ExistingShow[] = [
      {
        id: 'e1',
        title: 'Show',
        lat: 46.06,
        lng: 13.23,
        start_time: '2030-11-12T20:00:00',
        category: 'music',
        tags: [],
        created_at: '2030-01-01T10:00:00',
      },
    ];
    const updating = mkDeps([draft({})], existing);
    updating.apply = async (ev, match) => {
      if (!match) return 'published';
      published.push(ev);
      return 'updated';
    };
    await processTourSourcePage(page, cfg.sources[0], cfg, updating);
    assert(
      published[0]?.created_at === '2030-01-01T10:00:00',
      'update re-signs with the stored created_at'
    );

    // normalizer returning null → failed (no location); but reuse stored coords when matched
    const nullNorm = mkDeps([draft({})]);
    nullNorm.normalize = async () => null;
    res = await processTourSourcePage(page, cfg.sources[0], cfg, nullNorm);
    assert(
      res[0].outcome === 'failed',
      'no usable location and no match → failed'
    );

    // one lookup per band, not per show
    let lookups = 0;
    const counting = mkDeps([
      draft({}),
      draft({ start_time: '2030-11-13T21:00:00' }),
      draft({ start_time: '2030-11-14T21:00:00' }),
    ]);
    counting.lookup = async () => {
      lookups++;
      return [];
    };
    await processTourSourcePage(page, cfg.sources[0], cfg, counting);
    assert(lookups === 1, 'band existing shows looked up once per source run');

    // two drafts for the same show (listed twice on the page) → published once
    published.length = 0;
    await processTourSourcePage(
      page,
      cfg.sources[0],
      cfg,
      mkDeps([draft({}), draft({ title: 'Show (dup)' })])
    );
    assert(
      published.length === 1,
      'duplicate listing of one show published once'
    );

    // Same, with an apply that behaves like the real TourPublisher: a match
    // that differs is PUT, and a PUT to an id the API does not know 404s and
    // falls back to POST. The second listing carries more detail (a support
    // act → generated description), so it "differs" from the first; it must
    // still not be POSTed a second time.
    published.length = 0;
    const realish = mkDeps([
      draft({}),
      draft({
        performers: ['Test Band', 'Support Act'],
        start_time: '2030-11-12T21:30:00',
      }),
    ]);
    realish.apply = async (ev, match) => {
      if (match && !differs(match, ev)) return 'unchanged';
      published.push(ev); // POST, or a PUT to an unknown id → 404 → POST
      return 'published';
    };
    res = await processTourSourcePage(page, cfg.sources[0], cfg, realish);
    assert(
      published.length === 1,
      'duplicate listing with extra detail is not POSTed twice'
    );
    assert(
      res.length === 2 && res[0].outcome === 'published',
      'first listing published, second reported once'
    );

    // an existing show listed twice is updated once, not PUT twice
    published.length = 0;
    const twiceUpdated = mkDeps(
      [draft({}), draft({ title: 'Show (dup)' })],
      existing
    );
    twiceUpdated.apply = async (ev, match) => {
      published.push(ev);
      return match ? 'updated' : 'published';
    };
    res = await processTourSourcePage(page, cfg.sources[0], cfg, twiceUpdated);
    assert(
      published.length === 1 &&
        res.map(r => r.outcome).join() === 'updated,unchanged',
      'existing show listed twice is updated once'
    );

    // a geocoded show (no draft coordinates) outside the region is skipped
    published.length = 0;
    const geocoded = mkDeps([draft({ lat: undefined, lng: undefined })]);
    geocoded.normalize = async (e, opts) => ({
      pubkey: 'p',
      signature: 's',
      title: e.title,
      lat: 40.7,
      lng: -74,
      start_time: String(e.start_time),
      category: e.category,
      created_at: opts?.createdAt ?? 'now',
    });
    res = await processTourSourcePage(page, cfg.sources[0], cfg, geocoded);
    assert(
      res[0].outcome === 'skipped_out_of_region' && published.length === 0,
      'region checked on geocoded coordinates too'
    );

    // no draft coordinates: matched after geocoding, re-signed with created_at
    published.length = 0;
    const normCalls: (string | undefined)[] = [];
    const lateMatch = mkDeps(
      [draft({ lat: undefined, lng: undefined })],
      existing
    );
    lateMatch.normalize = async (e, opts) => {
      normCalls.push(opts?.createdAt);
      return {
        pubkey: 'p',
        signature: 's',
        title: e.title,
        lat: 46.0601,
        lng: 13.2301,
        start_time: String(e.start_time),
        category: e.category,
        created_at: opts?.createdAt ?? 'now',
      };
    };
    lateMatch.apply = async (ev, match) => {
      published.push(ev);
      return match ? 'updated' : 'published';
    };
    res = await processTourSourcePage(page, cfg.sources[0], cfg, lateMatch);
    assert(
      res[0].outcome === 'updated',
      'show without draft coordinates matched on geocoded position'
    );
    assert(
      published[0]?.created_at === '2030-01-01T10:00:00' &&
        normCalls.join() === ',2030-01-01T10:00:00',
      'late match re-normalized with stored created_at'
    );
  }

  console.log('\n=== tallyShows / sourceOutcome ===\n');
  {
    const r = (outcome: ShowResult['outcome']): ShowResult => ({
      title: 't',
      outcome,
    });
    const t = tallyShows([
      r('published'),
      r('updated'),
      r('unchanged'),
      r('unmatched'),
      r('skipped_past'),
      r('skipped_out_of_region'),
      r('failed'),
      r('published'),
    ]);
    assert(
      t.published === 2 &&
        t.updated === 1 &&
        t.unchanged === 1 &&
        t.unmatched === 1 &&
        t.skipped_past === 1 &&
        t.skipped_out_of_region === 1 &&
        t.failed === 1,
      'counters'
    );
    assert(
      sourceOutcome([r('unchanged'), r('published')]) === 'published',
      'published beats unchanged'
    );
    assert(
      sourceOutcome([r('unchanged'), r('updated')]) === 'updated',
      'updated beats unchanged'
    );
    assert(sourceOutcome([r('unchanged')]) === 'unchanged', 'unchanged');
    assert(
      sourceOutcome([r('unmatched'), r('skipped_past')]) === 'no_shows',
      'nothing publishable → no_shows'
    );
    assert(sourceOutcome([]) === 'no_shows', 'empty → no_shows');
    assert(
      sourceOutcome([r('failed'), r('failed')]) === 'failed',
      'only failures → failed'
    );
    assert(
      sourceOutcome([r('failed'), r('published')]) === 'published',
      'some success → that outcome'
    );
  }

  console.log('\n=== tours runner helpers ===\n');
  {
    assert(
      isDebugRequested(['node', 'x', '--debug'], {}).debug,
      '--debug recognised'
    );
    assert(
      isDebugRequested(['node', 'x'], { npm_config_debug: 'true' }).fromNpm,
      'npm-swallowed --debug recognised'
    );

    const results: TourSourceResult[] = [
      {
        url: 'https://a.example/live',
        outcome: 'published',
        shows: [
          { title: 'a', outcome: 'published' },
          { title: 'b', outcome: 'unmatched' },
        ],
      },
      { url: 'https://b.example/live', outcome: 'failed', shows: [] },
    ];
    const rec = buildTourRunRecord(
      results,
      new Date('2030-10-01T10:00:00Z'),
      new Date('2030-10-01T10:01:30Z')
    );
    assert(rec.kind === 'tours', 'record kind');
    assert(rec.sources_total === 2, 'sources_total');
    assert(rec.status === 'partial', 'one failed source → partial');
    assert(
      rec.published === 1 && rec.unmatched === 1,
      'show counters summed across sources'
    );
    assert(rec.duration_s === 90, 'duration');
    assert(
      JSON.stringify(rec.entries) ===
        JSON.stringify([
          { url: 'https://a.example/live', outcome: 'published' },
          { url: 'https://b.example/live', outcome: 'failed' },
        ]),
      'entries are {url, outcome} per source (what the stale report reads)'
    );
    const allFailed = buildTourRunRecord([results[1]], new Date(), new Date());
    assert(allFailed.status === 'failed', 'all sources failed → failed');
    assert(
      buildTourRunRecord(results.slice(0, 1), new Date(), new Date()).status ===
        'ok',
      'no failures → ok'
    );
  }

  console.log('\n=== looksBlocked / assertNotBlocked ===\n');
  {
    const cfText =
      'Attention Required! | Cloudflare Please enable cookies. Sorry, you have been blocked You are unable to access bandsintown.com Why have I been blocked?';
    assert(
      looksBlocked('Attention Required! | Cloudflare', cfText),
      'Cloudflare block page (title and text)'
    );
    assert(looksBlocked('', cfText), 'block text alone is enough');
    assert(
      looksBlocked(
        'Just a moment...',
        'Checking your browser before accessing example.com'
      ),
      'challenge interstitial'
    );
    assert(
      looksBlocked('Access Denied', 'You do not have permission'),
      'short page with a block title'
    );
    assert(
      !looksBlocked(
        'The Fratellis Concerts & Live Tour Dates',
        'Tour dates\n12 Nov Udine Club X\n20 Nov Ljubljana'
      ),
      'a normal short page'
    );
    assert(
      !looksBlocked('Contact', 'Please complete the form. Captcha protected.'),
      'the bare word captcha is not enough'
    );
    const long =
      'Tour dates and news. '.repeat(300) +
      ' Sorry, you have been blocked from commenting. Access denied to the shop.';
    assert(
      long.length > 3000 && !looksBlocked('Access denied news', long),
      'a long page that quotes block phrases is content'
    );
    assert(
      !looksBlocked('', ''),
      'empty page is not a block (that is "no shows", reported elsewhere)'
    );

    const ok = {
      url: 'https://a.example',
      title: 'Live',
      text: 'dates',
      html: '',
    };
    assert(
      assertNotBlocked(ok) === ok,
      'assertNotBlocked returns the page when fine'
    );
    let message = '';
    try {
      assertNotBlocked({
        url: 'https://b.example/live',
        title: 'Attention Required! | Cloudflare',
        text: cfText,
        html: '',
      });
    } catch (e) {
      message = (e as Error).message;
    }
    assert(
      /Blocked by bot protection/.test(message) &&
        message.includes('https://b.example/live'),
      'assertNotBlocked throws naming the url'
    );
  }

  console.log('\n=== run record: stale events ===\n');
  {
    const stale = { id: 'old1', band: 'Gillian Welch', lat: 55.7, lng: -3.7 };
    const withStale: TourSourceResult[] = [
      {
        url: 'https://a.example/tour',
        outcome: 'no_shows',
        shows: [
          { title: 'Forth Pub', outcome: 'skipped_out_of_region', stale },
          { title: 'Perth', outcome: 'skipped_out_of_region' },
        ],
      },
    ];
    const rec = buildTourRunRecord(withStale, new Date(), new Date());
    assert(
      Array.isArray((rec as any).stale) && (rec as any).stale.length === 1,
      'stale events are recorded'
    );
    assert(
      (rec as any).stale[0].id === 'old1' &&
        (rec as any).stale[0].title === 'Forth Pub' &&
        (rec as any).stale[0].source === 'https://a.example/tour',
      'with id, title and source'
    );
    const clean = buildTourRunRecord(
      [
        {
          url: 'u',
          outcome: 'published',
          shows: [{ title: 't', outcome: 'published' }],
        },
      ],
      new Date(),
      new Date()
    );
    assert(!('stale' in clean), 'no stale key when there are none');
  }

  console.log('\n=== run record: failed shows per source ===\n');
  {
    const results: TourSourceResult[] = [
      {
        url: 'https://a.example/live',
        outcome: 'published',
        shows: [
          { title: 'a', outcome: 'published' },
          { title: 'b', outcome: 'failed' },
          { title: 'c', outcome: 'failed' },
        ],
      },
      {
        url: 'https://b.example/live',
        outcome: 'unchanged',
        shows: [{ title: 'x', outcome: 'unchanged' }],
      },
      { url: 'https://c.example/live', outcome: 'failed', shows: [] },
    ];
    const rec = buildTourRunRecord(
      results,
      new Date('2030-10-01T10:00:00Z'),
      new Date('2030-10-01T10:01:00Z')
    );
    assert(
      rec.entries[0].failed_shows === 2,
      'failed shows are counted per source'
    );
    assert(
      !('failed_shows' in rec.entries[1]),
      'no failed_shows key when nothing failed'
    );
    assert(
      !('failed_shows' in rec.entries[2]),
      'a source that failed outright has no shows to count'
    );
  }

  console.log('\n=== selectRetrySources ===\n');
  {
    const src = (url: string) => ({ url, mode: 'band' as const, band: 'X' });
    const sources = [
      src('https://a.example/live'),
      src('https://b.example/live'),
      src('https://c.example/live'),
      src('https://d.example/live'),
    ];
    const rec = (
      kind: string,
      started: string,
      entries: { url: string; outcome: string; failed_shows?: number }[]
    ): RunRecord => ({ kind: kind as any, started_at: started, entries });

    const none = selectRetrySources(sources, []);
    assert(
      none.noPreviousRun && none.sources.length === 0,
      'no previous tours run'
    );
    assert(
      selectRetrySources(sources, [
        rec('radar', 'r', [
          { url: 'https://a.example/live', outcome: 'failed' },
        ]),
      ]).noPreviousRun,
      'other kinds of runs are ignored'
    );

    const records: RunRecord[] = [
      rec('tours', '2030-10-01', [
        { url: 'https://a.example/live', outcome: 'failed' },
        { url: 'https://b.example/live', outcome: 'failed' },
      ]),
      rec('tours', '2030-10-02', [
        { url: 'https://a.example/live', outcome: 'failed' },
        { url: 'https://b.example/live', outcome: 'published' },
        {
          url: 'https://c.example/live',
          outcome: 'published',
          failed_shows: 2,
        },
        { url: 'https://d.example/live', outcome: 'no_shows' },
        { url: 'https://gone.example/live', outcome: 'failed' },
      ]),
      rec('radar', '2030-10-03', [
        { url: 'https://d.example/live', outcome: 'failed' },
      ]),
    ];
    const sel = selectRetrySources(sources, records);
    assert(
      !sel.noPreviousRun && sel.basedOn === '2030-10-02',
      'based on the latest tours run only'
    );
    assert(
      sel.sources.map(s => s.url).join() ===
        'https://a.example/live,https://c.example/live',
      'failed sources and sources with failed shows, in bands.yaml order'
    );
    assert(
      sel.missing.join() === 'https://gone.example/live',
      'failed urls no longer in bands.yaml are reported, not run'
    );

    const clean = selectRetrySources(sources, [
      rec('tours', '2030-10-04', [
        { url: 'https://a.example/live', outcome: 'published' },
      ]),
    ]);
    assert(
      !clean.noPreviousRun && clean.sources.length === 0,
      'a clean last run selects nothing'
    );
    const old = selectRetrySources(sources, [
      rec('tours', 'x', [{ url: 'https://b.example/live', outcome: 'failed' }]),
    ]);
    assert(
      old.sources.length === 1,
      'records from before failed_shows existed still work'
    );
  }

  console.log('\n=== region and country reach the geocoder ===\n');
  {
    const band: BandConfig = {
      name: 'Gillian Welch',
      url: 'https://gw.example',
      status: 'active',
    };
    const base: TourShowDraft = {
      title: 'Gillian Welch',
      performers: ['Gillian Welch'],
      start_time: '2030-02-12',
      venue_name: 'Forth Pub',
      city: 'Forth',
    };
    const addr = (over: Partial<TourShowDraft>) =>
      finalizeTourShow({ ...base, ...over }, band, 'https://gw.example/tour')
        .address;

    assert(
      addr({ region: 'TAS', country: 'Australia' }) === 'Forth, TAS, Australia',
      'city, region and country are all passed on'
    );
    assert(addr({ region: 'TN' }) === 'Forth, TN', 'region alone');
    assert(
      addr({ country: 'New Zealand', city: 'Auckland' }) ===
        'Auckland, New Zealand',
      'country alone'
    );
    assert(
      addr({
        address: 'Via Roma 1',
        city: 'Udine',
        region: 'UD',
        country: 'Italy',
      }) === 'Via Roma 1, Udine, UD, Italy',
      'street address first, then city, region, country'
    );
    assert(
      addr({
        address: 'Via Roma 1, Udine, Italy',
        city: 'Udine',
        country: 'Italy',
      }) === 'Via Roma 1, Udine, Italy',
      'parts already in the address are not repeated'
    );
    assert(
      addr({
        address: 'Perth, WA, Australia',
        city: 'Perth',
        region: 'WA',
        country: 'Australia',
      }) === 'Perth, WA, Australia',
      'a full address is left alone'
    );
    assert(
      addr({
        address: 'Warner Theatre, 513 13th St',
        city: 'Washington',
        region: 'WA',
      }) === 'Warner Theatre, 513 13th St, Washington, WA',
      'a region code is not mistaken for a part of another word'
    );
    assert(
      addr({ city: undefined, region: 'TAS', country: 'Australia' }) ===
        'TAS, Australia',
      'no city: what exists is still passed on'
    );
    assert(
      addr({ city: undefined }) === undefined,
      'nothing to geocode from stays undefined'
    );

    const parsed = parseTourShows(
      {
        shows: [
          {
            title: 'T',
            performers: ['A'],
            start_time: '2030-02-12',
            city: 'Forth',
            region: ' TAS ',
            country: 'Australia',
          },
        ],
      },
      'https://gw.example/tour'
    );
    assert(
      parsed[0].region === 'TAS' && parsed[0].country === 'Australia',
      'region and country survive parsing (trimmed)'
    );
    const noExtras = parseTourShows(
      {
        shows: [
          {
            title: 'T',
            performers: ['A'],
            start_time: '2030-02-12',
            region: null,
            country: '',
          },
        ],
      },
      'https://gw.example/tour'
    );
    assert(
      noExtras[0].region === undefined && noExtras[0].country === undefined,
      'null or empty region/country are dropped'
    );

    const finalized = finalizeTourShow(
      { ...base, region: 'TAS', country: 'Australia' },
      band,
      'https://gw.example/tour'
    ) as unknown as Record<string, unknown>;
    assert(
      !('region' in finalized) &&
        !('country' in finalized) &&
        !('city' in finalized),
      'region, country and city are not sent to the API'
    );

    const prompt = getTourShowsPrompt();
    assert(
      /"region"|\*\*region\*\*/.test(prompt) && /country/.test(prompt),
      'the extraction prompt asks for region and country'
    );
    assert(
      /never drop|do not drop|must not drop/i.test(prompt),
      'the prompt forbids dropping them'
    );
    assert(
      /infer/i.test(prompt) && /surrounding/i.test(prompt),
      'the prompt lets the model infer region/country from the surrounding shows'
    );
    assert(
      /only when|if,? and only if/i.test(prompt),
      'and only when the context makes the place unambiguous'
    );
    assert(
      /Durham/.test(prompt),
      'with a worked example of a bare city among US cities'
    );
    assert(
      /Never replace a region or country that the page prints/i.test(prompt),
      'printed values are never replaced'
    );
    assert(
      !/do not guess it/i.test(prompt),
      'the old blanket ban on guessing the country is gone'
    );
  }

  console.log(
    '\n=== matchShow: same date and venue, different coordinates ===\n'
  );
  {
    const mk = (over: Partial<ExistingShow> = {}): ExistingShow => ({
      id: 'old',
      title: 'Show',
      lat: 55.7,
      lng: -3.7, // wrongly placed in Scotland
      start_time: '2030-02-12T00:00:00',
      category: 'music',
      tags: [],
      venue_name: 'Forth Pub',
      created_at: '2030-01-01T10:00:00',
      ...over,
    });
    const tas = { lat: -41.18, lng: 146.2 };
    assert(
      matchShow([mk()], '2030-02-12T20:00:00', tas.lat, tas.lng, 'Forth Pub')
        ?.id === 'old',
      'same day + same venue matches although the coordinates are far apart'
    );
    assert(
      matchShow([mk()], '2030-02-12T20:00:00', tas.lat, tas.lng, 'forth PUB!')
        ?.id === 'old',
      'venue names compare case-, accent- and punctuation-insensitively'
    );
    assert(
      matchShow(
        [mk()],
        '2030-02-12T20:00:00',
        undefined,
        undefined,
        'Forth Pub'
      )?.id === 'old',
      'without coordinates the venue alone can match'
    );
    assert(
      matchShow(
        [mk()],
        '2030-02-13T20:00:00',
        tas.lat,
        tas.lng,
        'Forth Pub'
      ) === undefined,
      'another day does not match'
    );
    assert(
      matchShow(
        [mk()],
        '2030-02-12T20:00:00',
        tas.lat,
        tas.lng,
        'Albert Hall'
      ) === undefined,
      'another venue does not match'
    );
    assert(
      matchShow([mk()], '2030-02-12T20:00:00', tas.lat, tas.lng) === undefined,
      'no venue given: coordinates only, as before'
    );
    assert(
      matchShow(
        [mk({ venue_name: null })],
        '2030-02-12T20:00:00',
        tas.lat,
        tas.lng,
        'Forth Pub'
      ) === undefined,
      'a stored show without a venue is never matched by venue'
    );
    assert(
      matchShow(
        [mk({ venue_name: '' })],
        '2030-02-12T20:00:00',
        undefined,
        undefined,
        ''
      ) === undefined,
      'empty venue names never match each other'
    );
    const near = mk({
      id: 'near',
      lat: -41.1,
      lng: 146.2,
      venue_name: 'Other',
    });
    assert(
      matchShow(
        [mk(), near],
        '2030-02-12T20:00:00',
        -41.1001,
        146.2001,
        'Forth Pub'
      )?.id === 'near',
      'a match by coordinates wins over a match by venue'
    );
    const far = mk({ id: 'far' });
    const closer = mk({ id: 'closer', lat: -30, lng: 140 });
    assert(
      matchShow(
        [far, closer],
        '2030-02-12T20:00:00',
        tas.lat,
        tas.lng,
        'Forth Pub'
      )?.id === 'closer',
      'among several same-venue matches the nearest wins'
    );
  }

  console.log(
    '\n=== a wrongly placed show is corrected, or reported when it leaves the region ===\n'
  );
  {
    const cfgEurope = parseCfg(`
defaults:
  region: { south: 34, west: -11, north: 72, east: 45 }
bands:
  - name: Test Band
    url: https://testband.example
sources:
  - { url: "https://testband.example/tour", mode: band, band: Test Band }
`);
    const cfgWorld = parseCfg(`
bands:
  - { name: Test Band, url: "https://testband.example", region: none }
sources:
  - { url: "https://testband.example/tour", mode: band, band: Test Band }
`);
    const pg: FetchedPage = {
      url: 'https://testband.example/tour',
      title: 'T',
      html: '',
      text: 'x',
    };
    const sent: { ev: NormalizedEvent; matched?: string }[] = [];
    const deps = (
      drafts: TourShowDraft[],
      existing: ExistingShow[],
      geocodeTo?: { lat: number; lng: number }
    ): TourSourceDeps => ({
      extract: async () => drafts,
      lookup: async () => existing,
      normalize: async (e: ExtractedEvent, opts) => {
        const lat = e.lat ?? geocodeTo?.lat;
        const lng = e.lng ?? geocodeTo?.lng;
        if (lat === undefined || lng === undefined) return null;
        return {
          pubkey: 'p',
          signature: 's',
          title: e.title,
          lat,
          lng,
          start_time: String(e.start_time),
          category: e.category,
          created_at: opts?.createdAt ?? 'now',
          venue_name: e.venue_name,
          act_name: e.act_name,
          act_url: e.act_url,
        } as NormalizedEvent;
      },
      apply: async (ev, match) => {
        sent.push({ ev, matched: match?.id });
        if (!match) return 'published';
        return Math.abs(match.lat - ev.lat) > 0.005 ||
          Math.abs(match.lng - ev.lng) > 0.005
          ? 'updated'
          : 'unchanged';
      },
      today: '2030-01-01',
    });
    const wrong: ExistingShow = {
      id: 'old1',
      title: 'Gillian Welch',
      lat: 55.7,
      lng: -3.7,
      start_time: '2030-02-12T00:00:00',
      category: 'music',
      tags: [],
      venue_name: 'Forth Pub',
      created_at: '2030-01-01T10:00:00',
    };
    const forth = (over: Partial<TourShowDraft> = {}): TourShowDraft => ({
      title: 'Gillian Welch',
      performers: ['Test Band'],
      start_time: '2030-02-12',
      venue_name: 'Forth Pub',
      city: 'Forth',
      region: 'TAS',
      country: 'Australia',
      ...over,
    });

    // worldwide band: the wrong event is corrected in place (PUT, created_at kept)
    sent.length = 0;
    let res = await processTourSourcePage(
      pg,
      cfgWorld.sources[0],
      cfgWorld,
      deps([forth()], [wrong], { lat: -41.18, lng: 146.2 })
    );
    assert(
      res.length === 1 && res[0].outcome === 'updated',
      'wrongly placed show is updated, not duplicated'
    );
    assert(
      sent.length === 1 &&
        sent[0].matched === 'old1' &&
        sent[0].ev.created_at === '2030-01-01T10:00:00',
      'it updates the existing event and re-signs with its created_at'
    );
    assert(
      Math.abs(sent[0].ev.lat + 41.18) < 0.001,
      'with the corrected coordinates'
    );

    // Europe-only band: the correct place is outside the region; nothing is sent, the old event is reported
    sent.length = 0;
    res = await processTourSourcePage(
      pg,
      cfgEurope.sources[0],
      cfgEurope,
      deps([forth()], [wrong], { lat: -41.18, lng: 146.2 })
    );
    assert(
      res[0].outcome === 'skipped_out_of_region' && sent.length === 0,
      'outside the region: nothing is published or updated'
    );
    assert(
      res[0].stale?.id === 'old1' && res[0].stale?.band === 'Test Band',
      'the published event that is now wrong is reported (id and band)'
    );

    // out of region with nothing published before: no stale report
    res = await processTourSourcePage(
      pg,
      cfgEurope.sources[0],
      cfgEurope,
      deps([forth()], [], { lat: -41.18, lng: 146.2 })
    );
    assert(
      res[0].outcome === 'skipped_out_of_region' && res[0].stale === undefined,
      'nothing to report when nothing was published'
    );

    // a stored event that already sits at the right place is not reported
    res = await processTourSourcePage(
      pg,
      cfgEurope.sources[0],
      cfgEurope,
      deps([forth()], [{ ...wrong, lat: -41.18, lng: 146.2 }], {
        lat: -41.18,
        lng: 146.2,
      })
    );
    assert(
      res[0].outcome === 'skipped_out_of_region' && res[0].stale === undefined,
      'same place as stored: not stale'
    );

    // corrected place inside the region: updated in place, no stale report
    sent.length = 0;
    const boiler: ExistingShow = {
      ...wrong,
      id: 'old2',
      lat: -33.9,
      lng: 151.2,
      venue_name: 'Boiler Shop',
    };
    res = await processTourSourcePage(
      pg,
      cfgEurope.sources[0],
      cfgEurope,
      deps(
        [
          forth({
            venue_name: 'Boiler Shop',
            city: 'Newcastle',
            region: undefined,
            country: 'UK',
          }),
        ],
        [boiler],
        { lat: 54.97, lng: -1.61 }
      )
    );
    assert(
      res[0].outcome === 'updated' &&
        res[0].stale === undefined &&
        sent[0].matched === 'old2',
      'a wrongly placed show whose correct place is in the region is updated'
    );

    // no coordinates in the draft: matched by venue before geocoding, created_at kept
    sent.length = 0;
    res = await processTourSourcePage(
      pg,
      cfgWorld.sources[0],
      cfgWorld,
      deps([forth()], [wrong], { lat: -41.18, lng: 146.2 })
    );
    assert(
      sent[0].ev.created_at === '2030-01-01T10:00:00',
      'matched by venue before geocoding, so the update is signed with the stored created_at'
    );
  }

  console.log('\n=== geocoder candidates and bias ===\n');
  {
    setGeocodeMinIntervalMs(0);
    const realFetch = globalThis.fetch;
    try {
      const requested: string[] = [];
      // A tiny fake Nominatim: query → rows (or an HTTP status number).
      const row = (
        lat: number,
        lng: number,
        importance: number,
        cc: string,
        name: string
      ) => ({
        lat: String(lat),
        lon: String(lng),
        display_name: name,
        importance,
        address: { country_code: cc },
      });
      const table: Record<string, unknown[] | number> = {
        Durham: [
          row(54.67, -1.75, 0.619, 'gb', 'County Durham, England, UK'),
          row(36.0, -78.9, 0.619, 'us', 'Durham, North Carolina, USA'),
          row(54.78, -1.58, 0.594, 'gb', 'Durham, England, UK'),
          row(43.12, -70.92, 0.513, 'us', 'Durham, New Hampshire, USA'),
        ],
        Sydney: [
          row(
            -33.87,
            151.21,
            0.782,
            'au',
            'Sydney, New South Wales, Australia'
          ),
          row(46.14, -60.19, 0.512, 'ca', 'Sydney, Nova Scotia, Canada'),
        ],
        Atlanta: [row(33.75, -84.39, 0.7, 'us', 'Atlanta, Georgia, USA')],
        Washington: [row(38.9, -77.04, 0.8, 'us', 'Washington, DC, USA')],
        Asheville: [
          row(35.6, -82.55, 0.6, 'us', 'Asheville, North Carolina, USA'),
        ],
        Nowhere: [],
        Limited: 429,
      };
      const stub = () => {
        requested.length = 0;
        clearGeocodeCache();
        globalThis.fetch = (async (url: any) => {
          const q = new URL(String(url)).searchParams.get('q')!;
          requested.push(q);
          const hit = table[q];
          if (typeof hit === 'number')
            return { ok: false, status: hit, json: async () => [] } as Response;
          return {
            ok: true,
            status: 200,
            json: async () => hit ?? [],
          } as Response;
        }) as typeof fetch;
      };

      stub();
      const durham = await geocodeCandidates('Durham');
      assert(
        durham.length === 4 &&
          durham[0].countryCode === 'GB' &&
          durham[1].displayName.includes('North Carolina'),
        'candidates are parsed (importance, display name, upper-case country code)'
      );
      assert(
        durham[1].importance === 0.619 &&
          durham[1].lat === 36.0 &&
          durham[1].lng === -78.9,
        'with coordinates and importance as numbers'
      );
      await geocodeCandidates('Durham');
      await geocodeCandidates('  durham ');
      assert(
        requested.length === 1,
        'the same query is requested once per process (cached, case- and space-insensitive)'
      );
      assert(
        (await geocodeCandidates('Nowhere')).length === 0,
        'no results is an empty list'
      );
      assert(
        await geocodeCandidates('Limited').then(
          () => false,
          e => /429/.test(String(e))
        ),
        'HTTP errors reject'
      );
      const before = requested.length;
      await geocodeCandidates('Limited').catch(() => {});
      assert(requested.length === before + 1, 'a failed request is not cached');

      // pickCandidate
      const cand = (
        lat: number,
        lng: number,
        importance: number,
        cc = 'xx'
      ): GeoCandidate => ({
        lat,
        lng,
        importance,
        displayName: `${lat},${lng}`,
        countryCode: cc,
      });
      const NA = { lat: 37, lng: -80 };
      assert(pickCandidate([], NA) === undefined, 'no candidates → undefined');
      assert(
        pickCandidate(durham)?.countryCode === 'GB',
        'without a bias the first candidate is used, as before'
      );
      assert(
        pickCandidate(durham, NA)?.displayName.includes('North Carolina') ===
          true,
        'a tie (0.619 / 0.619) goes to the candidate nearest the bias'
      );
      const sydney = await geocodeCandidates('Sydney');
      assert(
        pickCandidate(sydney, NA)?.countryCode === 'AU',
        'a clear winner (0.782 vs 0.512) is kept whatever the bias'
      );
      const near = [cand(10, 10, 0.5), cand(50, 50, 0.52), cand(11, 11, 0.9)];
      assert(
        pickCandidate(near, { lat: 50, lng: 50 })?.importance === 0.9,
        'only candidates within the margin of the best compete'
      );
      assert(
        pickCandidate(
          [cand(10, 10, 0.5), cand(50, 50, 0.46)],
          { lat: 50, lng: 50 },
          0.1
        )?.lat === 50,
        'the margin is a parameter'
      );
      assert(
        pickCandidate([cand(1, 1, 0), cand(2, 2, 0)], { lat: 2, lng: 2 })
          ?.lat === 2,
        'missing importance (0) ties everything: nearest wins'
      );

      // geocodeAddress
      stub();
      assert(
        (await geocodeAddress('Durham'))?.lat === 54.67,
        'geocodeAddress without a bias is unchanged (first candidate)'
      );
      const biased = await geocodeAddress('Durham', undefined, { bias: NA });
      assert(
        biased?.lat === 36.0 &&
          !!biased?.displayName.includes('North Carolina'),
        'with a bias the near-tie resolves to North Carolina'
      );
      assert(
        requested.filter(q => q === 'Durham').length === 1,
        'both calls share one request'
      );
      assert(
        (await geocodeAddress('Sydney', undefined, { bias: NA }))?.lat ===
          -33.87,
        'Sydney stays in Australia with the same bias'
      );
      assert(
        (await geocodeAddress('Nowhere', undefined, { bias: NA })) === null,
        'no result stays null'
      );

      // medianBias
      stub();
      const bias3 = await medianBias([
        'Atlanta',
        'Washington',
        'Asheville',
        'Durham',
      ]);
      assert(
        !!bias3 && bias3.lat > 33 && bias3.lat < 40 && bias3.lng < -70,
        'the median of the first candidates is in North America (the UK Durham among four places cannot move it)'
      );
      stub();
      assert(
        (await medianBias(['Atlanta', 'Washington'])) === undefined,
        'fewer than 3 places: no bias'
      );
      stub();
      const withFailures = await medianBias([
        'Atlanta',
        'Limited',
        'Nowhere',
        'Washington',
        'Asheville',
        'Atlanta',
      ]);
      assert(
        !!withFailures,
        'failing and empty queries are skipped, duplicates counted once'
      );
      stub();
      await medianBias(['Atlanta', 'atlanta ', 'Washington', 'Asheville']);
      assert(
        requested.filter(q => q.toLowerCase().trim() === 'atlanta').length ===
          1,
        'the same place is looked up once'
      );
    } finally {
      globalThis.fetch = realFetch;
      clearGeocodeCache();
      setGeocodeMinIntervalMs(1100);
    }
  }

  console.log('\n=== the normalizer passes geoBias to the geocoder ===\n');
  {
    setGeocodeMinIntervalMs(0);
    clearGeocodeCache();
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => [
            {
              lat: '54.67',
              lon: '-1.75',
              display_name: 'County Durham, England, UK',
              importance: 0.619,
              address: { country_code: 'gb' },
            },
            {
              lat: '36.0',
              lon: '-78.9',
              display_name: 'Durham, North Carolina, USA',
              importance: 0.619,
              address: { country_code: 'us' },
            },
          ],
        }) as Response) as typeof fetch;

      const privkey = bytesToHex(ed.utils.randomPrivateKey());
      const pubkey = bytesToHex(
        await ed.getPublicKeyAsync(hexToBytes(privkey))
      );
      const normalizer = new EventNormalizer({ keypair: { privkey, pubkey } });
      const event = {
        title: 'DPAC',
        address: 'Durham',
        start_time: '2030-10-27T20:00:00',
        category: 'music' as const,
      };

      const plain = await normalizer.normalize(event);
      assert(
        plain?.lat === 54.67,
        'without a bias: the first candidate, as before'
      );
      const biased = await normalizer.normalize(event, {
        geoBias: { lat: 37, lng: -80 },
      });
      assert(
        biased?.lat === 36.0 && biased?.lng === -78.9,
        'with geoBias: North Carolina'
      );
      const withCoords = await normalizer.normalize(
        { ...event, lat: 1, lng: 2 },
        { geoBias: { lat: 37, lng: -80 } }
      );
      assert(
        withCoords?.lat === 1 && withCoords?.lng === 2,
        'coordinates already known are never overridden by the bias'
      );
    } finally {
      globalThis.fetch = realFetch;
      clearGeocodeCache();
      setGeocodeMinIntervalMs(1100);
    }
  }

  console.log('\n=== buildAddress / placeQuery ===\n');
  {
    const d = (over: Partial<TourShowDraft>): TourShowDraft => ({
      title: 'T',
      performers: ['A'],
      start_time: '2030-02-12',
      ...over,
    });
    assert(
      buildAddress(d({ city: 'Durham', region: 'NC' })) === 'Durham, NC',
      'city + region'
    );
    assert(
      buildAddress(
        d({ address: 'Via Roma 1', city: 'Udine', country: 'Italy' })
      ) === 'Via Roma 1, Udine, Italy',
      'street first'
    );
    assert(buildAddress(d({})) === undefined, 'nothing to build from');
    assert(
      placeQuery(d({ city: 'Durham', region: 'NC', venue_name: 'DPAC' })) ===
        'Durham, NC',
      'the geocoder query is the address when there is one'
    );
    assert(
      placeQuery(d({ venue_name: 'DPAC' })) === 'DPAC',
      'the venue name otherwise'
    );
    assert(placeQuery(d({})) === undefined, 'nothing to geocode');
    const finalized = finalizeTourShow(
      d({ city: 'Durham', region: 'NC' }),
      { name: 'B', url: 'https://b.example', status: 'active' },
      'https://p.example'
    );
    assert(
      finalized.address === buildAddress(d({ city: 'Durham', region: 'NC' })),
      'finalizeTourShow uses the same address'
    );
  }

  console.log(
    '\n=== source processing: page centre and shows held by another key ===\n'
  );
  {
    const cfgW = parseCfg(`
bands:
  - { name: Test Band, url: "https://testband.example", region: none }
sources:
  - { url: "https://testband.example/tour", mode: band, band: Test Band }
`);
    const pg: FetchedPage = {
      url: 'https://testband.example/tour',
      title: 'T',
      html: '',
      text: 'x',
    };
    const sentBias: (GeoBias | undefined)[] = [];
    let queries: string[] = [];
    let applied = 0;
    const mk = (
      drafts: TourShowDraft[],
      existing: ExistingShow[] = [],
      locate?: TourSourceDeps['locate']
    ): TourSourceDeps => ({
      extract: async () => drafts,
      lookup: async () => existing,
      normalize: async (e: ExtractedEvent, opts) => {
        sentBias.push(opts?.geoBias);
        return {
          pubkey: 'me',
          signature: 's',
          title: e.title,
          lat: e.lat ?? 36,
          lng: e.lng ?? -78.9,
          start_time: String(e.start_time),
          category: e.category,
          created_at: opts?.createdAt ?? 'now',
          venue_name: e.venue_name,
          act_name: e.act_name,
          act_url: e.act_url,
        } as NormalizedEvent;
      },
      apply: async (_ev, match) => {
        applied++;
        return match ? 'unchanged' : 'published';
      },
      today: '2030-01-01',
      ownPubkey: 'me',
      ...(locate ? { locate } : {}),
    });
    const show = (over: Partial<TourShowDraft>): TourShowDraft => ({
      title: 'Beck',
      performers: ['Test Band'],
      start_time: '2030-10-27',
      venue_name: 'DPAC',
      city: 'Durham',
      ...over,
    });

    // locate receives the place queries of upcoming shows without coordinates
    sentBias.length = 0;
    await processTourSourcePage(
      pg,
      cfgW.sources[0],
      cfgW,
      mk(
        [
          show({}),
          show({ start_time: '2030-10-28', city: 'Asheville', region: 'NC' }),
          show({
            start_time: '2030-10-29',
            city: 'Atlanta',
            lat: 33.7,
            lng: -84.4,
          }),
          show({ start_time: '2029-12-01', city: 'Pastville' }),
          show({
            start_time: '2030-11-01',
            city: undefined,
            venue_name: 'Some Hall',
          }),
        ],
        [],
        async qs => {
          queries = qs;
          return { lat: 36, lng: -80 };
        }
      )
    );
    assert(
      JSON.stringify(queries) ===
        JSON.stringify(['Durham', 'Asheville, NC', 'Some Hall']),
      'locate gets the query of each upcoming show that has no coordinates (not past ones, not ones with coordinates)'
    );
    assert(
      sentBias.length >= 3 &&
        sentBias.every(b => b?.lat === 36 && b?.lng === -80),
      'the bias reaches every normalize call'
    );

    // locate failing or absent: nothing changes
    sentBias.length = 0;
    const res1 = await processTourSourcePage(
      pg,
      cfgW.sources[0],
      cfgW,
      mk([show({})], [], async () => {
        throw new Error('429');
      })
    );
    assert(
      res1[0].outcome === 'published' && sentBias.every(b => b === undefined),
      'a failing locate does not fail the shows and gives no bias'
    );
    sentBias.length = 0;
    await processTourSourcePage(pg, cfgW.sources[0], cfgW, mk([show({})]));
    assert(
      sentBias.every(b => b === undefined),
      'without locate there is no bias'
    );
    let called = 0;
    await processTourSourcePage(
      pg,
      cfgW.sources[0],
      cfgW,
      mk([show({ lat: 1, lng: 2 })], [], async () => {
        called++;
        return undefined;
      })
    );
    assert(
      called === 1,
      'locate is still called once (with an empty list when every show has coordinates)'
    );

    // a show held by another key is left alone
    applied = 0;
    const foreign: ExistingShow = {
      id: 'x1',
      title: 'Beck',
      lat: 36,
      lng: -78.9,
      start_time: '2030-10-27T00:00:00',
      category: 'music',
      tags: [],
      venue_name: 'DPAC',
      created_at: 'c',
      pubkey: 'someone-else',
      act_url: 'https://testband.example',
    };
    const res2 = await processTourSourcePage(
      pg,
      cfgW.sources[0],
      cfgW,
      mk([show({})], [foreign])
    );
    assert(
      res2[0].outcome === 'unchanged' && applied === 0,
      'a show already in the database under another key is unchanged: never updated, never re-posted'
    );
    applied = 0;
    const own: ExistingShow = { ...foreign, id: 'x2', pubkey: 'me' };
    const res3 = await processTourSourcePage(
      pg,
      cfgW.sources[0],
      cfgW,
      mk([show({})], [own])
    );
    assert(
      applied === 1 && res3[0].outcome === 'unchanged',
      'our own match still goes through apply (update logic)'
    );
    applied = 0;
    const noKey: ExistingShow = { ...foreign, id: 'x3', pubkey: undefined };
    await processTourSourcePage(
      pg,
      cfgW.sources[0],
      cfgW,
      mk([show({})], [noKey])
    );
    assert(
      applied === 1,
      'a match without a pubkey (older records) is treated as ours'
    );
  }

  console.log('\n=== adopted / duplicate outcomes ===\n');
  {
    const r = (outcome: ShowResult['outcome']): ShowResult => ({
      title: 't',
      outcome,
    });
    const t = tallyShows([
      r('adopted'),
      r('adopted'),
      r('duplicate'),
      r('published'),
    ]);
    assert(
      t.adopted === 2 &&
        t.duplicate === 1 &&
        t.published === 1 &&
        t.failed === 0,
      'new counters'
    );
    assert(
      sourceOutcome([r('adopted')]) === 'updated',
      'a source whose best result is an adoption counts as updated (healthy)'
    );
    assert(
      sourceOutcome([r('duplicate')]) === 'unchanged',
      'a source whose shows are all duplicates is healthy, not dead'
    );
    assert(
      sourceOutcome([r('duplicate'), r('failed')]) === 'unchanged',
      'a duplicate beats a failure'
    );
    assert(
      sourceOutcome([r('published'), r('adopted')]) === 'published',
      'published still wins'
    );
    assert(
      sourceOutcome([r('adopted'), r('unchanged')]) === 'updated',
      'adopted beats unchanged'
    );

    const rec = buildTourRunRecord(
      [
        {
          url: 'https://a.example/tour',
          outcome: 'updated',
          shows: [r('adopted'), r('duplicate')],
        },
      ],
      new Date(),
      new Date()
    );
    assert(
      (rec as any).adopted === 1 && (rec as any).duplicate === 1,
      'the run record carries the new counters'
    );
    assert(
      rec.status === 'ok',
      'adopted and duplicate shows do not make a run partial'
    );
  }

  console.log('\n=== adopting: signature matches the worker ===\n');
  {
    // ACT_VECTOR from worker/src/index.test.ts: the same bytes the worker verifies.
    const V = {
      privkey:
        '0101010101010101010101010101010101010101010101010101010101010101',
      eventId:
        'abababababababababababababababababababababababababababababababab',
      actName: 'Test Band',
      actUrl: 'https://testband.example',
      signature:
        'eb42a79e717ed8cf6a9657d1f8b426ee770dc35a6705a77f648b1b27f908d139f7481f05e916b75fc5a6c7ecf4e38ff4c1daa70dff51ce70cd19b923e9b64303',
    };
    assert(
      (await signAdoption(V.privkey, V.eventId, V.actName, V.actUrl)) ===
        V.signature,
      'signAdoption reproduces the worker test vector byte for byte'
    );
    assert(
      (await adoptMessage(V.eventId, V.actName, V.actUrl)).length === 32,
      'the signed message is a SHA-256 digest'
    );
    assert(
      (await signAdoption(V.privkey, V.eventId, 'Other', V.actUrl)) !==
        V.signature,
      'a different name gives a different signature'
    );
  }

  console.log('\n=== TourPublisher: lookup by act_url only ===\n');
  {
    const calls: string[] = [];
    const page = (events: unknown[], hasMore: boolean) =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          events,
          offset: 0,
          count: events.length,
          has_more: hasMore,
        }),
      }) as Response;
    let n = 0;
    const f = (async (url: string) => {
      calls.push(String(url));
      n++;
      return n === 1
        ? page(
            [
              { id: 'a', pubkey: 'other', act_url: 'https://x.example' },
              { id: 'b', pubkey: 'me' },
            ],
            true
          )
        : page([{ id: 'c' }], false);
    }) as unknown as typeof fetch;
    const pub = new TourPublisher('http://api.test', 'me', f);
    const found = await pub.lookup('https://x.example');
    assert(
      found.map(s => s.id).join() === 'a,b,c',
      'every page is followed (has_more) and shows of other keys are included'
    );
    const q0 = new URL(calls[0]).searchParams;
    assert(
      !q0.has('pubkey') && q0.get('act_url') === 'https://x.example',
      'the lookup is by act_url, not by pubkey'
    );
    assert(
      q0.get('from') === '1970-01-01T00:00:00' &&
        q0.get('to') === '2999-12-31T23:59:59',
      'with the explicit wide window'
    );
    assert(
      new URL(calls[1]).searchParams.get('offset') === '2',
      'the second page starts after the first page’s events'
    );
    const bareArray = new TourPublisher(
      'http://api.test',
      'me',
      (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => [],
        }) as Response) as unknown as typeof fetch
    );
    assert(
      await bareArray.lookup('https://x.example').then(
        () => false,
        () => true
      ),
      'a bare array is not the expected shape'
    );
    const bad = new TourPublisher(
      'http://api.test',
      'me',
      (async () =>
        ({ ok: false, status: 500 }) as Response) as unknown as typeof fetch
    );
    assert(
      await bad.lookup('https://x.example').then(
        () => false,
        () => true
      ),
      'HTTP errors reject'
    );
  }

  console.log('\n=== TourPublisher: a duplicate is adopted ===\n');
  {
    const ev = {
      pubkey: 'me',
      signature: 's',
      title: 'Fatoumata',
      lat: 49.9,
      lng: 2.3,
      start_time: '2030-03-13T19:00:00',
      category: 'music',
      created_at: 'c',
      act_name: 'Fatoumata Diawara',
      act_url: 'https://fd.example',
    } as NormalizedEvent;
    type Call = { url: string; method: string; body?: any };
    const mk = (
      adoptStatus: number | 'throw',
      adoptJson: unknown = {},
      postBody: unknown = { error: 'Duplicate event', existing_event_id: 'ex1' }
    ) => {
      const calls: Call[] = [];
      const f = (async (url: string, init?: RequestInit) => {
        const call: Call = {
          url: String(url),
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        };
        calls.push(call);
        if (call.url.endsWith('/events') && call.method === 'POST') {
          return {
            ok: false,
            status: 409,
            text: async () => JSON.stringify(postBody),
            json: async () => postBody,
          } as Response;
        }
        if (adoptStatus === 'throw') throw new Error('network');
        return {
          ok: adoptStatus >= 200 && adoptStatus < 300,
          status: adoptStatus,
          text: async () => JSON.stringify(adoptJson),
          json: async () => adoptJson,
        } as Response;
      }) as unknown as typeof fetch;
      const signed: string[][] = [];
      const pub = new TourPublisher(
        'http://api.test',
        'me',
        f,
        async (id, name, url) => {
          signed.push([id, name, url]);
          return 'SIG';
        }
      );
      return { pub, calls, signed, fetchFn: f };
    };

    let t = mk(200, { id: 'ex1', adopted: true });
    assert(
      (await t.pub.apply(ev, undefined)) === 'adopted',
      '409 + adopt accepted → adopted'
    );
    assert(
      t.calls.length === 2 &&
        t.calls[1].url === 'http://api.test/events/ex1/act' &&
        t.calls[1].method === 'POST',
      'one adopt request to /events/<existing id>/act'
    );
    assert(
      JSON.stringify(t.calls[1].body) ===
        JSON.stringify({
          pubkey: 'me',
          act_name: 'Fatoumata Diawara',
          act_url: 'https://fd.example',
          signature: 'SIG',
        }),
      'with pubkey, act, and the signature'
    );
    assert(
      JSON.stringify(t.signed) ===
        JSON.stringify([['ex1', 'Fatoumata Diawara', 'https://fd.example']]),
      'the signer is given the existing id and the act'
    );

    t = mk(200, { id: 'ex1', adopted: false, already: true });
    assert(
      (await t.pub.apply(ev, undefined)) === 'unchanged',
      'already linked → unchanged'
    );
    for (const status of [401, 403, 404, 409, 500] as const) {
      t = mk(status, { error: 'x' });
      assert(
        (await t.pub.apply(ev, undefined)) === 'duplicate',
        `adopt refused (${status}) → duplicate, not failed`
      );
    }
    t = mk('throw');
    assert(
      (await t.pub.apply(ev, undefined)) === 'duplicate',
      'network error while adopting → duplicate'
    );
    t = mk(200, {}, { error: 'Duplicate event' });
    assert(
      (await t.pub.apply(ev, undefined)) === 'failed' && t.calls.length === 1,
      '409 without an existing id stays failed (no adopt request)'
    );
    const noSignerCase = mk(200);
    const noSigner = new TourPublisher(
      'http://api.test',
      'me',
      noSignerCase.fetchFn
    );
    assert(
      (await noSigner.apply(ev, undefined)) === 'failed' &&
        noSignerCase.calls.length === 1,
      'without a signer a 409 stays failed'
    );
    t = mk(200, { adopted: true });
    const noAct = {
      ...ev,
      act_name: undefined,
      act_url: undefined,
    } as NormalizedEvent;
    assert(
      (await t.pub.apply(noAct, undefined)) === 'failed' &&
        t.calls.length === 1,
      'an event without act fields cannot be adopted'
    );
  }

  console.log('\n=== tracked bands export ===\n');
  {
    const cfg = parseCfg(`
bands:
  - { name: Zed Band, url: "https://zed.example/", aliases: ["ZB"], notes: "private note", region: none }
  - { name: alpha band, url: "https://Alpha.example" }
  - { name: Paused Band, url: "https://paused.example", status: paused }
  - { name: Édith, url: "https://edith.example" }
sources: []
`);
    const out = buildTrackedBands(cfg, '2030-10-07');
    assert(out.generated === '2030-10-07', 'carries the generation date');
    assert(
      out.bands.map(b => b.name).join('|') === 'alpha band|Édith|Zed Band',
      'active bands only, sorted by name (accent- and case-insensitively)'
    );
    assert(
      out.bands[0].url === 'https://alpha.example' &&
        out.bands[2].url === 'https://zed.example',
      'urls are the normalized act_url form'
    );
    const text = JSON.stringify(out);
    assert(
      !/private note|ZB|region|status|aliases|notes/.test(text),
      'nothing but name and url is exported (no notes, aliases, regions, status)'
    );
    assert(
      Object.keys(out.bands[0]).sort().join() === 'name,url',
      'each band has exactly name and url'
    );
    assert(
      buildTrackedBands(parseCfg('bands: []\nsources: []\n'), '2030-10-07')
        .bands.length === 0,
      'an empty registry exports an empty list'
    );

    const a = parseExportArgs(['node', 'x', '--out', 'o.json']);
    assert(a.out === 'o.json' && a.bands === 'bands.yaml', 'defaults');
    const b = parseExportArgs([
      'node',
      'x',
      '--bands',
      'b.yaml',
      '--out',
      'o.json',
    ]);
    assert(b.bands === 'b.yaml' && b.out === 'o.json', 'flags');
    assert(
      throws(() => parseExportArgs(['node', 'x'])),
      '--out is required'
    );
    assert(
      throws(() => parseExportArgs(['node', 'x', '--out'])),
      '--out needs a value'
    );
    assert(
      throws(() => parseExportArgs(['node', 'x', '--out', 'o.json', '--nope'])),
      'unknown flags are rejected'
    );
  }

  console.log('\n=== failure reasons: processTourSourcePage ===\n');
  {
    const cfg = parseCfg(`
bands:
  - name: Test Band
    url: https://testband.example
sources:
  - { url: "https://testband.example/live", mode: band, band: Test Band }
`);
    const page: FetchedPage = {
      url: 'https://testband.example/live',
      title: 'P',
      html: '',
      text: 'x',
    };
    const okNormalize: TourSourceDeps['normalize'] = async (e, opts) =>
      ({
        pubkey: 'p',
        signature: 's',
        title: e.title,
        lat: e.lat ?? 46.06,
        lng: e.lng ?? 13.23,
        start_time: String(e.start_time),
        category: e.category,
        created_at: opts?.createdAt ?? 'now',
        act_name: e.act_name,
        act_url: e.act_url,
        tags: e.tags,
      }) as NormalizedEvent;
    const deps = (
      drafts: TourShowDraft[],
      over: Partial<TourSourceDeps> = {}
    ): TourSourceDeps => ({
      extract: async () => drafts,
      lookup: async () => [],
      normalize: okNormalize,
      apply: async () => 'published',
      today: '2030-10-01',
      ...over,
    });
    const run = (d: TourSourceDeps) =>
      processTourSourcePage(page, cfg.sources[0], cfg, d);
    const noPlace: TourShowDraft = {
      title: 'Nowhere show',
      performers: ['Test Band'],
      start_time: '2030-11-12T21:00:00',
    };
    const withCity: TourShowDraft = {
      ...noPlace,
      title: 'Udine show',
      venue_name: 'Club X',
      city: 'Udine',
    };
    const venueOnly: TourShowDraft = {
      ...noPlace,
      title: 'Venue show',
      venue_name: 'Club X',
    };

    let res = await run(deps([noPlace], { normalize: async () => null }));
    assert(
      res[0].outcome === 'failed' &&
        res[0].reason === 'no address or venue on the page to geocode',
      'normalize null without any place → "no address or venue on the page to geocode"'
    );
    res = await run(deps([withCity], { normalize: async () => null }));
    assert(
      res[0].outcome === 'failed' &&
        res[0].reason === 'geocoding found no usable location for "Udine"',
      'normalize null with an address → geocoding reason quoting the address'
    );
    res = await run(deps([venueOnly], { normalize: async () => null }));
    assert(
      res[0].reason === 'geocoding found no usable location for "Club X"',
      'normalize null with only a venue → the venue is the quoted query'
    );
    const longCity: TourShowDraft = {
      ...noPlace,
      city: 'x'.repeat(300),
    };
    res = await run(deps([longCity], { normalize: async () => null }));
    assert(
      res[0].reason!.length === 160 && res[0].reason!.endsWith('…'),
      'a long reason is truncated to 160 chars with an ellipsis'
    );

    res = await run(
      deps([withCity], {
        apply: async () => 'failed',
        failureReason: () => 'API error 500 (POST /events)',
      })
    );
    assert(
      res[0].outcome === 'failed' &&
        res[0].reason === 'API error 500 (POST /events)',
      "apply 'failed' → the publisher's failure reason"
    );
    res = await run(deps([withCity], { apply: async () => 'failed' }));
    assert(
      res[0].reason === 'publishing failed',
      'apply \'failed\' without failureReason → "publishing failed"'
    );
    res = await run(
      deps([withCity], {
        apply: async () => 'failed',
        failureReason: () => undefined,
      })
    );
    assert(
      res[0].reason === 'publishing failed',
      'failureReason returning nothing → "publishing failed"'
    );
    res = await run(
      deps([withCity], {
        lookup: async () => {
          throw new Error('Lookup failed (500)');
        },
      })
    );
    assert(
      res[0].outcome === 'failed' && res[0].reason === 'Lookup failed (500)',
      'lookup throwing → the error message'
    );
    res = await run(
      deps([withCity], {
        normalize: async () => {
          throw new Error('Nominatim exploded');
        },
      })
    );
    assert(
      res[0].outcome === 'failed' && res[0].reason === 'Nominatim exploded',
      'normalize throwing → the error message'
    );
    res = await run(deps([withCity]));
    assert(
      res[0].outcome === 'published' && !('reason' in res[0]),
      'a successful show carries no reason'
    );
  }

  console.log('\n=== failure reasons: TourPublisher.lastFailure ===\n');
  {
    const ev = {
      pubkey: 'PUBKEY',
      signature: 's',
      title: 'T',
      lat: 46.06,
      lng: 13.23,
      start_time: '2030-11-12T21:00:00',
      category: 'music',
      created_at: 'c',
    } as NormalizedEvent;
    const match: ExistingShow = {
      id: 'e1',
      title: 'T',
      lat: 46.06,
      lng: 13.23,
      start_time: '2030-11-12T21:00:00',
      category: 'music',
      tags: [],
      created_at: 'c',
    };
    const respond = (status: number, json: unknown = { error: 'SECRET' }) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => json,
        text: async () => JSON.stringify(json),
      }) as Response;
    let status = 500;
    const f = (async () => respond(status)) as unknown as typeof fetch;
    const pub = new TourPublisher('http://api.test', 'PUBKEY', f);
    assert(pub.lastFailure === undefined, 'no failure before any apply');

    status = 500;
    await pub.apply(ev, undefined);
    assert(
      pub.lastFailure === 'API error 500 (POST /events)',
      'POST 500 → "API error 500 (POST /events)"'
    );
    status = 403;
    await pub.apply(ev, undefined);
    assert(
      pub.lastFailure === 'API error 403 — signing or identity problem',
      'POST 403 → signing or identity problem'
    );
    status = 401;
    await pub.apply({ ...ev, start_time: '2030-11-12T20:00:00' }, match);
    assert(
      pub.lastFailure === 'API error 401 — signing or identity problem',
      'PUT 401 → signing or identity problem'
    );
    status = 500;
    await pub.apply({ ...ev, start_time: '2030-11-12T20:00:00' }, match);
    assert(
      pub.lastFailure === 'API error 500 (PUT /events/:id)',
      'PUT 500 → "API error 500 (PUT /events/:id)"'
    );
    assert(
      !/SECRET|PUBKEY/.test(pub.lastFailure ?? ''),
      'no response body or key in the reason'
    );
    status = 409;
    await pub.apply(ev, undefined);
    assert(
      pub.lastFailure ===
        'duplicate of an existing event that could not be linked',
      'unlinkable 409 → duplicate that could not be linked'
    );
    status = 201;
    assert(
      (await pub.apply(ev, undefined)) === 'published' &&
        pub.lastFailure === undefined,
      'a successful apply resets lastFailure'
    );
    status = 500;
    await pub.apply(ev, undefined);
    assert(
      (await pub.apply(ev, match)) === 'unchanged' &&
        pub.lastFailure === undefined,
      'an unchanged apply (no request) resets lastFailure too'
    );

    const netErr = new TourPublisher('http://api.test', 'PUBKEY', (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch);
    await netErr.apply(ev, undefined);
    assert(
      netErr.lastFailure === 'network error (POST /events)',
      'network error on POST → "network error (POST /events)"'
    );
    await netErr.apply({ ...ev, start_time: '2030-11-12T20:00:00' }, match);
    assert(
      netErr.lastFailure === 'network error (PUT /events/:id)',
      'network error on PUT → "network error (PUT /events/:id)"'
    );
  }

  console.log('\n=== failure reasons: run record ===\n');
  {
    const failedShows = (n: number, reason: string): ShowResult[] =>
      Array.from({ length: n }, (_, i) => ({
        title: `Show ${i + 1}`,
        outcome: 'failed' as const,
        reason,
      }));
    const results: TourSourceResult[] = [
      {
        url: 'https://a.example/live',
        outcome: 'published',
        shows: [
          { title: 'ok', outcome: 'published' },
          {
            title: 'T'.repeat(200),
            outcome: 'failed',
            reason: 'API error 500 (POST /events)',
          },
        ],
      },
      {
        url: 'https://b.example/live',
        outcome: 'unchanged',
        shows: [{ title: 'x', outcome: 'unchanged' }],
      },
      {
        url: 'https://c.example/live',
        outcome: 'failed',
        shows: [],
        error:
          'Blocked by bot protection ("Just a moment") at https://c.example/live',
      },
      {
        url: 'https://d.example/live',
        outcome: 'failed',
        shows: failedShows(13, 'publishing failed'),
      },
    ];
    const rec = buildTourRunRecord(
      results,
      new Date('2030-10-01T10:00:00Z'),
      new Date('2030-10-01T10:01:00Z')
    );
    const [a, b, c, d] = rec.entries as any[];
    assert(
      a.failed_shows === 1 &&
        a.failures.length === 1 &&
        a.failures[0].reason === 'API error 500 (POST /events)',
      'failures list the failed shows with their reason'
    );
    assert(
      a.failures[0].title.length === 80 && a.failures[0].title.endsWith('…'),
      'long titles are truncated to 80 chars'
    );
    assert(
      !('failures_omitted' in a) && !('error' in a),
      'no failures_omitted / error keys when not relevant'
    );
    assert(
      Object.keys(b).sort().join() === 'outcome,url',
      'a clean source has only url and outcome'
    );
    assert(
      c.error ===
        'Blocked by bot protection ("Just a moment") at https://c.example/live' &&
        !('failures' in c),
      'a source error is recorded, without an empty failures list'
    );
    assert(
      d.failed_shows === 13 &&
        d.failures.length === 10 &&
        d.failures_omitted === 3 &&
        d.failures[9].title === 'Show 10',
      'at most 10 failures, the rest counted in failures_omitted'
    );

    // --retry-failed ignores the new keys
    const src = (url: string) => ({ url, mode: 'band' as const, band: 'X' });
    const sel = selectRetrySources(
      [
        src('https://a.example/live'),
        src('https://b.example/live'),
        src('https://c.example/live'),
        src('https://d.example/live'),
      ],
      [JSON.parse(JSON.stringify(rec)) as RunRecord]
    );
    assert(
      sel.sources.map(s => s.url).join() ===
        'https://a.example/live,https://c.example/live,https://d.example/live',
      'selectRetrySources works on entries with error/failures/failures_omitted'
    );
    const withKeys: RunRecord = {
      kind: 'tours',
      started_at: 's',
      entries: [
        {
          url: 'https://b.example/live',
          outcome: 'published',
          failures: [{ title: 't', reason: 'r' }],
          error: 'e',
        },
      ],
    };
    assert(
      selectRetrySources([src('https://b.example/live')], [withKeys]).sources
        .length === 0,
      'error/failures alone do not select a source (outcome and failed_shows decide)'
    );
  }

  console.log('\n=== failure reasons: formatFailures ===\n');
  {
    const shows = (
      list: [string, string][],
      extra: ShowResult[] = []
    ): ShowResult[] => [
      ...extra,
      ...list.map(([title, reason]) => ({
        title,
        outcome: 'failed' as const,
        reason,
      })),
    ];
    assert(
      formatFailures([
        {
          url: 'https://a.example/live',
          outcome: 'published',
          shows: [{ title: 'ok', outcome: 'published' }],
        },
      ]).length === 0,
      'nothing to report → no lines'
    );
    const lines = formatFailures([
      {
        url: 'https://www.venue.example/programme/?page=2#top',
        outcome: 'published',
        shows: shows(
          [
            ['A', 'API error 500 (POST /events)'],
            ['B', 'API error 500 (POST /events)'],
            ['C', 'geocoding found no usable location for "Udine"'],
            ['D', 'API error 500 (POST /events)'],
            ['E', 'Lookup failed (500)'],
            ['F', 'Lookup failed (500)'],
          ],
          [{ title: 'fine', outcome: 'published' }]
        ),
      },
      { url: 'https://clean.example/', outcome: 'unchanged', shows: [] },
      {
        url: 'https://blocked.example/',
        outcome: 'failed',
        shows: [],
        error: 'fetch failed',
      },
    ]);
    assert(
      JSON.stringify(lines) ===
        JSON.stringify([
          'Failures (why):',
          '  - www.venue.example/programme/',
          '    · 3 shows: API error 500 (POST /events)',
          '    · C: geocoding found no usable location for "Udine"',
          '    · E: Lookup failed (500)',
          '    · F: Lookup failed (500)',
          '  - blocked.example',
          '    fetch failed',
        ]),
      'groups 3+ identical reasons, lists the rest, skips clean sources, prints source errors'
    );

    const many = formatFailures([
      {
        url: 'https://x.example/' + 'p'.repeat(100),
        outcome: 'failed',
        shows: shows(
          Array.from(
            { length: 14 },
            (_, i) => [`S${i + 1}`, `reason ${i + 1}`] as [string, string]
          )
        ),
      },
    ]);
    assert(
      many[1].length === 4 + 70 && many[1].endsWith('…'),
      'the url is shortened to host+path, at most 70 chars'
    );
    assert(
      many.length === 2 + 10 + 1 &&
        many[11] === '    · S10: reason 10' &&
        many[12] === '    … and 4 more',
      'at most 10 lines per source, then "… and N more"'
    );
  }

  // (later tasks append their sections above this line)

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

import * as ed from '@noble/ed25519';
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
import { TourExtractor } from '../src/extractors/tour-extractor.js';
import type { LLMProvider } from '../../shared/types/llm.js';
import {
  findStaleSources,
  findStaleFestivals,
  STALE_WINDOW,
  type RunRecord,
} from '../src/utils/run-log.js';
import type { FetchedPage } from '../src/types/event.js';

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
        return respond(200, [
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
        ]);
      return respond(nextStatus);
    }) as unknown as typeof fetch;

    const pub = new TourPublisher('http://api.test', 'PUBKEY', fakeFetch);
    const found = await pub.lookup('https://testband.example');
    assert(found.length === 1, 'lookup returns the array');
    const q = new URL(calls[0].url).searchParams;
    assert(
      q.get('pubkey') === 'PUBKEY' &&
        q.get('act_url') === 'https://testband.example',
      'lookup filters by pubkey + act_url'
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
      respond(200, { events: [] })) as unknown as typeof fetch);
    assert(
      await badShape.lookup('https://x.example').then(
        () => false,
        () => true
      ),
      'lookup rejects a non-array response'
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

  // (later tasks append their sections above this line)

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

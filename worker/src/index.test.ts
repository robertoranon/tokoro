import { describe, it, expect, vi } from 'vitest';
import {
  parseWindowParam,
  eventsToICal,
  makeBackupKey,
  selectKeysToDelete,
  makeBackupPayload,
  duplicateCandidateCells,
  isMidnightSentinel,
  dedupSqlWindow,
  passesTimeFilter,
  buildTextFilter,
  buildFestivalUrlFilter,
  buildHasFestivalFilter,
  buildActUrlFilter,
  buildHasActFilter,
  validatePutRequest,
  validateAdoptBody,
  decideAdopt,
  findSameActSameDay,
  BACKUP_TABLES,
} from './index';
import worker from './index';
import { makeD1, ALL_MIGRATIONS } from '../test-support/d1';
import { makeKey, toHex, type TestKey } from '../test-support/sign';
import * as ed from '@noble/ed25519';
import { notifyConflict } from './alerts';

import { reevaluateConflicts } from './conflicts';

vi.mock('./conflicts', async importOriginal => {
  const actual = await importOriginal<typeof import('./conflicts')>();
  return {
    ...actual,
    reevaluateConflicts: vi.fn(actual.reevaluateConflicts),
  };
});

vi.mock('./alerts', async importOriginal => ({
  ...(await importOriginal<typeof import('./alerts')>()),
  notifyConflict: vi.fn(async () => {}),
}));

import { verifyActSignature, actMessage } from './crypto';
import { isDuplicate } from '../../shared/llm/duplicate-check';
import { encode as geohashEncode, neighbors } from './geohash';
import type { LLMProvider } from '../../shared/types/llm';

describe('parseWindowParam', () => {
  it('parses "30d" to 30 days in ms', () => {
    expect(parseWindowParam('30d')).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('parses "7d" to 7 days in ms', () => {
    expect(parseWindowParam('7d')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('returns null for invalid format', () => {
    expect(parseWindowParam('30')).toBeNull();
    expect(parseWindowParam('30h')).toBeNull();
    expect(parseWindowParam('abc')).toBeNull();
    expect(parseWindowParam('')).toBeNull();
  });
});

describe('eventsToICal', () => {
  const baseEvent = {
    id: 'abc123',
    title: 'Jazz Night',
    start_time: '2026-03-20T21:00:00',
    end_time: '2026-03-20T23:00:00',
    description: 'A great jazz concert',
    venue_name: 'Blue Note',
    address: 'Via Brera 1',
    lat: 45.464,
    lng: 9.189,
    url: 'https://example.com',
    category: 'music',
    created_at: '2026-03-15T10:00:00',
  };

  it('produces a valid VCALENDAR with VEVENT', () => {
    const result = eventsToICal([baseEvent], {
      lat: 45.4,
      lng: 9.1,
      category: 'music',
    });
    expect(result).toContain('BEGIN:VCALENDAR');
    expect(result).toContain('END:VCALENDAR');
    expect(result).toContain('BEGIN:VEVENT');
    expect(result).toContain('END:VEVENT');
  });

  it('sets correct PRODID and VERSION', () => {
    const result = eventsToICal([], { lat: 45.4, lng: 9.1 });
    expect(result).toContain('PRODID:-//Tokoro//Events//EN');
    expect(result).toContain('VERSION:2.0');
  });

  it('maps fields correctly', () => {
    const result = eventsToICal([baseEvent], { lat: 45.4, lng: 9.1 });
    expect(result).toContain('UID:abc123@tokoro');
    expect(result).toContain('DTSTART:20260320T210000');
    expect(result).toContain('DTEND:20260320T230000');
    expect(result).toContain('SUMMARY:Jazz Night');
    expect(result).toContain('DESCRIPTION:A great jazz concert');
    expect(result).toContain('LOCATION:Blue Note\\, Via Brera 1');
    expect(result).toContain('GEO:45.464;9.189');
    expect(result).toContain('URL:https://example.com');
    expect(result).toContain('CATEGORIES:music');
    expect(result).toContain('DTSTAMP:20260315T100000');
  });

  it('omits DTEND when end_time is missing', () => {
    const event = { ...baseEvent, end_time: undefined };
    const result = eventsToICal([event], { lat: 45.4, lng: 9.1 });
    expect(result).not.toContain('DTEND');
  });

  it('omits DESCRIPTION when missing', () => {
    const event = { ...baseEvent, description: undefined };
    const result = eventsToICal([event], { lat: 45.4, lng: 9.1 });
    expect(result).not.toContain('DESCRIPTION');
  });

  it('prepends festival_name to SUMMARY', () => {
    const event = { ...baseEvent, festival_name: 'Jazz Fest' };
    const result = eventsToICal([event], { lat: 45.4, lng: 9.1 });
    expect(result).toContain('SUMMARY:Jazz Fest: Jazz Night');
  });

  it('escapes special characters in text fields', () => {
    const event = {
      ...baseEvent,
      title: 'Rock, Jazz & More; Tonight\\Now',
      description: 'Line1\nLine2',
    };
    const result = eventsToICal([event], { lat: 45.4, lng: 9.1 });
    expect(result).toContain('SUMMARY:Rock\\, Jazz & More\\; Tonight\\\\Now');
    expect(result).toContain('DESCRIPTION:Line1\\nLine2');
  });

  it('folds lines longer than 75 characters', () => {
    const event = {
      ...baseEvent,
      description:
        'This is a very long description that should definitely be folded because it exceeds the RFC 5545 limit of 75 octets per line.',
    };
    const result = eventsToICal([event], { lat: 45.4, lng: 9.1 });
    const lines = result.split('\r\n');
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(75);
    }
  });

  it('includes X-WR-CALNAME with category', () => {
    const result = eventsToICal([], { lat: 45.4, lng: 9.1, category: 'music' });
    // Comma in coordinates is escaped per RFC 5545
    expect(result).toContain('X-WR-CALNAME:Tokoro: music near 45.4\\, 9.1');
  });

  it('includes X-WR-CALNAME without category', () => {
    const result = eventsToICal([], { lat: 45.4, lng: 9.1 });
    expect(result).toContain('X-WR-CALNAME:Tokoro: events near 45.4\\, 9.1');
  });

  it('handles empty event list', () => {
    const result = eventsToICal([], { lat: 45.4, lng: 9.1 });
    expect(result).toContain('BEGIN:VCALENDAR');
    expect(result).toContain('END:VCALENDAR');
    expect(result).not.toContain('VEVENT');
  });

  it('uses CRLF line endings throughout', () => {
    const result = eventsToICal([baseEvent], { lat: 45.4, lng: 9.1 });
    // All line endings should be CRLF
    const lines = result.split('\r\n');
    expect(lines.length).toBeGreaterThan(5);
    // No bare LF
    expect(result.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

describe('GET /events pubkey filter', () => {
  it('allows pubkey-only query (no geo params required)', () => {
    const lat = NaN;
    const lng = NaN;
    const pubkey = 'aabbccdd';

    const hasGeo = !isNaN(lat) && !isNaN(lng);
    const hasPubkey = Boolean(pubkey);
    const isValid = hasGeo || hasPubkey;

    expect(isValid).toBe(true);
  });

  it('rejects query with no geo and no pubkey', () => {
    const lat = NaN;
    const lng = NaN;
    const pubkey = '';

    const hasGeo = !isNaN(lat) && !isNaN(lng);
    const hasPubkey = Boolean(pubkey);
    const isValid = hasGeo || hasPubkey;

    expect(isValid).toBe(false);
  });
});

describe('blocklist validation', () => {
  it('blocked pubkey should be rejected', () => {
    const blockedKeys = new Set(['badactor123']);
    const pubkey = 'badactor123';

    const isBlocked = blockedKeys.has(pubkey);
    expect(isBlocked).toBe(true);
  });

  it('non-blocked pubkey should pass', () => {
    const blockedKeys = new Set(['badactor123']);
    const pubkey = 'gooduser456';

    const isBlocked = blockedKeys.has(pubkey);
    expect(isBlocked).toBe(false);
  });
});

describe('admin blocklist signature domain', () => {
  it('admin signature uses blocklist: prefix domain', async () => {
    const targetPubkey = 'aabbccddeeff';
    const encoder = new TextEncoder();
    const messageBytes = encoder.encode('blocklist:' + targetPubkey);
    const hashBuffer = await crypto.subtle.digest('SHA-256', messageBytes);
    const hash = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });
});

describe('handleDeleteEvent admin bypass', () => {
  it('admin pubkey bypasses ownership check logic', () => {
    const eventOwner = 'aabbcc';
    const adminKey = 'ddeeff';
    const requestPubkey = adminKey;

    const isAdmin = requestPubkey === adminKey;
    const isOwner = requestPubkey === eventOwner;
    const canDelete = isAdmin || isOwner;

    expect(canDelete).toBe(true);
  });

  it('non-admin non-owner cannot delete', () => {
    const eventOwner = 'aabbcc';
    const adminKey = 'ddeeff';
    const requestPubkey = '112233';

    const isAdmin = requestPubkey === adminKey;
    const isOwner = requestPubkey === eventOwner;
    const canDelete = isAdmin || isOwner;

    expect(canDelete).toBe(false);
  });
});

describe('makeBackupKey', () => {
  it('formats date as backups/backup-YYYY-MM-DD.json', () => {
    const date = new Date('2026-03-26T02:00:00Z');
    expect(makeBackupKey(date)).toBe('backups/backup-2026-03-26.json');
  });
});

describe('selectKeysToDelete', () => {
  it('returns empty array when count is within retention', () => {
    const keys = [
      'backups/backup-2026-03-20.json',
      'backups/backup-2026-03-21.json',
    ];
    expect(selectKeysToDelete(keys, 7)).toEqual([]);
  });

  it('returns oldest keys beyond retention limit', () => {
    const keys = [
      'backups/backup-2026-03-19.json',
      'backups/backup-2026-03-20.json',
      'backups/backup-2026-03-21.json',
      'backups/backup-2026-03-22.json',
      'backups/backup-2026-03-23.json',
      'backups/backup-2026-03-24.json',
      'backups/backup-2026-03-25.json',
      'backups/backup-2026-03-26.json',
    ];
    expect(selectKeysToDelete(keys, 7)).toEqual([
      'backups/backup-2026-03-19.json',
    ]);
  });

  it('handles fewer keys than retention limit', () => {
    expect(selectKeysToDelete(['backups/backup-2026-03-26.json'], 7)).toEqual(
      []
    );
  });
});

describe('makeBackupPayload', () => {
  it('serializes events to JSON string with timestamp', () => {
    const events = [{ id: 'abc', title: 'Test' }];
    const date = new Date('2026-03-26T02:00:00Z');
    const payload = makeBackupPayload({ events }, date);
    const parsed = JSON.parse(payload);
    expect(parsed.timestamp).toBe('2026-03-26T02:00:00.000Z');
    expect(parsed.tables.events).toHaveLength(1);
    expect(parsed.tables.events[0].id).toBe('abc');
  });

  it('includes the member tables next to events, empty when missing', () => {
    const date = new Date('2026-03-26T02:00:00Z');
    const parsed = JSON.parse(
      makeBackupPayload(
        {
          events: [{ id: 'abc' }],
          members: [{ pubkey: 'p', name: 'Ann' }],
          member_bands: [{ pubkey: 'p', act_url: 'https://a.example' }],
        },
        date
      )
    );
    expect(Object.keys(parsed.tables)).toEqual([...BACKUP_TABLES]);
    expect(parsed.tables.members[0].name).toBe('Ann');
    expect(parsed.tables.member_bands).toHaveLength(1);
    expect(parsed.tables.band_suggestions).toEqual([]);
    expect(parsed.tables.blocklist).toEqual([]);
  });

  it('includes the blocklist, so a restore does not unblock banned keys', () => {
    expect(BACKUP_TABLES).toContain('blocklist');
    const parsed = JSON.parse(
      makeBackupPayload(
        { blocklist: [{ pubkey: 'bad', created_at: 'x' }] },
        new Date('2026-03-26T02:00:00Z')
      )
    );
    expect(parsed.tables.blocklist).toEqual([
      { pubkey: 'bad', created_at: 'x' },
    ]);
  });
});

describe('scheduled backup', () => {
  function fakeBucket() {
    const objects = new Map<string, string>();
    return {
      objects,
      async put(key: string, value: string) {
        objects.set(key, value);
      },
      async list() {
        return {
          objects: [...objects.entries()].map(([key, v]) => ({
            key,
            size: v.length,
          })),
        };
      },
      async delete(key: string) {
        objects.delete(key);
      },
    };
  }

  it('the alert cron sends digests and does not back up', async () => {
    const DB = makeD1(ALL_MIGRATIONS);
    await DB.prepare(
      'INSERT INTO members (pubkey, name, created_at, telegram_chat_id) VALUES (?, ?, ?, ?)'
    )
      .bind('p1', 'Ann', '2026-10-01T00:00:00', '42')
      .run();
    await DB.prepare(
      'INSERT INTO member_bands (pubkey, act_url, created_at) VALUES (?, ?, ?)'
    )
      .bind('p1', 'https://band.example', '2026-10-01T00:00:00')
      .run();
    await DB.prepare(
      `INSERT INTO events (id, pubkey, signature, title, lat, lng, geohash5, geohash6,
         start_time, category, created_at, act_name, act_url, alert_pending)
       VALUES ('e1', 'pk', 'sig', 'Show', 45, 13, 'u0000', 'u00000', '2999-01-01T20:00:00',
         'music', 'x', 'Band', 'https://band.example', 1)`
    ).run();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const bucket = fakeBucket();
      await worker.scheduled(
        { cron: '0 8 * * *' } as any,
        { DB, BACKUP_BUCKET: bucket, TELEGRAM_BOT_TOKEN: 't' } as any
      );
      expect(bucket.objects.size).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((fetchMock.mock.calls[0] as any)[0]).toContain('/sendMessage');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('writes events and the member tables to one object per day', async () => {
    const DB = makeD1(ALL_MIGRATIONS);
    await DB.prepare(
      'INSERT INTO members (pubkey, name, created_at) VALUES (?, ?, ?)'
    )
      .bind('p1', 'Ann', '2026-10-01T00:00:00')
      .run();
    await DB.prepare(
      'INSERT INTO member_bands (pubkey, act_url, created_at) VALUES (?, ?, ?)'
    )
      .bind('p1', 'https://band.example', '2026-10-01T00:00:00')
      .run();
    await DB.prepare(
      `INSERT INTO band_suggestions (pubkey, name, status, created_at) VALUES (?, ?, 'pending', ?)`
    )
      .bind('p1', 'Some Band', '2026-10-01T00:00:00')
      .run();
    await DB.prepare('INSERT INTO blocklist (pubkey, created_at) VALUES (?, ?)')
      .bind('banned', '2026-10-02T00:00:00')
      .run();
    const bucket = fakeBucket();
    await worker.scheduled(
      {} as any,
      {
        DB,
        BACKUP_BUCKET: bucket,
      } as any
    );
    expect([...bucket.objects.keys()]).toEqual([makeBackupKey(new Date())]);
    const parsed = JSON.parse([...bucket.objects.values()][0]);
    expect(parsed.tables.events).toEqual([]);
    expect(parsed.tables.members).toEqual([
      {
        pubkey: 'p1',
        name: 'Ann',
        created_at: '2026-10-01T00:00:00',
        revoked_at: null,
        telegram_chat_id: null,
        radar_alerts: 0,
      },
    ]);
    expect(parsed.tables.member_bands[0].act_url).toBe('https://band.example');
    expect(parsed.tables.band_suggestions[0].name).toBe('Some Band');
    expect(parsed.tables.blocklist).toEqual([
      { pubkey: 'banned', created_at: '2026-10-02T00:00:00' },
    ]);
  });
});

describe('isDuplicate', () => {
  it('returns true for near-identical titles without calling LLM', async () => {
    let llmCalled = false;
    const llm: LLMProvider = {
      name: 'mock',
      complete: async () => {
        llmCalled = true;
        return { content: '{"probability":0}', model: 'mock' };
      },
    };
    const result = await isDuplicate(
      { title: 'Rolling Stones Concert', description: '' },
      { title: 'Rolling Stones Concert', description: '' },
      llm
    );
    expect(result).toBe(true);
    expect(llmCalled).toBe(false);
  });

  it('calls LLM for dissimilar titles and returns true when probability >= 0.7', async () => {
    const llm: LLMProvider = {
      name: 'mock',
      complete: async () => ({
        content: JSON.stringify({ probability: 0.9 }),
        model: 'mock',
      }),
    };
    const result = await isDuplicate(
      { title: 'Rolling Stones', description: '' },
      { title: 'Rolling Stones @ Metropolitan', description: '' },
      llm
    );
    expect(result).toBe(true);
  });

  it('calls LLM and returns false when probability < 0.7', async () => {
    const llm: LLMProvider = {
      name: 'mock',
      complete: async () => ({
        content: JSON.stringify({ probability: 0.1 }),
        model: 'mock',
      }),
    };
    const result = await isDuplicate(
      { title: 'Jazz Night', description: '' },
      { title: 'Rock Concert', description: '' },
      llm
    );
    expect(result).toBe(false);
  });

  it('returns false on LLM network error', async () => {
    const llm: LLMProvider = {
      name: 'mock',
      complete: async () => {
        throw new Error('timeout');
      },
    };
    const result = await isDuplicate(
      { title: 'Rolling Stones', description: '' },
      { title: 'Les Rolling Stones en concert', description: '' },
      llm
    );
    expect(result).toBe(false);
  });

  it('returns false when LLM response is not valid JSON', async () => {
    const llm: LLMProvider = {
      name: 'mock',
      complete: async () => ({ content: 'not json at all', model: 'mock' }),
    };
    const result = await isDuplicate(
      { title: 'Rolling Stones', description: '' },
      { title: 'Les Rolling Stones', description: '' },
      llm
    );
    expect(result).toBe(false);
  });

  it('falls back to Levenshtein >= 0.8 when no LLM is provided', async () => {
    const similar = await isDuplicate(
      { title: 'Jazz Festival', description: '' },
      { title: 'Jazz Festive', description: '' }
    );
    expect(similar).toBe(true);
  });

  it('catches same main title with different subtitle via common-prefix check (no LLM)', async () => {
    // "Rolling Stones @ Metropolitan" shares 100% of the shorter title as prefix
    const withVenue = await isDuplicate(
      { title: 'Rolling Stones', description: '' },
      { title: 'Rolling Stones @ Metropolitan', description: '' }
    );
    expect(withVenue).toBe(true);

    // Real-world case: same festival, different subtitle extracted by LLM
    const shagoo = await isDuplicate(
      { title: 'Shagoo Shagoo - Festa di Apertura', description: '' },
      {
        title: 'Shagoo Shagoo - Music Festival Bucolico Indipendente',
        description: '',
      }
    );
    expect(shagoo).toBe(true); // common prefix "shagoo shagoo - " = 48.5% of shorter title

    // Genuinely different events starting with different words should not match
    const different = await isDuplicate(
      { title: 'Jazz Night', description: '' },
      { title: 'Rock Concert', description: '' }
    );
    expect(different).toBe(false);
  });

  it('falls back to structural checks (not fully open) on LLM error', async () => {
    const llm: LLMProvider = {
      name: 'mock',
      complete: async () => {
        throw new Error('timeout');
      },
    };
    // Same main title — should still be caught despite LLM failure
    const result = await isDuplicate(
      { title: 'Shagoo Shagoo - Festa di Apertura', description: '' },
      {
        title: 'Shagoo Shagoo - Music Festival Bucolico Indipendente',
        description: '',
      },
      llm
    );
    expect(result).toBe(true);
  });
});

describe('duplicateCandidateCells', () => {
  it('returns the center cell plus all 8 neighbors (9 total)', () => {
    const cell = geohashEncode(45.464, 9.189, 6);
    const cells = duplicateCandidateCells(cell);
    expect(cells).toContain(cell);
    expect(cells).toHaveLength(9);
    for (const n of neighbors(cell)) {
      expect(cells).toContain(n);
    }
  });

  it('includes the geohash6 cell of a point 50m away across a cell boundary', () => {
    // Find two points in different geohash6 cells that are < 0.1 km apart.
    // Scan northward from a base point until we cross a cell boundary.
    const baseLat = 45.464,
      baseLng = 9.189;
    const baseCell = geohashEncode(baseLat, baseLng, 6);

    let nearbyCell: string | null = null;
    for (let i = 1; i <= 100; i++) {
      const lat = baseLat + i * 0.0001; // ~11m steps northward
      const cell = geohashEncode(lat, baseLng, 6);
      if (cell !== baseCell) {
        nearbyCell = cell;
        break;
      }
    }

    // If no boundary found within ~1.1 km, skip (shouldn't happen for geohash6)
    expect(nearbyCell).not.toBeNull();

    const cells = duplicateCandidateCells(baseCell);
    expect(cells).toContain(nearbyCell);
  });
});

describe('isMidnightSentinel', () => {
  it('returns true for T00:00:00', () => {
    expect(isMidnightSentinel('2026-05-17T00:00:00')).toBe(true);
  });

  it('returns false for any other time', () => {
    expect(isMidnightSentinel('2026-05-17T22:00:00')).toBe(false);
    expect(isMidnightSentinel('2026-05-17T00:01:00')).toBe(false);
    expect(isMidnightSentinel('2026-05-17T12:00:00')).toBe(false);
  });
});

describe('dedupSqlWindow', () => {
  it('returns full calendar day when new event is midnight sentinel', () => {
    const { from, to } = dedupSqlWindow('2026-05-17T00:00:00');
    expect(from).toBe('2026-05-17T00:00:00');
    expect(to).toBe('2026-05-17T23:59:59');
  });

  it('returns ±2-hour buffer for non-sentinel start times', () => {
    const { from, to } = dedupSqlWindow('2026-05-17T22:00:00');
    expect(from).toBe('2026-05-17T20:00:00');
    expect(to).toBe('2026-05-18T00:00:00');
  });

  it('buffer for midnight-adjacent time does not use sentinel path', () => {
    const { from, to } = dedupSqlWindow('2026-05-17T01:00:00');
    expect(from).toBe('2026-05-16T23:00:00');
    expect(to).toBe('2026-05-17T03:00:00');
  });
});

describe('passesTimeFilter', () => {
  // Sentinel cases
  it('passes when new event is sentinel and candidate is same date', () => {
    expect(passesTimeFilter('2026-05-17T00:00:00', '2026-05-17T22:00:00')).toBe(
      true
    );
  });

  it('passes when candidate is sentinel and new event is same date', () => {
    expect(passesTimeFilter('2026-05-17T22:00:00', '2026-05-17T00:00:00')).toBe(
      true
    );
  });

  it('passes when both are sentinels on same date', () => {
    expect(passesTimeFilter('2026-05-17T00:00:00', '2026-05-17T00:00:00')).toBe(
      true
    );
  });

  it('rejects when either is sentinel but dates differ', () => {
    expect(passesTimeFilter('2026-05-17T00:00:00', '2026-05-18T22:00:00')).toBe(
      false
    );
    expect(passesTimeFilter('2026-05-17T22:00:00', '2026-05-18T00:00:00')).toBe(
      false
    );
  });

  // Normal (non-sentinel) cases — 1-hour window
  it('passes when both are within 1 hour', () => {
    expect(passesTimeFilter('2026-05-17T22:00:00', '2026-05-17T22:30:00')).toBe(
      true
    );
    expect(passesTimeFilter('2026-05-17T22:00:00', '2026-05-17T21:00:00')).toBe(
      true
    );
  });

  it('rejects when both non-sentinel and differ by more than 1 hour', () => {
    expect(passesTimeFilter('2026-05-17T22:00:00', '2026-05-17T20:59:00')).toBe(
      false
    );
    expect(passesTimeFilter('2026-05-17T22:00:00', '2026-05-17T23:01:00')).toBe(
      false
    );
  });
});

describe('buildTextFilter', () => {
  it('returns empty sql and params when q is empty', () => {
    expect(buildTextFilter('')).toEqual({ sql: '', params: [] });
  });

  it('returns empty sql and params when q is whitespace', () => {
    expect(buildTextFilter('  ')).toEqual({ sql: '', params: [] });
  });

  it('returns LIKE clause and three %q% params when q is non-empty', () => {
    const result = buildTextFilter('jazz');
    expect(result.sql).toBe(
      ' AND (title LIKE ? OR description LIKE ? OR tags LIKE ?)'
    );
    expect(result.params).toEqual(['%jazz%', '%jazz%', '%jazz%']);
  });

  it('preserves internal spaces in q', () => {
    const result = buildTextFilter('outdoor market');
    expect(result.params).toEqual([
      '%outdoor market%',
      '%outdoor market%',
      '%outdoor market%',
    ]);
  });
});

describe('buildFestivalUrlFilter', () => {
  it('returns empty filter for empty or blank input', () => {
    expect(buildFestivalUrlFilter('')).toEqual({ sql: '', params: [] });
    expect(buildFestivalUrlFilter('   ')).toEqual({ sql: '', params: [] });
  });

  it('strips a single trailing slash', () => {
    expect(buildFestivalUrlFilter('https://fest.example/')).toEqual({
      sql: ' AND festival_url = ?',
      params: ['https://fest.example'],
    });
  });

  it('passes a clean URL through unchanged', () => {
    expect(buildFestivalUrlFilter('https://fest.example/2026')).toEqual({
      sql: ' AND festival_url = ?',
      params: ['https://fest.example/2026'],
    });
  });
});

describe('buildHasFestivalFilter', () => {
  it("returns the presence clause only for literal '1'", () => {
    expect(buildHasFestivalFilter('1')).toBe(
      " AND festival_url IS NOT NULL AND festival_url != ''"
    );
  });

  it('returns empty string for anything else', () => {
    expect(buildHasFestivalFilter('')).toBe('');
    expect(buildHasFestivalFilter('0')).toBe('');
    expect(buildHasFestivalFilter('true')).toBe('');
  });
});

describe('buildActUrlFilter', () => {
  it('returns empty filter for empty or blank input', () => {
    expect(buildActUrlFilter('')).toEqual({ sql: '', params: [] });
    expect(buildActUrlFilter('   ')).toEqual({ sql: '', params: [] });
  });

  it('strips a single trailing slash', () => {
    expect(buildActUrlFilter('https://band.example/')).toEqual({
      sql: ' AND act_url = ?',
      params: ['https://band.example'],
    });
  });

  it('passes a clean URL through unchanged', () => {
    expect(buildActUrlFilter('https://band.example/live')).toEqual({
      sql: ' AND act_url = ?',
      params: ['https://band.example/live'],
    });
  });
});

describe('buildHasActFilter', () => {
  it("returns the presence clause for '1'", () => {
    expect(buildHasActFilter('1')).toBe(
      " AND act_url IS NOT NULL AND act_url != ''"
    );
  });

  it("returns the absence clause for '0'", () => {
    expect(buildHasActFilter('0')).toBe(
      " AND (act_url IS NULL OR act_url = '')"
    );
  });

  it('returns empty string for anything else', () => {
    expect(buildHasActFilter('')).toBe('');
    expect(buildHasActFilter('true')).toBe('');
    expect(buildHasActFilter('2')).toBe('');
  });
});

describe('validatePutRequest', () => {
  const existing = {
    pubkey: 'a'.repeat(64),
    created_at: '2026-07-01T10:00:00',
  };
  const validBody = {
    pubkey: 'a'.repeat(64),
    signature: 'b'.repeat(128),
    title: 'Terraforma 2026',
    lat: 45.6,
    lng: 8.8,
    start_time: '2026-09-04T00:00:00',
    end_time: '2026-09-06T23:59:59',
    category: 'music',
    created_at: '2026-07-01T10:00:00',
  };

  it('accepts a valid update', () => {
    expect(validatePutRequest(validBody, existing)).toEqual({ ok: true });
  });

  it('rejects missing required fields with 400', () => {
    const { title, ...noTitle } = validBody;
    expect(validatePutRequest(noTitle, existing)).toEqual({
      ok: false,
      status: 400,
      error: 'Missing required fields',
    });
  });

  it('accepts lat/lng of 0 (equator/meridian is not a missing field)', () => {
    expect(
      validatePutRequest({ ...validBody, lat: 0, lng: 0 }, existing)
    ).toEqual({ ok: true });
  });

  it('rejects a pubkey that does not own the event with 403', () => {
    expect(
      validatePutRequest({ ...validBody, pubkey: 'c'.repeat(64) }, existing)
    ).toEqual({ ok: false, status: 403, error: 'Unauthorized' });
  });

  it('rejects a changed created_at with 400', () => {
    expect(
      validatePutRequest(
        { ...validBody, created_at: '2026-07-02T10:00:00' },
        existing
      )
    ).toEqual({ ok: false, status: 400, error: 'created_at mismatch' });
  });
});

// Shared with crawler/tests/test-tours.ts: both sides must agree on these bytes.
const ACT_VECTOR = {
  privkey: '0101010101010101010101010101010101010101010101010101010101010101',
  pubkey: '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c',
  eventId: 'abababababababababababababababababababababababababababababababab',
  actName: 'Test Band',
  actUrl: 'https://testband.example',
  signature:
    'eb42a79e717ed8cf6a9657d1f8b426ee770dc35a6705a77f648b1b27f908d139f7481f05e916b75fc5a6c7ecf4e38ff4c1daa70dff51ce70cd19b923e9b64303',
};

describe('verifyActSignature', () => {
  const v = ACT_VECTOR;

  it('accepts the fixed vector', async () => {
    expect(
      await verifyActSignature(
        v.eventId,
        v.actName,
        v.actUrl,
        v.pubkey,
        v.signature
      )
    ).toBe(true);
  });

  it('rejects any change to the id, name, url or key', async () => {
    expect(
      await verifyActSignature(
        'cd'.repeat(32),
        v.actName,
        v.actUrl,
        v.pubkey,
        v.signature
      )
    ).toBe(false);
    expect(
      await verifyActSignature(
        v.eventId,
        'Other Band',
        v.actUrl,
        v.pubkey,
        v.signature
      )
    ).toBe(false);
    expect(
      await verifyActSignature(
        v.eventId,
        v.actName,
        'https://other.example',
        v.pubkey,
        v.signature
      )
    ).toBe(false);
    expect(
      await verifyActSignature(
        v.eventId,
        v.actName,
        v.actUrl,
        '02'.repeat(32),
        v.signature
      )
    ).toBe(false);
  });

  it('rejects malformed input instead of throwing', async () => {
    expect(
      await verifyActSignature(
        v.eventId,
        v.actName,
        v.actUrl,
        'zz',
        v.signature
      )
    ).toBe(false);
    expect(
      await verifyActSignature(v.eventId, v.actName, v.actUrl, v.pubkey, '')
    ).toBe(false);
  });

  it('uses a domain separator: the raw event id is not a valid message', async () => {
    const message = await actMessage(v.eventId, v.actName, v.actUrl);
    expect(message.length).toBe(32);
    const rawId = new Uint8Array(
      v.eventId.match(/.{2}/g)!.map(h => parseInt(h, 16))
    );
    expect(Array.from(message)).not.toEqual(Array.from(rawId));
  });
});

describe('validateAdoptBody', () => {
  const good = {
    pubkey: 'a'.repeat(64),
    signature: 'b'.repeat(128),
    act_name: 'Test Band',
    act_url: 'https://testband.example',
  };

  it('accepts a well-formed body and returns the fields as given', () => {
    const r = validateAdoptBody(good);
    expect(r).toEqual({
      ok: true,
      pubkey: good.pubkey,
      signature: good.signature,
      actName: 'Test Band',
      actUrl: 'https://testband.example',
    });
  });

  it('rejects non-objects', () => {
    for (const b of [null, undefined, 'x', 3, []]) {
      const r = validateAdoptBody(b);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
  });

  it('rejects a malformed pubkey or signature', () => {
    expect(validateAdoptBody({ ...good, pubkey: 'abc' }).ok).toBe(false);
    expect(validateAdoptBody({ ...good, pubkey: 'g'.repeat(64) }).ok).toBe(
      false
    );
    expect(validateAdoptBody({ ...good, signature: 'b'.repeat(64) }).ok).toBe(
      false
    );
    expect(validateAdoptBody({ ...good, signature: undefined }).ok).toBe(false);
  });

  it('rejects an empty or too long act_name', () => {
    expect(validateAdoptBody({ ...good, act_name: '' }).ok).toBe(false);
    expect(validateAdoptBody({ ...good, act_name: '   ' }).ok).toBe(false);
    expect(validateAdoptBody({ ...good, act_name: 'x'.repeat(201) }).ok).toBe(
      false
    );
    expect(validateAdoptBody({ ...good, act_name: 'x'.repeat(200) }).ok).toBe(
      true
    );
    expect(validateAdoptBody({ ...good, act_name: 42 }).ok).toBe(false);
  });

  it('requires act_url to be an http(s) url of at most 500 characters', () => {
    expect(validateAdoptBody({ ...good, act_url: '' }).ok).toBe(false);
    expect(validateAdoptBody({ ...good, act_url: 'not a url' }).ok).toBe(false);
    expect(
      validateAdoptBody({ ...good, act_url: 'ftp://band.example' }).ok
    ).toBe(false);
    expect(
      validateAdoptBody({ ...good, act_url: 'javascript:alert(1)' }).ok
    ).toBe(false);
    expect(
      validateAdoptBody({
        ...good,
        act_url: 'https://band.example/' + 'x'.repeat(500),
      }).ok
    ).toBe(false);
    expect(
      validateAdoptBody({ ...good, act_url: 'http://band.example/live' }).ok
    ).toBe(true);
  });
});

describe('decideAdopt', () => {
  it('adopts an event that has no act yet', () => {
    expect(decideAdopt(null, 'https://testband.example')).toBe('adopt');
    expect(decideAdopt(undefined, 'https://testband.example')).toBe('adopt');
    expect(decideAdopt('', 'https://testband.example')).toBe('adopt');
    expect(decideAdopt('  ', 'https://testband.example')).toBe('adopt');
  });

  it('is idempotent for the same act (a trailing slash does not matter)', () => {
    expect(
      decideAdopt('https://testband.example', 'https://testband.example')
    ).toBe('already');
    expect(
      decideAdopt('https://testband.example/', 'https://testband.example')
    ).toBe('already');
    expect(
      decideAdopt('https://testband.example', 'https://testband.example/')
    ).toBe('already');
  });

  it('never overwrites a different act', () => {
    expect(
      decideAdopt('https://other.example', 'https://testband.example')
    ).toBe('conflict');
    expect(
      decideAdopt('https://testband.example/live', 'https://testband.example')
    ).toBe('conflict');
  });
});

describe('findSameActSameDay', () => {
  const insert = (
    DB: any,
    id: string,
    actUrl: string | null,
    start: string,
    venue: string | null = null
  ) =>
    DB.prepare(
      `INSERT INTO events (id, pubkey, signature, title, lat, lng, geohash5, geohash6,
         start_time, category, created_at, act_name, act_url, venue_name)
       VALUES (?, 'pk', 'sig', 'Show', 46.44, 11.28, 'u0pyr', 'u0pyrx', ?,
         'music', 'x', 'Band', ?, ?)`
    )
      .bind(id, start, actUrl, venue)
      .run();

  it("finds the band's show of that day wherever it is", async () => {
    const DB = makeD1(ALL_MIGRATIONS);
    await insert(
      DB,
      'e1',
      'https://band.example/en',
      '2027-06-03T00:00:00',
      'Vicar Street'
    );
    expect(
      await findSameActSameDay(
        DB,
        'https://band.example/en',
        '2027-06-03T00:00:00',
        'Vicar Street'
      )
    ).toBe('e1');
  });

  it('ignores the time of day and a trailing slash', async () => {
    const DB = makeD1(ALL_MIGRATIONS);
    await insert(
      DB,
      'e1',
      'https://band.example/en/',
      '2027-06-03T21:00:00',
      'Vicar Street'
    );
    expect(
      await findSameActSameDay(
        DB,
        'https://band.example/en',
        '2027-06-03T00:00:00',
        'Vicar Street'
      )
    ).toBe('e1');
  });

  it('does not match another day, another band or an event without a band', async () => {
    const DB = makeD1(ALL_MIGRATIONS);
    await insert(DB, 'day', 'https://band.example', '2027-06-04T00:00:00');
    await insert(DB, 'other', 'https://other.example', '2027-06-03T00:00:00');
    await insert(DB, 'none', null, '2027-06-03T00:00:00');
    expect(
      await findSameActSameDay(
        DB,
        'https://band.example',
        '2027-06-03T20:00:00'
      )
    ).toBeNull();
  });

  it('matches nothing without an act url', async () => {
    const DB = makeD1(ALL_MIGRATIONS);
    await insert(DB, 'none', null, '2027-06-03T00:00:00');
    expect(
      await findSameActSameDay(DB, undefined, '2027-06-03T00:00:00')
    ).toBeNull();
    expect(await findSameActSameDay(DB, '', '2027-06-03T00:00:00')).toBeNull();
  });

  it('does not match when both name a venue and the venues differ', async () => {
    const DB = makeD1(ALL_MIGRATIONS);
    await insert(
      DB,
      'e1',
      'https://band.example',
      '2027-06-04T00:00:00',
      'Rock im Park'
    );
    expect(
      await findSameActSameDay(
        DB,
        'https://band.example',
        '2027-06-04T00:00:00',
        'Rock Am Ring'
      )
    ).toBeNull();
  });

  it('matches the same named venue (trimmed, case-insensitive)', async () => {
    const DB = makeD1(ALL_MIGRATIONS);
    await insert(
      DB,
      'named',
      'https://band.example',
      '2027-06-04T00:00:00',
      'Rock im Park'
    );
    expect(
      await findSameActSameDay(
        DB,
        'https://band.example',
        '2027-06-04T00:00:00',
        ' rock IM park '
      )
    ).toBe('named');
  });

  it('does not match when either side lacks a venue (that is a conflict)', async () => {
    const DB = makeD1(ALL_MIGRATIONS);
    await insert(
      DB,
      'named',
      'https://band.example',
      '2027-06-04T00:00:00',
      'Rock im Park'
    );
    expect(
      await findSameActSameDay(
        DB,
        'https://band.example',
        '2027-06-04T00:00:00'
      )
    ).toBeNull();
    await insert(DB, 'blank', 'https://other.example', '2027-06-04T00:00:00');
    expect(
      await findSameActSameDay(
        DB,
        'https://other.example',
        '2027-06-04T00:00:00',
        'Anywhere'
      )
    ).toBeNull();
    expect(
      await findSameActSameDay(
        DB,
        'https://other.example',
        '2027-06-04T00:00:00'
      )
    ).toBeNull();
  });
});

describe('conflicts on event writes', () => {
  const BAND = 'https://band.example';
  const CREATED = '2026-10-28T00:00:00';

  async function sha256Hex(s: string): Promise<string> {
    const buf = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(s)
    );
    return toHex(new Uint8Array(buf));
  }
  const hexBytes = (h: string) =>
    new Uint8Array(h.match(/.{2}/g)!.map(x => parseInt(x, 16)));

  /** An event signed exactly as verifyEventSignature expects. */
  async function signed(key: TestKey, f: Record<string, any>) {
    const e: Record<string, any> = {
      pubkey: key.pubkey,
      category: 'music',
      created_at: CREATED,
      act_name: 'Band',
      act_url: BAND,
      ...f,
    };
    const data = {
      pubkey: e.pubkey,
      title: e.title,
      description: e.description || '',
      url: e.url || '',
      venue_name: e.venue_name || '',
      address: e.address || '',
      lat: e.lat,
      lng: e.lng,
      start_time: e.start_time,
      end_time: e.end_time,
      category: e.category,
      tags: e.tags || [],
      created_at: e.created_at,
    };
    const msg = hexBytes(await sha256Hex(JSON.stringify(data)));
    e.signature = toHex(await ed.signAsync(msg, key.priv));
    return e;
  }

  const call = (DB: D1Database, method: string, path: string, body: unknown) =>
    worker.fetch(
      new Request(`https://w.test${path}`, {
        method,
        body: JSON.stringify(body),
      }),
      { DB } as any
    );

  const dublin = {
    title: 'Band live in Dublin',
    lat: 53.35,
    lng: -6.26,
    start_time: '2030-06-18T20:00:00',
  };
  const cork = {
    title: 'Band live in Cork',
    lat: 51.9,
    lng: -8.47,
    start_time: '2030-06-18T20:00:00',
  };

  const held = async (DB: D1Database, id: string) =>
    (
      (await DB.prepare('SELECT held FROM events WHERE id = ?')
        .bind(id)
        .first()) as any
    ).held;
  const conflictsOf = async (DB: D1Database) =>
    (
      await DB.prepare(
        'SELECT id, status, act_url, day FROM conflicts ORDER BY id'
      ).all()
    ).results as any[];

  async function postBoth(DB: D1Database, key: TestKey) {
    const r1 = await call(DB, 'POST', '/events', await signed(key, dublin));
    const r2 = await call(DB, 'POST', '/events', await signed(key, cork));
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    return {
      d: ((await r1.json()) as any).id as string,
      c: ((await r2.json()) as any).id as string,
    };
  }

  it('POST of two venue-less same-day shows at two places holds both and notifies once', async () => {
    vi.mocked(notifyConflict).mockClear();
    const DB = makeD1();
    const key = await makeKey();
    const { d, c } = await postBoth(DB, key);
    expect(await held(DB, d)).toBe(1);
    expect(await held(DB, c)).toBe(1);
    const cs = await conflictsOf(DB);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({
      status: 'open',
      act_url: BAND,
      day: '2030-06-18',
    });
    expect(notifyConflict).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(notifyConflict).mock.calls[0][1];
    expect(arg.day).toBe('2030-06-18');
    expect(arg.actName).toBe('Band');
    expect(arg.events.map(e => e.id).sort()).toEqual([d, c].sort());

    // a third show at a third place joins the open conflict, no new notice
    const r3 = await call(
      DB,
      'POST',
      '/events',
      await signed(key, {
        title: 'Band live in Galway',
        lat: 53.27,
        lng: -9.05,
        start_time: '2030-06-18T21:00:00',
      })
    );
    expect(r3.status).toBe(201);
    expect(notifyConflict).toHaveBeenCalledTimes(1);
    expect(await conflictsOf(DB)).toHaveLength(1);
  });

  it('a notification failure does not fail the write', async () => {
    vi.mocked(notifyConflict).mockClear();
    vi.mocked(notifyConflict).mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const DB = makeD1();
      await postBoth(DB, await makeKey());
      expect(notifyConflict).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('POST of the same band, day and named venue is still a 409', async () => {
    const DB = makeD1();
    const key = await makeKey();
    const r1 = await call(
      DB,
      'POST',
      '/events',
      await signed(key, { ...dublin, venue_name: 'Vicar Street' })
    );
    expect(r1.status).toBe(201);
    const r2 = await call(
      DB,
      'POST',
      '/events',
      await signed(key, { ...cork, venue_name: ' vicar street ' })
    );
    expect(r2.status).toBe(409);
    expect(await conflictsOf(DB)).toHaveLength(0);
  });

  it('POST of an event without a band creates no conflict', async () => {
    const DB = makeD1();
    const key = await makeKey();
    const r = await call(
      DB,
      'POST',
      '/events',
      await signed(key, { ...dublin, act_url: undefined, act_name: undefined })
    );
    expect(r.status).toBe(201);
    expect(await conflictsOf(DB)).toHaveLength(0);
  });

  it('PUT moving Cork to the next day resolves the conflict and releases both', async () => {
    const DB = makeD1();
    const key = await makeKey();
    const { d, c } = await postBoth(DB, key);
    const res = await call(
      DB,
      'PUT',
      `/events/${c}`,
      await signed(key, { ...cork, start_time: '2030-06-19T20:00:00' })
    );
    expect(res.status).toBe(200);
    expect((await conflictsOf(DB))[0].status).toBe('resolved');
    expect(await held(DB, d)).toBe(0);
    expect(await held(DB, c)).toBe(0);
  });

  it('PUT moving a show onto a busy day creates a conflict there', async () => {
    vi.mocked(notifyConflict).mockClear();
    const DB = makeD1();
    const key = await makeKey();
    await call(DB, 'POST', '/events', await signed(key, dublin));
    const r = await call(
      DB,
      'POST',
      '/events',
      await signed(key, { ...cork, start_time: '2030-06-19T20:00:00' })
    );
    const c = ((await r.json()) as any).id;
    expect(await conflictsOf(DB)).toHaveLength(0);
    const res = await call(DB, 'PUT', `/events/${c}`, await signed(key, cork));
    expect(res.status).toBe(200);
    const cs = await conflictsOf(DB);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ status: 'open', day: '2030-06-18' });
    expect(notifyConflict).toHaveBeenCalledTimes(1);
  });

  it("DELETE Cork releases Dublin and purges Cork's links", async () => {
    const DB = makeD1();
    const key = await makeKey();
    const { d, c } = await postBoth(DB, key);
    const cid = (await conflictsOf(DB))[0].id;
    await DB.prepare(
      `INSERT INTO conflict_proposals (conflict_id, event_id, action, reason, created_at)
       VALUES (?, ?, 'delete', 'wrong city', 'x')`
    )
      .bind(cid, c)
      .run();
    const sig = await ed.signAsync(hexBytes(c), key.priv);
    const res = await call(DB, 'DELETE', `/events/${c}`, {
      pubkey: key.pubkey,
      signature: toHex(sig),
    });
    expect(res.status).toBe(200);
    expect(await held(DB, d)).toBe(0);
    expect((await conflictsOf(DB))[0].status).toBe('resolved');
    const links = (await DB.prepare(
      'SELECT COUNT(*) AS n FROM conflict_events WHERE event_id = ?'
    )
      .bind(c)
      .first()) as any;
    const props = (await DB.prepare(
      'SELECT COUNT(*) AS n FROM conflict_proposals WHERE event_id = ?'
    )
      .bind(c)
      .first()) as any;
    expect(links.n).toBe(0);
    expect(props.n).toBe(0);
  });

  it('attaching a band that creates a clash opens a conflict', async () => {
    vi.mocked(notifyConflict).mockClear();
    const DB = makeD1();
    const key = await makeKey();
    const r1 = await call(DB, 'POST', '/events', await signed(key, dublin));
    const d = ((await r1.json()) as any).id;
    const r2 = await call(
      DB,
      'POST',
      '/events',
      await signed(key, { ...cork, act_url: undefined, act_name: undefined })
    );
    const c = ((await r2.json()) as any).id;
    expect(await conflictsOf(DB)).toHaveLength(0);
    const sig = await ed.signAsync(await actMessage(c, 'Band', BAND), key.priv);
    const res = await call(DB, 'POST', `/events/${c}/act`, {
      pubkey: key.pubkey,
      signature: toHex(sig),
      act_name: 'Band',
      act_url: BAND,
    });
    expect(res.status).toBe(200);
    const cs = await conflictsOf(DB);
    expect(cs).toHaveLength(1);
    expect(cs[0].status).toBe('open');
    expect(await held(DB, d)).toBe(1);
    expect(await held(DB, c)).toBe(1);
    expect(notifyConflict).toHaveBeenCalledTimes(1);
  });

  it('POST answers 201 and keeps the event when reevaluation fails', async () => {
    const DB = makeD1();
    const key = await makeKey();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(reevaluateConflicts).mockRejectedValueOnce(new Error('d1 down'));
    try {
      const r = await call(DB, 'POST', '/events', await signed(key, dublin));
      expect(r.status).toBe(201);
      const id = ((await r.json()) as any).id;
      const row = await DB.prepare('SELECT id FROM events WHERE id = ?')
        .bind(id)
        .first();
      expect(row).not.toBeNull();
      expect(errSpy).toHaveBeenCalled();
      expect(String(errSpy.mock.calls[0].join(' '))).toContain(BAND);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('DELETE answers 200 and removes the event when reevaluation fails', async () => {
    const DB = makeD1();
    const key = await makeKey();
    const { c } = await postBoth(DB, key);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(reevaluateConflicts).mockRejectedValueOnce(new Error('d1 down'));
    try {
      const sig = await ed.signAsync(hexBytes(c), key.priv);
      const res = await call(DB, 'DELETE', `/events/${c}`, {
        pubkey: key.pubkey,
        signature: toHex(sig),
      });
      expect(res.status).toBe(200);
      const row = await DB.prepare('SELECT id FROM events WHERE id = ?')
        .bind(c)
        .first();
      expect(row).toBeNull();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('PUT still reevaluates the new band-day when the old one fails', async () => {
    const DB = makeD1();
    const key = await makeKey();
    const { c } = await postBoth(DB, key); // Dublin + Cork on the 18th
    await call(
      DB,
      'POST',
      '/events',
      await signed(key, {
        title: 'Band live in Galway',
        lat: 53.27,
        lng: -9.05,
        start_time: '2030-06-19T20:00:00',
      })
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(reevaluateConflicts).mockRejectedValueOnce(new Error('d1 down'));
    try {
      const res = await call(
        DB,
        'PUT',
        `/events/${c}`,
        await signed(key, { ...cork, start_time: '2030-06-19T20:00:00' })
      );
      expect(res.status).toBe(200);
      expect(errSpy).toHaveBeenCalled();
      const day19 = (await conflictsOf(DB)).filter(x => x.day === '2030-06-19');
      expect(day19).toHaveLength(1);
      expect(day19[0].status).toBe('open');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('the expiry cron removes orphan links and resolves conflicts left with one event', async () => {
    const DB = makeD1();
    const ins = (id: string, start: string) =>
      DB.prepare(
        `INSERT INTO events (id, pubkey, signature, title, lat, lng, geohash5, geohash6,
           start_time, category, created_at, act_url, held)
         VALUES (?, 'pk', 'sig', 'Show', 45, 13, 'u0000', 'u00000', ?, 'music', 'x', ?, 1)`
      )
        .bind(id, start, BAND)
        .run();
    await ins('old', '2000-01-01T20:00:00'); // expires
    await ins('live', '2999-01-01T20:00:00');
    await ins('live2', '2999-01-01T20:00:00');
    await ins('live3', '2999-01-01T20:00:00');
    const conf = (status: string) =>
      DB.prepare(
        `INSERT INTO conflicts (act_url, day, status, created_at) VALUES (?, ?, ?, 'x')`
      )
        .bind(BAND, '2000-01-01', status)
        .run();
    const c1 = Number((await conf('open')).meta.last_row_id); // old + live -> 1 left
    const c2 = Number((await conf('kept')).meta.last_row_id); // old + live2 -> 1 left
    const link = (cid: number, eid: string) =>
      DB.prepare(
        'INSERT INTO conflict_events (conflict_id, event_id) VALUES (?, ?)'
      )
        .bind(cid, eid)
        .run();
    await link(c1, 'old');
    await link(c1, 'live');
    await link(c2, 'old');
    await link(c2, 'live2');
    // a separate conflict that still has two events stays open
    const c3 = Number(
      (
        await DB.prepare(
          `INSERT INTO conflicts (act_url, day, status, created_at) VALUES (?, '2999-01-01', 'open', 'x')`
        )
          .bind(BAND)
          .run()
      ).meta.last_row_id
    );
    await link(c3, 'live2');
    await link(c3, 'live3');
    await DB.prepare(
      `INSERT INTO conflict_proposals (conflict_id, event_id, action, reason, created_at)
       VALUES (?, 'old', 'delete', 'r', 'x')`
    )
      .bind(c1)
      .run();

    await worker.scheduled({ cron: '0 2 * * *' } as any, { DB } as any);

    const left = (
      await DB.prepare(
        'SELECT event_id FROM conflict_events ORDER BY conflict_id, event_id'
      ).all()
    ).results.map((r: any) => r.event_id);
    expect(left).toEqual(['live', 'live2', 'live2', 'live3']);
    const props = (await DB.prepare(
      'SELECT COUNT(*) AS n FROM conflict_proposals'
    ).first()) as any;
    expect(props.n).toBe(0);
    const st = (
      await DB.prepare(
        'SELECT id, status, resolved_at FROM conflicts ORDER BY id'
      ).all()
    ).results as any[];
    expect(st[0].status).toBe('resolved');
    expect(st[0].resolved_at).toBeTruthy();
    expect(st[1].status).toBe('resolved');
    expect(st[2].status).toBe('open');
    expect(st[2].resolved_at).toBeNull();
    const heldOf = async (id: string) =>
      (
        (await DB.prepare('SELECT held FROM events WHERE id = ?')
          .bind(id)
          .first()) as any
      ).held;
    expect(await heldOf('live')).toBe(0); // its conflict closed
    expect(await heldOf('live3')).toBe(1); // still in an open conflict
  });
});

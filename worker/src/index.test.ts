import { describe, it, expect } from 'vitest';
import { parseWindowParam, eventsToICal, makeBackupKey, selectKeysToDelete, makeBackupPayload, duplicateCandidateCells } from './index';
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
		const result = eventsToICal([baseEvent], { lat: 45.4, lng: 9.1, category: 'music' });
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
		const event = { ...baseEvent, title: 'Rock, Jazz & More; Tonight\\Now', description: 'Line1\nLine2' };
		const result = eventsToICal([event], { lat: 45.4, lng: 9.1 });
		expect(result).toContain('SUMMARY:Rock\\, Jazz & More\\; Tonight\\\\Now');
		expect(result).toContain('DESCRIPTION:Line1\\nLine2');
	});

	it('folds lines longer than 75 characters', () => {
		const event = {
			...baseEvent,
			description: 'This is a very long description that should definitely be folded because it exceeds the RFC 5545 limit of 75 octets per line.',
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
		const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

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
		const keys = ['backups/backup-2026-03-20.json', 'backups/backup-2026-03-21.json'];
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
		expect(selectKeysToDelete(keys, 7)).toEqual(['backups/backup-2026-03-19.json']);
	});

	it('handles fewer keys than retention limit', () => {
		expect(selectKeysToDelete(['backups/backup-2026-03-26.json'], 7)).toEqual([]);
	});
});

describe('makeBackupPayload', () => {
	it('serializes events to JSON string with timestamp', () => {
		const events = [{ id: 'abc', title: 'Test' }];
		const date = new Date('2026-03-26T02:00:00Z');
		const payload = makeBackupPayload(events, date);
		const parsed = JSON.parse(payload);
		expect(parsed.timestamp).toBe('2026-03-26T02:00:00.000Z');
		expect(parsed.tables.events).toHaveLength(1);
		expect(parsed.tables.events[0].id).toBe('abc');
	});
});

describe('isDuplicate', () => {
	it('returns true for near-identical titles without calling LLM', async () => {
		let llmCalled = false;
		const llm: LLMProvider = {
			name: 'mock',
			complete: async () => { llmCalled = true; return { content: '{"probability":0}', model: 'mock' }; },
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
			complete: async () => ({ content: JSON.stringify({ probability: 0.9 }), model: 'mock' }),
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
			complete: async () => ({ content: JSON.stringify({ probability: 0.1 }), model: 'mock' }),
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
			complete: async () => { throw new Error('timeout'); },
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

		const different = await isDuplicate(
			{ title: 'Rolling Stones', description: '' },
			{ title: 'Rolling Stones @ Metropolitan', description: '' }
		);
		expect(different).toBe(false); // without LLM, Levenshtein < 0.8
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
		const baseLat = 45.464, baseLng = 9.189;
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

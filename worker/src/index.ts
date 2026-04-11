import { verifyEventSignature, verifyDeleteSignature, verifyAdminSignature } from './crypto';
import { encode as geohashEncode, neighbors } from './geohash';
import { isDuplicate } from '../../shared/llm/duplicate-check';
import { createLLMProvider } from '../../shared/llm/factory';
import { DEDUP_DISTANCE_KM, DEDUP_TIME_WINDOW_MS, DEDUP_SQL_BUFFER_MS } from '../../shared/dedup-config';

export interface Env {
	DB: D1Database;
	BACKUP_BUCKET?: R2Bucket;   // set via wrangler.toml [[r2_buckets]] binding
	ADMIN_PUBKEY?: string;       // set via: wrangler secret put ADMIN_PUBKEY
	ALLOWED_PUBKEYS?: string;    // Comma-separated hex pubkeys allowed to publish events
	LLM_API_KEY?: string;        // set via: wrangler secret put LLM_API_KEY
	LLM_PROVIDER?: string;       // set via: wrangler secret put LLM_PROVIDER (default: openrouter)
	LLM_MODEL?: string;          // set via: wrangler secret put LLM_MODEL (optional override)
}

interface Event {
	id: string;
	pubkey: string;
	signature: string;
	title: string;
	description?: string;
	url?: string;
	venue_name?: string;
	address?: string;
	lat: number;
	lng: number;
	start_time: string;  // ISO 8601 format (e.g. "2026-03-15T21:00:00")
	end_time?: string;   // ISO 8601 format
	category: string;
	tags?: string[];
	festival_name?: string;
	festival_url?: string;
	created_at: string;  // ISO 8601 format
}

// Database row type (D1 returns unknown, but we know the shape)
interface DbEventRow {
	id: unknown;
	title: unknown;
	lat: unknown;
	lng: unknown;
	start_time: unknown;
	pubkey?: unknown;
	[key: string]: unknown;
}

// CORS headers for all responses
const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

// Calculate distance between two coordinates using Haversine formula (returns km)
function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
	const R = 6371; // Earth's radius in km
	const dLat = toRadians(lat2 - lat1);
	const dLng = toRadians(lng2 - lng1);
	const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
		Math.sin(dLng / 2) * Math.sin(dLng / 2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return R * c;
}

function toRadians(degrees: number): number {
	return degrees * (Math.PI / 180);
}

// Parse a window param like "30d" → milliseconds, or null if invalid
export function parseWindowParam(window: string): number | null {
	const match = window.match(/^(\d+)d$/);
	if (!match) return null;
	return parseInt(match[1], 10) * 24 * 60 * 60 * 1000;
}

// Escape text fields per RFC 5545 (backslash, semicolon, comma, newline)
function escapeICalText(text: string): string {
	return text
		.replace(/\\/g, '\\\\')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,')
		.replace(/\r/g, '')
		.replace(/\n/g, '\\n');
}

// Fold long lines at 75 chars per RFC 5545
function foldICalLine(line: string): string {
	if (line.length <= 75) return line;
	const segments: string[] = [line.slice(0, 75)];
	let i = 75;
	while (i < line.length) {
		segments.push(' ' + line.slice(i, i + 74));
		i += 74;
	}
	return segments.join('\r\n');
}

// Convert "2026-03-15T21:00:00" → "20260315T210000" (floating local time)
function formatICalDateTime(isoStr: string): string {
	return isoStr.replace(/[-:]/g, '');
}

// Convert "2026-03-15T21:00:00" → "20260315" (date only, for all-day events)
function formatICalDate(isoStr: string): string {
	return isoStr.slice(0, 10).replace(/-/g, '');
}

// Add N days to a "YYYY-MM-DD" date string
function addDays(dateStr: string, n: number): string {
	const d = new Date(dateStr + 'T00:00:00Z');
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// Returns true if the event duration is >= 7 hours (treat as all-day)
function isLongEvent(startTime: string, endTime: string | null | undefined): boolean {
	if (!endTime) return false;
	const start = new Date(startTime).getTime();
	const end = new Date(endTime).getTime();
	return (end - start) >= 7 * 60 * 60 * 1000;
}

export function eventsToICal(events: any[], query: { lat: number; lng: number; category?: string }): string {
	const calName = query.category
		? `Tokoro: ${query.category} near ${query.lat}, ${query.lng}`
		: `Tokoro: events near ${query.lat}, ${query.lng}`;

	const lines: string[] = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Tokoro//Events//EN',
		foldICalLine(`X-WR-CALNAME:${escapeICalText(calName)}`),
	];

	for (const event of events) {
		const dtstamp = event.created_at
			? formatICalDateTime(event.created_at)
			: formatICalDateTime(new Date().toISOString().slice(0, 19));

		const summary = event.festival_name
			? `${event.festival_name}: ${event.title}`
			: event.title;

		const locationParts = [event.venue_name, event.address].filter(Boolean);
		const location = locationParts.join(', ');

		const allDay = isLongEvent(event.start_time, event.end_time);
		const endDate = event.end_time ? event.end_time.slice(0, 10) : event.start_time.slice(0, 10);

		lines.push('BEGIN:VEVENT');
		lines.push(foldICalLine(`UID:${event.id}@tokoro`));
		lines.push(`DTSTAMP:${dtstamp}`);
		if (allDay) {
			lines.push(`DTSTART;VALUE=DATE:${formatICalDate(event.start_time)}`);
			lines.push(`DTEND;VALUE=DATE:${addDays(endDate, 1)}`);
		} else {
			lines.push(`DTSTART:${formatICalDateTime(event.start_time)}`);
			if (event.end_time) {
				lines.push(`DTEND:${formatICalDateTime(event.end_time)}`);
			}
		}
		lines.push(foldICalLine(`SUMMARY:${escapeICalText(summary)}`));
		if (event.description) {
			lines.push(foldICalLine(`DESCRIPTION:${escapeICalText(event.description)}`));
		}
		if (location) {
			lines.push(foldICalLine(`LOCATION:${escapeICalText(location)}`));
		}
		if (event.lat != null && event.lng != null) {
			lines.push(`GEO:${event.lat};${event.lng}`);
		}
		if (event.url) {
			lines.push(foldICalLine(`URL:${event.url}`));
		}
		if (event.category) {
			lines.push(`CATEGORIES:${escapeICalText(event.category)}`);
		}
		lines.push('END:VEVENT');
	}

	lines.push('END:VCALENDAR');
	return lines.join('\r\n');
}

// Returns the geohash6 cell itself plus its 8 neighbors — used to avoid missing
// duplicate events that land just across a cell boundary.
export function duplicateCandidateCells(geohash6: string): string[] {
	return [geohash6, ...neighbors(geohash6)];
}

// Format a Date object as local time in ISO 8601 format (YYYY-MM-DDTHH:MM:SS)
// without timezone conversion
function formatLocalDateTime(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	const hours = String(date.getHours()).padStart(2, '0');
	const minutes = String(date.getMinutes()).padStart(2, '0');
	const seconds = String(date.getSeconds()).padStart(2, '0');
	return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}


export function makeBackupKey(date: Date): string {
	const yyyy = date.getUTCFullYear();
	const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(date.getUTCDate()).padStart(2, '0');
	return `backups/backup-${yyyy}-${mm}-${dd}.json`;
}

export function selectKeysToDelete(keys: string[], retain: number): string[] {
	const sorted = [...keys].sort(); // lexicographic = chronological for YYYY-MM-DD keys
	return sorted.slice(0, Math.max(0, sorted.length - retain));
}

export function makeBackupPayload(events: any[], date: Date): string {
	return JSON.stringify({
		timestamp: date.toISOString(),
		tables: { events },
	});
}

export default {
	async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
		// 1. Expire old events
		const cutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
		const cutoffStr = formatLocalDateTime(cutoff);
		await env.DB.prepare(`
			DELETE FROM events
			WHERE (end_time IS NOT NULL AND end_time < ?)
			   OR (end_time IS NULL AND start_time < ?)
		`).bind(cutoffStr, cutoffStr).run();

		// 2. Backup to R2 (if binding is configured)
		if (env.BACKUP_BUCKET) {
			const now = new Date();
			const key = makeBackupKey(now);

			const result = await env.DB.prepare('SELECT * FROM events').all();
			const events = result.results || [];
			const payload = makeBackupPayload(events, now);

			await env.BACKUP_BUCKET.put(key, payload, {
				httpMetadata: { contentType: 'application/json' },
			});

			// Prune old backups: enforce 7-day retention and 10 GB storage cap.
			// If total size exceeds the cap, delete the oldest backup and check again.
			const STORAGE_CAP_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
			let listed = await env.BACKUP_BUCKET.list({ prefix: 'backups/' });
			let objects = [...listed.objects].sort((a, b) => a.key < b.key ? -1 : 1);

			// Enforce 7-day retention first
			const toDelete = selectKeysToDelete(objects.map(o => o.key), 7);
			for (const k of toDelete) {
				await env.BACKUP_BUCKET.delete(k);
			}
			objects = objects.filter(o => !toDelete.includes(o.key));

			// Then enforce storage cap: remove oldest until under limit
			let totalBytes = objects.reduce((sum, o) => sum + o.size, 0);
			while (totalBytes > STORAGE_CAP_BYTES && objects.length > 1) {
				const oldest = objects.shift()!;
				await env.BACKUP_BUCKET.delete(oldest.key);
				totalBytes -= oldest.size;
			}
		}
	},

	async fetch(request: Request, env: Env): Promise<Response> {
		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: CORS_HEADERS });
		}

		const url = new URL(request.url);
		const path = url.pathname;

		try {
			// Route: GET / (API info)
			if (request.method === 'GET' && path === '/') {
				return jsonResponse({
					name: 'Tokoro API',
					version: '0.1.0',
					endpoints: {
						'GET /events': {
							description: 'Query events by location and time',
							params: {
								lat: 'Latitude (required)',
								lng: 'Longitude (required)',
								radius: 'Search radius in km (default: 10)',
								from: 'Start time ISO 8601 YYYY-MM-DDTHH:MM:SS (default: now)',
								to: 'End time ISO 8601 YYYY-MM-DDTHH:MM:SS (default: now + 7 days)',
								category: 'Filter by category (optional)'
							},
							example: '/events?lat=45.464&lng=9.189&radius=100&from=2026-03-04T00:00:00&to=2026-06-04T00:00:00'
						},
						'POST /events': {
							description: 'Create a new event (requires Ed25519 signature)',
							body: {
								pubkey: 'Ed25519 public key (hex)',
								signature: 'Ed25519 signature (hex)',
								title: 'Event title (required)',
								description: 'Event description',
								url: 'Event URL',
								venue_name: 'Venue name',
								address: 'Physical address',
								lat: 'Latitude (required)',
								lng: 'Longitude (required)',
								start_time: 'Start time (ISO 8601, required)',
								end_time: 'End time (ISO 8601)',
								category: 'Category (required)',
								tags: 'Array of tags',
								created_at: 'Creation time (ISO 8601, required)'
							}
						},
						'DELETE /events/:id': {
							description: 'Delete an event (requires Ed25519 signature)',
							body: {
								pubkey: 'Ed25519 public key (hex)',
								signature: 'Signature of event ID (hex)'
							}
						}
					}
				});
			}

			// Route: GET /stats
			if (request.method === 'GET' && path === '/stats') {
				return await handleGetStats(env);
			}

			// Route: GET /events
			if (request.method === 'GET' && path === '/events') {
				return await handleGetEvents(request, env);
			}

			// Route: POST /events
			if (request.method === 'POST' && path === '/events') {
				return await handlePostEvent(request, env);
			}

			// Route: DELETE /events/:id
			if (request.method === 'DELETE' && path.startsWith('/events/')) {
				const eventId = path.split('/')[2];
				return await handleDeleteEvent(request, env, eventId);
			}

			// Route: GET /admin/blocklist
			if (request.method === 'GET' && path === '/admin/blocklist') {
				return await handleGetBlocklist(request, env);
			}

			// Route: POST /admin/blocklist
			if (request.method === 'POST' && path === '/admin/blocklist') {
				return await handlePostBlocklist(request, env);
			}

			// Route: DELETE /admin/blocklist/:pubkey
			if (request.method === 'DELETE' && path.startsWith('/admin/blocklist/')) {
				const targetPubkey = path.split('/')[3];
				return await handleDeleteBlocklist(request, env, targetPubkey);
			}

			return jsonResponse({ error: 'Not found' }, 404);
		} catch (error) {
			console.error('Error:', error);
			return jsonResponse({ error: 'Internal server error' }, 500);
		}
	},
};

async function handleGetStats(env: Env): Promise<Response> {
	const countResult = await env.DB.prepare('SELECT COUNT(*) as total FROM events').first<{ total: number }>();
	const lastResult = await env.DB.prepare(
		'SELECT title, venue_name, lat, lng FROM events ORDER BY created_at DESC LIMIT 1'
	).first<{ title: string; venue_name: string | null; lat: number; lng: number }>();

	return jsonResponse({
		total_events: countResult?.total ?? 0,
		last_event: lastResult ?? null,
	});
}

async function handleGetEvents(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const lat = parseFloat(url.searchParams.get('lat') || '');
	const lng = parseFloat(url.searchParams.get('lng') || '');
	const radius = parseFloat(url.searchParams.get('radius') || '10'); // km
	const fromParam = url.searchParams.get('from');
	const toParam = url.searchParams.get('to');
	const format = url.searchParams.get('format') || '';
	const windowParam = url.searchParams.get('window') || '';

	const now = new Date();
	let from: string;
	let to: string;

	if (windowParam) {
		const windowMs = parseWindowParam(windowParam);
		if (windowMs !== null) {
			from = formatLocalDateTime(now);
			to = formatLocalDateTime(new Date(now.getTime() + windowMs));
		} else {
			from = fromParam || formatLocalDateTime(now);
			to = toParam || formatLocalDateTime(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000));
		}
	} else if (format === 'ical' && !fromParam && !toParam) {
		// Default 30d window for iCal subscriptions
		from = formatLocalDateTime(now);
		to = formatLocalDateTime(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000));
	} else {
		from = fromParam || formatLocalDateTime(now);
		to = toParam || formatLocalDateTime(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000));
	}

	const category = url.searchParams.get('category') || '';
	const festivalUrl = url.searchParams.get('festival_url') || '';
	const normalizedFestivalUrl = festivalUrl ? festivalUrl.replace(/\/$/, '') : '';
	const pubkeyFilter = url.searchParams.get('pubkey') || '';

	const hasGeo = !isNaN(lat) && !isNaN(lng);

	// No-params path: return events with pagination (admin/browse use case)
	if (!hasGeo && !pubkeyFilter) {
		const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;

		let allQuery = 'SELECT * FROM events WHERE 1=1';
		const allParams: any[] = [];

		if (fromParam) { allQuery += ' AND start_time >= ?'; allParams.push(from); }
		if (toParam)   { allQuery += ' AND start_time <= ?'; allParams.push(to); }
		if (category)  { allQuery += ' AND category = ?';    allParams.push(category); }

		allQuery += ' ORDER BY start_time ASC LIMIT 100 OFFSET ?';
		allParams.push(offset);

		const allResult = await env.DB.prepare(allQuery).bind(...allParams).all();
		const allEvents = allResult.results?.map(row => ({
			...(row as DbEventRow),
			tags: (row as DbEventRow).tags ? JSON.parse((row as DbEventRow).tags as string) : []
		})) || [];

		return jsonResponse({ events: allEvents, offset, count: allEvents.length, has_more: allEvents.length === 100 });
	}

	// Pubkey-only path: no geo params, just filter by author
	if (!hasGeo && pubkeyFilter) {
		let pubkeyQuery = `
			SELECT * FROM events
			WHERE pubkey = ?
			AND start_time >= ?
			AND start_time <= ?
		`;
		const pubkeyParams: any[] = [pubkeyFilter, from, to];

		if (category) {
			pubkeyQuery += ' AND category = ?';
			pubkeyParams.push(category);
		}

		pubkeyQuery += ' ORDER BY start_time ASC LIMIT 100';

		const pubkeyResult = await env.DB.prepare(pubkeyQuery).bind(...pubkeyParams).all();
		const pubkeyEvents = pubkeyResult.results?.map(row => ({
			...(row as DbEventRow),
			tags: (row as DbEventRow).tags ? JSON.parse((row as DbEventRow).tags as string) : []
		})) || [];

		return jsonResponse(pubkeyEvents);
	}

	// Choose geohash precision based on search radius to optimize query performance
	// Approximate geohash cell sizes: 1:5000km, 2:1250km, 3:156km, 4:39km, 5:4.9km, 6:1.2km
	// Use a precision where cell + neighbors covers at least the search radius
	let precision: number;
	if (radius <= 5) {
		precision = 6; // ~1.2km cells, 9 cells covers ~3.6km radius
	} else if (radius <= 15) {
		precision = 5; // ~4.9km cells, 9 cells covers ~15km radius
	} else if (radius <= 50) {
		precision = 4; // ~39km cells, 9 cells covers ~117km radius
	} else if (radius <= 200) {
		precision = 3; // ~156km cells, 9 cells covers ~468km radius
	} else {
		precision = 2; // ~1250km cells, 9 cells covers ~3750km radius
	}

	// Generate geohash for the query location with appropriate precision
	const centerHash = geohashEncode(lat, lng, precision);

	// Get neighboring geohashes to cover the area
	const hashes = [centerHash, ...neighbors(centerHash)];

	// Build SQL query using appropriate geohash column
	// Note: We only have geohash5 and geohash6 columns in the DB
	// For other precisions, we need to use prefix matching
	const placeholders = hashes.map(() => '?').join(',');

	let query: string;
	const params: any[] = [];

	if (precision === 5) {
		// Direct lookup in geohash5 column (most common case)
		query = `
			SELECT * FROM events
			WHERE geohash5 IN (${placeholders})
			AND start_time <= ?
			AND (
			  (end_time IS NOT NULL AND end_time >= ?)
			  OR (end_time IS NULL AND start_time >= ?)
			)
		`;
		params.push(...hashes, to, from, from);
	} else if (precision === 6) {
		// Direct lookup in geohash6 column
		query = `
			SELECT * FROM events
			WHERE geohash6 IN (${placeholders})
			AND start_time <= ?
			AND (
			  (end_time IS NOT NULL AND end_time >= ?)
			  OR (end_time IS NULL AND start_time >= ?)
			)
		`;
		params.push(...hashes, to, from, from);
	} else {
		// For precision 2, 3, 4: use prefix matching on geohash5
		// This checks if geohash5 starts with any of the lower-precision hashes
		const likeConditions = hashes.map(() => 'geohash5 LIKE ?').join(' OR ');
		query = `
			SELECT * FROM events
			WHERE (${likeConditions})
			AND start_time <= ?
			AND (
			  (end_time IS NOT NULL AND end_time >= ?)
			  OR (end_time IS NULL AND start_time >= ?)
			)
		`;
		params.push(...hashes.map(h => h + '%'), to, from, from);
	}

	if (category) {
		query += ' AND category = ?';
		params.push(category);
	}

	if (normalizedFestivalUrl) {
		query += ' AND festival_url = ?';
		params.push(normalizedFestivalUrl);
	}

	if (pubkeyFilter) {
		query += ' AND pubkey = ?';
		params.push(pubkeyFilter);
	}

	query += ' ORDER BY start_time ASC LIMIT 100';

	const result = await env.DB.prepare(query).bind(...params).all();

	// Filter by actual distance (post-processing)
	const events = result.results?.map(row => ({
		...(row as DbEventRow),
		tags: (row as DbEventRow).tags ? JSON.parse((row as DbEventRow).tags as string) : []
	})) || [];

	// Calculate actual distance and filter by radius
	const filteredEvents = events.filter(event => {
		const distance = haversineDistance(lat, lng, event.lat as number, event.lng as number);
		return distance <= radius;
	});

	if (format === 'ical') {
		const icalContent = eventsToICal(filteredEvents, { lat, lng, category: category || undefined });
		return new Response(icalContent, {
			status: 200,
			headers: {
				'Content-Type': 'text/calendar; charset=utf-8',
				...CORS_HEADERS,
			},
		});
	}

	return jsonResponse({ events: filteredEvents });
}

async function isBlocklisted(env: Env, pubkey: string): Promise<boolean> {
	const row = await env.DB.prepare('SELECT pubkey FROM blocklist WHERE pubkey = ?')
		.bind(pubkey)
		.first();
	return row !== null;
}

async function handlePostEvent(request: Request, env: Env): Promise<Response> {
	const event: Event = await request.json();

	// Validate required fields
	if (!event.pubkey || !event.signature || !event.title ||
	    !event.lat || !event.lng || !event.start_time || !event.category) {
		return jsonResponse({ error: 'Missing required fields' }, 400);
	}

	if (await isBlocklisted(env, event.pubkey)) {
		return jsonResponse({ error: 'Forbidden' }, 403);
	}

	// Check allowlist (if configured)
	if (env.ALLOWED_PUBKEYS) {
		const allowed = env.ALLOWED_PUBKEYS.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
		if (!allowed.includes(event.pubkey.toLowerCase())) {
			return jsonResponse({ error: 'Forbidden', message: 'Public key not in allowlist' }, 403);
		}
	}

	// Verify signature
	const isValid = await verifyEventSignature(event);
	if (!isValid) {
		return jsonResponse({ error: 'Invalid signature' }, 401);
	}

	// Generate geohashes
	const geohash5 = geohashEncode(event.lat, event.lng, 5);
	const geohash6 = geohashEncode(event.lat, event.lng, 6);

	// Check for duplicate events in the same area and time window.
	// Query events in the geohash6 cell AND its 8 neighbors to avoid missing
	// duplicates whose coordinates land just across a cell boundary.
	const eventTime = new Date(event.start_time);
	const twoHoursBefore = formatLocalDateTime(new Date(eventTime.getTime() - DEDUP_SQL_BUFFER_MS));
	const twoHoursAfter = formatLocalDateTime(new Date(eventTime.getTime() + DEDUP_SQL_BUFFER_MS));

	const candidateCells = duplicateCandidateCells(geohash6);
	const placeholders = candidateCells.map(() => '?').join(', ');
	const existingEvents = await env.DB.prepare(`
		SELECT id, title, description, lat, lng, start_time
		FROM events
		WHERE geohash6 IN (${placeholders})
		AND start_time BETWEEN ? AND ?
	`).bind(
		...candidateCells,
		twoHoursBefore,
		twoHoursAfter
	).all();

	// Check if any existing event is too similar
	if (existingEvents.results && existingEvents.results.length > 0) {
		const llm = env.LLM_API_KEY
			? createLLMProvider({ provider: env.LLM_PROVIDER, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL })
			: undefined;

		for (const existing of existingEvents.results) {
			const row = existing as DbEventRow;

			const distanceKm = haversineDistance(event.lat, event.lng, row.lat as number, row.lng as number);
			if (distanceKm > DEDUP_DISTANCE_KM) continue;

			const timeDiffMs = Math.abs(
				new Date(event.start_time).getTime() - new Date(row.start_time as string).getTime()
			);
			if (timeDiffMs > DEDUP_TIME_WINDOW_MS) continue;

			const dup = await isDuplicate(
				{ title: event.title, description: event.description },
				{ title: row.title as string, description: (row.description as string) || '' },
				llm
			);

			if (dup) {
				console.log(`Duplicate event detected: "${event.title}" similar to existing "${row.title}" (ID: ${row.id})`);
				return jsonResponse({
					error: 'Duplicate event',
					message: 'A similar event already exists in the database',
					existing_event_id: row.id,
				}, 409);
			}
		}
	}

	// Generate event ID (hash of canonical event data)
	const eventData = {
		pubkey: event.pubkey,
		title: event.title,
		description: event.description || '',
		url: event.url || '',
		venue_name: event.venue_name || '',
		address: event.address || '',
		lat: event.lat,
		lng: event.lng,
		start_time: event.start_time,
		end_time: event.end_time || null,
		category: event.category,
		tags: event.tags || [],
		created_at: event.created_at
	};

	const eventId = await generateEventId(eventData);

	// Insert into database
	const tagsJson = JSON.stringify(event.tags || []);

	await env.DB.prepare(`
		INSERT INTO events (
			id, pubkey, signature, title, description, url, venue_name, address,
			lat, lng, geohash5, geohash6, start_time, end_time,
			category, tags, created_at, festival_name, festival_url
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		eventId,
		event.pubkey,
		event.signature,
		event.title,
		event.description || null,
		event.url || null,
		event.venue_name || null,
		event.address || null,
		event.lat,
		event.lng,
		geohash5,
		geohash6,
		event.start_time,
		event.end_time || null,
		event.category,
		tagsJson,
		event.created_at,
		event.festival_name || null,
		event.festival_url || null
	).run();

	return jsonResponse({ id: eventId, message: 'Event created successfully' }, 201);
}

async function handleDeleteEvent(request: Request, env: Env, eventId: string): Promise<Response> {
	// Get signature and pubkey from request body
	const { pubkey, signature } = await request.json() as { pubkey: string; signature: string };

	if (!pubkey || !signature) {
		return jsonResponse({ error: 'Missing pubkey or signature' }, 400);
	}

	if (await isBlocklisted(env, pubkey)) {
		return jsonResponse({ error: 'Forbidden' }, 403);
	}

	// Verify signature for deletion
	const isValid = await verifyDeleteSignature(eventId, pubkey, signature);
	if (!isValid) {
		return jsonResponse({ error: 'Invalid signature' }, 401);
	}

	// Check if event exists and belongs to this pubkey
	const event = await env.DB.prepare('SELECT pubkey FROM events WHERE id = ?')
		.bind(eventId)
		.first();

	if (!event) {
		return jsonResponse({ error: 'Event not found' }, 404);
	}

	const isAdmin = env.ADMIN_PUBKEY && pubkey === env.ADMIN_PUBKEY;
	if (!isAdmin && event.pubkey !== pubkey) {
		return jsonResponse({ error: 'Unauthorized' }, 403);
	}

	// Delete the event
	await env.DB.prepare('DELETE FROM events WHERE id = ?')
		.bind(eventId)
		.run();

	return jsonResponse({ message: 'Event deleted successfully' });
}

async function handleGetBlocklist(_request: Request, env: Env): Promise<Response> {
	if (!env.ADMIN_PUBKEY) {
		return jsonResponse({ error: 'Admin not configured' }, 503);
	}

	const result = await env.DB.prepare('SELECT pubkey, created_at FROM blocklist ORDER BY created_at DESC').all();
	return jsonResponse(result.results || []);
}

async function handlePostBlocklist(request: Request, env: Env): Promise<Response> {
	if (!env.ADMIN_PUBKEY) {
		return jsonResponse({ error: 'Admin not configured' }, 503);
	}

	const { pubkey, signature, target_pubkey } = await request.json() as {
		pubkey: string; signature: string; target_pubkey: string;
	};
	if (!pubkey || !signature || !target_pubkey) {
		return jsonResponse({ error: 'Missing pubkey, signature, or target_pubkey' }, 400);
	}
	if (pubkey !== env.ADMIN_PUBKEY) {
		return jsonResponse({ error: 'Unauthorized' }, 403);
	}

	const isValid = await verifyAdminSignature(target_pubkey, env.ADMIN_PUBKEY, signature);
	if (!isValid) {
		return jsonResponse({ error: 'Invalid signature' }, 401);
	}

	if (target_pubkey === env.ADMIN_PUBKEY) {
		return jsonResponse({ error: 'Cannot block admin key' }, 400);
	}

	const now = formatLocalDateTime(new Date());
	await env.DB.prepare('INSERT OR IGNORE INTO blocklist (pubkey, created_at) VALUES (?, ?)')
		.bind(target_pubkey, now)
		.run();

	return jsonResponse({ message: 'Pubkey blocked', pubkey: target_pubkey }, 201);
}

async function handleDeleteBlocklist(request: Request, env: Env, targetPubkey: string): Promise<Response> {
	if (!env.ADMIN_PUBKEY) {
		return jsonResponse({ error: 'Admin not configured' }, 503);
	}

	const { pubkey, signature } = await request.json() as { pubkey: string; signature: string };
	if (!pubkey || !signature) {
		return jsonResponse({ error: 'Missing pubkey or signature' }, 400);
	}
	if (pubkey !== env.ADMIN_PUBKEY) {
		return jsonResponse({ error: 'Unauthorized' }, 403);
	}

	const isValid = await verifyAdminSignature(targetPubkey, env.ADMIN_PUBKEY, signature);
	if (!isValid) {
		return jsonResponse({ error: 'Invalid signature' }, 401);
	}

	await env.DB.prepare('DELETE FROM blocklist WHERE pubkey = ?').bind(targetPubkey).run();
	return jsonResponse({ message: 'Pubkey unblocked', pubkey: targetPubkey });
}

async function generateEventId(eventData: any): Promise<string> {
	const canonical = JSON.stringify(eventData);
	const encoder = new TextEncoder();
	const data = encoder.encode(canonical);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	return hashHex;
}

function jsonResponse(data: any, status: number = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			...CORS_HEADERS
		}
	});
}

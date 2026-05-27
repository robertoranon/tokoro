import { Env } from './types';
import { geocodeAddress } from '../../shared/utils/geocode';
import { createLLMProvider } from '../../shared/llm/factory';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedQuery {
  locationName: string;
  lat: number;
  lng: number;
  radiusKm: number;
  dateFrom: string; // ISO 8601 e.g. "2026-05-30T00:00:00"
  dateTo: string; // ISO 8601
  category?: string;
  tags?: string[];
  language: string; // BCP 47
  dayFilter?: 'sat' | 'sun';
}

export interface ApiEvent {
  id: string;
  title: string;
  description?: string;
  url?: string;
  venue_name?: string;
  lat: number;
  lng: number;
  start_time: string;
  end_time?: string;
  category: string;
  tags?: string[];
}

export interface QueryResult {
  text: string;
  keyboard: TgButton[][];
}

type TgButton = { text: string; callback_data: string };

export type ParseQueryResult =
  | { ok: true; query: ParsedQuery }
  | { ok: false; error: 'parse_failed' | 'geocode_failed'; language: string };

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

type I18nKey =
  | 'found_events'
  | 'no_events'
  | 'geocode_error'
  | 'api_error'
  | 'usage_hint'
  | 'query_expired'
  | 'show_more';

const TR: Record<string, Record<I18nKey, string>> = {
  en: {
    found_events:
      '🔍 {count} event{s} near {location} ({radius} km) · {dateRange}',
    no_events:
      'No events found near {location}. Try a wider radius or different dates.',
    geocode_error:
      "Couldn't find that location. Try being more specific, e.g. <i>Milan, Italy</i>.",
    api_error: 'Something went wrong fetching events. Please try again.',
    usage_hint:
      'Usage: /events &lt;location&gt; [date] [radius] [category]\nExample: /events in Milan next weekend, 50km',
    query_expired: 'This query has expired. Please send a new /events command.',
    show_more: '▼ Show more',
  },
  it: {
    found_events:
      '🔍 {count} event{s} vicino a {location} ({radius} km) · {dateRange}',
    no_events:
      'Nessun evento trovato vicino a {location}. Prova un raggio più ampio o date diverse.',
    geocode_error:
      'Non ho trovato questa posizione. Prova a essere più preciso, es. <i>Milano, Italia</i>.',
    api_error: 'Errore durante il recupero degli eventi. Riprova.',
    usage_hint:
      'Uso: /events &lt;luogo&gt; [data] [raggio] [categoria]\nEsempio: /events a Milano questo weekend, 50km',
    query_expired: 'Questa ricerca è scaduta. Invia un nuovo comando /events.',
    show_more: '▼ Mostra altri',
  },
  fr: {
    found_events:
      '🔍 {count} événement{s} près de {location} ({radius} km) · {dateRange}',
    no_events:
      'Aucun événement trouvé près de {location}. Essayez un rayon plus grand ou des dates différentes.',
    geocode_error:
      'Lieu introuvable. Soyez plus précis, ex. <i>Paris, France</i>.',
    api_error: 'Erreur lors de la récupération des événements. Réessayez.',
    usage_hint:
      'Usage : /events &lt;lieu&gt; [date] [rayon] [catégorie]\nExemple : /events à Paris ce weekend, 50km',
    query_expired:
      'Cette recherche a expiré. Envoyez une nouvelle commande /events.',
    show_more: '▼ Voir plus',
  },
  de: {
    found_events:
      '🔍 {count} Veranstaltung{s} in der Nähe von {location} ({radius} km) · {dateRange}',
    no_events:
      'Keine Veranstaltungen in der Nähe von {location} gefunden. Versuche einen größeren Radius.',
    geocode_error:
      'Ort nicht gefunden. Bitte präziser angeben, z.B. <i>Berlin, Deutschland</i>.',
    api_error:
      'Fehler beim Abrufen der Veranstaltungen. Bitte erneut versuchen.',
    usage_hint:
      'Verwendung: /events &lt;Ort&gt; [Datum] [Radius] [Kategorie]\nBeispiel: /events in Berlin dieses Wochenende, 50km',
    query_expired:
      'Diese Suche ist abgelaufen. Bitte neuen /events-Befehl senden.',
    show_more: '▼ Mehr anzeigen',
  },
  es: {
    found_events:
      '🔍 {count} evento{s} cerca de {location} ({radius} km) · {dateRange}',
    no_events:
      'No se encontraron eventos cerca de {location}. Prueba un radio mayor o fechas distintas.',
    geocode_error:
      'Ubicación no encontrada. Sé más específico, ej. <i>Madrid, España</i>.',
    api_error: 'Error al obtener los eventos. Por favor, inténtalo de nuevo.',
    usage_hint:
      'Uso: /events &lt;lugar&gt; [fecha] [radio] [categoría]\nEjemplo: /events en Madrid este fin de semana, 50km',
    query_expired: 'Esta búsqueda expiró. Envía un nuevo comando /events.',
    show_more: '▼ Ver más',
  },
  pt: {
    found_events:
      '🔍 {count} evento{s} perto de {location} ({radius} km) · {dateRange}',
    no_events:
      'Nenhum evento encontrado perto de {location}. Tente um raio maior ou datas diferentes.',
    geocode_error:
      'Localização não encontrada. Seja mais específico, ex. <i>Lisboa, Portugal</i>.',
    api_error: 'Erro ao buscar eventos. Por favor, tente novamente.',
    usage_hint:
      'Uso: /events &lt;localização&gt; [data] [raio] [categoria]\nExemplo: /events em Lisboa neste fim de semana, 50km',
    query_expired: 'Esta pesquisa expirou. Envie um novo comando /events.',
    show_more: '▼ Ver mais',
  },
};

export function t(
  lang: string,
  key: I18nKey,
  vars: Record<string, string | number> = {}
): string {
  const tbl = TR[lang] ?? TR.en;
  let s = tbl[key] ?? TR.en[key];
  for (const [k, v] of Object.entries(vars)) {
    s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return s;
}

// ---------------------------------------------------------------------------
// Date utility
// ---------------------------------------------------------------------------

export function getNextSundayEnd(now: Date): Date {
  const day = now.getDay(); // 0=Sun, 6=Sat
  const daysUntilSunday = day === 0 ? 7 : 7 - day;
  const d = new Date(now);
  d.setDate(d.getDate() + daysUntilSunday);
  d.setHours(23, 59, 59, 0);
  return d;
}

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------

const QUERY_KV_TTL = 1800; // 30 min

export async function storeQuery(
  kv: KVNamespace,
  query: ParsedQuery
): Promise<string> {
  const kvKey = `tq:${crypto.randomUUID().slice(0, 8)}`;
  await kv.put(kvKey, JSON.stringify(query), { expirationTtl: QUERY_KV_TTL });
  return kvKey;
}

export async function loadQuery(
  kv: KVNamespace,
  kvKey: string
): Promise<ParsedQuery | null> {
  const raw = await kv.get(kvKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ParsedQuery;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTML escaping (used in formatResults)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// parseEventQuery
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = new Set([
  'music',
  'arts',
  'sports',
  'food',
  'community',
  'education',
  'tech',
  'other',
]);

interface RawLLMQuery {
  location?: string;
  date_from?: string;
  date_to?: string;
  radius_km?: number;
  category?: string | null;
  tags?: unknown;
  language?: string;
}

export async function parseEventQuery(
  text: string,
  env: Env,
  now: Date
): Promise<ParseQueryResult> {
  const DAYS = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];
  const todayISO = now.toISOString().slice(0, 10);
  const nowISO = now.toISOString().slice(0, 19);
  const defaultTo = getNextSundayEnd(now).toISOString().slice(0, 19);

  const systemPrompt = `You extract event search parameters from a natural language query.
Today is ${todayISO} (${DAYS[now.getDay()]}). Current datetime: ${nowISO}.
Default date range if unspecified: from ${nowISO} to ${defaultTo}.
Return ONLY valid JSON — no markdown, no explanation.

Schema:
{
  "location": string,
  "date_from": string,
  "date_to": string,
  "radius_km": number,
  "category": string|null,
  "tags": string[],
  "language": string
}

Valid categories: music, arts, sports, food, community, education, tech, other`;

  let raw: RawLLMQuery;
  try {
    const llm = createLLMProvider({
      provider: env.LLM_PROVIDER,
      apiKey: env.LLM_API_KEY!,
      model: env.LLM_MODEL,
    });
    const resp = await llm.complete(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
      { temperature: 0, maxTokens: 300, responseFormat: 'json' }
    );
    raw = JSON.parse(resp.content) as RawLLMQuery;
  } catch (err) {
    console.error('[parseEventQuery] LLM/parse error:', err);
    return { ok: false, error: 'parse_failed', language: 'en' };
  }

  if (!raw.location || !raw.date_from || !raw.date_to) {
    return { ok: false, error: 'parse_failed', language: 'en' };
  }

  const detectedLang =
    typeof raw.language === 'string' && raw.language.length >= 2
      ? raw.language.slice(0, 5).toLowerCase()
      : 'en';

  const geo = await geocodeAddress(raw.location);
  if (!geo) {
    return { ok: false, error: 'geocode_failed', language: detectedLang };
  }

  return {
    ok: true,
    query: {
      locationName: raw.location,
      lat: geo.lat,
      lng: geo.lng,
      radiusKm:
        typeof raw.radius_km === 'number' && raw.radius_km > 0
          ? raw.radius_km
          : 20,
      dateFrom: raw.date_from,
      dateTo: raw.date_to,
      category:
        typeof raw.category === 'string' && VALID_CATEGORIES.has(raw.category)
          ? raw.category
          : undefined,
      tags: Array.isArray(raw.tags)
        ? (raw.tags as unknown[]).filter(
            (x): x is string => typeof x === 'string'
          )
        : [],
      language: detectedLang,
    },
  };
}

// ---------------------------------------------------------------------------
// fetchEvents
// ---------------------------------------------------------------------------

export async function fetchEvents(
  query: ParsedQuery,
  env: Env
): Promise<ApiEvent[]> {
  const p = new URLSearchParams({
    lat: String(query.lat),
    lng: String(query.lng),
    radius: String(query.radiusKm),
    from: query.dateFrom,
    to: query.dateTo,
  });
  if (query.category) p.set('category', query.category);
  if (query.tags?.length) p.set('tags', JSON.stringify(query.tags));

  let res: Response;
  if (env.API_WORKER) {
    res = await env.API_WORKER.fetch(new Request(`https://worker/events?${p}`));
  } else if (env.API_WORKER_URL) {
    res = await fetch(`${env.API_WORKER_URL}/events?${p}`);
  } else {
    throw new Error('No API worker configured');
  }

  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return (await res.json()) as ApiEvent[];
}

// ---------------------------------------------------------------------------
// formatResults
// ---------------------------------------------------------------------------

const CAT_EMOJI: Record<string, string> = {
  music: '🎵',
  arts: '🎨',
  sports: '🏃',
  food: '🍔',
  community: '👥',
  education: '📚',
  tech: '💻',
  other: '📌',
};

function fmtDateRange(dateFrom: string, dateTo: string): string {
  const d1 = dateFrom.slice(0, 10);
  const d2 = dateTo.slice(0, 10);
  return d1 === d2 ? d1 : `${d1} – ${d2}`;
}

export function formatResults(
  allEvents: ApiEvent[],
  query: ParsedQuery,
  offset: number,
  kvKey: string
): QueryResult {
  const PAGE = 5;
  const lang = query.language;

  // Apply day filter in memory
  const events = query.dayFilter
    ? allEvents.filter(e => {
        const d = new Date(e.start_time).getDay();
        return query.dayFilter === 'sat' ? d === 6 : d === 0;
      })
    : allEvents;

  const header = t(lang, 'found_events', {
    count: events.length,
    s: events.length !== 1 ? 's' : '',
    location: escapeHtml(query.locationName),
    radius: query.radiusKm,
    dateRange: fmtDateRange(query.dateFrom, query.dateTo),
  });

  const page = events.slice(offset, offset + PAGE);
  const lines = page.map((e, i) => {
    const num = offset + i + 1;
    const date = e.start_time.slice(5, 10).replace('-', '/');
    const time = e.start_time.slice(11, 16);
    const venue = e.venue_name ? ` · ${escapeHtml(e.venue_name)}` : '';
    return `${num}. <b>${escapeHtml(e.title)}</b>\n   ${date} ${time}${venue}`;
  });

  const text = `${header}\n\n${lines.join('\n\n')}`;

  const keyboard: TgButton[][] = [];

  // Category buttons: top 3 most frequent in all results, excluding active filter
  const catCounts: Record<string, number> = {};
  for (const e of allEvents) {
    catCounts[e.category] = (catCounts[e.category] ?? 0) + 1;
  }
  const topCats = Object.entries(catCounts)
    .filter(([cat]) => cat !== query.category)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cat]) => cat);

  if (topCats.length > 0) {
    keyboard.push(
      topCats.map(cat => ({
        text: `${CAT_EMOJI[cat] ?? '📌'} ${cat.charAt(0).toUpperCase() + cat.slice(1)}`,
        callback_data: `qfc:${cat}:${kvKey}`,
      }))
    );
  }

  // Day filter buttons
  const hasSat = allEvents.some(e => new Date(e.start_time).getDay() === 6);
  const hasSun = allEvents.some(e => new Date(e.start_time).getDay() === 0);
  const dayBtns: TgButton[] = [];
  if (hasSat && query.dayFilter !== 'sat') {
    dayBtns.push({ text: '📅 Sat', callback_data: `qfd:sat:${kvKey}` });
  }
  if (hasSun && query.dayFilter !== 'sun') {
    dayBtns.push({ text: '📅 Sun', callback_data: `qfd:sun:${kvKey}` });
  }
  if (dayBtns.length > 0) keyboard.push(dayBtns);

  // Show more
  if (offset + PAGE < events.length) {
    keyboard.push([
      {
        text: t(lang, 'show_more'),
        callback_data: `qm:${offset + PAGE}:${kvKey}`,
      },
    ]);
  }

  return { text, keyboard };
}

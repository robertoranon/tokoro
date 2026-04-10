/**
 * Generates the LLM system prompt for event extraction
 *
 * @param options Optional parameters to customize the prompt
 * @returns The complete system prompt for event extraction
 */
import { DEFAULT_MAX_CONTENT_LENGTH } from './extraction-limits.js';

export function getEventExtractionPrompt(options?: {
  maxContentLength?: number;
}): string {
  const maxContentLength =
    options?.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;

  return `You are an expert at extracting structured event data from web pages.

Extract the following information from the provided web page content:

- **title**: The event title/name (required)
- **description**: A concise summary of the event in at most 3-4 sentences (optional)
- **url**: The event's website or ticket URL (optional, use the page URL if not found)
- **venue_name**: The venue name only (e.g. "Blue Note", "Alcatraz") - NOT the full address
- **address**: The COMPLETE physical street address (CRITICAL for accurate geocoding)
- **lat, lng**: GPS coordinates if explicitly mentioned (optional)
- **start_time**: Start date and time (required) - provide as ISO 8601 string (e.g. "2026-04-20T19:00:00"). **CRITICAL: use the exact local time shown on the page — do NOT convert to UTC or adjust for any timezone offset**
- **day_name**: name of the day of event, if explicitly mentioned (optional)
- **end_time**: End date and time (optional, only if the page explicitly mentions it). Same rule: exact local time, no UTC conversion.
- **category**: Choose ONE from: music, food, sports, art, theater, film, nightlife, community, outdoor, learning, wellness, talks, other
- **tags**: An array of relevant tags (optional, e.g. ["jazz", "outdoor", "free"]), such as music genre, type of food, ...
- **festival_name**: If the page is clearly part of a named festival or multi-day event series (e.g. "Flow Festival 2026", "Glastonbury 2026"), populate this on ALL events extracted from the page. If unsure, omit.
- **festival_url**: The festival's canonical homepage URL (e.g. "https://www.flowfestival.com"). Only populate if you are confident of the festival homepage URL — if unsure, omit rather than guess.

DATE EXTRACTION RULES:
- Today's date will be provided in the user message
- If the page URL contains a year (e.g. \`/2025/\`, \`/edition-2024/\`, \`?year=2023\`), use that year **definitively** for all dates on the page — even if it results in past dates. Do NOT advance to the next year when a URL year hint is present. Past events will be filtered automatically.
- If the event date does NOT include a year (and there is no URL year hint), assume it refers to the CURRENT YEAR (the year from today's date)
- If the inferred date (with current-year default, no URL hint) would be in the past (before today), if it would be only a few months in the past from today, assume it is a past event and keep the inferred date, otherwise assume it's next year.
- For example: if today is March 2, 2026 and the event says "February 16", assume February 16, 2026 (not 2027)
- For example: if today is December 2, 2026 and the event says "February 10", assume February 10, 2027 (next occurrence)
- Social media pages often include the time / date of the post (e.g. 5 h for an entry posted 5 hours ago), use that to contextualize the inferred date.
For example, for an entry posted 5 hours ago, "Tuesday" indicates next Tuesday from now (minus 5 hours).
- When a day name is shown alongside a date — in any language, abbreviated or full (e.g. \`Sun 20 Apr\`, \`Tuesday 15 March\`, \`Dom 20 Apr\`, \`DOMENICA 20 APRILE\`, \`Samstag 10. Mai\`, \`Samedi 10 mai\`) — always populate the \`day_name\` field with the English full weekday name (e.g. \`"Sunday"\`, \`"Saturday"\`). Translate from any language if needed. Do this even when the year is known or explicit. This field is used for post-processing validation.

ADDRESS EXTRACTION RULES:
- Prefer a COMPLETE street address with street name, number, and city (best for geocoding)
- Search the ENTIRE page content - address info may be in venue details, footer, or contact sections
- If the page only has a venue name and city (no street), return those (e.g. "Blue Note, Milano") — this is fine
- If the page only has a city or region with no venue, return just that (e.g. "Pordenone")
- NEVER invent or guess any part of the address. Only return what is explicitly on the page.
- If absolutely no location information is found, omit the address field entirely

Guidelines:
- **Extract ALL events found on the page** — do NOT limit or filter by date proximity, relevance, or any other criteria. If the page lists 40 events, return all 40. Never stop early.
- **Multi-day range events** (festivals, museum exhibits, fairs, markets): if the page shows a DATE RANGE (e.g. "May 12–22", "open from June 1 to June 30") with no specific per-day schedule, extract as a SINGLE event with start_time set to the first day at T00:00:00 and end_time set to the last day at T23:59:59. If daily opening hours are stated (e.g. "open 10am–6pm daily"), use those hours instead of T00:00:00/T23:59:59. If no closing date is stated, omit end_time.
- **Scheduled multi-day events**: if the page lists specific programs, performances, or schedules for individual days (e.g. "Friday May 12 – The Glowing Socks, Saturday May 13 – Banana Republic"), extract each day as a separate event, using each day's explicit date for start_time. The title should be "{Festival Name} – {Day Name/Date}" (e.g. "Sunshine Fest 2026 – Friday") and the description MUST list ALL performers/acts scheduled for that day (e.g. "The Glowing Socks, Banana Republic, Captain Noodle, ..."). If only some days have schedules while others do not, prefer the single-event approach and mention the scheduled acts in the description.
- If start time is not explicit, make a reasonable guess based on context (concerts often 20:00, sports vary, etc.)
- Only set end_time if explicitly mentioned on the page. Do NOT estimate or guess end times — omit end_time entirely if it is not shown.
- Category should match the primary focus of the event
- Tags should be lowercase and descriptive

Festival context: If the page is a festival program/schedule page, every extracted event should include festival_name and festival_url. Example for a per-day festival schedule page:
[{"title":"Sunshine Fest 2026 – Friday","description":"The Glowing Socks, Banana Republic, Captain Noodle","festival_name":"Sunshine Fest 2026","festival_url":"https://www.sunshinefest.example","start_time":"2026-07-11T00:00:00","category":"music",...},{"title":"Sunshine Fest 2026 – Saturday","description":"Laser Hamster, Void Patrol, The Soggy Biscuits","festival_name":"Sunshine Fest 2026","festival_url":"https://www.sunshinefest.example","start_time":"2026-07-12T00:00:00","category":"music",...}]

Return ONLY a valid JSON object (or array of objects if multiple events) matching this schema. Do not include any explanatory text.

Example output (page shows "Sunday 15 March"):
{
  "title": "The Big Jazz Band",
  "description": "An evening of live jazz featuring local and international artists.",
  "venue_name": "Blue Note",
  "address": "Via Inventata 99, Cittàfinta",
  "start_time": "2026-03-15T21:00:00",
  "end_time": "2026-03-16T00:00:00",
  "day_name": "Sunday",
  "category": "music",
  "tags": ["jazz", "live music", "nightlife"]
}

If you find multiple events on the page, return an array: [event1, event2, ...]`;
}

/**
 * Generates the user prompt for event extraction
 *
 * @param page The fetched page data
 * @param todayISO Today's date in ISO format (YYYY-MM-DD)
 * @param content The page content to extract from (usually page.text or page.readableText)
 * @returns The user prompt to send to the LLM
 */
export function getEventExtractionUserPrompt(
  page: { url: string; title: string },
  todayISO: string,
  content: string
): string {
  return `Today's date: ${todayISO}

Page URL: ${page.url}
Page Title: ${page.title}

Content:
${content}`;
}

/**
 * Generates the LLM system prompt for extracting events from images (flyers, posters, etc.)
 *
 * @returns The complete system prompt for image-based event extraction
 */
export function getImageEventExtractionPrompt(): string {
  return `You are an expert at extracting structured event data from images of event flyers, posters, and promotional materials.

Analyze the provided image and extract the following information:

- **title**: The event title/name (required)
- **description**: A BRIEF 1-2 sentence summary of the event based on visible information (optional, MUST be concise)
- **url**: The event's website or ticket URL if visible on the image (optional)
- **venue_name**: The venue name only (e.g. "Blue Note", "Alcatraz") - NOT the full address
- **address**: The COMPLETE physical street address if visible (CRITICAL for accurate geocoding)
- **lat, lng**: GPS coordinates if explicitly mentioned (optional, rarely present on flyers)
- **start_time**: Start date and time (required) - provide as ISO 8601 string (e.g. "2026-04-20T19:00:00"). **CRITICAL: use the exact local time shown on the image — do NOT convert to UTC or adjust for any timezone offset**
- **end_time**: End date and time (optional, if shown on the flyer). Same rule: exact local time, no UTC conversion.
- **day_name**: name of the day of event, if explicitly mentioned (optional)
- **category**: Choose ONE from: music, food, sports, art, theater, film, nightlife, community, outdoor, learning, wellness, talks, other
- **tags**: An array of relevant tags based on the event type and visible information (optional, e.g. ["jazz", "outdoor", "free"])

DATE EXTRACTION RULES:
- Today's date will be provided in the user message
- If the event date does NOT include a year, assume it refers to the CURRENT YEAR (the year from today's date)
- If the inferred date would be in the past (before today), if it would be only a few months in the past from today, assume it is a past event and keep the inferred date, otherwise assume it's next year.
- For example: if today is March 2, 2026 and the event says "February 16", assume February 16, 2026 (not 2027)
- For example: if today is December 2, 2026 and the event says "February 10", assume February 10, 2027 (next occurrence)
- Common date formats on flyers: "April 16", "16/04", "Apr 16", "16.04", etc.
- Look for time information: "21:00", "9:00 PM", "ore 21:00", "doors 8pm", etc.
- When a day name is shown alongside a date — in any language, abbreviated or full (e.g. \`Sun 20 Apr\`, \`Tuesday 15 March\`, \`Dom 20 Apr\`, \`DOMENICA 20 APRILE\`, \`Samstag 10. Mai\`, \`Samedi 10 mai\`) — always populate the \`day_name\` field with the English full weekday name (e.g. \`"Sunday"\`, \`"Saturday"\`). Translate from any language if needed. Do this even when the year is known or explicit. This field is used for post-processing validation.

ADDRESS EXTRACTION RULES:
- Prefer a COMPLETE street address with street name, number, and city (best for geocoding)
- If the image only shows a venue name and city (no street), return those (e.g. "Blue Note, Milano") — this is fine
- If the image only shows a city or region, return just that (e.g. "Pordenone")
- NEVER invent or guess any part of the address. Only return what is explicitly visible.
- If absolutely no address information is visible, omit the address field entirely

FLYER READING TIPS:
- Event flyers often have the main event name in large text at the top or center
- Date and time are usually prominently displayed
- Venue information is typically at the bottom or in smaller text
- Look for recognizable venue logos or branding
- URLs are often at the bottom or in fine print
- Price information, if present, might be useful for tags (e.g. "free")
- Multiple acts/artists may be listed - include the main headliner as title, others in description or tags

Guidelines:
- **Multi-day range events** (festivals, exhibits, fairs): if the image shows a DATE RANGE (e.g. "May 12–22") with no per-day schedule, extract as a SINGLE event with start_time set to the first day at T00:00:00 and end_time set to the last day at T23:59:59. If daily opening hours are visible (e.g. "open 10am–6pm daily"), use those hours instead. If no closing date is visible, omit end_time.
- **Scheduled multi-day events**: if the image shows specific programs or acts per day (e.g. "Friday May 12 – Band X, Saturday May 13 – Band Y"), extract each day as a separate event, using each day's explicit date for start_time. If only some days have schedules, prefer the single-event approach and mention the scheduled acts in the description.
- If the image shows multiple unrelated events (like a weekly schedule), extract each as a separate event
- If start time is not visible, make a reasonable guess based on event type (concerts often 20:00-21:00, sports vary, etc.)
- **end_time**: only set if explicitly visible on the image. Do NOT estimate or guess end times — omit end_time entirely if it is not shown.
- Category should match the primary focus of the event based on visual cues
- Tags should be lowercase and descriptive based on what you see

Return ONLY a valid JSON object (or array of objects if multiple events) matching this schema. Do not include any explanatory text.

Example output for a jazz concert flyer (no end time visible on the flyer):
{
  "title": "Jazz Night at Blue Note",
  "description": "An evening of live jazz featuring local and international artists.",
  "venue_name": "Blue Note",
  "address": "Via Inventata 99, Cittàfinta",
  "start_time": "2026-03-15T21:00:00",
  "day_name": "Sunday",
  "end_time": "2026-03-16T00:00:00",
  "category": "music",
  "tags": ["jazz", "live music", "nightlife"]
}

If you find multiple events on the flyer/image, return an array: [event1, event2, ...]`;
}

/**
 * Generates the user prompt for extracting events from an image
 *
 * @param imageSource Optional source information (URL where the image was found)
 * @param todayISO Today's date in ISO format (YYYY-MM-DD)
 * @returns The user prompt to send to the LLM (text only, image will be in separate content block)
 */
export function getImageEventExtractionUserPrompt(
  imageSource: string | undefined,
  todayISO: string
): string {
  let prompt = `Today's date: ${todayISO}\n\n`;

  if (imageSource) {
    prompt += `Image source: ${imageSource}\n\n`;
  }

  prompt += `Please analyze the event flyer/poster image and extract all visible event information.`;

  return prompt;
}

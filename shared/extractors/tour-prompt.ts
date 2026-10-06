/**
 * System prompt for extracting EVERY upcoming show listed on a page: a band's
 * own tour page, or a venue/aggregator programme. The user prompt is the
 * regular getEventExtractionUserPrompt().
 */
export function getTourShowsPrompt(): string {
  return `You are an expert at reading concert listings. Extract EVERY upcoming concert or live show listed on the page, one record per show. Do not decide which acts matter: report all of them.

Return a JSON object {"shows": [ ... ]}. Each show has:

- **title** (required): the show title as the page gives it (e.g. "Test Band live", or the event/tour name)
- **performers** (required): array with the name of EVERY act on the bill, headliner first, exactly as written on the page. If the page names no act for a show, use the single act the page is about (a band's own page) or [].
- **start_time** (required): "YYYY-MM-DDTHH:MM:SS" local time of the venue if the page gives a time (doors time is acceptable only if no show time is given); otherwise just the date "YYYY-MM-DD". Do NOT convert time zones.
- **end_time**: only if the page states it, same format
- **venue_name**: the venue name only
- **city**: the city or town of the venue
- **address**: street address if the page gives one (never invent or guess)
- **lat, lng**: only if explicitly stated
- **url**: the show's own page or ticket link if it has one
- **description**: one short sentence only if the page gives extra information (support acts go in performers, not here)
- **tags**: lowercase genre tags only if the page states them

RULES:
- Include only shows on or after today's date (given in the user message). Skip past shows.
- Use the exact dates shown. If a date shows no year, assume the current year, or next year if the current-year date is more than a few months in the past. If the page URL or title contains a year, use it.
- Several dates in the same city are separate shows. A multi-day festival appearance is one show per day the act plays if the page says so, otherwise one show on the first day.
- Skip cancelled shows, sold-out status does not matter (keep sold-out shows).
- Do not invent shows, venues or dates. If the page lists no upcoming shows, return {"shows": []}.

Example output:
{
  "shows": [
    {
      "title": "Test Band live",
      "performers": ["Test Band", "Opener"],
      "start_time": "2030-11-12T21:00:00",
      "venue_name": "Club X",
      "city": "Udine",
      "address": "Via Roma 1, Udine",
      "url": "https://tickets.example/test-band-udine"
    },
    {
      "title": "Test Band live",
      "performers": ["Test Band"],
      "start_time": "2030-11-20",
      "venue_name": "Kino Šiška",
      "city": "Ljubljana"
    }
  ]
}`;
}

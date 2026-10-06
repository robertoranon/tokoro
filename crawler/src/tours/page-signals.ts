// Deterministic checks on a band homepage's full text, used by the bands scout
// so that the decision "this page is where the shows are" does not depend on
// how much of the page an LLM was shown.

const MONTHS = [
  // English, Italian, French, German, Spanish spellings (full names and the
  // usual abbreviations); "may"/"mar"/"mai" etc. only count next to a day number.
  'jan(?:uary|uar)?',
  'janv(?:ier)?',
  'gen(?:naio)?',
  'ene(?:ro)?',
  'feb(?:ruary|ruar|braio)?',
  'f[ée]vr(?:ier)?',
  'mar(?:ch|zo)?',
  'm[äa]rz',
  'mars',
  'apr(?:il|ile)?',
  'avr(?:il)?',
  'abr(?:il)?',
  'may',
  'mai',
  'mag(?:gio)?',
  'jun(?:e|i)?',
  'juin',
  'giu(?:gno)?',
  'jul(?:y|i)?',
  'juil(?:let)?',
  'lug(?:lio)?',
  'julio',
  'aug(?:ust)?',
  'ao[uû]t',
  'ago(?:sto)?',
  'sep(?:t(?:ember|embre|iembre)?)?',
  'set(?:tembre)?',
  'oct(?:ober|obre)?',
  'okt(?:ober)?',
  'ott(?:obre)?',
  'nov(?:ember|embre)?',
  'dec(?:ember|embre)?',
  'd[ée]c(?:embre)?',
  'dez(?:ember)?',
  'dic(?:iembre|embre)?',
].join('|');

// "Nov 12", "12 Nov", "12th November", "12.11.2030", "12/11/30", "2030-11-12"
const DATE_LIKE = new RegExp(
  `\\b(?:${MONTHS})\\.? \\d{1,2}\\b|\\b\\d{1,2}(?:st|nd|rd|th|\\.)? (?:${MONTHS})\\b|\\b\\d{1,2}[./]\\d{1,2}[./](?:20)?\\d{2}\\b|\\b20\\d{2}-\\d{2}-\\d{2}\\b`,
  'gi'
);

const TOURISH_WORD =
  /\b(?:tour|live|tickets?|concerts?|shows?|gigs?|dates|tournée|konzerte?|biglietti|conciertos?)\b/i;

// "No upcoming events" and its usual variants.
const NO_EVENTS = new RegExp(
  [
    'no (?:upcoming |current |scheduled )?(?:events|shows|dates|concerts|gigs|tour dates)',
    'there are no (?:upcoming |current )?(?:events|shows|dates|concerts)',
    'no events? (?:are |is )?(?:currently |presently )?(?:scheduled|planned|announced)',
    'nothing (?:is )?(?:scheduled|planned|announced)',
    'keine (?:aktuellen |bevorstehenden |anstehenden )?(?:termine|events|konzerte)',
    'nessun[oa]? (?:evento|concerto|data)',
    'aucun[e]? (?:concert|date|événement|evenement)',
    'ning[uú]n (?:concierto|evento)',
  ].join('|'),
  'i'
);

/** Number of date-like mentions in the text. */
export function countDateMentions(text: string): number {
  return (text.match(DATE_LIKE) ?? []).length;
}

/**
 * The page lists dated shows: at least two date-like mentions plus a
 * tour-related word somewhere (so a news archive full of post dates is not
 * enough by itself).
 */
export function looksLikeShowListing(text: string): boolean {
  return countDateMentions(text) >= 2 && TOURISH_WORD.test(text);
}

/** The page says there are no upcoming events/shows (an events section that is empty right now). */
export function saysNoEvents(text: string): boolean {
  return NO_EVENTS.test(text);
}

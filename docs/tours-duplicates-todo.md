# Tours: duplicates and wrong entries — task list

Context: a duplicate Einstürzende Neubauten show (Trento) led to a wider look at
tour data quality. Done so far (uncommitted, not deployed): geocoder name-match
and stable tie-break (`shared/utils/geocode.ts`), `matchShow` date-only fallback
(`crawler/src/tours/tour-publisher.ts`), worker same-band/same-date 409
(`findSameActSameDay` in `worker/src/index.ts`, skipped when both events name
different venues). Specs and tests updated for all three.

## Tasks, in order

- [x] **1. Why did extraction get dates wrong?** (investigated, cause not proven; see Findings) Two confirmed cases, both off by
      one day:
  - Putan Club, La Pompe (Florac): stored 2027-03-19, should be 03-18
    (event `68637010a7c63206891d24fa61e467bfc9e21c42021d4fb4c172a2de0f4a6efc`;
    source https://putanclub.org/tour.html)
  - TOTO, Cork: stored 2027-06-16, should be 06-17
    (event `1eca6f95ca8a41ab7acb65d28f84bb0dd42d2468d883afdea6ea8d4d121bcd84`;
    source https://totoofficial.com/events/)
- [ ] **2. How to treat an announced date that is a range.** Festival appearances
      (Interrupters at Southside / Hurricane, Blink-182 at Rock im Park / Rock am
      Ring, Pigeon at ESNS) have no exact date yet; we store the range start.
      Decide: how to represent it, how it interacts with the same-band/same-date
      rules (`matchShow` rule 3, worker `findSameActSameDay`), and when the real
      date arrives (update in place, not a new event).
- [ ] **3. Duplicates and wrong entries in the data.** Needs the user's decision
      on which of each pair to keep; deleting is done by the user (wrangler is not
      authorized for the remote DB).
  - Probable duplicates: Cat Power Paris (10-31 and 11-09), Fontaines D.C. Paris
    11-13 ("Accor Arena" vs "Fontaines D.C."), Fatoumata Diawara 11-09
    (Leverkusener Jazztag vs Fatoumata Diawara), TOTO Groningen 07-03, Azkena
    Rock Festival 2027-06-18.
  - Wrong dates (from task 1): Putan Club La Pompe, TOTO Cork. Deleting lets the
    crawler republish them with the right date.
  - Valid, keep: Interrupters (Southside + Hurricane), Blink-182 (Rock im Park +
    Rock am Ring), Pigeon (Whelan's + ESNS).
- [ ] **4. The Pretty Reckless duplicate** (Glasgow, 2026-12-02): events
      `91b1c6fc…` and `f899ee75…`, same key, identical coordinates and venue,
      created in the same second. The proximity check should have caught it.
      Hypothesis (unverified): a race between concurrent POSTs. If so, the new
      worker same-band/same-date check has the same race.
- [ ] **5. Before deploying:** run the main crawler suite (`npm test`), then
      deploy the crawler fix before the next tours run, then the worker.

## Notes

- The Neubauten Trento and OFF Festival Katowice duplicates were deleted by the
  user.
- Root cause of those (done): the geocoder placed the same city at different
  points between runs, and neither `matchShow` (no venue name) nor the worker
  proximity check (~1 km) could see the two as one show.

## Findings: task 1 (extraction dates)

- Replayed both sources with `npm run tours -- --bands /tmp/tours-repro.yaml
  --debug` (dry run, 79 shows). Today the LLM returns the correct dates: La Pompe
  2027-03-18, Le 18 03-19, Dublin 06-16, Cork 06-17. **Not reproducible.**
- The source pages are correct: TOTO lists `Jun 16 Dublin`, `Jun 17 Cork`;
  Putan Club lists `18/03 La Pompe`, `19/03 Le 18`.
- In both wrong events the date was a neighbouring row's (La Pompe took the
  next row's, Cork the previous one's). Putan Club was published 2026-10-06
  19:30, before the last tour-prompt change (22:02 that day); TOTO on 10-19,
  with the current prompt.
- The default LLM temperature is 0.1 (`shared/llm/*.ts`), so extraction is not
  deterministic, and the tours runner keeps no record of the extraction output,
  so the original run cannot be inspected. Likeliest cause: a one-off
  misalignment of dates and places in a long list. Unproven.
- Idea (not done): flag, instead of publishing, two drafts of one source on the
  same date in different places when neither names a venue. A band cannot play
  two cities in a day, and the festival placeholders that legitimately share a
  date name different venues.

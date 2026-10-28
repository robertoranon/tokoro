# Tours: duplicates and wrong entries — task list

Context: a duplicate Einstürzende Neubauten show (Trento) led to a wider look at
tour data quality. Status on 2026-10-28: everything below is merged into `main`,
the migration is applied, the worker is deployed and `main` is pushed (the tours
job runs the pushed crawler). The data cleanup is done; two follow-ups are open
(tasks 4 and 6).

## Tasks, in order

- [x] **1. Why did extraction get dates wrong?** (investigated, cause not proven; see Findings) Two confirmed cases, both off by
      one day:
  - Putan Club, La Pompe (Florac): stored 2027-03-19, should be 03-18
    (event `68637010a7c63206891d24fa61e467bfc9e21c42021d4fb4c172a2de0f4a6efc`;
    source https://putanclub.org/tour.html)
  - TOTO, Cork: stored 2027-06-16, should be 06-17
    (event `1eca6f95ca8a41ab7acb65d28f84bb0dd42d2468d883afdea6ea8d4d121bcd84`;
    source https://totoofficial.com/events/)
- [x] **2. How to treat an announced date that is a range.** _Done and deployed: a range is `start_time` plus `end_time`; extraction keeps the span, the page and digest show it, a draft inside a stored range updates it in place, ranges never conflict. ESNS and the Blink-182 festivals become ranges when the crawler next visits their pages._ Festival appearances
      (Interrupters at Southside / Hurricane, Blink-182 at Rock im Park / Rock am
      Ring, Pigeon at ESNS) have no exact date yet; we store the range start.
      Decide: how to represent it, how it interacts with the same-band/same-date
      rules (`matchShow` rule 3, worker `findSameActSameDay`), and when the real
      date arrives (update in place, not a new event).
- [x] **3. Duplicates and wrong entries in the data.** _Done on 2026-10-28: conflict detection, the admin Conflicts tab and the sweep are deployed; the known bad rows were resolved or deleted by hand (Putan La Pompe, TOTO Cork, Cat Power, Fatoumata Diawara, TOTO Groningen, Azkena, Fontaines D.C., Pretty Reckless, Rock im Park 06-04). Kept as valid: Interrupters (two ranges), Rock am Ring 06-04 and Rock im Park 06-06, Pigeon/ESNS (resolves when ESNS becomes a range)._ Needs the user's decision
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
- [ ] **4. The Pretty Reckless duplicate (root cause still open; the duplicate itself was deleted)** (Glasgow, 2026-12-02): events
      `91b1c6fc…` and `f899ee75…`, same key, identical coordinates and venue,
      created in the same second. The proximity check should have caught it.
      Hypothesis (unverified): a race between concurrent POSTs. If so, the new
      worker same-band/same-date check has the same race.
- [x] **5. Before deploying:** ran the suites, applied the migration, deployed the worker, pushed `main`.

## Deploy checklist (done 2026-10-28)

1. Apply migration `0009_add_conflicts.sql` to the remote DB.
2. Set `ADMIN_TELEGRAM_CHAT_ID` (and optionally `ADMIN_PAGE_URL`) on the worker.
3. Deploy the worker.
4. Deploy the crawler before the next tours run.
5. Run the tours job once and open the Conflicts tab (the 12:00 UTC run of 2026-10-28, part 2/2, was the first run of the new crawler: check its log for updated ranges, moved events, new copies, proposals).
6. Delete by hand (done) the known bad events: Putan Club La Pompe `68637010...`, TOTO Cork `1eca6f95...`, and the duplicates chosen in task 3. Then confirm the next run republishes them with the right dates and no conflict remains.

- [ ] **6. Stale events when a source changes a show's date.** Example: Rock im
      Park was stored on 06-04 (2026-10-07); a later crawl read 06-06 and published
      a second event, leaving the 06-04 one. The crawler only proposes deleting
      events that are already held in a conflict, so such leftovers stay public
      until deleted by hand. Possible follow-up: propose deleting any stored show
      of a band whose own tour page (band-mode source) no longer lists it. Not in
      the approved design; needs a decision.

## Known weaknesses of the shipped feature

- The sweep (`POST /admin/conflicts/sweep`) takes up to 200 band-days per call,
  more than the Workers free plan allows per invocation (about 50 queries /
  subrequests). A big backfill would be partial; re-running is safe. Fix idea:
  a limit around 10 plus a keyset cursor.
- If the LLM alternates between giving and omitting a festival's end date on
  different runs, the stored show flips between range and single day (one PUT
  each time) and can reopen a conflict.
- The public tours page drops a show once its start day has passed, so a
  range in progress (18-20 Jun on the 19th) disappears.
- A festival listed day by day against a stored range collapses to its first
  day for that run; it recovers on the next run.
- The Conflicts tab has not been through a full browser test beyond the
  manual check on 2026-10-28.

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

## Task 2 verification (festival span in extraction)

Prompt reworded (`shared/extractors/tour-prompt.ts`): a festival appearance with
no known day is one show, `start_time` = festival first day, `end_time` = last
day. Dry run (`npm run tours -- --bands <blink+pigeon> --debug`), first try:
ESNS Showcase Festival 2027 (Pigeon) carries `end_time` (2027-01-13 to
2027-01-16). Rock am Ring (2027-06-04) and Rock im Park (2027-06-06) from the
Blink-182 page came out WITHOUT `end_time`; the tour page is JavaScript-rendered
so it could not be checked whether it lists only the band's own day (then no
`end_time` is correct). Not iterated further. Not verified for those two.

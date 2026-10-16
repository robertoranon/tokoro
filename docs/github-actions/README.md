# Running radar, scout and tours on GitHub Actions

The crawler code stays in the public `tokoro` repo. Personal data lives in a
separate **private** repo (e.g. `tokoro-radar-data`) that runs the workflows.

## Private repo layout

```
festivals.yaml          # radar watchlist (copy of crawler/festivals.yaml)
bands.yaml              # tours watchlist (copy of crawler/bands.yaml)
logs/runs.jsonl         # tours run log (committed back by the workflow)
scout-sources.yaml      # scout discovery sources + taste profile
candidates.yaml         # scout output (committed back by the workflow)
scout-state.json        # scout memory (committed back by the workflow)
.github/workflows/radar.yml
.github/workflows/scout.yml
.github/workflows/tours.yml
```

Copy `radar.yml`, `scout.yml` and `tours.yml` from this folder into `.github/workflows/`.
Tours runs four times a week (Mon, Wed, Fri, Sun, 12:00 UTC): Monday and Friday
on the first half of the sources in `bands.yaml` (`--part 1/2`), Wednesday and
Sunday on the second (`--part 2/2`). A source's part comes from a hash of its
url, so adding a band never moves the others; every source is checked every
3-4 days. A manual run lets you pick a part, or `all`. Monday's tours run
starts two hours after the radar.
After each tours run (even a failed one) the workflow commits `logs/runs.jsonl`
back to the private repo, and restores it before the next run. That keeps the
staleness report working (it needs 4 runs of a source) and makes
`--retry-failed` usable: start the workflow manually with "retry_failed" ticked
to re-run only what failed in the last run.

## Setup

1. Create the private repo and push the data files from `crawler/`.
2. Settings → Secrets and variables → Actions:
   - **Secrets**: `TOKORO_API_URL`, `CRAWLER_PRIVKEY`, `CRAWLER_PUBKEY`,
     `OPENROUTER_API_KEY` (or the key for your provider); optional
     `JINA_API_KEY`, `BRAVE_SEARCH_API_KEY`.
   - **Variables**: `LLM_PROVIDER`, `OPENROUTER_MODEL`.
3. Settings → Actions → General → Workflow permissions: allow read and write
   (the scout workflow pushes its results).
4. Run each workflow once from the Actions tab (workflow_dispatch) and check
   the log before relying on the schedule.
5. Remove the radar/scout cron entries from your laptop if you had them
   (the `crawl-jobs` entry is unaffected).

## Day-to-day

- Edit `festivals.yaml` in the private repo (web editor or `git pull` locally).
- Review proposals: `git pull`, set `status` in `candidates.yaml`, then locally
  run `npm run scout-promote -- --candidates ../path/candidates.yaml
  --festivals ../path/festivals.yaml --state ../path/scout-state.json` and push.
- Scheduled runs only fire on the default branch. GitHub disables schedules in
  repos with no activity for 60 days; the scout's commits keep it alive, and
  you can re-enable manually otherwise.

## Notes

- Cron times are UTC and may be delayed by several minutes under load.
- Failed scheduled runs email the repo owner.
- Scout and radar share no files they both write, so they cannot conflict.
- Not covered: `crawl-jobs` (`jobs.yaml`). It can be added the same way.

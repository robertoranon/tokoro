# Running radar and scout on GitHub Actions

The crawler code stays in the public `tokoro` repo. Personal data lives in a
separate **private** repo (e.g. `tokoro-radar-data`) that runs the workflows.

## Private repo layout

```
festivals.yaml          # radar watchlist (copy of crawler/festivals.yaml)
scout-sources.yaml      # scout discovery sources + taste profile
candidates.yaml         # scout output (committed back by the workflow)
scout-state.json        # scout memory (committed back by the workflow)
.github/workflows/radar.yml
.github/workflows/scout.yml
```

Copy `radar.yml` and `scout.yml` from this folder into `.github/workflows/`.

## Setup

1. Create the private repo and push the four data files from `crawler/`.
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

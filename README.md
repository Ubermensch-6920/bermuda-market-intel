# bermuda-market-intel

GENESIS market-data dashboard (React + Vite) plus a scheduled Python data
pipeline. Everything refreshes and publishes from a single GitHub Actions
workflow, `.github/workflows/deploy.yml`.

## Reinsurer news monitor

Tracks recent news about the Bermuda life & annuity reinsurers on a watchlist
and publishes a standalone dashboard alongside GENESIS.

| | |
|---|---|
| Script | `scripts/news_monitor.py` |
| Watchlist | `companies.json` (repo root) |
| Outputs | `docs/reinsurer-news.html`, `docs/reinsurer-news.md`, `data/reinsurer_news.json` |
| Published at | `https://<user>.github.io/bermuda-market-intel/reinsurer-news.html` |
| Window | Items from the last 14 days (`LOOKBACK_DAYS`) |
| Times | Rendered in Atlantic/Bermuda |

Sources are public RSS only, no API keys: [Artemis.bm](https://www.artemis.bm/feed/),
[Reinsurance News](https://www.reinsurancene.ws/feed/), and one Google News
query per tracked company.

### Editing the company list

Edit `companies.json` — the monitor reloads it every run, no code change needed.

```json
{"name": "Athene", "aliases": ["Athene Holding", "Athene Annuity"]}
```

`name` is the heading on the dashboard. `aliases` are extra phrases that also
count as a match. Matching is case-insensitive and **whole-phrase**, so
"Athene" will not match "Athens" and "Monument Re" will not match "Monumental".
Each company adds one Google News request per run, so the run gets slower
roughly linearly — worth watching past ~30 companies against the workflow's
`timeout-minutes: 12`.

### Running locally

```bash
pip install -r requirements.txt
python scripts/news_monitor.py              # live run: fetches feeds, writes all three outputs
python scripts/news_monitor.py --selftest   # offline: matching/dedupe/render checks, no network
python scripts/news_monitor.py --render-only # re-render from cached JSON, no network
```

Open `docs/reinsurer-news.html` in a browser — it is fully self-contained
(inline CSS, no scripts, no CDN or webfont requests), so it works offline and
from the filesystem.

### Changing the schedule

The monitor runs as a step in the normal refresh, so it follows that
workflow's `cron` in `.github/workflows/deploy.yml`:

```yaml
on:
  schedule:
    - cron: '15 */3 * * *'   # every 3 hours
```

Cron is **UTC** — Bermuda is UTC−3 (ADT) or UTC−4 (AST), so a 6am Bermuda run
is `0 9 * * *` in summer. To run the news monitor less often than the rest of
the pipeline, gate just its step rather than adding a second workflow:

```yaml
      - name: Refresh reinsurer news monitor
        if: github.event_name == 'workflow_dispatch' || github.event.schedule == '15 6 * * 1'
        run: python scripts/news_monitor.py
```

`workflow_dispatch` is already enabled, so you can trigger a run by hand from
the repo's **Actions** tab at any time.

### Feed reliability

Artemis.bm and reinsurancene.ws sit behind Cloudflare and intermittently
return 403 to GitHub Actions runner IPs. This is expected and handled:

- Any feed may fail. The failure is logged, recorded in `data/source_health.json`,
  and shown as a red ✗ row on the dashboard. The run continues.
- The per-company Google News leg is the resilience layer — it is already
  proven reachable from this repo's CI.
- If every feed fails, the page re-renders from the previous run's JSON, so it
  goes stale rather than empty.

### Publishing

GitHub Pages is already set to **Source: GitHub Actions** and serves the Vite
build. **Do not change that setting** — switching to "Deploy from a branch"
would disable the Actions deployment and take GENESIS offline. The workflow
copies `docs/reinsurer-news.html` into the build, so it publishes automatically
with no Pages configuration change.

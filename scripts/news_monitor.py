#!/usr/bin/env python3
"""Track recent news about the Bermuda life & annuity reinsurers on a watchlist.

This is a job-search tool, not a market-data feed: it answers "what happened at
the companies I'm tracking in the last two weeks", grouped by company, and
renders a standalone page I can open or read on my phone.

Watchlist lives in companies.json at the repo root so it can be edited without
touching this file. Matching is whole-phrase and case-insensitive, so "Athene"
does not match "Athens" and "Monument Re" does not match "Monumental".

Sources are public RSS only, no API keys:

  - artemis.bm and reinsurancene.ws, the two trade feeds worth reading directly
  - one Google News query per tracked company

The direct trade feeds sit behind Cloudflare and intermittently 403 GitHub
Actions runner IPs. That is expected, not a bug -- the Google News leg is the
resilience layer (it is already proven reachable from this repo's CI, see
"Google News (market)" in data/source_health.json). Any feed may fail: it is
logged, recorded in source health, shown as a failure on the page, and the run
continues. If everything fails we re-render from the previous run's JSON, so
the dashboard goes stale rather than empty.

Writes three files:

  data/reinsurer_news.json    matched items (also lets the GENESIS React app
                              pick this up as a panel later)
  docs/reinsurer-news.html    self-contained dashboard, no external requests
  docs/reinsurer-news.md      same digest in markdown

Run:                      python scripts/news_monitor.py
Offline (no network):     python scripts/news_monitor.py --selftest
"""
import argparse
import hashlib
import html as html_mod
import json
import logging
import re
import sys
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).parent))
from fetchlib import (  # noqa: E402
    DATA, log, record_source, flush_source_health,
    fetch_feed, resolve_many,
)

logging.basicConfig(level=logging.INFO, format="%(message)s")

ROOT = Path(__file__).parent.parent
COMPANIES_FILE = ROOT / "companies.json"
DOCS = ROOT / "docs"
JSON_FILE = DATA / "reinsurer_news.json"
HTML_FILE = DOCS / "reinsurer-news.html"
MD_FILE = DOCS / "reinsurer-news.md"

# Only items published in this window are shown. Items already on file age out
# of the page but stay in the JSON until they fall outside KEEP_DAYS, which
# gives the dashboard something to show when every feed is blocked.
LOOKBACK_DAYS = 14
KEEP_DAYS = 45
MAX_PER_COMPANY = 12

BERMUDA = ZoneInfo("Atlantic/Bermuda")

GOOGLE_NEWS = "https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"

# Direct trade-press feeds. Keyed by display name -> URL.
TRADE_FEEDS = {
    "Artemis.bm": "https://www.artemis.bm/feed/",
    "Reinsurance News": "https://www.reinsurancene.ws/feed/",
}

# Tracking/campaign params that differ between syndications of the same story.
TRACKING_PARAMS = ("utm_", "fbclid", "gclid", "mc_cid", "mc_eid", "ito", "ncid")


def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(raw):
    if not raw:
        return None
    try:
        return datetime.strptime(raw[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _item_id(*parts):
    return hashlib.sha1("|".join(p for p in parts if p).encode("utf-8")).hexdigest()[:12]


def _bermuda(dt):
    """Render a UTC datetime in Atlantic/Bermuda time (the whole point of the
    timezone requirement -- headlines should read in local time, not UTC)."""
    return dt.astimezone(BERMUDA)


# ── Watchlist ───────────────────────────────────────────────────────────────

def load_companies():
    """Load companies.json -> [{name, aliases, patterns}].

    Falls back to an empty list rather than raising: a malformed edit to the
    watchlist should show up as "0 companies" in the log, not a failed run.
    """
    try:
        raw = json.loads(COMPANIES_FILE.read_text())
    except Exception as e:
        log.error(f"  companies.json unreadable ({e}); nothing to track")
        return []

    out = []
    for entry in raw.get("companies", []):
        name = (entry.get("name") or "").strip()
        if not name:
            continue
        aliases = [a.strip() for a in entry.get("aliases", []) if a and a.strip()]
        phrases = [name] + aliases
        # Whole-phrase, case-insensitive. \b on both ends stops "Athene"
        # matching "Athens"; \s+ between words tolerates line breaks in
        # summaries. Phrases are escaped, so "Apollo/Athene" is safe.
        patterns = [
            re.compile(r"\b" + r"\s+".join(re.escape(w) for w in p.split()) + r"\b", re.I)
            for p in phrases
        ]
        out.append({"name": name, "aliases": aliases, "patterns": patterns})
    return out


def match_companies(text, companies):
    """Return the names of every tracked company mentioned in text."""
    hits = []
    for c in companies:
        if any(p.search(text) for p in c["patterns"]):
            hits.append(c["name"])
    return hits


# ── Link handling ───────────────────────────────────────────────────────────

def clean_link(link):
    """The URL we store and display: tracking params stripped, otherwise intact.

    normalize_link() below goes further (drops scheme/www) to build a
    comparison key; that form is not a working URL, so it is never stored.
    """
    if not link:
        return ""
    try:
        p = urllib.parse.urlsplit(link)
        q = [(k, v) for k, v in urllib.parse.parse_qsl(p.query)
             if not any(k.lower().startswith(t) for t in TRACKING_PARAMS)]
        return urllib.parse.urlunsplit((p.scheme, p.netloc, p.path,
                                        urllib.parse.urlencode(q), ""))
    except Exception:
        return link


def normalize_link(link):
    """Canonical form of a URL for de-duplication.

    The same story reaches us as an artemis.bm link and as a Google News
    redirect that resolves to the same URL with campaign params attached, so
    strip tracking params, the fragment, a trailing slash and www/scheme
    differences before comparing.
    """
    if not link:
        return ""
    try:
        p = urllib.parse.urlsplit(link)
        q = [(k, v) for k, v in urllib.parse.parse_qsl(p.query)
             if not any(k.lower().startswith(t) for t in TRACKING_PARAMS)]
        netloc = p.netloc.lower()
        if netloc.startswith("www."):
            netloc = netloc[4:]
        path = p.path.rstrip("/") or "/"
        return urllib.parse.urlunsplit(("", netloc, path, urllib.parse.urlencode(q), ""))
    except Exception:
        return link.strip().lower()


def _title_key(title):
    """Loose key for catching the same headline reworded across syndications."""
    words = re.findall(r"[a-z0-9]+", (title or "").lower())
    return " ".join(words[:8])


# ── Fetching ────────────────────────────────────────────────────────────────

def _google_query(company):
    return GOOGLE_NEWS.format(
        q=urllib.parse.quote(f'"{company}" (reinsurance OR annuity OR insurer) when:{LOOKBACK_DAYS}d')
    )


def gather_feeds(companies, workers=8):
    """Fetch every feed concurrently. Returns (raw_items, feed_status).

    feed_status is [{name, ok, count, error}] and drives both the on-page
    status block and the source-health records. Nothing raises out of here:
    a feed that fails is a row with ok=False, and the run continues.
    """
    jobs = [(name, url, None) for name, url in TRADE_FEEDS.items()]
    for c in companies:
        jobs.append((f"Google News: {c['name']}", _google_query(c["name"]), c["name"]))

    raw_items, status = [], []

    def run(job):
        name, url, _scope = job
        try:
            return name, fetch_feed(url), None
        except Exception as e:
            return name, None, f"{type(e).__name__}: {e}"

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(run, j): j for j in jobs}
        for fut in as_completed(futures):
            name, items, err = fut.result()
            if err is not None:
                log.warning(f"  {name}: FAILED ({err})")
                status.append({"name": name, "ok": False, "count": 0, "error": err})
                continue
            log.info(f"  {name}: {len(items)} items")
            status.append({"name": name, "ok": True, "count": len(items), "error": None})
            for it in items:
                it["feed"] = name
                raw_items.append(it)

    status.sort(key=lambda s: s["name"])
    return raw_items, status


def build_items(raw_items, companies):
    """Filter to the lookback window, match against the watchlist, de-dupe."""
    cutoff = _now() - timedelta(days=LOOKBACK_DAYS)
    candidates = []
    for it in raw_items:
        dt = it.get("date")
        if not dt or dt < cutoff:
            continue
        hits = match_companies(f"{it.get('title', '')} {it.get('summary', '')}", companies)
        if hits:
            candidates.append((it, hits))

    # Resolve Google News redirects before de-duping: the same article arrives
    # as a google redirect from one feed and a direct URL from another, and
    # only the resolved form makes them compare equal.
    resolved = resolve_many([it["link"] for it, _ in candidates if "news.google.com" in it["link"]])

    by_link, by_title = {}, {}
    out = []
    for it, hits in candidates:
        link = clean_link(resolved.get(it["link"], it["link"]))
        lkey = normalize_link(link)
        tkey = _title_key(it["title"])
        seen = by_link.get(lkey) or by_title.get(tkey)
        if seen is not None:
            # Merge company hits and keep the non-Google link if we now have one.
            for h in hits:
                if h not in seen["companies"]:
                    seen["companies"].append(h)
            if "news.google.com" in seen["link"] and "news.google.com" not in link:
                seen["link"] = link
            continue
        rec = {
            "id": _item_id(tkey or it["title"]),
            "title": it["title"],
            "link": link,
            "source": it.get("source") or it.get("feed") or "",
            "feed": it.get("feed", ""),
            "date": _iso(it["date"]),
            "summary": it.get("summary", "")[:400],
            "companies": list(hits),
        }
        out.append(rec)
        if lkey:
            by_link[lkey] = rec
        if tkey:
            by_title[tkey] = rec
    return out


def merge_with_cache(items):
    """Union this run's items with the previous run's, so a fully-blocked run
    still renders. Fresh copies win; anything older than KEEP_DAYS is dropped."""
    prev = []
    try:
        prev = json.loads(JSON_FILE.read_text()).get("items", [])
    except Exception:
        pass

    by_id = {it["id"]: it for it in prev if it.get("id")}
    for it in items:
        by_id[it["id"]] = it

    cutoff = _now() - timedelta(days=KEEP_DAYS)
    merged = [it for it in by_id.values()
              if (_parse_iso(it.get("date")) or _now()) >= cutoff]
    merged.sort(key=lambda it: (it.get("date") or "", it.get("title", "")), reverse=True)
    return merged


def group_by_company(items, companies):
    """[(company_name, [items])] in watchlist order, companies with news first."""
    order = [c["name"] for c in companies]
    cutoff = _now() - timedelta(days=LOOKBACK_DAYS)
    groups = {name: [] for name in order}
    for it in items:
        dt = _parse_iso(it.get("date"))
        if not dt or dt < cutoff:
            continue  # page shows the window; JSON keeps the longer tail
        for name in it.get("companies", []):
            if name in groups and len(groups[name]) < MAX_PER_COMPANY:
                groups[name].append(it)
    for name in groups:
        groups[name].sort(key=lambda it: it.get("date") or "", reverse=True)
    with_news = [(n, groups[n]) for n in order if groups[n]]
    without = [(n, []) for n in order if not groups[n]]
    return with_news + without


# ── Rendering ───────────────────────────────────────────────────────────────

def _esc(s):
    return html_mod.escape(s or "", quote=True)


CSS = """
:root { color-scheme: dark; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #080a0f; color: #e2e8f0; line-height: 1.5;
       font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                    "Helvetica Neue", Arial, sans-serif;
       padding: 32px 20px 64px; }
.wrap { max-width: 860px; margin: 0 auto; }
h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; color: #f8fafc; }
.sub { color: #64748b; font-size: 13px; margin-top: 6px; }
.meta { border-bottom: 1px solid #1e2028; padding-bottom: 20px; margin-bottom: 8px; }
.feeds { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
.feed { font-size: 11px; padding: 3px 9px; border-radius: 999px;
        border: 1px solid #1e2028; background: #0d1017; color: #94a3b8;
        white-space: nowrap; }
.feed.ok { border-color: #14532d; color: #4ade80; }
.feed.bad { border-color: #4c1d24; color: #f87171; }
.warn { margin-top: 14px; padding: 10px 12px; border-radius: 6px; font-size: 12px;
        background: #1a1207; border: 1px solid #45320f; color: #fbbf24; }
.co { margin-top: 32px; }
.co h2 { font-size: 15px; font-weight: 600; color: #f1f5f9;
         display: flex; align-items: baseline; gap: 9px; }
.count { font-size: 11px; font-weight: 500; color: #64748b; }
.co ul { list-style: none; margin-top: 10px; }
.co li { padding: 11px 0; border-bottom: 1px solid #13161d; }
.co li:last-child { border-bottom: 0; }
.hl { display: block; color: #cbd5e1; text-decoration: none; font-size: 14px;
      font-weight: 500; }
.hl:hover { color: #7dd3fc; text-decoration: underline; }
.line { margin-top: 4px; font-size: 11px; color: #64748b; }
.dot { color: #334155; margin: 0 5px; }
.sum { margin-top: 5px; font-size: 12.5px; color: #94a3b8; }
.tag { font-size: 10px; color: #475569; border: 1px solid #1e2028;
       border-radius: 3px; padding: 1px 5px; margin-left: 5px; }
.quiet { margin-top: 28px; padding-top: 18px; border-top: 1px solid #1e2028;
         font-size: 12px; color: #475569; }
.quiet strong { color: #64748b; font-weight: 500; }
.empty { margin-top: 28px; padding: 18px; border: 1px dashed #1e2028;
         border-radius: 6px; color: #64748b; font-size: 13px; }
footer { margin-top: 44px; padding-top: 16px; border-top: 1px solid #1e2028;
         font-size: 11px; color: #3f4b5b; }
@media (max-width: 600px) { body { padding: 20px 14px 48px; } h1 { font-size: 19px; } }
"""


def summarize_status(status):
    """Collapse the per-company Google News legs into one row for display.

    One chip per company would be 16+ near-identical chips; the useful signal
    is "Google News worked, and these specific ones didn't". Failures stay
    itemised, successes become a single row with a count.
    """
    trade = [s for s in status if not s["name"].startswith("Google News: ")]
    gnews = [s for s in status if s["name"].startswith("Google News: ")]
    rows = list(trade)
    if gnews:
        ok = [s for s in gnews if s["ok"]]
        bad = [s for s in gnews if not s["ok"]]
        if ok:
            rows.append({
                "name": f"Google News ({len(ok)} of {len(gnews)} companies)",
                "ok": True,
                "count": sum(s["count"] for s in ok),
                "error": None,
            })
        rows.extend(bad)
    rows.sort(key=lambda r: (not r["ok"], r["name"]))
    return rows


def render_html(grouped, status, generated, total):
    """Self-contained dashboard: inline CSS, no external fonts, scripts or CDN."""
    status = summarize_status(status)
    ok_feeds = [s for s in status if s["ok"]]
    bad_feeds = [s for s in status if not s["ok"]]
    stamp = _bermuda(generated).strftime("%a %d %b %Y, %H:%M %Z")

    p = []
    p.append("<!DOCTYPE html>")
    p.append('<html lang="en"><head><meta charset="utf-8">')
    p.append('<meta name="viewport" content="width=device-width, initial-scale=1">')
    p.append("<title>Reinsurer News Monitor</title>")
    p.append(f"<style>{CSS}</style>")
    p.append("</head><body><div class=\"wrap\">")

    p.append('<div class="meta">')
    p.append("<h1>Reinsurer News Monitor</h1>")
    p.append(f'<div class="sub">Bermuda life &amp; annuity watchlist &middot; '
             f'last {LOOKBACK_DAYS} days &middot; {total} '
             f'{"item" if total == 1 else "items"} &middot; generated {_esc(stamp)}</div>')

    p.append('<div class="feeds">')
    for s in status:
        cls = "ok" if s["ok"] else "bad"
        mark = "&#10003;" if s["ok"] else "&#10007;"
        label = f'{mark} {_esc(s["name"])}'
        if s["ok"]:
            label += f' <span style="opacity:.6">{s["count"]}</span>'
        p.append(f'<span class="feed {cls}" title="{_esc(s["error"] or "")}">{label}</span>')
    p.append("</div>")

    if bad_feeds:
        names = ", ".join(_esc(s["name"]) for s in bad_feeds)
        p.append(f'<div class="warn"><strong>{len(bad_feeds)} of {len(status)} feeds '
                 f'unavailable this run:</strong> {names}. '
                 f'Items below may be incomplete; previously-collected items are still shown.</div>')
    if not status:
        p.append('<div class="warn">Awaiting the first scheduled run &mdash; '
                 'this page fills in once the workflow fetches the feeds.</div>')
    elif not ok_feeds:
        p.append('<div class="warn"><strong>Every feed failed this run.</strong> '
                 'Showing the last successfully collected results.</div>')
    p.append("</div>")

    any_news = any(items for _, items in grouped)
    if not any_news:
        msg = ("Nothing collected yet." if not status else
               f"No tracked company was mentioned in the last {LOOKBACK_DAYS} days.")
        p.append(f'<div class="empty">{msg}</div>')

    for name, items in grouped:
        if not items:
            continue
        p.append('<div class="co">')
        p.append(f'<h2>{_esc(name)}<span class="count">{len(items)} '
                 f'{"item" if len(items) == 1 else "items"}</span></h2><ul>')
        for it in items:
            dt = _parse_iso(it.get("date"))
            when = _bermuda(dt).strftime("%a %d %b") if dt else "undated"
            p.append("<li>")
            p.append(f'<a class="hl" href="{_esc(it["link"])}" target="_blank" '
                     f'rel="noopener noreferrer">{_esc(it["title"])}</a>')
            p.append(f'<div class="line">{_esc(when)}')
            if it.get("source"):
                p.append(f'<span class="dot">&middot;</span>{_esc(it["source"])}')
            others = [c for c in it.get("companies", []) if c != name]
            for o in others:
                p.append(f'<span class="tag">{_esc(o)}</span>')
            p.append("</div>")
            if it.get("summary"):
                p.append(f'<div class="sum">{_esc(it["summary"])}</div>')
            p.append("</li>")
        p.append("</ul></div>")

    quiet = [name for name, items in grouped if not items]
    if quiet and any_news:
        p.append(f'<div class="quiet"><strong>No news in the window:</strong> '
                 f'{_esc(", ".join(quiet))}</div>')

    p.append('<footer>Public RSS only &middot; times in Atlantic/Bermuda &middot; '
             'regenerated by scripts/news_monitor.py</footer>')
    p.append("</div></body></html>")
    return "\n".join(p) + "\n"


def render_markdown(grouped, status, generated, total):
    status = summarize_status(status)
    stamp = _bermuda(generated).strftime("%a %d %b %Y, %H:%M %Z")
    out = ["# Reinsurer News Monitor", ""]
    out.append(f"Bermuda life & annuity watchlist — last {LOOKBACK_DAYS} days — "
               f"{total} {'item' if total == 1 else 'items'}")
    out.append(f"Generated {stamp}")
    out.append("")
    out.append("## Feed status")
    out.append("")
    if not status:
        out.append("_Awaiting the first scheduled run._")
    for s in status:
        if s["ok"]:
            out.append(f"- ✅ **{s['name']}** — {s['count']} "
                       f"{'item' if s['count'] == 1 else 'items'}")
        else:
            out.append(f"- ❌ **{s['name']}** — failed: {s['error']}")
    out.append("")

    if not any(items for _, items in grouped):
        out.append("_Nothing collected yet._" if not status else
                   f"_No tracked company was mentioned in the last {LOOKBACK_DAYS} days._")
        out.append("")

    for name, items in grouped:
        if not items:
            continue
        out.append(f"## {name}")
        out.append("")
        for it in items:
            dt = _parse_iso(it.get("date"))
            when = _bermuda(dt).strftime("%Y-%m-%d") if dt else "undated"
            src = f" — {it['source']}" if it.get("source") else ""
            out.append(f"- **{when}**{src} — [{it['title']}]({it['link']})")
            if it.get("summary"):
                out.append(f"  - {it['summary']}")
        out.append("")

    quiet = [name for name, items in grouped if not items]
    if quiet:
        out.append(f"_No news in the window: {', '.join(quiet)}_")
        out.append("")
    out.append("---")
    out.append("")
    out.append("Public RSS only. Times in Atlantic/Bermuda. "
               "Regenerated by `scripts/news_monitor.py`.")
    return "\n".join(out) + "\n"


def write_outputs(items, grouped, status, generated):
    DOCS.mkdir(exist_ok=True)
    total = sum(len(i) for _, i in grouped)

    JSON_FILE.write_text(json.dumps({
        "updated": _iso(generated),
        "lookback_days": LOOKBACK_DAYS,
        "feeds": status,
        "items": items,
    }, indent=2))
    log.info(f"  wrote {len(items)} items -> {JSON_FILE.name}")

    HTML_FILE.write_text(render_html(grouped, status, generated, total))
    log.info(f"  wrote dashboard -> docs/{HTML_FILE.name}")

    MD_FILE.write_text(render_markdown(grouped, status, generated, total))
    log.info(f"  wrote digest -> docs/{MD_FILE.name}")


# ── Entry point ─────────────────────────────────────────────────────────────

def selftest():
    """Offline checks: matching precision, link normalisation, rendering.

    Deliberately touches no network so the page layout can be iterated on
    (and so CI/local runs can prove the logic without depending on feeds).
    """
    companies = load_companies()
    assert companies, "companies.json produced no companies"
    names = {c["name"] for c in companies}

    # Whole-phrase matching: the substring traps must not fire.
    assert match_companies("Athene closes funding agreement", companies) == ["Athene"]
    assert "Athene" not in match_companies("Flights to Athens are delayed", companies)
    assert "Athene" not in match_companies("The Atheneum reading room", companies)
    assert "RGA" not in match_companies("The organisation restructured", companies)
    if "Monument Re" in names:
        assert "Monument Re" not in match_companies("Monumental shift in rates", companies)
    assert match_companies("Wilton  Re completes a block deal", companies) == ["Wilton Re"]
    multi = match_companies("Athene and Wilton Re agree terms", companies)
    assert set(multi) == {"Athene", "Wilton Re"}, multi

    # Link normalisation collapses syndications of one story.
    a = normalize_link("https://www.artemis.bm/news/deal/?utm_source=rss&utm_medium=feed")
    b = normalize_link("http://artemis.bm/news/deal#section")
    assert a == b, (a, b)
    assert normalize_link("https://x.com/a?id=7") != normalize_link("https://x.com/a?id=8")
    # clean_link keeps a usable URL but drops campaign noise.
    assert clean_link("https://www.artemis.bm/n/?utm_source=rss&id=4") == \
        "https://www.artemis.bm/n/?id=4"

    # Per-company Google News legs collapse to one row; failures stay itemised.
    collapsed = summarize_status([
        {"name": "Artemis.bm", "ok": True, "count": 3, "error": None},
        {"name": "Google News: Athene", "ok": True, "count": 2, "error": None},
        {"name": "Google News: RGA", "ok": True, "count": 0, "error": None},
        {"name": "Google News: Wilton Re", "ok": False, "count": 0, "error": "403"},
    ])
    assert len(collapsed) == 3, collapsed
    assert any(r["name"].startswith("Google News (2 of 3") for r in collapsed), collapsed
    assert collapsed[-1]["name"] == "Google News: Wilton Re" and not collapsed[-1]["ok"]

    # De-dupe across feeds, and the lookback filter.
    now = _now()
    raw = [
        {"title": "Athene closes $2B deal", "link": "https://news.google.com/rss/articles/XYZ",
         "source": "Reuters", "date": now - timedelta(days=1), "summary": "A deal.", "feed": "Google News: Athene"},
        {"title": "Athene closes $2B deal", "link": "https://www.reuters.com/athene?utm_source=rss",
         "source": "Reuters", "date": now - timedelta(days=1), "summary": "A deal.", "feed": "Artemis.bm"},
        {"title": "Wilton Re buys a block", "link": "https://www.artemis.bm/wilton",
         "source": "Artemis", "date": now - timedelta(days=3), "summary": "", "feed": "Artemis.bm"},
        {"title": "Athene ancient history", "link": "https://old.example/x",
         "source": "X", "date": now - timedelta(days=90), "summary": "", "feed": "Artemis.bm"},
        {"title": "Unrelated cat bond news", "link": "https://www.artemis.bm/cat",
         "source": "Artemis", "date": now - timedelta(days=2), "summary": "", "feed": "Artemis.bm"},
    ]
    items = build_items(raw, companies)
    titles = sorted(it["title"] for it in items)
    assert titles == ["Athene closes $2B deal", "Wilton Re buys a block"], titles

    status = [
        {"name": "Artemis.bm", "ok": True, "count": 20, "error": None},
        {"name": "Reinsurance News", "ok": False, "count": 0, "error": "HTTPError: 403"},
    ]
    grouped = group_by_company(items, companies)
    page = render_html(grouped, status, now, len(items))
    assert "<!DOCTYPE html>" in page and "</html>" in page
    # Self-contained: no external requests of any kind.
    for bad in ("http://", "src=", "cdn.", "fonts.googleapis", "<script"):
        assert bad not in page.replace('href="https://', "href=\"OK"), f"external ref: {bad}"
    assert "Reinsurance News" in page and "403" in page, "failed feed not surfaced"
    md = render_markdown(grouped, status, now, len(items))
    assert "## Athene" in md and "❌" in md

    log.info("selftest: OK (matching, dedupe, lookback, render, feed-failure surfacing)")
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--selftest", action="store_true",
                    help="run offline logic/render tests, no network")
    ap.add_argument("--render-only", action="store_true",
                    help="re-render HTML/markdown from data/reinsurer_news.json, no network")
    args = ap.parse_args()

    if args.selftest:
        selftest()
        return

    log.info("=== news_monitor ===")
    generated = _now()
    companies = load_companies()
    if not companies:
        log.error("  no companies to track; nothing to do")
        return
    log.info(f"  tracking {len(companies)} companies")

    if args.render_only:
        cached = json.loads(JSON_FILE.read_text())
        items, status = cached.get("items", []), cached.get("feeds", [])
    else:
        raw, status = gather_feeds(companies)
        fresh = build_items(raw, companies)
        items = merge_with_cache(fresh)
        log.info(f"  {len(fresh)} matched this run, {len(items)} in window+cache")

        # Record one row per trade feed plus a single aggregate for the
        # Google News legs -- 16 per-company rows would swamp the shared
        # source-health panel that every other fetcher writes into.
        for s in summarize_status(status):
            record_source(
                s["name"] if not s["name"].startswith("Google News")
                else "Google News (reinsurers)",
                feeds="Bermuda reinsurer news monitor",
                ok=s["ok"],
                fallback=None if s["ok"] else "own_history",
                note=f"{s['count']} items" if s["ok"] else s["error"],
            )

    grouped = group_by_company(items, companies)
    write_outputs(items, grouped, status, generated)

    ok = sum(1 for s in status if s["ok"])
    log.info(f"done ({ok}/{len(status)} feeds ok, "
             f"{sum(len(i) for _, i in grouped)} items on page)")

    if not args.render_only:
        try:
            flush_source_health()
        except Exception as e:
            log.warning(f"source health flush failed: {e}")


if __name__ == "__main__":
    main()

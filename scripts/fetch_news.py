#!/usr/bin/env python3
"""Fetch live market news and insurance-regulator publications.

Kept separate from fetch_all.py so that module stays focused on market data
and does not keep growing. Writes two small JSON files the dashboard reads:

  data/news.json        -> curated-topic market / insurance news feed
  data/regulatory.json  -> NAIC / BMA / Cayman (CIMA) regulatory updates

Sources are public RSS (Google News RSS, which needs no API key and is
reachable from CI runners) plus best-effort direct regulator pages. Everything
degrades gracefully: if a feed is unreachable we keep the previously-saved
items and simply refresh whenever the feeds are reachable again. There is no
curated fallback: an empty feed shows as unavailable, never as made-up items.

Run:  python scripts/fetch_news.py
"""
import hashlib
import json
import logging
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Reuse the shared pipeline helpers (HTTP headers, logging, data dir, health,
# and the generic RSS parsing/link-resolution that news_monitor.py shares).
sys.path.insert(0, str(Path(__file__).parent))
from fetchlib import (  # noqa: E402
    DATA, log, record_source, flush_source_health,
    fetch_feed, parse_feed_date, resolve_many, strip_html,
)

# Module-local aliases keep the rest of this file reading as it always has.
_strip_html = strip_html
_parse_date = parse_feed_date
_resolve_many = resolve_many

logging.basicConfig(level=logging.INFO, format="%(message)s")

NEWS_FILE = DATA / "news.json"
REG_FILE = DATA / "regulatory.json"

# How many items to keep per feed/category, and how recent counts as "new".
MAX_NEWS = 30
MAX_REG = 25
NEW_WITHIN_DAYS = 7  # feeds look back 60-90 days; "new" should mean this week
GOOGLE_NEWS = "https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"


# ── News topics (general market + insurance asset-management coverage) ──
NEWS_TOPICS = {
    "Rates & Macro": "central bank interest rates OR government bond yields when:14d",
    "Private Credit": "private credit insurance OR direct lending insurer when:21d",
    "Structured Credit": "structured credit CLO OR ABS insurer when:21d",
    "Insurance AM": "insurance asset management OR reinsurance investment when:21d",
}

# ── Insurance regulators: NAIC, BMA, Cayman (CIMA) ──
# Each maps to a Google News query that biases toward publications, notices,
# consultations and presentations from that authority.
REGULATORS = {
    "naic": {
        "label": "NAIC",
        "query": ('"NAIC" (publication OR proposal OR adopts OR exposure OR '
                  'meeting OR presentation OR framework) insurance when:60d'),
    },
    "bma": {
        "label": "BMA",
        "query": ('"Bermuda Monetary Authority" (notice OR consultation OR '
                  'guidance OR rules OR discussion paper OR publication) when:90d'),
    },
    "cayman": {
        "label": "Cayman",
        "query": ('"Cayman Islands Monetary Authority" OR CIMA (notice OR rule OR '
                  'statement OR guidance OR consultation OR publication) insurance '
                  '-Cameroon -Afrique -Africa -CEMAC when:90d'),
    },
}

# Google News matches loosely (an article that mentions a regulator anywhere
# in its body qualifies), so each regulator's items must also clear a
# relevance check on title + summary, or come from a local outlet.
REG_RELEVANCE = {
    "naic": ("naic", "national association of insurance commissioners", "insurance regulator",
             "insurance commissioner", "insurance watchdog"),
    "bma": ("bma", "bermuda"),
    "cayman": ("cayman", "cima"),
}
REG_LOCAL_SOURCES = {"naic": (), "bma": ("bernews", "royal gazette", "bermuda"), "cayman": ("cayman",)}
# "CIMA" is also the Conférence Interafricaine des Marchés d'Assurances, the
# insurance regulator for 14 African states; its news flooded the Cayman feed.
AFRICAN_CIMA_MARKERS = ("cameroon", "cameroun", "africa", "afrique", "afrik", "cemac", "interafricaine",
                        "inter-african", "senegal", "sénégal", "ivoire", "ivorian", "ivory coast", "gabon",
                        "libreville", "benin", "bénin", "togo", "burkina", "niger", "tchad", "congo",
                        "cfaf", "capmad")


def reg_relevant(key, item):
    text = f"{item.get('title', '')} {item.get('summary', '')}".lower()
    src = (item.get("source") or "").lower()
    if key == "cayman" and "cayman" not in f"{text} {src}" and any(m in f"{text} {src}" for m in AFRICAN_CIMA_MARKERS):
        return False
    return any(w in text for w in REG_RELEVANCE.get(key, ())) or any(w in src for w in REG_LOCAL_SOURCES.get(key, ()))

# Keyword -> category for regulatory items (best-effort classification).
CAT_RULES = [
    ("Capital/Solvency", ("solvency", "bscr", "capital", "scr", "mcr", "stress")),
    ("Investment", ("invest", "asset", "prudent person", "credit", "portfolio")),
    ("Governance", ("governance", "ai ", "conduct", "board", "burden", "risk management")),
    ("Licensing", ("licens", "registration", "authoris", "authoriz", "approval")),
    ("Reporting", ("reporting", "disclosure", "filing", "return", "form")),
]


def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _item_id(*parts):
    return hashlib.sha1("|".join(p for p in parts if p).encode("utf-8")).hexdigest()[:12]


def fetch_rss(query):
    """Fetch a Google News RSS search and return parsed items.

    Thin wrapper over fetchlib.fetch_feed(); the shared parser handles the
    " - Publisher" headline suffix and redundant descriptions that Google
    News emits. Raises on network/parse failure so callers can fall back.
    """
    return fetch_feed(GOOGLE_NEWS.format(q=urllib.parse.quote(query)))


def _categorize(text):
    low = (text or "").lower()
    for cat, kws in CAT_RULES:
        if any(k in low for k in kws):
            return cat
    return "General"


def _load_existing(path):
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def _merge(items, existing, key_field, limit):
    """Merge freshly-fetched items with previously-saved ones.

    De-dupes by id, prefers the newest dated copy, sorts newest-first and caps
    at `limit`. `existing` is the list of previously-saved dict items.
    """
    by_id = {}
    for it in existing or []:
        if it.get("id"):
            by_id[it["id"]] = it
    for it in items:
        by_id[it["id"]] = it  # fresh copy wins (richer/more recent metadata)

    def sort_key(it):
        d = it.get(key_field) or ""
        return (d, it.get("title", ""))

    merged = sorted(by_id.values(), key=sort_key, reverse=True)
    return merged[:limit]


def _mark_new(items, date_field):
    cutoff = _now() - timedelta(days=NEW_WITHIN_DAYS)
    for it in items:
        dt = _parse_date(it.get(date_field))
        it["isNew"] = bool(dt and dt >= cutoff)
    return items


def build_news():
    log.info("NEWS: fetching topic feeds")
    fetched, ok_topics = [], 0
    for topic, query in NEWS_TOPICS.items():
        try:
            raw = fetch_rss(query)
            ok_topics += 1
            kept = raw[:12]
            resolved = _resolve_many([r["link"] for r in kept])
            for r in kept:
                fetched.append({
                    # id keyed on title, not link: the same article's link can
                    # move from an unresolved Google redirect to the real
                    # publisher URL between runs, and that shouldn't mint a
                    # new id / duplicate entry.
                    "id": _item_id(r["title"], topic),
                    "title": r["title"],
                    "source": r["source"] or "News",
                    "date": _iso(r["date"]) if r["date"] else "",
                    "topic": topic,
                    "summary": r["summary"],
                    "link": resolved.get(r["link"], r["link"]),
                })
            log.info(f"  {topic}: {len(raw)} items")
        except Exception as e:
            log.warning(f"  {topic}: feed failed ({e})")

    # No curated fallback: an empty feed renders as "unavailable" rather than
    # as made-up headlines attributed to real outlets.
    existing = _load_existing(NEWS_FILE).get("items", [])

    items = _merge(fetched, existing, "date", MAX_NEWS)
    # Drop dated items older than ~90 days to keep the feed fresh.
    cutoff = _now() - timedelta(days=90)
    items = [it for it in items
             if not it.get("date") or (_parse_date(it["date"]) or _now()) >= cutoff]
    items = _mark_new(items, "date")

    topics = sorted({it["topic"] for it in items if it.get("topic")})
    out = {"updated": _iso(_now()), "topics": topics, "items": items}
    NEWS_FILE.write_text(json.dumps(out, indent=2))
    log.info(f"  wrote {len(items)} news items -> {NEWS_FILE.name}")
    record_source("Google News (market)", feeds="market & insurance news feed",
                  ok=ok_topics > 0,
                  fallback=None if ok_topics else ("own_history" if existing else "static_default"),
                  note=f"{ok_topics}/{len(NEWS_TOPICS)} topic feeds returned data")
    return ok_topics > 0


def build_regulatory():
    log.info("REGULATORY: fetching NAIC / BMA / Cayman")
    existing = _load_existing(REG_FILE)
    out = {"updated": _iso(_now())}
    any_ok = False

    for key, cfg in REGULATORS.items():
        fetched = []
        ok = False
        try:
            raw = fetch_rss(cfg["query"])
            ok = True
            any_ok = True
            kept = raw[:MAX_REG]
            resolved = _resolve_many([r["link"] for r in kept])
            for r in kept:
                fetched.append({
                    # See build_news(): id is keyed on title, not link, since
                    # the link can move from a Google redirect to the real
                    # URL between runs.
                    "id": _item_id(r["title"], key),
                    "title": r["title"],
                    "date": _iso(r["date"])[:10] if r["date"] else "",
                    "cat": _categorize(r["title"] + " " + r["summary"]),
                    "summary": r["summary"],
                    "source": r["source"] or cfg["label"],
                    "link": resolved.get(r["link"], r["link"]),
                })
            log.info(f"  {cfg['label']}: {len(raw)} items")
        except Exception as e:
            log.warning(f"  {cfg['label']}: feed failed ({e})")

        prev = existing.get(key, [])
        # Re-filter what was saved before too, so already-stored junk drops out.
        fresh = [it for it in fetched if reg_relevant(key, it)]
        if len(fresh) < len(fetched):
            log.info(f"  {cfg['label']}: dropped {len(fetched) - len(fresh)} off-topic items")
        merged = _merge(fresh, [it for it in prev if reg_relevant(key, it)], "date", MAX_REG)
        merged = _mark_new(merged, "date")
        out[key] = merged
        record_source(
            f"{cfg['label']} updates",
            feeds=f"{cfg['label']} regulatory publications",
            ok=ok,
            fallback=None if ok else ("own_history" if prev else "static_default"),
            note=f"{len(merged)} items",
        )

    REG_FILE.write_text(json.dumps(out, indent=2))
    log.info(f"  wrote regulatory updates -> {REG_FILE.name}")
    return any_ok


def main():
    log.info("=== fetch_news ===")
    news_ok = build_news()
    reg_ok = build_regulatory()
    try:
        flush_source_health()
    except Exception as e:
        log.warning(f"source health flush failed: {e}")
    log.info(f"done (news_ok={news_ok}, reg_ok={reg_ok})")


if __name__ == "__main__":
    main()

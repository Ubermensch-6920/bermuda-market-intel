#!/usr/bin/env python3
"""Fetch live market news and insurance-regulator publications.

Kept separate from fetch_all.py so that module stays focused on market data
and does not keep growing. Writes two small JSON files the dashboard reads:

  data/news.json        -> curated-topic market / insurance news feed
  data/regulatory.json  -> NAIC / BMA / Cayman (CIMA) regulatory updates

Sources are public RSS (Google News RSS, which needs no API key and is
reachable from CI runners) plus best-effort direct regulator pages. Everything
degrades gracefully: if a feed is unreachable we keep the previously-saved
items and/or a small curated seed list, so the dashboard always has something
to show and simply refreshes whenever the feeds are reachable again.

Run:  python scripts/fetch_news.py
"""
import hashlib
import html
import json
import logging
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from xml.etree import ElementTree as ET

# Reuse the shared pipeline helpers (HTTP headers, logging, data dir, health).
sys.path.insert(0, str(Path(__file__).parent))
from fetchlib import DATA, HDR, log, record_source, flush_source_health  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(message)s")

NEWS_FILE = DATA / "news.json"
REG_FILE = DATA / "regulatory.json"

# How many items to keep per feed/category, and how recent counts as "new".
MAX_NEWS = 30
MAX_REG = 25
NEW_WITHIN_DAYS = 30
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
                  'statement OR guidance OR consultation OR publication) insurance when:90d'),
    },
}

# Keyword -> category for regulatory items (best-effort classification).
CAT_RULES = [
    ("Capital/Solvency", ("solvency", "bscr", "capital", "scr", "mcr", "stress")),
    ("Investment", ("invest", "asset", "prudent person", "credit", "portfolio")),
    ("Governance", ("governance", "ai ", "conduct", "board", "burden", "risk management")),
    ("Licensing", ("licens", "registration", "authoris", "authoriz", "approval")),
    ("Reporting", ("reporting", "disclosure", "filing", "return", "form")),
]


# ── Curated seed items (offline / first-run fallback so the UI is never empty) ──
SEED_NEWS = [
    {"title": "UK gilt 10Y hits 5% for first time since 2008", "source": "CNBC",
     "date": "2026-03-20T09:30:00Z", "topic": "Rates & Macro",
     "summary": "Energy surge plus hawkish BOE push long-end gilt yields higher.", "link": ""},
    {"title": "Apollo raises $8.2B for insurance private credit", "source": "Reuters",
     "date": "2026-03-20T14:30:00Z", "topic": "Private Credit",
     "summary": "Investment-grade private placements earmarked for insurance balance sheets.", "link": ""},
    {"title": "Global reinsurer completes $1.5B structured credit deal", "source": "Insurance Insider",
     "date": "2026-03-19T16:45:00Z", "topic": "Structured Credit",
     "summary": "CLO and ABS exposure transferred to a Class E insurer.", "link": ""},
    {"title": "NAIC proposes enhanced private credit reporting", "source": "AM Best",
     "date": "2026-03-19T14:20:00Z", "topic": "Insurance AM",
     "summary": "More transparency sought on insurers' illiquid asset holdings.", "link": ""},
]

SEED_REG = {
    "naic": [
        {"title": "NAIC adopts enhanced reporting for insurer private credit",
         "date": "2026-03-19", "cat": "Reporting",
         "summary": "Expanded Schedule disclosures for illiquid and affiliated investments.",
         "link": "https://content.naic.org/"},
        {"title": "NAIC Macroprudential Working Group exposure on asset risk",
         "date": "2026-02-12", "cat": "Investment",
         "summary": "Exposure draft on concentration and structured-asset risk for life insurers.",
         "link": "https://content.naic.org/"},
    ],
    "bma": [
        {"title": "Notice – Pre-Approval for New Insurance Registrations",
         "date": "2026-03-19", "cat": "Licensing",
         "summary": "Updated Class D/E pre-approval requirements for new registrations.",
         "link": "https://www.bma.bm/"},
        {"title": "Notice – 2025 Year-End BSCR Model Republication",
         "date": "2026-02-18", "cat": "Capital/Solvency",
         "summary": "BSCR model republished with validation updates.",
         "link": "https://www.bma.bm/"},
        {"title": "Discussion Paper – AI Governance Framework",
         "date": "2026-02-09", "cat": "Governance",
         "summary": "Proposed framework for the governance of AI in regulated entities.",
         "link": "https://www.bma.bm/"},
    ],
    "cayman": [
        {"title": "CIMA – Updated Rule on Reinsurance Arrangements",
         "date": "2026-02-25", "cat": "Capital/Solvency",
         "summary": "Revised expectations for collateral and risk transfer in reinsurance.",
         "link": "https://www.cima.ky/"},
        {"title": "CIMA – Statement of Guidance on Investment Activities",
         "date": "2026-01-20", "cat": "Investment",
         "summary": "Guidance on prudent investment management for licensed insurers.",
         "link": "https://www.cima.ky/"},
    ],
}


def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _item_id(*parts):
    return hashlib.sha1("|".join(p for p in parts if p).encode("utf-8")).hexdigest()[:12]


def _strip_html(text):
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _parse_date(raw):
    """Parse an RSS pubDate into a UTC datetime, or None."""
    if not raw:
        return None
    try:
        dt = parsedate_to_datetime(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except (TypeError, ValueError):
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw[:19] if "T" in raw else raw[:10], fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _http_get_bytes(url, timeout=15):
    req = urllib.request.Request(url, headers=HDR)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fetch_rss(query):
    """Fetch a Google News RSS search and return parsed items.

    Returns list of {title, link, source, date(datetime|None), summary}.
    Raises on network/parse failure so callers can fall back.
    """
    url = GOOGLE_NEWS.format(q=urllib.parse.quote(query))
    raw = _http_get_bytes(url)
    root = ET.fromstring(raw)
    items = []
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        if not title or not link:
            continue
        pub = _parse_date(it.findtext("pubDate"))
        src_el = it.find("source")
        source = (src_el.text.strip() if src_el is not None and src_el.text else "")
        summary = _strip_html(it.findtext("description"))
        # Google News titles are "Headline - Publisher"; split out the source
        # and keep a clean headline.
        if not source and " - " in title:
            source = title.rsplit(" - ", 1)[-1].strip()
        if source and title.endswith(" - " + source):
            title = title[: -(len(source) + 3)].strip()
        # The description for Google News search is usually just the headline,
        # so only keep it as a summary when it adds information.
        if summary and summary.lower().startswith(title.lower()[:40]):
            summary = ""
        items.append({
            "title": title,
            "link": link,
            "source": source,
            "date": pub,
            "summary": summary,
        })
    return items


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
            for r in raw[:12]:
                fetched.append({
                    "id": _item_id(r["link"], r["title"]),
                    "title": r["title"],
                    "source": r["source"] or "News",
                    "date": _iso(r["date"]) if r["date"] else "",
                    "topic": topic,
                    "summary": r["summary"],
                    "link": r["link"],
                })
            log.info(f"  {topic}: {len(raw)} items")
        except Exception as e:
            log.warning(f"  {topic}: feed failed ({e})")

    existing = _load_existing(NEWS_FILE).get("items", [])
    if not fetched and not existing:
        # First run with no network: fall back to curated seed.
        fetched = [dict(s, id=_item_id(s["title"], s["topic"])) for s in SEED_NEWS]

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
            for r in raw[:MAX_REG]:
                fetched.append({
                    "id": _item_id(r["link"], r["title"]),
                    "title": r["title"],
                    "date": _iso(r["date"])[:10] if r["date"] else "",
                    "cat": _categorize(r["title"] + " " + r["summary"]),
                    "summary": r["summary"],
                    "source": r["source"] or cfg["label"],
                    "link": r["link"],
                })
            log.info(f"  {cfg['label']}: {len(raw)} items")
        except Exception as e:
            log.warning(f"  {cfg['label']}: feed failed ({e})")

        prev = existing.get(key, [])
        if not fetched and not prev:
            fetched = [dict(s, id=_item_id(s["title"], key)) for s in SEED_REG.get(key, [])]
        merged = _merge(fetched, prev, "date", MAX_REG)
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

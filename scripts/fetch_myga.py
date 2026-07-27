#!/usr/bin/env python3
"""MYGA new-money spreads over Treasuries, bucketed by AM Best rating.

Feeds the annuity in-the-money meter. The calculator needs one number — the
spread a policyholder can actually reinvest at, over the matched-maturity
Treasury — and until now that spread was a hardcoded calibration constant.
This turns it into an observed market statistic.

WHAT IS STORED, AND WHY IT IS ONLY THIS
---------------------------------------
Carrier names and individual quotes are NEVER written to disk. The output
schema has no field for them. What is stored is, per rating bucket and term:
the median and top-quartile SPREAD OVER THE MATCHED TREASURY, and a count.

That is a deliberate constraint, not an oversight. This repository deploys
publicly to GitHub Pages, so persisting a third party's compiled carrier-level
rate table would be republishing their work product. A distribution statistic
derived against a Treasury benchmark is a different thing, and it happens to
be exactly — and only — what the model consumes.

POLITENESS
----------
The pipeline runs every three hours; MYGA rates move on carrier pricing
committees, not intraday. This fetcher no-ops unless the existing file is
older than MIN_REFRESH_HOURS, and sleeps between term requests. Set
MYGA_FETCH=off to disable it entirely.

Self-test (no network):  python scripts/fetch_myga.py --selftest
"""
import argparse
import json
import logging
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from statistics import median

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetchlib import DATA, HDR, record_source, flush_source_health  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("fetch")

OUT = DATA / "myga_spreads.json"
BASE_URL = "https://www.stantheannuityman.com/myga-quote"
TERMS = [3, 5, 7, 10]
STATE = os.environ.get("MYGA_STATE", "FL").upper()
MIN_REFRESH_HOURS = 20
REQUEST_GAP_SECONDS = 3

# AM Best scale collapsed to the buckets the model actually distinguishes.
# The point of the bucketing is to price the credit-quality tradeoff the
# calculator currently only warns about in prose.
BUCKETS = [
    ("aplus", "A++ / A+", {"A++", "A+"}),
    ("a", "A", {"A"}),
    ("aminus", "A-", {"A-"}),
    ("bplus", "B++ / B+", {"B++", "B+"}),
]
BUCKET_OF = {r: key for key, _label, ratings in BUCKETS for r in ratings}
LABEL_OF = {key: label for key, label, _ in BUCKETS}

RATE_KEYS = ("effectiveyield", "effectiveannualyield", "annualyield", "yield",
             "rate", "creditedrate", "apy", "effectiverate")
RATING_KEYS = ("ambest", "ambestrating", "rating", "carrierrating", "bestrating")
TERM_KEYS = ("years", "term", "termyears", "guaranteeperiod", "duration")


# ── Treasury benchmark ────────────────────────────────────────────

def _interp(tenors, yields, target):
    """Linear interpolation across the UST curve, flat past either end.
    Mirrors interpolateCurve() in src/annuityMoneyness.js."""
    pts = []
    for t, v in zip(tenors or [], yields or []):
        m = re.match(r"^([\d.]+)\s*([MY])$", str(t).strip(), re.I)
        if not m or v is None:
            continue
        n = float(m.group(1))
        pts.append((n / 12 if m.group(2).upper() == "M" else n, float(v)))
    if not pts:
        return None
    pts.sort()
    if target <= pts[0][0]:
        return pts[0][1]
    if target >= pts[-1][0]:
        return pts[-1][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if target <= x1:
            return y0 + (y1 - y0) * (target - x0) / (x1 - x0)
    return pts[-1][1]


def load_ust():
    try:
        d = json.loads((DATA / "ust.json").read_text())
        return d.get("tenors"), d.get("yields"), d.get("date")
    except Exception as e:
        log.warning(f"  MYGA: no UST curve to spread against ({e})")
        return None, None, None


# ── Parsing ───────────────────────────────────────────────────────
# The site is almost certainly a JS app, and its internal shape is not a
# contract. Rather than bind to one selector, walk whatever JSON the page
# carries and pick out dicts that look like a quote — a rate-ish key next to
# a rating-ish key. That survives most re-skins, and when it stops working it
# returns nothing rather than something wrong.

def _norm_key(k):
    return re.sub(r"[^a-z]", "", str(k).lower())


def _to_rate(v):
    """'5.35%' | '5.35' | 5.35 → 5.35. Rejects anything outside a sane band."""
    if isinstance(v, (int, float)):
        r = float(v)
    else:
        m = re.search(r"(\d+(?:\.\d+)?)\s*%?", str(v))
        if not m:
            return None
        r = float(m.group(1))
    if r > 100:
        return None
    if r <= 0.25:          # a fraction rather than a percentage
        r *= 100
    return r if 0.5 <= r <= 20 else None


def _to_rating(v):
    """'A+ (Superior)' → 'A+'.  'AM Best A-' → 'A-'.  'n/a' → None.

    Deliberately case-sensitive, and no \\b anchors. A trailing word boundary
    can never match after '+' (both are non-word characters), which silently
    drops every modifier and collapses A++/A+/A- into a bare 'A' — the exact
    failure that would flatten the ratings ladder this whole file exists to
    measure. The lookarounds do the job \\b cannot.
    """
    s = str(v).strip()
    if re.fullmatch(r"(?i)\s*n\s*/?\s*a\s*", s):
        return None
    m = re.search(r"(?<![A-Za-z])(A\+\+|A\+|A-|A|B\+\+|B\+|B-|B)(?![A-Za-z])", s)
    return m.group(1) if m else None


def _to_term(v):
    m = re.search(r"(\d+)", str(v))
    if not m:
        return None
    n = int(m.group(1))
    return n if 1 <= n <= 20 else None


def harvest_quotes(node, default_term=None, _depth=0):
    """Recursively pull {rate, rating, term} triples out of arbitrary JSON."""
    found = []
    if _depth > 12:
        return found
    if isinstance(node, list):
        for item in node:
            found += harvest_quotes(item, default_term, _depth + 1)
        return found
    if not isinstance(node, dict):
        return found

    keys = {_norm_key(k): k for k in node}
    rate_k = next((keys[k] for k in RATE_KEYS if k in keys), None)
    rating_k = next((keys[k] for k in RATING_KEYS if k in keys), None)
    term_k = next((keys[k] for k in TERM_KEYS if k in keys), None)

    if rate_k and rating_k:
        rate = _to_rate(node[rate_k])
        rating = _to_rating(node[rating_k])
        term = _to_term(node[term_k]) if term_k else default_term
        if rate is not None and rating and term:
            found.append({"rate": rate, "rating": rating, "term": term})

    for v in node.values():
        if isinstance(v, (dict, list)):
            found += harvest_quotes(v, default_term, _depth + 1)
    return found


def extract_json_blobs(html):
    """Every JSON payload embedded in the page, in likely-usefulness order."""
    blobs = []
    for pat in (
        r'<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)</script>',
        r'<script[^>]+type="application/json"[^>]*>(.*?)</script>',
        r'window\.__INITIAL_STATE__\s*=\s*({.*?})\s*;?\s*</script>',
        r'window\.__NUXT__\s*=\s*({.*?})\s*;?\s*</script>',
    ):
        for m in re.finditer(pat, html, re.S | re.I):
            try:
                blobs.append(json.loads(m.group(1)))
            except Exception:
                pass
    return blobs


def parse_html_table(html, default_term):
    """Last resort: server-rendered rows carrying a rating and a percentage."""
    out = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S | re.I):
        text = re.sub(r"<[^>]+>", " ", row)
        rating = _to_rating(text)
        m = re.search(r"(\d+\.\d+)\s*%", text)
        if rating and m:
            rate = _to_rate(m.group(1))
            if rate is not None:
                out.append({"rate": rate, "rating": rating, "term": default_term})
    return out


def fetch_term(term, state, timeout=20):
    url = f"{BASE_URL}?state={state}&years={term}"
    req = urllib.request.Request(url, headers=HDR)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        html = r.read().decode("utf-8", errors="replace")
    quotes = []
    for blob in extract_json_blobs(html):
        quotes += harvest_quotes(blob, default_term=term)
    if not quotes:
        quotes = parse_html_table(html, default_term=term)
    # A term page can carry adjacent terms; keep only what was asked for.
    return [q for q in quotes if q["term"] == term], url


# ── Aggregation ───────────────────────────────────────────────────

def _quantile(sorted_vals, q):
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    pos = q * (len(sorted_vals) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


def aggregate(quotes, ust_tenors, ust_yields):
    """Quotes → spread distribution by rating bucket and term.

    This is the step that discards carrier identity. Everything downstream
    sees basis points over Treasuries and a sample count, nothing else.
    """
    buckets, overall, ust_used = {}, {}, {}
    by_key = {}
    for q in quotes:
        bucket = BUCKET_OF.get(q["rating"])
        if not bucket:
            continue
        ust = _interp(ust_tenors, ust_yields, q["term"])
        if ust is None:
            continue
        ust_used[q["term"]] = round(ust, 4)
        spread_bp = (q["rate"] - ust) * 100
        by_key.setdefault((bucket, q["term"]), []).append(spread_bp)
        by_key.setdefault(("__all__", q["term"]), []).append(spread_bp)

    for (bucket, term), spreads in sorted(by_key.items()):
        spreads.sort()
        entry = {
            "median_bp": round(median(spreads), 1),
            "top_quartile_bp": round(_quantile(spreads, 0.75), 1),
            "best_bp": round(spreads[-1], 1),
            "n": len(spreads),
            "ust_pct": ust_used.get(term),
        }
        if bucket == "__all__":
            overall[str(term)] = entry
        else:
            buckets.setdefault(bucket, {"label": LABEL_OF[bucket], "terms": {}})
            buckets[bucket]["terms"][str(term)] = entry
    return buckets, overall


# ── Orchestration ─────────────────────────────────────────────────

def _recent_enough():
    try:
        prev = json.loads(OUT.read_text())
        ts = datetime.strptime(prev["_fetched"][:19], "%Y-%m-%dT%H:%M:%S")
        return datetime.utcnow() - ts < timedelta(hours=MIN_REFRESH_HOURS), prev
    except Exception:
        return False, None


def write_out(obj):
    obj["_fetched"] = datetime.utcnow().isoformat() + "Z"
    OUT.write_text(json.dumps(obj, indent=2))


def fetch_myga():
    if os.environ.get("MYGA_FETCH", "on").lower() in ("off", "0", "false", "no"):
        log.info("  MYGA: disabled via MYGA_FETCH")
        record_source("Stan The Annuity Man", feeds="MYGA new-money spreads by rating",
                      ok=False, fallback="cache", note="disabled via MYGA_FETCH")
        return

    fresh, prev = _recent_enough()
    if fresh:
        log.info(f"  MYGA: cached copy is under {MIN_REFRESH_HOURS}h old, skipping fetch")
        record_source("Stan The Annuity Man", feeds="MYGA new-money spreads by rating",
                      ok=True, note=f"cached (<{MIN_REFRESH_HOURS}h); rates move weekly at most")
        return

    tenors, yields, ust_date = load_ust()
    if not tenors:
        record_source("Stan The Annuity Man", feeds="MYGA new-money spreads by rating",
                      ok=False, fallback="cache", note="no UST curve to spread against")
        raise RuntimeError("ust.json unavailable; cannot derive spreads")

    all_quotes, errors, url = [], [], None
    for i, term in enumerate(TERMS):
        try:
            quotes, url = fetch_term(term, STATE)
            log.info(f"  MYGA {STATE} {term}y: {len(quotes)} quotes parsed")
            all_quotes += quotes
        except urllib.error.HTTPError as e:
            errors.append(f"{term}y HTTP {e.code}")
            log.warning(f"  MYGA {STATE} {term}y: HTTP {e.code}")
        except Exception as e:
            errors.append(f"{term}y {e}")
            log.warning(f"  MYGA {STATE} {term}y: {e}")
        if i < len(TERMS) - 1:
            time.sleep(REQUEST_GAP_SECONDS)

    if not all_quotes:
        note = "no quotes parsed" + (f" ({'; '.join(errors[:3])})" if errors else
                                     " — page shape changed or content is client-rendered")
        log.warning(f"  MYGA: {note}; leaving previous file untouched")
        record_source("Stan The Annuity Man", feeds="MYGA new-money spreads by rating",
                      ok=False, fallback="cache" if prev else "static_default", note=note)
        if prev is None:
            write_out({
                "date": datetime.utcnow().strftime("%Y-%m-%d"),
                "state": STATE, "source": "Stan The Annuity Man — MYGA quote tool",
                "url": f"{BASE_URL}?state={STATE}&years=5",
                "status": "unavailable", "note": note,
                "buckets": {}, "overall": {},
            })
        return

    buckets, overall = aggregate(all_quotes, tenors, yields)
    write_out({
        "date": datetime.utcnow().strftime("%Y-%m-%d"),
        "state": STATE,
        "source": "Stan The Annuity Man — MYGA quote tool",
        "url": f"{BASE_URL}?state={STATE}&years=5",
        "status": "ok",
        "ust_date": ust_date,
        "terms": TERMS,
        "quote_count": len(all_quotes),
        "note": ("Derived statistics only. Spreads are each carrier's effective annual yield "
                 "less the matched-maturity Treasury, aggregated by AM Best bucket. No carrier "
                 "names or individual quotes are stored or published."),
        "buckets": buckets,
        "overall": overall,
    })
    log.info(f"  myga_spreads.json written ({len(all_quotes)} quotes, "
             f"{len(buckets)} rating buckets, state {STATE})")
    record_source("Stan The Annuity Man", feeds="MYGA new-money spreads by rating",
                  ok=True, note=f"{len(all_quotes)} quotes across {len(TERMS)} terms, state {STATE}")


# ── Self-test (no network) ────────────────────────────────────────

def selftest():
    ok = fails = 0

    def check(name, cond, got=None, want=None):
        nonlocal ok, fails
        if cond:
            ok += 1
            print(f"  ok   {name}")
        else:
            fails += 1
            print(f"  FAIL {name}\n         got  {got}\n         want {want}")

    t = ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "30Y"]
    y = [4.14, 4.33, 4.36, 4.43, 4.55, 4.69, 5.16]

    print("\ncurve interpolation (must match the JS engine)")
    check("exact node", _interp(t, y, 5) == 4.43, _interp(t, y, 5), 4.43)
    check("midpoint 6Y", abs(_interp(t, y, 6) - 4.49) < 1e-9, _interp(t, y, 6), 4.49)
    check("flat past the end", _interp(t, y, 40) == 5.16, _interp(t, y, 40), 5.16)
    check("nulls skipped", _interp(["1Y", "2Y"], [None, 4.0], 2) == 4.0, None, 4.0)

    print("\nvalue coercion")
    check("percent string", _to_rate("5.35%") == 5.35, _to_rate("5.35%"), 5.35)
    check("bare number", _to_rate(5.35) == 5.35, _to_rate(5.35), 5.35)
    check("fraction promoted", _to_rate(0.0535) == 5.35, _to_rate(0.0535), 5.35)
    check("absurd rate rejected", _to_rate(250) is None, _to_rate(250), None)
    check("zero rejected", _to_rate(0) is None, _to_rate(0), None)
    check("A+ parsed", _to_rating("A+ (Superior)") == "A+", _to_rating("A+ (Superior)"), "A+")
    check("A- not read as A", _to_rating("A-") == "A-", _to_rating("A-"), "A-")
    check("no rating", _to_rating("n/a") is None, _to_rating("n/a"), None)
    check("N/A uppercase", _to_rating("N/A") is None, _to_rating("N/A"), None)
    check("A++ not truncated", _to_rating("A++ (Superior)") == "A++", _to_rating("A++ (Superior)"), "A++")
    check("prefix text ignored", _to_rating("AM Best A-") == "A-", _to_rating("AM Best A-"), "A-")
    check("bare A still works", _to_rating("A") == "A", _to_rating("A"), "A")
    check("B++ parsed", _to_rating("B++") == "B++", _to_rating("B++"), "B++")

    print("\nquote harvesting from arbitrary JSON")
    payload = {"props": {"pageProps": {"results": [
        {"carrierName": "Redacted Life", "amBestRating": "A+", "effectiveYield": "5.60%", "years": 5},
        {"carrierName": "Other Mutual", "rating": "A-", "rate": 5.95, "term": 5},
        {"nested": {"deep": [{"ambest": "A", "annualYield": "5.40%", "termYears": 5}]}},
        {"carrierName": "No Rating Co", "effectiveYield": "9.99%", "years": 5},
    ]}}}
    q = harvest_quotes(payload)
    check("finds quotes at any depth", len(q) == 3, len(q), 3)
    check("drops rows without a rating", all(x["rating"] for x in q), q, "all rated")
    check("carries the term through", all(x["term"] == 5 for x in q), q, "term 5")
    check("empty input is safe", harvest_quotes({}) == [] and harvest_quotes(None) == [], None, [])

    print("\nHTML fallback")
    html = ("<table><tr><td>Some Carrier</td><td>A+</td><td>5.60%</td></tr>"
            "<tr><td>Another</td><td>A-</td><td>5.95%</td></tr>"
            "<tr><td>Header</td><td>Rating</td><td>Yield</td></tr></table>")
    rows = parse_html_table(html, default_term=5)
    check("parses server-rendered rows", len(rows) == 2, len(rows), 2)

    print("\naggregation — the step that discards carrier identity")
    quotes = [
        {"rate": 5.60, "rating": "A+", "term": 5},
        {"rate": 5.70, "rating": "A+", "term": 5},
        {"rate": 5.90, "rating": "A-", "term": 5},
        {"rate": 6.10, "rating": "A-", "term": 5},
        {"rate": 5.00, "rating": "C", "term": 5},   # unrated bucket, dropped
    ]
    buckets, overall = aggregate(quotes, t, y)
    # UST 5Y = 4.43, so A+ spreads are 117bp and 127bp → median 122bp
    check("A+ median spread", buckets["aplus"]["terms"]["5"]["median_bp"] == 122.0,
          buckets["aplus"]["terms"]["5"]["median_bp"], 122.0)
    check("A- pays more than A+",
          buckets["aminus"]["terms"]["5"]["median_bp"] > buckets["aplus"]["terms"]["5"]["median_bp"],
          None, "A- > A+")
    check("unmapped rating dropped", "C" not in str(buckets), None, "no C bucket")
    check("overall pools every bucket", overall["5"]["n"] == 4, overall["5"]["n"], 4)
    check("UST recorded for provenance", buckets["aplus"]["terms"]["5"]["ust_pct"] == 4.43,
          buckets["aplus"]["terms"]["5"]["ust_pct"], 4.43)
    blob = json.dumps({"buckets": buckets, "overall": overall})
    check("no carrier identity survives aggregation",
          "carrier" not in blob.lower() and "Life" not in blob, None, "clean")
    check("no raw rates survive either", "5.6" not in blob and "6.1" not in blob, None, "spreads only")

    print("\nno-curve guard")
    b2, o2 = aggregate(quotes, None, None)
    check("no UST ⇒ no output rather than wrong output", b2 == {} and o2 == {}, (b2, o2), ({}, {}))

    print(f"\n{ok} passed, {fails} failed\n")
    return 1 if fails else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true", help="run offline logic tests")
    args = ap.parse_args()
    if args.selftest:
        sys.exit(selftest())
    fetch_myga()
    flush_source_health()

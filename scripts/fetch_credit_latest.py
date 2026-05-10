#!/usr/bin/env python3
"""Fast, bounded credit-spread refresh for Bermuda Market Intel.

This script intentionally stays separate from fetch_all.py for now. It runs after the
main pipeline, overwrites data/credit.json with the latest available ICE BofA OAS
series from FRED, and patches data/manifest.json with an honest credit status.

Runtime design:
- One bulk FRED graph CSV call over a short recent window.
- Bounded parallel fallback calls only for missing series.
- Cache fallback if FRED is unavailable.
- No long retry chains, no scraping, no external packages.
"""

import csv
import io
import json
import logging
import re
import time
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("credit")

DATA = Path(__file__).parent.parent / "data"
DATA.mkdir(exist_ok=True)

HDR = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/csv,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
}

# FRED ICE BofA option-adjusted spread series. FRED values are in percentage
# points, so 0.88 means 88bp.
SERIES = {
    "ig":  {"sid": "BAMLC0A0CM",   "name": "US IG",   "bucket": "IG"},
    "aaa": {"sid": "BAMLC0A1CAAA", "name": "US AAA",  "bucket": "AAA"},
    "aa":  {"sid": "BAMLC0A2CAA",  "name": "US AA",   "bucket": "AA"},
    "a":   {"sid": "BAMLC0A3CA",   "name": "US A",    "bucket": "A"},
    "bbb": {"sid": "BAMLC0A4CBBB", "name": "US BBB",  "bucket": "BBB"},
    "hy":  {"sid": "BAMLH0A0HYM2", "name": "US HY",   "bucket": "HY"},
    "bb":  {"sid": "BAMLH0A1HYBB", "name": "US BB",   "bucket": "BB"},
    "b":   {"sid": "BAMLH0A2HYB",  "name": "US B",    "bucket": "B"},
    "ccc": {"sid": "BAMLH0A3HYC",  "name": "US CCC+", "bucket": "CCC"},
}

MAX_FRESH_AGE_DAYS = 7
RECENT_WINDOW_DAYS = 45
REQUEST_TIMEOUT_SECONDS = 7
FALLBACK_TIMEOUT_SECONDS = 5
FALLBACK_WORKERS = 6


def utc_now():
    return datetime.utcnow()


def iso_now():
    return utc_now().isoformat() + "Z"


def get(url, timeout):
    req = urllib.request.Request(url, headers=HDR)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


def load_json(path, default):
    try:
        if path.exists():
            return json.loads(path.read_text())
    except Exception as exc:
        log.warning("Could not read %s: %s", path, exc)
    return default


def write_json(path, obj):
    obj["_fetched"] = iso_now()
    path.write_text(json.dumps(obj, indent=2, default=str))
    log.info("wrote %s", path.name)


def parse_fred_csv(raw, expected_series):
    """Parse FRED graph/download CSV into {series_id: [{date, value}]}.

    Works for both multi-series graph CSV and single-series download CSV.
    """
    out = {sid: [] for sid in expected_series}
    rows = list(csv.reader(io.StringIO(raw)))
    if len(rows) < 2:
        return out

    header = [h.strip().strip('"') for h in rows[0]]
    expected_upper = {sid.upper(): sid for sid in expected_series}

    col_map = {}
    for i, h in enumerate(header):
        if i == 0:
            continue
        sid = expected_upper.get(h.upper())
        if sid:
            col_map[i] = sid

    # Single-series download endpoint often has DATE,VALUE rather than DATE,SERIES_ID.
    if not col_map and len(expected_series) == 1 and len(header) >= 2:
        col_map[1] = expected_series[0]

    for parts in rows[1:]:
        if not parts:
            continue
        date_val = parts[0].strip().strip('"')
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_val):
            continue
        for ci, sid in col_map.items():
            if ci >= len(parts):
                continue
            val = parts[ci].strip().strip('"')
            if val in ("", ".", "NA", "N/A"):
                continue
            try:
                # FRED OAS is in percentage points; dashboard stores basis points.
                bp = round(float(val) * 100)
                if 0 < bp < 5000:
                    out[sid].append({"date": date_val, "value": bp})
            except Exception:
                pass

    for sid in out:
        out[sid].sort(key=lambda x: x["date"], reverse=True)
    return out


def fred_bulk(series_ids):
    start = (utc_now() - timedelta(days=RECENT_WINDOW_DAYS)).strftime("%Y-%m-%d")
    joined = ",".join(series_ids)
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={joined}&cosd={start}"
    raw = get(url, timeout=REQUEST_TIMEOUT_SECONDS)
    return parse_fred_csv(raw, series_ids)


def fred_download_one(series_id):
    start = (utc_now() - timedelta(days=RECENT_WINDOW_DAYS)).strftime("%Y-%m-%d")
    url = f"https://fred.stlouisfed.org/series/{series_id}/downloaddata/{series_id}.csv"
    try:
        raw = get(url, timeout=FALLBACK_TIMEOUT_SECONDS)
        return series_id, parse_fred_csv(raw, [series_id]).get(series_id, [])
    except Exception as exc:
        log.warning("FRED fallback failed for %s: %s", series_id, exc)
        return series_id, []


def fetch_observations():
    series_ids = [meta["sid"] for meta in SERIES.values()]
    observations = {sid: [] for sid in series_ids}

    try:
        observations.update(fred_bulk(series_ids))
        got = sum(1 for sid in series_ids if observations.get(sid))
        log.info("FRED bulk returned %s/%s series", got, len(series_ids))
    except Exception as exc:
        log.warning("FRED bulk failed: %s", exc)

    missing = [sid for sid in series_ids if not observations.get(sid)]
    if missing:
        log.info("Trying bounded parallel fallback for %s missing series", len(missing))
        with ThreadPoolExecutor(max_workers=FALLBACK_WORKERS) as ex:
            futures = [ex.submit(fred_download_one, sid) for sid in missing]
            for fut in as_completed(futures):
                sid, rows = fut.result()
                if rows:
                    observations[sid] = rows

    return observations


def age_days(date_str):
    try:
        return (utc_now().date() - datetime.strptime(date_str, "%Y-%m-%d").date()).days
    except Exception:
        return None


def build_credit_json(observations, last_credit):
    last_spreads = (last_credit or {}).get("spreads", {})
    spreads = {}
    fresh_dates = []
    fresh_count = 0
    cache_count = 0
    stale_count = 0

    for key, meta in SERIES.items():
        sid = meta["sid"]
        rows = observations.get(sid) or []
        latest = rows[0] if rows else None
        prior = rows[1] if len(rows) > 1 else None
        last_row = last_spreads.get(key, {}) if isinstance(last_spreads, dict) else {}

        if latest:
            row_age = age_days(latest["date"])
            is_stale = row_age is not None and row_age > MAX_FRESH_AGE_DAYS
            source = "fred_stale" if is_stale else "fred"
            if is_stale:
                stale_count += 1
            else:
                fresh_count += 1
            fresh_dates.append(latest["date"])
            spreads[key] = {
                "name": meta["name"],
                "spread": latest["value"],
                "prior": prior["value"] if prior else last_row.get("prior"),
                "bucket": meta["bucket"],
                "source": source,
                "series_id": sid,
                "date": latest["date"],
                "prior_date": prior["date"] if prior else last_row.get("prior_date", ""),
                "age_days": row_age,
            }
        else:
            cache_count += 1
            spreads[key] = {
                "name": last_row.get("name", meta["name"]),
                "spread": last_row.get("spread"),
                "prior": last_row.get("prior"),
                "bucket": last_row.get("bucket", meta["bucket"]),
                "source": "cache",
                "series_id": sid,
                "date": last_row.get("date", ""),
                "prior_date": last_row.get("prior_date", ""),
                "age_days": age_days(last_row.get("date", "")),
            }

    if fresh_dates:
        # Use the modal latest date so one delayed rating bucket does not make the whole
        # file date jump around. Fall back to max date if no clear mode exists.
        date_counts = Counter(fresh_dates)
        modal_date, modal_count = date_counts.most_common(1)[0]
        file_date = modal_date if modal_count >= 2 else max(fresh_dates)
    else:
        file_date = (last_credit or {}).get("date", "")

    total = len(SERIES)
    if fresh_count == total:
        status = "ok"
    elif fresh_count > 0:
        status = "partial"
    elif stale_count > 0:
        status = "stale"
    else:
        status = "cached"

    note = (
        "ICE BofA option-adjusted spreads from FRED. Fast bulk CSV fetch over a "
        "short recent window; missing series use bounded parallel download fallback; "
        "cache is used only where FRED data is unavailable. Values are basis points."
    )
    if status != "ok":
        note += f" Status={status}: fresh={fresh_count}, stale={stale_count}, cached={cache_count}."

    return {
        "date": file_date,
        "source": "FRED / ICE BofA Indices",
        "url": "https://fred.stlouisfed.org/release?rid=209",
        "status": status,
        "fresh_count": fresh_count,
        "stale_count": stale_count,
        "cache_count": cache_count,
        "max_fresh_age_days": MAX_FRESH_AGE_DAYS,
        "spreads": spreads,
        "note": note,
    }


def patch_manifest(status):
    path = DATA / "manifest.json"
    manifest = load_json(path, {"results": {}, "run": iso_now()})
    manifest.setdefault("results", {})["credit"] = status
    manifest.setdefault("run", iso_now())
    write_json(path, manifest)


def main():
    last_credit = load_json(DATA / "credit.json", {})
    try:
        observations = fetch_observations()
        credit = build_credit_json(observations, last_credit)
    except Exception as exc:
        log.exception("Credit refresh failed; preserving cache: %s", exc)
        credit = last_credit or {
            "date": "",
            "source": "FRED / ICE BofA Indices",
            "url": "https://fred.stlouisfed.org/release?rid=209",
            "spreads": {},
        }
        credit["status"] = "cached"
        credit["note"] = "Credit refresh failed; cached data preserved."

    write_json(DATA / "credit.json", credit)
    patch_manifest(credit.get("status", "cached"))


if __name__ == "__main__":
    main()

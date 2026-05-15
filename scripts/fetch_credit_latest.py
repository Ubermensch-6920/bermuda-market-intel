#!/usr/bin/env python3
"""Fast, bounded credit-spread refresh for GENESIS.

This script intentionally stays separate from fetch_all.py. It runs after the
main pipeline, overwrites data/credit.json with the latest available ICE BofA
OAS series, and patches data/manifest.json with an honest credit status.

Runtime design:
- One bulk FRED CSV call over a short recent window.
- Bounded parallel per-series CSV fallback for missing series.
- Bounded parallel per-series FRED graph API fallback if CSV is blocked/empty.
- Cache fallback if FRED is unavailable.
- No long retry chains, no scraping, no external packages.
"""

import csv
import io
import json
import logging
import re
import urllib.parse
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
    "Accept": "text/csv,application/json,text/plain,*/*",
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
RECENT_WINDOW_DAYS = 90
REQUEST_TIMEOUT_SECONDS = 8
FALLBACK_TIMEOUT_SECONDS = 6
FALLBACK_WORKERS = 6


def utc_now():
    return datetime.utcnow()


def iso_now():
    return utc_now().isoformat() + "Z"


def recent_start():
    return (utc_now() - timedelta(days=RECENT_WINDOW_DAYS)).strftime("%Y-%m-%d")


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


def valid_bp(v):
    try:
        bp = round(float(v) * 100)
        return bp if 0 < bp < 5000 else None
    except Exception:
        return None


def parse_fred_csv(raw, expected_series):
    """Parse FRED CSV into {series_id: [{date, value_bp}]}.

    Handles both multi-series graph CSV and single-series download CSV.
    """
    out = {sid: [] for sid in expected_series}
    rows = list(csv.reader(io.StringIO(raw)))
    if len(rows) < 2:
        return out

    header = [h.strip().strip('"').lstrip("\ufeff") for h in rows[0]]
    expected_upper = {sid.upper(): sid for sid in expected_series}

    col_map = {}
    for i, h in enumerate(header):
        if i == 0:
            continue
        sid = expected_upper.get(h.upper())
        if sid:
            col_map[i] = sid

    # Single-series download endpoint can use DATE,VALUE rather than DATE,SERIES_ID.
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
            bp = valid_bp(val)
            if bp is not None:
                out[sid].append({"date": date_val, "value": bp})

    for sid in out:
        out[sid].sort(key=lambda x: x["date"], reverse=True)
    return out


def to_date_string(value):
    if value is None:
        return None
    if isinstance(value, str):
        s = value.strip()
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
            return s
        # Some graph endpoints return epoch milliseconds as strings.
        if re.fullmatch(r"\d{10,13}", s):
            try:
                n = int(s)
                if n > 10_000_000_000:
                    n = n / 1000
                return datetime.utcfromtimestamp(n).strftime("%Y-%m-%d")
            except Exception:
                return None
    if isinstance(value, (int, float)):
        try:
            n = value / 1000 if value > 10_000_000_000 else value
            return datetime.utcfromtimestamp(n).strftime("%Y-%m-%d")
        except Exception:
            return None
    return None


def collect_json_points(obj):
    """Recursively collect date/value observations from FRED graph JSON variants."""
    points = []

    if isinstance(obj, dict):
        # Common FRED API shape: {date: ..., value: ...}
        if "date" in obj and "value" in obj:
            d = to_date_string(obj.get("date"))
            bp = valid_bp(obj.get("value"))
            if d and bp is not None:
                points.append({"date": d, "value": bp})

        # Common graph shape: {x: epoch_ms, y: value} or {0: date, 1: value} nested in data.
        for dk in ("x", "timestamp", "time"):
            for vk in ("y", "value"):
                if dk in obj and vk in obj:
                    d = to_date_string(obj.get(dk))
                    bp = valid_bp(obj.get(vk))
                    if d and bp is not None:
                        points.append({"date": d, "value": bp})

        for v in obj.values():
            points.extend(collect_json_points(v))

    elif isinstance(obj, list):
        # Common FRED graph data shape: [[epoch_ms, value], ...]
        if len(obj) >= 2:
            d = to_date_string(obj[0])
            bp = valid_bp(obj[1])
            if d and bp is not None:
                points.append({"date": d, "value": bp})
        for item in obj:
            points.extend(collect_json_points(item))

    return points


def dedupe_sort(points):
    by_date = {}
    for p in points:
        if p.get("date") and p.get("value") is not None:
            by_date[p["date"]] = p["value"]
    out = [{"date": d, "value": v} for d, v in by_date.items()]
    out.sort(key=lambda x: x["date"], reverse=True)
    return out


def fred_bulk(series_ids):
    params = urllib.parse.urlencode({"id": ",".join(series_ids), "cosd": recent_start()})
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?{params}"
    raw = get(url, timeout=REQUEST_TIMEOUT_SECONDS)
    return parse_fred_csv(raw, series_ids)


def fred_graph_csv_one(series_id):
    params = urllib.parse.urlencode({"id": series_id, "cosd": recent_start()})
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?{params}"
    try:
        raw = get(url, timeout=FALLBACK_TIMEOUT_SECONDS)
        return series_id, parse_fred_csv(raw, [series_id]).get(series_id, [])
    except Exception as exc:
        log.warning("FRED single CSV failed for %s: %s", series_id, exc)
        return series_id, []


def fred_download_one(series_id):
    url = f"https://fred.stlouisfed.org/series/{series_id}/downloaddata/{series_id}.csv"
    try:
        raw = get(url, timeout=FALLBACK_TIMEOUT_SECONDS)
        return series_id, parse_fred_csv(raw, [series_id]).get(series_id, [])
    except Exception as exc:
        log.warning("FRED download failed for %s: %s", series_id, exc)
        return series_id, []


def fred_graph_api_one(series_id):
    params = urllib.parse.urlencode({"obs": "true", "id": series_id, "cosd": recent_start()})
    url = f"https://fred.stlouisfed.org/graph/api/series/?{params}"
    try:
        raw = get(url, timeout=FALLBACK_TIMEOUT_SECONDS)
        data = json.loads(raw)
        return series_id, dedupe_sort(collect_json_points(data))
    except Exception as exc:
        log.warning("FRED graph API failed for %s: %s", series_id, exc)
        return series_id, []


def parallel_fill(observations, missing, fetcher, label):
    if not missing:
        return observations
    log.info("Trying %s for %s missing series", label, len(missing))
    with ThreadPoolExecutor(max_workers=min(FALLBACK_WORKERS, len(missing))) as ex:
        futures = [ex.submit(fetcher, sid) for sid in missing]
        for fut in as_completed(futures):
            sid, rows = fut.result()
            if rows:
                observations[sid] = rows
    got = sum(1 for sid in missing if observations.get(sid))
    log.info("%s filled %s/%s missing series", label, got, len(missing))
    return observations


def fetch_observations():
    series_ids = [meta["sid"] for meta in SERIES.values()]
    observations = {sid: [] for sid in series_ids}

    try:
        observations.update(fred_bulk(series_ids))
        got = sum(1 for sid in series_ids if observations.get(sid))
        log.info("FRED bulk CSV returned %s/%s series", got, len(series_ids))
    except Exception as exc:
        log.warning("FRED bulk CSV failed: %s", exc)

    missing = [sid for sid in series_ids if not observations.get(sid)]
    observations = parallel_fill(observations, missing, fred_graph_csv_one, "single-series CSV")

    missing = [sid for sid in series_ids if not observations.get(sid)]
    observations = parallel_fill(observations, missing, fred_download_one, "download CSV")

    missing = [sid for sid in series_ids if not observations.get(sid)]
    observations = parallel_fill(observations, missing, fred_graph_api_one, "graph API")

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
            is_stale = row_age is None or row_age > MAX_FRESH_AGE_DAYS
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
        "ICE BofA option-adjusted spreads from FRED. Uses bounded CSV and graph API "
        "fallbacks over a recent window; cache is used only where FRED data is unavailable. "
        "Values are basis points."
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

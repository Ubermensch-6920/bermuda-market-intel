#!/usr/bin/env python3
"""Shared helpers for the GENESIS data pipeline.

- FRED client that prefers the official API (when FRED_API_KEY is set) and
  falls back to the public fredgraph.csv endpoint with retries. The graph
  endpoint is rate-limited/blocked from CI runners, which is why so many
  FRED-backed fields were coming back null.
- Source-health recorder: every fetcher reports which upstream sources were
  attempted and whether they succeeded, so data/source_health.json can show
  active vs fallback vs stagnant sources on the dashboard.
"""
import csv
import io
import json
import logging
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

log = logging.getLogger("fetch")
DATA = Path(__file__).parent.parent / "data"
DATA.mkdir(exist_ok=True)

HDR = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

def _load_fred_api_key():
    """FRED_API_KEY env var first (CI uses the GitHub secret), then a local
    .env file at the repo root for local runs (gitignored; see .env.example)."""
    key = os.environ.get("FRED_API_KEY", "").strip()
    if key:
        return key
    env_path = Path(__file__).parent.parent / ".env"
    try:
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                line = line.strip()
                if line.startswith("FRED_API_KEY"):
                    val = line.split("=", 1)[1].strip().strip("'\"") if "=" in line else ""
                    if val and "your" not in val.lower():
                        return val
    except Exception:
        pass
    return ""


FRED_API_KEY = _load_fred_api_key()
FRED_API_URL = "https://api.stlouisfed.org/fred/series/observations"


def _http_get(url, timeout=10):
    req = urllib.request.Request(url, headers=HDR)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


def _fred_api_series(series_id, start, timeout=10):
    """Fetch one series via the official FRED API. Returns obs newest-first.

    The API allows 120 requests/min; a pipeline run makes dozens of calls, so
    back off and retry on HTTP 429 instead of failing the series.
    """
    params = urllib.parse.urlencode({
        "series_id": series_id,
        "api_key": FRED_API_KEY,
        "file_type": "json",
        "observation_start": start,
        "sort_order": "desc",
    })
    url = f"{FRED_API_URL}?{params}"
    raw = None
    for attempt, backoff in enumerate((2, 5, None)):
        try:
            raw = _http_get(url, timeout=timeout)
            break
        except urllib.error.HTTPError as e:
            if e.code == 429 and backoff is not None:
                log.warning(f"  FRED API {series_id}: 429 rate-limited, retrying in {backoff}s")
                time.sleep(backoff)
                continue
            raise
    data = json.loads(raw)
    obs = []
    for o in data.get("observations", []):
        v = o.get("value", ".")
        if v in (".", ""):
            continue
        try:
            obs.append({"date": o["date"], "value": float(v)})
        except (TypeError, ValueError):
            pass
    return obs


def _fredgraph_multi(series_ids, start, timeout=10, retries=2):
    """Fetch series via the public fredgraph.csv endpoint (one request)."""
    joined = ",".join(series_ids)
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={joined}&cosd={start}"
    result = {sid: [] for sid in series_ids}
    sid_upper = {sid.upper(): sid for sid in series_ids}
    last_err = None
    for attempt in range(retries + 1):
        try:
            raw = _http_get(url, timeout=timeout)
            rows = list(csv.reader(io.StringIO(raw)))
            if len(rows) < 2:
                return result
            header = [h.strip().strip('"') for h in rows[0]]
            col_map = {}
            for i, h in enumerate(header):
                if i == 0:
                    continue
                sid = sid_upper.get(h.upper())
                if sid:
                    col_map[i] = sid
            for parts in rows[1:]:
                if len(parts) < 2:
                    continue
                date_val = parts[0].strip().strip('"')
                if not re.match(r"\d{4}-\d{2}-\d{2}", date_val):
                    continue
                for ci, sid in col_map.items():
                    if ci < len(parts):
                        val = parts[ci].strip().strip('"')
                        if val not in (".", ""):
                            try:
                                result[sid].append({"date": date_val, "value": float(val)})
                            except ValueError:
                                pass
            for sid in result:
                result[sid].sort(key=lambda x: x["date"], reverse=True)
            return result
        except Exception as e:
            last_err = e
            log.warning(f"  FRED graph CSV [{joined}] attempt {attempt + 1}: {e}")
            if attempt < retries:
                time.sleep(2 * (attempt + 1))
    log.warning(f"  FRED graph CSV [{joined}] exhausted retries: {last_err}")
    return result


def fred_fetch(series_ids, start="2024-01-01", timeout=10, retries=2):
    """Fetch FRED series, official API first (if keyed), fredgraph fallback.

    Returns {series_id: [{date, value}, ...]} sorted newest-first. Records
    source health for "FRED" automatically.
    """
    result = {sid: [] for sid in series_ids}
    if FRED_API_KEY:
        api_failed = []
        for sid in series_ids:
            try:
                result[sid] = _fred_api_series(sid, start, timeout=timeout)
                time.sleep(0.5)
            except Exception as e:
                api_failed.append(sid)
                log.warning(f"  FRED API {sid}: {e}")
        if api_failed:
            graph = _fredgraph_multi(api_failed, start, timeout=timeout, retries=retries)
            for sid in api_failed:
                result[sid] = graph.get(sid, [])
    else:
        result = _fredgraph_multi(list(series_ids), start, timeout=timeout, retries=retries)

    got = sum(1 for sid in series_ids if result.get(sid))
    record_source(
        "FRED",
        feeds="rates / spreads / FX reference data",
        ok=got > 0,
        note=f"{got}/{len(series_ids)} series returned data"
        + ("" if FRED_API_KEY else " (no FRED_API_KEY; using public CSV endpoint)"),
    )
    return result


# ---------------------------------------------------------------------------
# Source health tracking
# ---------------------------------------------------------------------------

HEALTH_FILE = DATA / "source_health.json"
STAGNANT_AFTER_DAYS = 3

_health_this_run = {}


def record_source(source, feeds, ok, fallback=None, note=None):
    """Record the outcome of an upstream fetch attempt.

    source:   upstream name, e.g. "FRED", "NY Fed", "MOF Japan".
    feeds:    what dashboard data this source supplies.
    ok:       True if usable data came back from the source itself.
    fallback: what was used instead when ok is False
              ("cache" | "own_history" | "derived" | "static_default" | other source name).
    """
    now = datetime.utcnow().isoformat() + "Z"
    entry = _health_this_run.get(source)
    if entry is None:
        entry = {"source": source, "feeds": feeds, "ok": ok,
                 "last_attempt": now, "fallback": fallback, "note": note}
        _health_this_run[source] = entry
    else:
        # A source can be attempted for several feeds in one run; any success
        # counts, and feed descriptions accumulate.
        entry["ok"] = entry["ok"] or ok
        entry["last_attempt"] = now
        if feeds and feeds not in entry["feeds"]:
            entry["feeds"] += f"; {feeds}"
        if fallback and not entry.get("fallback"):
            entry["fallback"] = fallback
        if note:
            entry["note"] = note if not entry.get("note") else f"{entry['note']}; {note}"
    if ok:
        entry["last_success"] = now
    return entry


def flush_source_health():
    """Merge this run's source outcomes into data/source_health.json."""
    existing = {}
    try:
        prev = json.loads(HEALTH_FILE.read_text())
        existing = {s["source"]: s for s in prev.get("sources", [])}
    except Exception:
        pass

    now = datetime.utcnow()
    for source, entry in _health_this_run.items():
        prev_entry = existing.get(source, {})
        last_success = entry.get("last_success") or prev_entry.get("last_success")
        merged = {
            "source": source,
            "feeds": entry["feeds"],
            "last_attempt": entry["last_attempt"],
            "last_success": last_success,
            "fallback": entry.get("fallback"),
            "note": entry.get("note"),
        }
        if entry["ok"]:
            merged["status"] = "active"
        else:
            age_days = None
            if last_success:
                try:
                    age_days = (now - datetime.strptime(last_success[:10], "%Y-%m-%d")).days
                except ValueError:
                    pass
            if age_days is not None and age_days <= STAGNANT_AFTER_DAYS:
                merged["status"] = "fallback"
            else:
                merged["status"] = "stagnant"
        existing[source] = merged

    # Prune entries not attempted recently (renamed/retired source labels).
    def _fresh(s):
        try:
            return (now - datetime.strptime(s.get("last_attempt", "")[:10], "%Y-%m-%d")).days <= 14
        except ValueError:
            return False
    sources = sorted((s for s in existing.values() if _fresh(s)), key=lambda s: s["source"].lower())
    counts = {"active": 0, "fallback": 0, "stagnant": 0}
    for s in sources:
        counts[s.get("status", "stagnant")] = counts.get(s.get("status", "stagnant"), 0) + 1
    out = {
        "updated": now.isoformat() + "Z",
        "summary": counts,
        "sources": sources,
    }
    HEALTH_FILE.write_text(json.dumps(out, indent=2))
    log.info(f"  source health: {counts['active']} active, {counts['fallback']} fallback, "
             f"{counts['stagnant']} stagnant -> {HEALTH_FILE.name}")
    return out

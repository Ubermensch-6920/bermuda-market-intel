#!/usr/bin/env python3
"""GENESIS — Data Pipeline v8.
Improved India / UK rates sourcing and roll-aware commodity futures history.
"""
import json, re, sys, os, logging, time, io, zipfile, csv, threading
from datetime import datetime, timedelta, date
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib.error
import urllib.request

try:
    from openpyxl import load_workbook
except Exception:
    load_workbook = None

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fetch")
DATA = Path(__file__).parent.parent / "data"
DATA.mkdir(exist_ok=True)

sys.path.insert(0, str(Path(__file__).parent))
from fetchlib import fred_fetch, record_source, flush_source_health
HDR = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

def get(url, timeout=8):
    req = urllib.request.Request(url, headers=HDR)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")

def get_bytes(url, timeout=20, retries=2, sleep_seconds=2):
    last_err = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=HDR)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:
            last_err = e
            if attempt < retries:
                time.sleep(sleep_seconds * (attempt + 1))
    raise last_err

def write(name, obj):
    obj["_fetched"] = datetime.utcnow().isoformat() + "Z"
    (DATA / name).write_text(json.dumps(obj, indent=2, default=str))
    log.info(f"  wrote {name}")

def fred_csv(series_id, start="2024-01-01", retries=2):
    """Fetch single FRED series (official API when keyed, CSV fallback)."""
    return fred_fetch([series_id], start=start, retries=retries).get(series_id, [])

def fred_multi_csv(series_ids, start="2024-01-01", retries=2):
    """Fetch MULTIPLE FRED series. Returns {series_id: [obs]}."""
    return fred_fetch(list(series_ids), start=start, retries=retries)

def fred_download_csv(series_id, start="2024-01-01"):
    """Alternative FRED endpoint: series download page instead of graph CSV.
    Served via a different URL path — useful when the graph endpoint is throttled.
    Single attempt, short timeout, no retries."""
    url = f"https://fred.stlouisfed.org/series/{series_id}/downloaddata/{series_id}.csv"
    try:
        raw = get(url, timeout=6)
        obs = []
        for line in raw.strip().split("\n")[1:]:
            parts = line.split(",")
            if len(parts) >= 2 and parts[1].strip() not in (".", ""):
                try:
                    d = parts[0].strip()
                    if d >= start:
                        obs.append({"date": d, "value": float(parts[1].strip())})
                except Exception:
                    pass
        obs.sort(key=lambda x: x["date"], reverse=True)
        if obs:
            log.info(f"  FRED↓ {series_id}: got {len(obs)} obs via download endpoint")
        return obs
    except Exception as e:
        log.warning(f"  FRED↓ {series_id}: {e}")
        return []

def fred_year_ago_10y(series_id):
    target = (datetime.utcnow() - timedelta(days=365)).strftime("%Y-%m-%d")
    obs = fred_csv(series_id, start=(datetime.utcnow() - timedelta(days=400)).strftime("%Y-%m-%d"))
    if not obs:
        return None, ""
    best = min(obs, key=lambda o: abs((datetime.strptime(o["date"], "%Y-%m-%d") - datetime.strptime(target, "%Y-%m-%d")).days))
    return round(best["value"], 4), best["date"]

def find_prior_date_yields(rows, days_ago, tenors, max_diff_days=14):
    """Find yields from rows list closest to N days ago. rows: [{date, yields}] sorted desc."""
    target = (datetime.utcnow() - timedelta(days=days_ago)).strftime("%Y-%m-%d")
    if not rows:
        return [None] * len(tenors), ""
    best = min(rows, key=lambda r: abs((datetime.strptime(r["date"], "%Y-%m-%d") - datetime.strptime(target, "%Y-%m-%d")).days))
    diff = abs((datetime.strptime(best["date"], "%Y-%m-%d") - datetime.strptime(target, "%Y-%m-%d")).days)
    if diff > max_diff_days:
        return [None] * len(tenors), ""
    return [best["yields"].get(t) for t in tenors], best["date"]

def fred_prior_single(series_id, days_ago, max_diff_days=14):
    """Fetch a single FRED series value closest to N days ago. Returns (value, date)."""
    target_dt = datetime.utcnow() - timedelta(days=days_ago)
    start = (target_dt - timedelta(days=30)).strftime("%Y-%m-%d")
    obs = fred_csv(series_id, start=start, retries=0)
    if not obs:
        return None, ""
    target = target_dt.strftime("%Y-%m-%d")
    best = min(obs, key=lambda o: abs((datetime.strptime(o["date"], "%Y-%m-%d") - datetime.strptime(target, "%Y-%m-%d")).days))
    diff = abs((datetime.strptime(best["date"], "%Y-%m-%d") - datetime.strptime(target, "%Y-%m-%d")).days)
    if diff > max_diff_days:
        return None, ""
    return round(best["value"], 4), best["date"]

def validate_yield(val):
    """Range-check a yield value. Returns rounded float or None."""
    if val is None:
        return None
    return round(val, 4) if 0 < val < 20 else None

def interpolate_curve(yields_dict, tenors):
    """Linear interpolation for missing interior tenors. Does not extrapolate."""
    def t2n(t):
        return float(t.replace("Y", ""))
    known = sorted([(t2n(t), v) for t, v in yields_dict.items() if v is not None], key=lambda k: k[0])
    if len(known) < 2:
        return yields_dict
    for t in tenors:
        if yields_dict.get(t) is None:
            x = t2n(t)
            left = max((k for k in known if k[0] < x), default=None, key=lambda k: k[0])
            right = min((k for k in known if k[0] > x), default=None, key=lambda k: k[0])
            if left and right:
                yields_dict[t] = round(left[1] + (right[1] - left[1]) * (x - left[0]) / (right[0] - left[0]), 4)
    return yields_dict

def hold_spikes(current, tenors, last, threshold_bp=25, calm_bp=8, max_holds=3, max_age_days=4):
    """Hold a tenor at its previous value when it alone jumps.

    Scraped curves occasionally return a wrong number for one tenor (India's
    TE "52W" row flipped between ~6.1% and 5.8%/6.5% run to run, even on a
    Saturday). If one tenor moves more than `threshold_bp` while the median
    of the others moves at most `calm_bp`, keep the previous value. A hold
    lasts at most `max_holds` consecutive runs, so a genuine level shift
    still comes through. Mutates `current`; returns {tenor: consecutive holds}.
    """
    if not last or not last.get("date"):
        return {}
    try:
        age = (datetime.utcnow().date() - date.fromisoformat(last["date"][:10])).days
    except ValueError:
        return {}
    if age > max_age_days:
        return {}
    last_y = dict(zip(last.get("tenors", []), last.get("yields", [])))
    held_before = last.get("held") or {}
    moves = {t: abs(current[t] - last_y[t]) * 100 for t in tenors
             if current.get(t) is not None and last_y.get(t) is not None}
    held = {}
    for t, mv in moves.items():
        others = sorted(v for k, v in moves.items() if k != t)
        if len(others) < 3 or mv <= threshold_bp:
            continue
        if others[len(others) // 2] <= calm_bp and held_before.get(t, 0) < max_holds:
            held[t] = held_before.get(t, 0) + 1
            log.warning(f"  {t}: {current[t]} is a {mv:.0f}bp jump with the rest of the curve calm; "
                        f"holding previous {last_y[t]} (hold {held[t]}/{max_holds})")
            current[t] = last_y[t]
    return held

def load_last_india():
    try:
        f = DATA / "india.json"
        if f.exists():
            return json.loads(f.read_text())
    except Exception:
        pass
    return None

def load_last_bma():
    try:
        f = DATA / "bma_rates.json"
        if f.exists():
            return json.loads(f.read_text())
    except Exception:
        pass
    return None

def load_last_gilt():
    try:
        f = DATA / "gilt.json"
        if f.exists():
            return json.loads(f.read_text())
    except Exception:
        pass
    return None

def load_last_commodities():
    try:
        f = DATA / "commodities.json"
        if f.exists():
            return json.loads(f.read_text())
    except Exception:
        pass
    return None

def load_last_credit():
    try:
        f = DATA / "credit.json"
        if f.exists():
            return json.loads(f.read_text())
    except Exception:
        pass
    return None

def append_curve_history(name, date_str, tenors, yields, source):
    path = DATA / f"{name}_history.jsonl"
    row = {
        "date": date_str,
        "source": source,
        "tenors": tenors,
        "yields": yields,
        "_fetched": datetime.utcnow().isoformat() + "Z",
    }
    # Upsert: the day's LAST run wins. Keeping the first run meant a pre-market
    # snapshot (yesterday's close) stood in for the whole day.
    try:
        rows = []
        if path.exists():
            rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        rows = [r for r in rows if r.get("date") != date_str] + [row]
        rows.sort(key=lambda r: r.get("date", ""))
        path.write_text("".join(json.dumps(r) + "\n" for r in rows))
    except Exception as e:
        log.warning(f"  history append failed for {name}: {e}")

def load_curve_history(name):
    path = DATA / f"{name}_history.jsonl"
    out = []
    try:
        if path.exists():
            for line in path.read_text().splitlines():
                if not line.strip():
                    continue
                obj = json.loads(line)
                out.append({
                    "date": obj["date"],
                    "yields": dict(zip(obj.get("tenors", []), obj.get("yields", [])))
                })
    except Exception as e:
        log.warning(f"  history load failed for {name}: {e}")
    out.sort(key=lambda x: x["date"], reverse=True)
    return out

def history_lookup(name, days_ago, tenors, max_diff_days=14):
    rows = load_curve_history(name)
    return find_prior_date_yields(rows, days_ago, tenors, max_diff_days=max_diff_days)

def parse_d(s):
    """Parse '31 December 2025' or '31 Dec 2025'. Returns datetime or None."""
    if not s:
        return None
    for fmt in ["%d %B %Y", "%d %b %Y"]:
        try:
            return datetime.strptime(s.strip(), fmt)
        except ValueError:
            pass
    return None

def extract_date_from_url(url):
    """Extract date from PDF filenames like Discount_Rates_31_December_2025.pdf."""
    m = re.search(r'(\d{1,2})[_\s-](\w+)[_\s-](\d{4})', url)
    if not m:
        return None
    return parse_d(f"{m.group(1)} {m.group(2)} {m.group(3)}")

def _to_iso_date(v):
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    s = str(v).strip()
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d-%B-%Y", "%d/%m/%Y", "%m/%d/%Y", "%d.%m.%Y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except Exception:
            pass
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return s[:10]
    return None

def _as_float(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(",", "")
    s = s.replace("%", "")
    if s in ("", ".", "-", "--", "NA", "N/A"):
        return None
    try:
        return float(s)
    except Exception:
        return None

def _to_years(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        x = float(v)
        return x if 0 < x <= 100 else None
    s = str(v).strip().lower()
    s = s.replace("years", "y").replace("year", "y").replace("yrs", "y").replace("yr", "y")
    s = s.replace("months", "m").replace("month", "m").replace("mos", "m").replace("mo", "m")
    s = s.replace(" ", "")
    if re.fullmatch(r"\d+(\.\d+)?y", s):
        return float(s[:-1])
    if re.fullmatch(r"\d+(\.\d+)?m", s):
        return float(s[:-1]) / 12.0
    if re.fullmatch(r"\d+(\.\d+)?", s):
        x = float(s)
        return x if 0 < x <= 100 else None
    return None

def _open_first_xlsx_from_zip(blob):
    if load_workbook is None:
        raise RuntimeError("openpyxl not available")
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        candidates = [n for n in zf.namelist() if n.lower().endswith((".xlsx", ".xlsm"))]
        if not candidates:
            raise RuntimeError("no xlsx/xlsm member inside zip")
        return io.BytesIO(zf.read(candidates[0]))

def _find_header_row(ws, min_numeric_headers=6, max_scan_rows=40, max_scan_cols=160):
    for r in range(1, min(ws.max_row, max_scan_rows) + 1):
        nums = []
        for c in range(1, min(ws.max_column, max_scan_cols) + 1):
            yrs = _to_years(ws.cell(r, c).value)
            nums.append(yrs)
        count = sum(1 for x in nums if x is not None)
        if count >= min_numeric_headers:
            return r
    return None

def _find_date_col(ws, header_row, max_scan_cols=12, probe_rows=20):
    best = (None, -1)
    for c in range(1, min(ws.max_column, max_scan_cols) + 1):
        score = 0
        for r in range(header_row + 1, min(ws.max_row, header_row + probe_rows) + 1):
            if _to_iso_date(ws.cell(r, c).value):
                score += 1
        if score > best[1]:
            best = (c, score)
    return best[0]

def _extract_curve_rows_from_sheet(ws, want_map):
    """
    Generic parser for wide curve sheets:
      date | 0.5 | 1 | 2 | 3 | 5 | ...
    """
    header_row = _find_header_row(ws)
    if not header_row:
        return []

    date_col = _find_date_col(ws, header_row)
    if not date_col:
        return []

    numeric_headers = {}
    for c in range(1, ws.max_column + 1):
        yrs = _to_years(ws.cell(header_row, c).value)
        if yrs is not None:
            numeric_headers[c] = yrs

    if len(numeric_headers) < 4:
        return []

    target_cols = {}
    for label, yrs in want_map.items():
        ranked = sorted(numeric_headers.items(), key=lambda kv: abs(kv[1] - yrs))
        if not ranked:
            continue
        c, found_yrs = ranked[0]
        if abs(found_yrs - yrs) <= (0.08 if yrs <= 2 else 0.6):
            target_cols[label] = c

    if len(target_cols) < 3:
        return []

    rows = []
    for r in range(header_row + 1, ws.max_row + 1):
        d = _to_iso_date(ws.cell(r, date_col).value)
        if not d:
            continue
        yd = {}
        for label, c in target_cols.items():
            yd[label] = validate_yield(_as_float(ws.cell(r, c).value))
        if any(v is not None for v in yd.values()):
            rows.append({"date": d, "yields": yd})

    rows.sort(key=lambda x: x["date"], reverse=True)
    return rows

def _load_workbook_from_bytes(blob):
    if load_workbook is None:
        raise RuntimeError("openpyxl not available")
    return load_workbook(io.BytesIO(blob), data_only=True, read_only=True)

def _strip_html(s):
    return " ".join(re.sub(r"<[^>]+>", " ", s).split())

def scrape_investing_yield(url_path):
    try:
        html = get(f"https://www.investing.com{url_path}", timeout=7)
        for pat in [
            r'data-test="instrument-price-last"[^>]*>([\d.]+)<',
            r'class="text-5xl[^"]*"[^>]*>([\d.]+)<',
            r'class="text-2xl[^"]*"[^>]*>([\d.]+)<',
            r'"last":\s*([\d.]+)',
            r'"last_numeric":\s*([\d.]+)',
        ]:
            m = re.search(pat, html)
            if m:
                v = float(m.group(1))
                if 0 < v < 20:
                    record_source("Investing.com", "yield scrapes", ok=True)
                    return v
    except Exception:
        pass
    record_source("Investing.com", "yield scrapes", ok=False)
    return None

def _scrape_tenors(tenor_path_map, max_workers=4):
    """Scrape multiple Investing.com yield paths in parallel. Returns {tenor: value_or_None}."""
    results = {}
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        fut_map = {ex.submit(scrape_investing_yield, path): tenor for tenor, path in tenor_path_map.items()}
        for fut in as_completed(fut_map):
            tenor = fut_map[fut]
            try:
                results[tenor] = validate_yield(fut.result())
            except Exception:
                results[tenor] = None
    return results

def scrape_commodity_spot(url_path):
    try:
        html = get(f"https://www.investing.com{url_path}", timeout=7)
        for pat in [
            r'data-test="instrument-price-last"[^>]*>([\d,]+\.?\d*)<',
            r'class="text-5xl[^"]*"[^>]*>([\d,]+\.?\d*)<',
            r'"last":\s*([\d.]+)',
            r'"last_numeric":\s*([\d.]+)',
        ]:
            m = re.search(pat, html)
            if m:
                v = float(m.group(1).replace(",", ""))
                if v > 0:
                    record_source("Investing.com", "commodity spots", ok=True)
                    return round(v, 2)
    except Exception:
        pass
    record_source("Investing.com", "commodity spots", ok=False)
    return None

def scrape_fx_spot(url_path):
    try:
        html = get(f"https://www.investing.com{url_path}", timeout=8)
        for pat in [
            r'data-test="instrument-price-last"[^>]*>([\d,]+\.?\d*)<',
            r'class="text-5xl[^"]*"[^>]*>([\d,]+\.?\d*)<',
            r'class="text-2xl[^"]*"[^>]*>([\d,]+\.?\d*)<',
            r'"last":\s*([\d.]+)',
            r'"last_numeric":\s*([\d.]+)',
        ]:
            m = re.search(pat, html)
            if m:
                v = float(m.group(1).replace(",", ""))
                if v > 0:
                    record_source("Investing.com", "FX spots", ok=True)
                    return round(v, 4)
    except Exception:
        pass
    record_source("Investing.com", "FX spots", ok=False)
    return None

def nse_usdinr_forwards(spot_hint=None):
    """
    Source USD/INR forward curve proxies from NSE currency derivatives.
    Maps nearest listed monthly expiries to 3M/6M/12M/24M buckets.
    """
    out = {}
    try:
        raw = get("https://www.nseindia.com/api/currency-derivatives?symbol=USDINR", timeout=12)
        data = json.loads(raw)
        records = data.get("data", []) if isinstance(data, dict) else []
        now = datetime.utcnow().date()
        rows = []
        for r in records:
            exp = r.get("expiryDate")
            lp = r.get("lastPrice")
            if not exp or lp in (None, "-", ""):
                continue
            try:
                dt = datetime.strptime(exp, "%d-%b-%Y").date()
                v = float(lp)
            except Exception:
                continue
            if dt < now or not (50 <= v <= 120):
                continue
            if spot_hint is not None and abs(v - spot_hint) > 20:
                continue
            # USD/INR forwards always trade at a premium to spot (persistent INR carry discount).
            # Values more than 3 INR below spot are stale/misparsed.
            if spot_hint is not None and v < spot_hint - 3.0:
                continue
            rows.append((dt, round(v, 4)))
        rows.sort(key=lambda x: x[0])
        buckets = {"3M": 90, "6M": 182, "12M": 365, "24M": 730}
        for tenor, days in buckets.items():
            target = now + timedelta(days=days)
            cand = min(rows, key=lambda x: abs((x[0] - target).days)) if rows else None
            if cand is not None:
                out[tenor] = cand[1]
    except Exception as e:
        log.warning(f"  NSE USD/INR forwards: {e}")
    record_source("NSE", "USD/INR forwards", ok=bool(out),
                  fallback=None if out else "Investing forwards / Yahoo futures")
    return out

def scrape_usdinr_forwards(spot_hint=None):
    """
    Best-effort parse of USD/INR forward rates from Investing.
    Returns tenor map like {"3M": 83.12, "6M": 83.45, "12M": 84.01, "24M": 84.92}.
    """
    out = {}
    try:
        raw = get("https://www.investing.com/currencies/usd-inr-forward-rates", timeout=10)
        text = _strip_html(raw)
        # Use non-greedy any-char matching ([\s\S]{0,120}?) so the pattern still matches
        # when table cells contain dates or other digits between the tenor label and the
        # outright forward rate.  The decimal requirement + hard 50-120 bounds + directional
        # guard below keep false-positive matches well-controlled.
        patterns = {
            "3M": [
                r"\b3\s*M\b[\s\S]{0,120}?([0-9]{2,3}\.[0-9]{2,4})",
                r"\b3\s*Month\b[\s\S]{0,120}?([0-9]{2,3}\.[0-9]{2,4})",
                r"\b3\s*Months\b[\s\S]{0,120}?([0-9]{2,3}\.[0-9]{2,4})",
            ],
            "6M": [
                r"\b6\s*M\b[\s\S]{0,120}?([0-9]{2,3}\.[0-9]{2,4})",
                r"\b6\s*Month\b[\s\S]{0,120}?([0-9]{2,3}\.[0-9]{2,4})",
                r"\b6\s*Months\b[\s\S]{0,120}?([0-9]{2,3}\.[0-9]{2,4})",
            ],
            "12M": [
                r"\b1\s*Y\b[\s\S]{0,120}?([0-9]{2,3}\.[0-9]{2,4})",
                r"\b12\s*M\b[\s\S]{0,120}?([0-9]{2,3}\.[0-9]{2,4})",
                r"\b1\s*Year\b[\s\S]{0,120}?([0-9]{2,3}\.[0-9]{2,4})",
                r"\b12\s*Month\b[\s\S]{0,120}?([0-9]{2,3}\.[0-9]{2,4})",
            ],
            "24M": [
                r"\b2\s*Y\b[\s\S]{0,120}?([0-9]{2,3}\.[0-9]{2,4})",
                r"\b24\s*M\b[\s\S]{0,120}?([0-9]{2,3}\.[0-9]{2,4})",
                r"\b2\s*Year\b[\s\S]{0,120}?([0-9]{2,3}\.[0-9]{2,4})",
                r"\b24\s*Month\b[\s\S]{0,120}?([0-9]{2,3}\.[0-9]{2,4})",
            ],
        }
        for tenor, pats in patterns.items():
            for pat in pats:
                m = re.search(pat, text, flags=re.I | re.DOTALL)
                if m:
                    v = float(m.group(1))
                    if not (50 <= v <= 120):
                        continue
                    if spot_hint is not None and spot_hint > 0:
                        max_allowed_diff = 15.0 if tenor == "24M" else 10.0
                        if abs(v - spot_hint) > max_allowed_diff:
                            continue
                        # USD/INR forwards always price at a premium to spot; values
                        # more than 3 INR below spot are stale or misparsed.
                        if v < spot_hint - 3.0:
                            continue
                    out[tenor] = round(v, 4)
                    break
    except Exception as e:
        log.warning(f"  Investing USD/INR forwards: {e}")
    return out

def scrape_te_last_value(url):
    try:
        text = _strip_html(get(url, timeout=12))
        patterns = [
            r"(?:rose|fell|eased|surged|climbed|hovered|was|traded)\s+(?:to\s+)?([0-9][0-9,]*(?:\.\d+)?)\s+USD",
            r"Actual\s+Chg\s+%Chg\s+[A-Za-z ]+\s+([0-9][0-9,]*(?:\.\d+)?)",
        ]
        for pat in patterns:
            m = re.search(pat, text, flags=re.I)
            if m:
                return round(float(m.group(1).replace(",", "")), 2)
    except Exception:
        pass
    return None

def te_bonds_table(url, code_map):
    """
    Parses the simple bond table visible on TE country bond pages.
    Returns {tenor: {"current":..., "m1":..., "y1":..., "date":...}}.
    """
    try:
        text = _strip_html(get(url, timeout=15))
    except Exception:
        record_source("TradingEconomics", "bond yield tables", ok=False)
        return {}

    out = {}
    for label, te_label in code_map.items():
        pat = re.compile(
            rf"{re.escape(te_label)}\s+([0-9]+(?:\.[0-9]+)?)\s+([+-]?[0-9]+(?:\.[0-9]+)?)%\s+([+-]?[0-9]+(?:\.[0-9]+)?)%\s+([+-]?[0-9]+(?:\.[0-9]+)?)%\s+([A-Za-z]{{3}}/\d{{2}})",
            flags=re.I
        )
        m = pat.search(text)
        if not m:
            continue
        cur = float(m.group(1))
        month_delta = float(m.group(3))
        year_delta = float(m.group(4))
        out[label] = {
            "current": round(cur, 4),
            "m1": round(cur - month_delta, 4),
            "y1": round(cur - year_delta, 4),
            "date": m.group(5),
        }
    record_source("TradingEconomics", "bond yield tables", ok=bool(out))
    return out

# Yahoo chart API, shared by every Yahoo lookup. Transient failures (429/5xx,
# timeouts) retry with backoff, alternating onto query2; a 400/404 means the
# symbol isn't listed (expired or not-yet-listed contract) and returns at once.
# Payloads are cached for the run so a contract used by several tenor/horizon
# lookups is only fetched once.
_YAHOO_HOSTS = ("query1.finance.yahoo.com", "query2.finance.yahoo.com")
_yahoo_cache = {}
_yahoo_cache_lock = threading.Lock()

def _yahoo_chart(symbol, query, timeout=10, retries=2):
    key = (symbol, query)
    with _yahoo_cache_lock:
        if key in _yahoo_cache:
            return _yahoo_cache[key]
    result = None
    for attempt in range(retries + 1):
        url = f"https://{_YAHOO_HOSTS[attempt % 2]}/v8/finance/chart/{symbol}?{query}"
        try:
            data = json.loads(get(url, timeout=timeout))
            result = ((data.get("chart") or {}).get("result") or [None])[0]
            break
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):
                break
        except Exception:
            pass
        if attempt < retries:
            time.sleep(1.5 * (attempt + 1))
    with _yahoo_cache_lock:
        _yahoo_cache[key] = result
    return result

def yahoo_daily_bars(symbol, range_="5y"):
    """Daily closes for a Yahoo symbol as [(YYYY-MM-DD, close)], oldest first.

    Bars are dated in the exchange's local time, and a live intraday bar that
    shares a date with the day's bar replaces it. A bar stamped on a weekend
    (the Sunday-evening open of futures and FX) belongs to Monday's session,
    so it is dated Monday — otherwise Monday's "1D change" is measured against
    Monday's own first hour.
    """
    res = _yahoo_chart(symbol, f"interval=1d&range={range_}")
    out = []
    if res:
        try:
            ts = res.get("timestamp") or []
            closes = res["indicators"]["quote"][0].get("close") or []
            off = (res.get("meta") or {}).get("gmtoffset") or 0
            for t, c in zip(ts, closes):
                if c is None:
                    continue
                dt = datetime.utcfromtimestamp(t + off)
                if dt.weekday() >= 5:
                    dt += timedelta(days=7 - dt.weekday())
                d = dt.strftime("%Y-%m-%d")
                if out and out[-1][0] == d:
                    out[-1] = (d, c)
                else:
                    out.append((d, c))
        except Exception:
            out = []
    record_source("Yahoo Finance", "futures / spot prices", ok=bool(out))
    return out

def bar_near(bars, target, max_diff_days):
    """Close of the bar nearest `target` (a date) within tolerance -> (close, date_str)."""
    if not bars:
        return None, ""
    best = min(bars, key=lambda b: abs((date.fromisoformat(b[0]) - target).days))
    if abs((date.fromisoformat(best[0]) - target).days) > max_diff_days:
        return None, ""
    return best[1], best[0]

def yahoo_price(symbol):
    """Latest close for a Yahoo Finance symbol (futures, indices, FX, etc.)."""
    bars = yahoo_daily_bars(symbol, "5d")
    return round(bars[-1][1], 2) if bars else None

def yahoo_price_near_date(symbol, target_dt, max_diff_days=5):
    v, d = bar_near(yahoo_daily_bars(symbol), target_dt.date(), max_diff_days)
    return (round(v, 2), d) if v is not None else (None, "")

# Commodity futures helpers
_MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
_FUT_CODES = {1: "F", 2: "G", 3: "H", 4: "J", 5: "K", 6: "M", 7: "N", 8: "Q", 9: "U", 10: "V", 11: "X", 12: "Z"}
_GOLD_MONTHS = [2, 4, 6, 8, 10, 12]

def _advance_months(m, y, n):
    m += n
    y += (m - 1) // 12
    m = (m - 1) % 12 + 1
    return m, y

def _next_active(m, y, actives):
    for a in actives:
        if a >= m:
            return a, y
    return actives[0], y + 1

def _gold_symbol(months_ahead, base_dt=None):
    base_dt = base_dt or datetime.utcnow()
    m, y = _advance_months(base_dt.month, base_dt.year, months_ahead)
    m, y = _next_active(m, y, _GOLD_MONTHS)
    return f"GC{_FUT_CODES[m]}{y%100:02d}.CMX", f"{_MONTH_ABBR[m-1].capitalize()} {y}"

def _wti_symbol(months_ahead, base_dt=None):
    base_dt = base_dt or datetime.utcnow()
    m, y = _advance_months(base_dt.month, base_dt.year, months_ahead)
    return f"CL{_FUT_CODES[m]}{y%100:02d}.NYM", f"{_MONTH_ABBR[m-1].capitalize()} {y}"

def _brent_symbol(months_ahead, base_dt=None):
    base_dt = base_dt or datetime.utcnow()
    m, y = _advance_months(base_dt.month, base_dt.year, months_ahead)
    return f"BZ{_FUT_CODES[m]}{y%100:02d}.NYM", f"{_MONTH_ABBR[m-1].capitalize()} {y}"

def _usdinr_symbol(months_ahead, base_dt=None):
    """
    INR CME futures-style symbol.
    Falls back to continuous INR=F in fetch logic if contract ticker is unavailable.
    """
    base_dt = base_dt or datetime.utcnow()
    m, y = _advance_months(base_dt.month, base_dt.year, months_ahead)
    return f"INR{_FUT_CODES[m]}{y%100:02d}.CME", f"{_MONTH_ABBR[m-1].capitalize()} {y}"

def _boe_nominal_rows():
    """
    Official Bank of England daily nominal government liability curve archive.
    """
    if load_workbook is None:
        return []
    want = {"1Y": 1.0, "2Y": 2.0, "3Y": 3.0, "5Y": 5.0, "7Y": 7.0, "10Y": 10.0, "15Y": 15.0, "20Y": 20.0, "30Y": 30.0}
    try:
        blob = get_bytes("https://www.bankofengland.co.uk/-/media/boe/files/statistics/yield-curves/glcnominalddata.zip", timeout=20, retries=1)
        wb = load_workbook(_open_first_xlsx_from_zip(blob), data_only=True, read_only=True)
        ws = wb["4. spot curve"] if "4. spot curve" in wb.sheetnames else wb[wb.sheetnames[0]]
        rows = _extract_curve_rows_from_sheet(ws, want)
        record_source("Bank of England", "GBP gilt curve", ok=bool(rows), fallback=None if rows else "Investing/TE scrape")
        return rows
    except Exception:
        record_source("Bank of England", "GBP gilt curve", ok=False, fallback="Investing/TE scrape")
        raise

def _discover_fbil_xlsx_urls():
    urls = []
    try:
        html = get("https://www.fbil.org.in/", timeout=12)
        for href in re.findall(r'href="([^"]+\.(?:xlsx|xlsm|xls))"', html, flags=re.I):
            full = href if href.startswith("http") else f"https://www.fbil.org.in{href}"
            low = full.lower()
            if ("valuation" in low or "gsec" in low or "gs_ec" in low or "yield" in low) and "/uploads/" in low:
                urls.append(full)
    except Exception as e:
        log.warning(f"  FBIL discovery failed: {e}")

    seen = set()
    out = []
    for u in urls:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out

def _fbil_rows():
    """
    Best-effort workbook parse for latest India G-Sec curve.
    """
    if load_workbook is None:
        return []
    want = {"1Y": 1.0, "2Y": 2.0, "3Y": 3.0, "5Y": 5.0, "7Y": 7.0, "10Y": 10.0, "15Y": 15.0, "20Y": 20.0, "30Y": 30.0}
    # Bounded probe: FBIL blocks CI more often than not, so cap candidates and
    # skip retries — Investing/TE/FRED cover the curve when this fails.
    for url in _discover_fbil_xlsx_urls()[:3]:
        try:
            low = url.lower()
            if low.endswith(".xlsx") or low.endswith(".xlsm"):
                wb = _load_workbook_from_bytes(get_bytes(url, timeout=20, retries=0))
            else:
                continue
            for s in wb.sheetnames:
                rows = _extract_curve_rows_from_sheet(wb[s], want)
                if rows:
                    record_source("FBIL", "India G-Sec curve", ok=True)
                    return rows
        except Exception as e:
            log.warning(f"  FBIL parse failed for {url}: {e}")
    record_source("FBIL", "India G-Sec curve", ok=False, fallback="Investing/TE/FRED")
    return []

# ── 1. UST ──
def fetch_ust():
    log.info("UST: fetching")
    import xml.etree.ElementTree as ET
    ns = {"a": "http://www.w3.org/2005/Atom", "m": "http://schemas.microsoft.com/ado/2007/08/dataservices/metadata", "d": "http://schemas.microsoft.com/ado/2007/08/dataservices"}
    tmap = {"BC_1MONTH": "1M", "BC_3MONTH": "3M", "BC_6MONTH": "6M", "BC_1YEAR": "1Y", "BC_2YEAR": "2Y", "BC_3YEAR": "3Y", "BC_5YEAR": "5Y", "BC_7YEAR": "7Y", "BC_10YEAR": "10Y", "BC_20YEAR": "20Y", "BC_30YEAR": "30Y"}
    tenors = list(tmap.values())

    def parse_year(year):
        raw = get(f"https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value={year}")
        rows = []
        for entry in ET.fromstring(raw).findall("a:entry", ns):
            props = entry.find("a:content/m:properties", ns)
            if props is None:
                continue
            de = props.find("d:NEW_DATE", ns)
            if de is None or not de.text:
                continue
            yd = {}
            for xf, tn in tmap.items():
                el = props.find(f"d:{xf}", ns)
                try:
                    yd[tn] = round(float(el.text), 4)
                except Exception:
                    yd[tn] = None
            rows.append({"date": de.text[:10], "yields": yd})
        rows.sort(key=lambda x: x["date"], reverse=True)
        return rows

    now = datetime.utcnow()
    try:
        rows = parse_year(now.year)
        assert len(rows) >= 2
    except Exception:
        record_source("US Treasury", "UST curve", ok=False)
        raise
    record_source("US Treasury", "UST curve", ok=True)
    ya_rows = parse_year(now.year - 1)
    # Interpolate 15Y (linear between 10Y and 20Y) for all fetched rows
    for r in rows + ya_rows:
        y = r["yields"]
        y10, y20 = y.get("10Y"), y.get("20Y")
        y["15Y"] = round(y10 + (y20 - y10) * 0.5, 4) if y10 is not None and y20 is not None else None
    tenors = ['1M', '3M', '6M', '1Y', '2Y', '3Y', '5Y', '7Y', '10Y', '15Y', '20Y', '30Y']
    target_ya = (now - timedelta(days=365)).strftime("%Y-%m-%d")
    ya_yields, ya_date = [None] * len(tenors), ""
    if ya_rows:
        best = min(ya_rows, key=lambda r: abs((datetime.strptime(r["date"], "%Y-%m-%d") - datetime.strptime(target_ya, "%Y-%m-%d")).days))
        ya_yields = [best["yields"].get(t) for t in tenors]
        ya_date = best["date"]
    all_rows = rows + ya_rows
    p1m_yields, p1m_date = find_prior_date_yields(all_rows, 30, tenors)
    p3m_yields, p3m_date = find_prior_date_yields(all_rows, 91, tenors)
    log.info(f"  UST 1M ago: {p1m_date}, 3M ago: {p3m_date}")
    write("ust.json", {
        "date": rows[0]["date"],
        "prior_date": rows[1]["date"],
        "source": "US Treasury Daily Par Yield Curve",
        "url": "https://home.treasury.gov/resource-center/data-chart-center/interest-rates",
        "tenors": tenors,
        "yields": [rows[0]["yields"].get(t) for t in tenors],
        "prior_yields": [rows[1]["yields"].get(t) for t in tenors],
        "prior_1m_yields": p1m_yields,
        "prior_1m_date": p1m_date,
        "prior_3m_yields": p3m_yields,
        "prior_3m_date": p3m_date,
        "year_ago_yields": ya_yields,
        "year_ago_date": ya_date
    })
    log.info(f"  UST OK: {rows[0]['date']}")

# ── 2. JGB ──
JGB_TENORS = ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "25Y", "30Y", "40Y"]
JGB_BASE = "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate"
# jgbcme.csv only holds the CURRENT month (one row on the 1st business day,
# which used to crash the fetch); the full history lives in jgbcme_all.csv.
JGB_HISTORY_URLS = [f"{JGB_BASE}/historical/jgbcme_all.csv", f"{JGB_BASE}/jgbcme_all.csv"]

def parse_mof_jgb_csv(raw, want=JGB_TENORS):
    """Rows from an MOF JGB yield CSV, newest first: [{date, yields}]."""
    lines = raw.split("\n")
    headers, hdr_idx = [], -1
    for i, line in enumerate(lines[:5]):
        if "date" in line.lower():
            hdr_idx = i
            headers = [h.strip().strip('"') for h in line.split(",")]
            break
    if hdr_idx < 0:
        return []
    col = {h.replace(" ", ""): j for j, h in enumerate(headers) if h.replace(" ", "") in want}
    rows = []
    for line in lines[hdr_idx + 1:]:
        parts = [p.strip().strip('"') for p in line.split(",")]
        m = re.match(r"(\d{4})[/-](\d{1,2})[/-](\d{1,2})", parts[0]) if parts else None
        if not m or len(parts) < 10:
            continue
        yd = {}
        for t in want:
            try:
                yd[t] = round(float(parts[col[t]]), 4) if t in col else None
            except (ValueError, IndexError):
                yd[t] = None
        if any(v is not None for v in yd.values()):
            rows.append({"date": f"{m[1]}-{m[2].zfill(2)}-{m[3].zfill(2)}", "yields": yd})
    rows.sort(key=lambda x: x["date"], reverse=True)
    return rows

def fetch_jgb():
    log.info("JGB: fetching")
    want = JGB_TENORS
    try:
        current_rows = parse_mof_jgb_csv(get(f"{JGB_BASE}/jgbcme.csv", timeout=15))
    except Exception:
        record_source("MOF Japan", "JGB curve", ok=False)
        raise
    if not current_rows:
        record_source("MOF Japan", "JGB curve", ok=False, note="current-month CSV had no rows")
        raise RuntimeError("JGB: current-month CSV had no parsable rows")
    record_source("MOF Japan", "JGB curve", ok=True)

    hist_rows = []
    for url in JGB_HISTORY_URLS:
        try:
            hist_rows = parse_mof_jgb_csv(get(url, timeout=25))
            if hist_rows:
                break
        except Exception as e:
            log.warning(f"  JGB history {url}: {e}")
    by_date = {r["date"]: r for r in hist_rows}
    by_date.update({r["date"]: r for r in current_rows})  # current month wins
    # Our own snapshots cover the case where the history file is unreachable.
    for r in load_curve_history("jgb"):
        by_date.setdefault(r["date"], r)
    rows = sorted(by_date.values(), key=lambda r: r["date"], reverse=True)
    latest = rows[0]
    append_curve_history("jgb", latest["date"], want, [latest["yields"].get(t) for t in want], "MOF Japan")

    prior = rows[1] if len(rows) > 1 else None
    p1m_yields, p1m_date = find_prior_date_yields(rows, 30, want)
    p3m_yields, p3m_date = find_prior_date_yields(rows, 91, want)
    ya_yields, ya_date = find_prior_date_yields(rows, 365, want, max_diff_days=14)
    if not any(v is not None for v in ya_yields):
        fred_ya, fdate = fred_year_ago_10y("IRLTLT01JPM156N")
        if fred_ya:
            ya_yields[want.index("10Y")] = fred_ya
            ya_date = fdate
    log.info(f"  JGB rows: {len(current_rows)} current-month + {len(hist_rows)} history; "
             f"1M ago: {p1m_date or '-'}, 3M ago: {p3m_date or '-'}, 1Y ago: {ya_date or '-'}")
    write("jgb.json", {
        "date": latest["date"],
        "prior_date": prior["date"] if prior else "",
        "source": "Ministry of Finance Japan",
        "url": f"{JGB_BASE}/",
        "tenors": want,
        "yields": [latest["yields"].get(t) for t in want],
        "prior_yields": [prior["yields"].get(t) for t in want] if prior else [None] * len(want),
        "prior_1m_yields": p1m_yields,
        "prior_1m_date": p1m_date,
        "prior_3m_yields": p3m_yields,
        "prior_3m_date": p3m_date,
        "year_ago_yields": ya_yields,
        "year_ago_date": ya_date
    })
    log.info(f"  JGB OK: {latest['date']}")

# ── 3. GILT ──
GILT_INV = {"1Y": "/rates-bonds/uk-1-year-bond-yield", "2Y": "/rates-bonds/uk-2-year-bond-yield", "3Y": "/rates-bonds/uk-3-year-bond-yield", "5Y": "/rates-bonds/uk-5-year-bond-yield", "7Y": "/rates-bonds/uk-7-year-bond-yield", "10Y": "/rates-bonds/uk-10-year-bond-yield", "15Y": "/rates-bonds/uk-15-year-bond-yield", "20Y": "/rates-bonds/uk-20-year-bond-yield", "30Y": "/rates-bonds/uk-30-year-bond-yield"}

def fetch_gilt():
    log.info("GILT: fetching")
    tenors = ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"]

    rows = []
    try:
        rows = _boe_nominal_rows()
        if rows:
            log.info(f"  GILT official BoE rows: {len(rows)}")
    except Exception as e:
        log.warning(f"  GILT BoE failed: {e}")

    current = {}
    interpolated, cached, held, derived, last = [], [], {}, {}, None
    if rows:
        current = rows[0]["yields"].copy()
        date_str = rows[0]["date"]
        prior_yields = [rows[1]["yields"].get(t) for t in tenors] if len(rows) > 1 else [None] * len(tenors)
        prior_date = rows[1]["date"] if len(rows) > 1 else ""
        p1m_yields, p1m_date = find_prior_date_yields(rows, 30, tenors)
        p3m_yields, p3m_date = find_prior_date_yields(rows, 91, tenors)
        ya_yields, ya_date = find_prior_date_yields(rows, 365, tenors, max_diff_days=21)
        source = "Bank of England daily government liability curve (nominal)"
        source_url = "https://www.bankofengland.co.uk/-/media/boe/files/statistics/yield-curves/glcnominalddata.zip"
    else:
        scraped = _scrape_tenors(GILT_INV)
        current.update({k: v for k, v in scraped.items() if v is not None})
        te = te_bonds_table(
            "https://tradingeconomics.com/united-kingdom/government-bond-yield",
            {
                "1Y": "UK 52W",
                "2Y": "UK 2Y",
                "3Y": "UK 3Y",
                "5Y": "UK 5Y",
                "7Y": "UK 7Y",
                "10Y": "UK 10Y",
                "15Y": "UK 15Y",
                "20Y": "UK 20Y",
                "30Y": "UK 30Y",
            }
        )
        for t in tenors:
            if current.get(t) is None and te.get(t):
                current[t] = validate_yield(te[t]["current"])

        try:
            obs = fred_csv("IRLTLT01GBM156N", start="2024-01-01")
            if obs and current.get("10Y") is None:
                current["10Y"] = validate_yield(obs[0]["value"])
        except Exception:
            pass

        missing = [t for t in tenors if current.get(t) is None]
        current = interpolate_curve(current, tenors)
        interpolated = [t for t in missing if current.get(t) is not None]

        last = load_last_gilt()
        if last:
            last_y = dict(zip(last.get("tenors", []), last.get("yields", [])))
            for t in tenors:
                if current.get(t) is None and last_y.get(t) is not None:
                    current[t] = last_y[t]
                    cached.append(t)
        held = hold_spikes(current, tenors, last)

        date_str = datetime.utcnow().strftime("%Y-%m-%d")
        hist_rows = [r for r in load_curve_history("gilt") if r["date"] < date_str]
        # Prior day from our own daily snapshots (the scrape has no history).
        prior_yields, prior_date = find_prior_date_yields(hist_rows, 1, tenors, max_diff_days=5)
        if prior_date:
            derived["prior_day"] = "own history"
        p1m_yields = [te.get(t, {}).get("m1") for t in tenors]
        p1m_date = ""
        if any(v is not None for v in p1m_yields):
            derived["prior_1m"] = "TE month delta reconstruction"
        p3m_yields, p3m_date = find_prior_date_yields(hist_rows, 91, tenors)
        if p3m_date:
            derived["prior_3m"] = "own history"
        ya_yields = [te.get(t, {}).get("y1") for t in tenors]
        ya_date = ""
        if any(v is not None for v in ya_yields):
            derived["year_ago"] = "TE year delta reconstruction"
        source = "Investing.com / TradingEconomics / FRED / cache"
        source_url = "https://www.investing.com/rates-bonds/uk-government-bonds"

    valid_count = sum(1 for v in current.values() if v is not None)
    if valid_count < 3:
        raise Exception(f"GILT: insufficient data ({valid_count} tenors)")
    if cached and len(cached) == len(tenors):
        # Nothing live: rewriting the file would re-date stale numbers as today.
        log.warning("  GILT: no live quotes; keeping the previous file")
        return f"stale: no live gilt quotes; kept {(last or {}).get('date', 'previous')} curve"

    # History records live quotes only, so a carried-forward value can't later
    # pose as that day's market (and turn the next day's change into zero).
    append_curve_history("gilt", date_str, tenors,
                         [None if t in cached or t in held else current.get(t) for t in tenors], source)

    write("gilt.json", {
        "date": date_str,
        "prior_date": prior_date,
        "source": source,
        "url": source_url,
        "tenors": tenors,
        "yields": [current.get(t) for t in tenors],
        "prior_yields": prior_yields,
        "prior_1m_yields": p1m_yields,
        "prior_1m_date": p1m_date,
        "prior_3m_yields": p3m_yields,
        "prior_3m_date": p3m_date,
        "year_ago_yields": ya_yields,
        "year_ago_date": ya_date,
        "derived": derived,
        "interpolated": interpolated,
        "cached": cached,
        "held": held,
        "note": "Official BoE daily archive first; then market scrapes; then local history / cache."
    })
    log.info(f"  GILT OK: {valid_count} tenors")
    if cached:
        return f"partial: {len(cached)}/{len(tenors)} tenors carried forward"

# ── 4. EUR ──
def fetch_eur():
    log.info("EUR: fetching")
    ecb_map = {"1Y": "SR_1Y", "2Y": "SR_2Y", "3Y": "SR_3Y", "5Y": "SR_5Y", "7Y": "SR_7Y", "10Y": "SR_10Y", "15Y": "SR_15Y", "20Y": "SR_20Y", "30Y": "SR_30Y"}
    tenors = list(ecb_map.keys())
    results = {}
    for tn, sk in ecb_map.items():
        try:
            raw = get(f"https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.{sk}?lastNObservations=280&format=csvdata", timeout=15)
            lines = raw.strip().split("\n")
            if len(lines) < 2:
                continue
            header = lines[0].split(",")
            oi = next((i for i, h in enumerate(header) if "OBS_VALUE" in h), -1)
            ti = next((i for i, h in enumerate(header) if "TIME_PERIOD" in h), -1)
            if oi < 0:
                continue
            obs = []
            for line in lines[1:]:
                p = line.split(",")
                try:
                    obs.append({"date": p[ti].strip('"'), "value": round(float(p[oi]), 4)})
                except Exception:
                    pass
            obs.sort(key=lambda x: x["date"], reverse=True)
            if obs:
                results[tn] = {"value": obs[0]["value"], "prior": obs[1]["value"] if len(obs) > 1 else None, "date": obs[0]["date"], "all_obs": obs}
        except Exception as e:
            log.warning(f"  ECB {tn}: {e}")
    record_source("ECB SDW", "EUR AAA govt curve", ok=bool(results))
    if not results:
        raise RuntimeError("ECB: no tenor returned data")
    latest = max(r["date"] for r in results.values())

    def ecb_find_prior(days_ago):
        target = (datetime.utcnow() - timedelta(days=days_ago)).strftime("%Y-%m-%d")
        out = []
        d_used = ""
        for tn in tenors:
            obs_list = results.get(tn, {}).get("all_obs", [])
            if not obs_list:
                out.append(None)
                continue
            best = min(obs_list, key=lambda o: abs((datetime.strptime(o["date"], "%Y-%m-%d") - datetime.strptime(target, "%Y-%m-%d")).days))
            diff = abs((datetime.strptime(best["date"], "%Y-%m-%d") - datetime.strptime(target, "%Y-%m-%d")).days)
            if diff > 14:
                out.append(None)
            else:
                out.append(best["value"])
                d_used = best["date"]
        return out, d_used

    # ~280 business days covers the year-ago lookup (70 used to stop at ~3M).
    p1m_yields, p1m_date = ecb_find_prior(30)
    p3m_yields, p3m_date = ecb_find_prior(91)
    ya_yields, ya_date = ecb_find_prior(365)
    prior_date = next((r["all_obs"][1]["date"] for r in results.values()
                       if r["date"] == latest and len(r["all_obs"]) > 1), "")
    log.info(f"  EUR 1M ago: {p1m_date}, 3M ago: {p3m_date}")
    write("eur.json", {
        "date": latest,
        "prior_date": prior_date,
        "source": "ECB SDW (EUR AAA Govt — EIOPA proxy)",
        "url": "https://data.ecb.europa.eu/",
        "tenors": tenors,
        "yields": [results.get(t, {}).get("value") for t in tenors],
        "prior_yields": [results.get(t, {}).get("prior") for t in tenors],
        "prior_1m_yields": p1m_yields,
        "prior_1m_date": p1m_date,
        "prior_3m_yields": p3m_yields,
        "prior_3m_date": p3m_date,
        "year_ago_yields": ya_yields,
        "year_ago_date": ya_date,
        "note": "EUR AAA govt curve proxy. Actual EIOPA RFR includes UFR extrapolation."
    })
    log.info(f"  EUR OK: {latest}")

# ── 5. INDIA ──
INDIA_INV = {"1Y": "/rates-bonds/india-1-year-bond-yield", "2Y": "/rates-bonds/india-2-year-bond-yield", "3Y": "/rates-bonds/india-3-year-bond-yield", "5Y": "/rates-bonds/india-5-year-bond-yield", "7Y": "/rates-bonds/india-7-year-bond-yield", "10Y": "/rates-bonds/india-10-year-bond-yield", "15Y": "/rates-bonds/india-15-year-bond-yield", "20Y": "/rates-bonds/india-20-year-bond-yield", "30Y": "/rates-bonds/india-30-year-bond-yield"}

def fetch_india():
    log.info("INDIA: fetching")
    tenors = ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"]

    current = {}
    date_str = datetime.utcnow().strftime("%Y-%m-%d")
    source = ""
    source_url = ""

    rows = []
    try:
        rows = _fbil_rows()
        if rows:
            current = rows[0]["yields"].copy()
            date_str = rows[0]["date"]
            source = "FBIL GOI prices / par yield workbook"
            source_url = "https://www.fbil.org.in/"
            log.info(f"  INDIA FBIL rows: {len(rows)}")
    except Exception as e:
        log.warning(f"  INDIA FBIL failed: {e}")

    if not current:
        scraped = _scrape_tenors(INDIA_INV)
        current.update({k: v for k, v in scraped.items() if v is not None})
        source = "Investing.com / TradingEconomics / FRED / cache"
        source_url = "https://www.investing.com/rates-bonds/india-government-bonds"

    te = te_bonds_table(
        "https://tradingeconomics.com/india/government-bond-yield",
        {
            "1Y": "India 52W",
            "2Y": "India 2Y",
            "3Y": "India 3Y",
            "5Y": "India 5Y",
            "7Y": "India 7Y",
            "10Y": "India 10Y",
            "15Y": "India 15Y",
            "20Y": "India 20Y",
            "30Y": "India 30Y",
        }
    )

    for t in tenors:
        if current.get(t) is None and te.get(t):
            current[t] = validate_yield(te[t]["current"])

    try:
        obs = fred_csv("INDIRLTLT01STM", start="2024-01-01")
        if obs and current.get("10Y") is None:
            current["10Y"] = validate_yield(obs[0]["value"])
    except Exception:
        pass

    missing = [t for t in tenors if current.get(t) is None]
    current = interpolate_curve(current, tenors)
    interpolated = [t for t in missing if current.get(t) is not None]

    cached = []
    last = load_last_india()
    if last:
        last_y = dict(zip(last.get("tenors", []), last.get("yields", [])))
        for t in tenors:
            if current.get(t) is None and last_y.get(t) is not None:
                current[t] = last_y[t]
                cached.append(t)
    held = {} if rows else hold_spikes(current, tenors, last)

    valid_count = sum(1 for v in current.values() if v is not None)
    if valid_count < 3:
        raise Exception(f"INDIA: insufficient data ({valid_count} tenors)")
    if cached and len(cached) == len(tenors):
        log.warning("  INDIA: no live quotes; keeping the previous file")
        return f"stale: no live India quotes; kept {(last or {}).get('date', 'previous')} curve"

    # Our own stored history (excluding today) supplies prior-day and fills
    # gaps the upstream sources leave — this is what makes comparisons
    # self-healing after a day of runs.
    hist_rows = [r for r in load_curve_history("india") if r["date"] < date_str]
    derived = {}

    if rows and len(rows) > 1:
        prior_yields = [rows[1]["yields"].get(t) for t in tenors]
        prior_date = rows[1]["date"]
    else:
        prior_yields, prior_date = find_prior_date_yields(hist_rows, 1, tenors, max_diff_days=5)
        if prior_date:
            derived["prior_day"] = "own history"

    if rows and len(rows) > 2:
        p1m_yields, p1m_date = find_prior_date_yields(rows, 30, tenors)
        p3m_yields, p3m_date = find_prior_date_yields(rows, 91, tenors)
        ya_yields, ya_date = find_prior_date_yields(rows, 365, tenors, max_diff_days=21)
    else:
        p1m_yields = [te.get(t, {}).get("m1") for t in tenors]
        p1m_date = ""
        if any(v is not None for v in p1m_yields):
            derived["prior_1m"] = "TE month delta reconstruction"
        p3m_yields, p3m_date = find_prior_date_yields(hist_rows, 91, tenors)
        if p3m_date:
            derived["prior_3m"] = "own history"
        ya_yields = [te.get(t, {}).get("y1") for t in tenors]
        ya_date = ""
        if any(v is not None for v in ya_yields):
            derived["year_ago"] = "TE year delta reconstruction"
        # Only call FRED for 10Y priors that TE didn't cover (avoids expensive
        # timeout chains when FRED is under load)
        idx10 = tenors.index("10Y")
        need_p1m = p1m_yields[idx10] is None
        need_p3m = p3m_yields[idx10] is None
        need_ya  = ya_yields[idx10] is None
        if need_p1m or need_p3m or need_ya:
            try:
                if need_p1m:
                    p1m_val, p1m_d = fred_prior_single("INDIRLTLT01STM", 30)
                    if p1m_val is not None:
                        p1m_yields[idx10] = p1m_val
                        p1m_date = p1m_d or p1m_date
                if need_p3m:
                    p3m_val, p3m_d = fred_prior_single("INDIRLTLT01STM", 91)
                    if p3m_val is not None:
                        p3m_yields[idx10] = p3m_val
                        p3m_date = p3m_d or p3m_date
                if need_ya:
                    ya_val, ya_d = fred_year_ago_10y("INDIRLTLT01STM")
                    if ya_val is not None:
                        ya_yields[idx10] = ya_val
                        ya_date = ya_d or ya_date
            except Exception:
                pass

    # Fill remaining comparison gaps from our own history
    for vals, days_ago, max_diff, key in ((p1m_yields, 30, 7, "prior_1m"), (ya_yields, 365, 21, "year_ago")):
        if any(v is None for v in vals):
            hv, hd = find_prior_date_yields(hist_rows, days_ago, tenors, max_diff_days=max_diff)
            if hd:
                for i in range(len(vals)):
                    if vals[i] is None and hv[i] is not None:
                        vals[i] = hv[i]
                        derived.setdefault(key, "own history")

    append_curve_history("india", date_str, tenors,
                         [None if t in cached or t in held else current.get(t) for t in tenors], source)

    write("india.json", {
        "date": date_str,
        "source": source,
        "url": source_url,
        "tenors": tenors,
        "yields": [current.get(t) for t in tenors],
        "prior_yields": prior_yields,
        "prior_date": prior_date,
        "prior_1m_yields": p1m_yields,
        "prior_1m_date": p1m_date,
        "prior_3m_yields": p3m_yields,
        "prior_3m_date": p3m_date,
        "year_ago_yields": ya_yields,
        "year_ago_date": ya_date,
        "derived": derived,
        "interpolated": interpolated,
        "cached": cached,
        "held": held,
        "note": "FBIL latest first, then Investing/TE/FRED, then local history / cache. India 3M curve is exact once local history accumulates."
    })
    log.info(f"  INDIA OK: {valid_count} tenors")
    if cached:
        return f"partial: {len(cached)}/{len(tenors)} tenors carried forward"

# ── 6. CREDIT ──
def fetch_credit():
    log.info("CREDIT: fetching")
    series = {
        "ig": "BAMLC0A0CM",
        "aaa": "BAMLC0A1CAAA",
        "aa": "BAMLC0A2CAA",
        "a": "BAMLC0A3CA",
        "bbb": "BAMLC0A4CBBB",
        "hy": "BAMLH0A0HYM2",
        "bb": "BAMLH0A1HYBB",
        "b": "BAMLH0A2HYB",
        "ccc": "BAMLH0A3HYC",
    }
    names = {
        "ig": "US IG",
        "aaa": "US AAA",
        "aa": "US AA",
        "a": "US A",
        "bbb": "US BBB",
        "hy": "US HY",
        "bb": "US BB",
        "b": "US B",
        "ccc": "US CCC+",
    }
    buckets = {
        "ig": "IG",
        "aaa": "AAA",
        "aa": "AA",
        "a": "A",
        "bbb": "BBB",
        "hy": "HY",
        "bb": "BB",
        "b": "B",
        "ccc": "CCC",
    }

    def build_row(key, obs, source_tag):
        curr = round(obs[0]["value"] * 100)
        prev = round(obs[1]["value"] * 100) if len(obs) > 1 else curr
        return {
            "name": names[key],
            "spread": curr,
            "prior": prev,
            "bucket": buckets[key],
            "date": obs[0]["date"],
            "source": source_tag,
        }

    spreads = {}
    latest_date = ""

    # ── Stage 1: single bulk FRED call (no retries) ──
    multi = fred_multi_csv(list(series.values()), start="2024-01-01", retries=0)
    for key, sid in series.items():
        obs = multi.get(sid, [])
        if obs:
            spreads[key] = build_row(key, obs, "fred_multi")
            if obs[0]["date"] > latest_date:
                latest_date = obs[0]["date"]
            log.info(f"  Credit {key}: {spreads[key]['spread']}bp (multi)")
        else:
            log.warning(f"  Credit {key}: missing from bulk fetch")

    # ── Stage 2: alternative FRED download endpoint for missing series (parallel) ──
    missing = [key for key in series if key not in spreads]
    if missing:
        log.info(f"  Credit: trying download endpoint for: {missing}")
        with ThreadPoolExecutor(max_workers=min(4, len(missing))) as ex:
            fut_map = {ex.submit(fred_download_csv, series[key], "2024-01-01"): key for key in missing}
            for fut in as_completed(fut_map):
                key = fut_map[fut]
                try:
                    obs = fut.result()
                except Exception:
                    obs = []
                if obs:
                    spreads[key] = build_row(key, obs, "fred_download")
                    if obs[0]["date"] > latest_date:
                        latest_date = obs[0]["date"]
                    log.info(f"  Credit {key}: {spreads[key]['spread']}bp (download)")
                else:
                    log.warning(f"  Credit {key}: download endpoint also failed")

    # ── Stage 3: cache fallback for anything still missing ──
    last = load_last_credit()
    if last:
        last_spreads = last.get("spreads", {})
        for key in series:
            if key not in spreads and key in last_spreads:
                cached = dict(last_spreads[key])
                cached["source"] = "cache"
                spreads[key] = cached
                latest_date = max(latest_date, cached.get("date", ""))
                log.warning(f"  Credit {key}: using cache fallback")

    if not spreads:
        raise Exception("CREDIT: no series")

    any_cached = any(spreads[k].get("source") == "cache" for k in spreads)
    note = (
        "Single bulk FRED fetch; missing series retried via FRED download endpoint; "
        "cache fallback used for unavailable series. Values are option-adjusted spreads in basis points."
        + (" Some series are from cache." if any_cached else "")
    )

    write("credit.json", {
        "date": latest_date,
        "source": "FRED / ICE BofA Indices",
        "url": "https://fred.stlouisfed.org/release?rid=209",
        "spreads": spreads,
        # Carry forward quarter-end history maintained by fetch_credit_latest.py
        # (which runs after this script) so it survives this rewrite.
        "quarter_history": (load_last_credit() or {}).get("quarter_history", []),
        "note": note,
    })
    log.info(f"  CREDIT OK: {latest_date}, {len(spreads)} series")

# ── 6b. CDS (Credit Default Swaps) ──
def fetch_cds():
    log.info("CDS: fetching")

    # ── Part A: Corporate rating buckets — re-read credit.json (no extra FRED calls) ──
    CORP_KEY_MAP = {
        "aaa": ("aaa", "AAA Corp"),
        "aa":  ("aa",  "AA Corp"),
        "a":   ("a",   "A Corp"),
        "bbb": ("bbb", "BBB Corp"),
        "bb":  ("bb",  "BB Corp"),
        "b":   ("b",   "B Corp"),
        "ccc": ("ccc", "CCC Corp"),
    }
    corporate = {}
    try:
        credit_file = DATA / "credit.json"
        if credit_file.exists():
            credit_data = json.loads(credit_file.read_text())
            for cds_key, (credit_key, display_name) in CORP_KEY_MAP.items():
                row = credit_data.get("spreads", {}).get(credit_key)
                if row and row.get("spread") is not None:
                    corporate[cds_key] = {
                        "name": display_name,
                        "spread": row["spread"],
                        "prior": row.get("prior"),
                        "series_id": row.get("series_id", ""),
                        "date": row.get("date", ""),
                        "source": "credit.json",
                    }
    except Exception as e:
        log.warning(f"  CDS corporate: could not read credit.json: {e}")

    # ── Part B: US Sovereign 5Y CDS ──
    sovereign_spread = None
    sovereign_date = ""
    sovereign_source = ""

    # Attempt 1: TradingEconomics
    try:
        te_url = "https://tradingeconomics.com/united-states/credit-default-swap"
        text = _strip_html(get(te_url, timeout=15))
        patterns = [
            r"Credit Default Swap[^0-9]{0,40}([0-9]+(?:\.[0-9]+)?)",
            r"5\s*[Yy](?:ear)?\s+CDS[^0-9]{0,20}([0-9]+(?:\.[0-9]+)?)",
            r"Actual[^0-9]{0,60}([0-9]+(?:\.[0-9]+)?)",
            r"\b([0-9]{1,3}(?:\.[0-9]{1,2})?)\s*(?:bp|bps|basis)",
        ]
        for pat in patterns:
            m = re.search(pat, text, flags=re.I)
            if m:
                v = float(m.group(1))
                if 5 <= v <= 500:
                    sovereign_spread = round(v, 1)
                    sovereign_source = "TradingEconomics"
                    sovereign_date = datetime.utcnow().strftime("%Y-%m-%d")
                    log.info(f"  CDS sovereign (TE): {sovereign_spread}bp")
                    break
    except Exception as e:
        log.warning(f"  CDS sovereign TE scrape failed: {e}")

    # Attempt 2: worldgovernmentbonds fallback
    if sovereign_spread is None:
        try:
            wgb_url = "https://www.worldgovernmentbonds.com/credit-default-swaps/"
            text = _strip_html(get(wgb_url, timeout=15))
            for pat in [r"United\s+States[^0-9]{0,30}([0-9]+(?:\.[0-9]+)?)",
                        r"USA[^0-9]{0,20}([0-9]+(?:\.[0-9]+)?)"]:
                m = re.search(pat, text, flags=re.I)
                if m:
                    v = float(m.group(1))
                    if 5 <= v <= 500:
                        sovereign_spread = round(v, 1)
                        sovereign_source = "worldgovernmentbonds"
                        sovereign_date = datetime.utcnow().strftime("%Y-%m-%d")
                        log.info(f"  CDS sovereign (WGB): {sovereign_spread}bp")
                        break
        except Exception as e:
            log.warning(f"  CDS sovereign WGB scrape failed: {e}")

    # Sector OAS (financials / tech) used to come from four FRED ICE BofA IDs
    # (BAMLC0A0CMFIN, BAMLH0A0HYM2FIN, BAMLC8A0C7T10YEY, BAMLH0A0HYM2TMK) that
    # FRED does not publish: every run got HTTP 400, burned ~30s in fallback
    # timeouts and rendered four permanently empty rows. Dropped.
    sector = {}

    # ── Stage 3: cache fallback ──
    try:
        last_cds_file = DATA / "cds.json"
        if last_cds_file.exists():
            last_cds = json.loads(last_cds_file.read_text())

            for k in CORP_KEY_MAP:
                if k not in corporate:
                    cached_row = last_cds.get("corporate", {}).get(k)
                    if cached_row:
                        cached_row = dict(cached_row)
                        cached_row["source"] = "cache"
                        corporate[k] = cached_row

            if sovereign_spread is None:
                last_sov = last_cds.get("sovereign", {}).get("us_5y")
                if last_sov and last_sov.get("spread") is not None:
                    sovereign_spread = last_sov["spread"]
                    sovereign_date = last_sov.get("date", "")
                    sovereign_source = "cache"
                    log.warning("  CDS sovereign: using cache fallback")
    except Exception as e:
        log.warning(f"  CDS cache fallback failed: {e}")

    # ── Determine overall status ──
    fresh_corp = sum(1 for v in corporate.values() if v.get("source") == "credit.json")
    has_sov = sovereign_spread is not None and sovereign_source not in ("cache", "")
    any_cache = (
        any(v.get("source") == "cache" for v in corporate.values()) or
        sovereign_source == "cache"
    )
    if fresh_corp >= 7 and has_sov:
        status = "ok"
    elif fresh_corp >= 3 or has_sov:
        status = "partial"
    elif any_cache:
        status = "cached"
    else:
        status = "stale"

    dates = (
        [v.get("date", "") for v in corporate.values()] +
        ([sovereign_date] if sovereign_date else [])
    )
    latest_date = max(dates, default="")

    write("cds.json", {
        "date": latest_date,
        "source": "FRED ICE BofA / TradingEconomics",
        "status": status,
        "sovereign": {
            "us_5y": {
                "name": "US 5Y CDS",
                "spread": sovereign_spread,
                "prior": None,
                "date": sovereign_date,
                "source": sovereign_source,
            }
        },
        "corporate": corporate,
        "sector": sector,
    })
    log.info(f"  CDS OK: {latest_date}, status={status}, sov={sovereign_spread}, corp={len(corporate)}")
    if status != "ok":
        return f"{status}: sovereign {sovereign_source or 'unavailable'}" + (f" ({sovereign_date})" if sovereign_date else "")

# ── 7. SOFR ──
def fetch_sofr():
    log.info("SOFR: fetching from NY Fed API")
    rates = {}
    history = []
    latest_date = ""

    try:
        url = "https://markets.newyorkfed.org/api/rates/secured/sofr/last/270.json"
        raw = get(url, timeout=15)
        data = json.loads(raw)
        sofr_data = data.get("refRates", [])
        if sofr_data:
            sofr_data.sort(key=lambda x: x.get("effectiveDate", ""), reverse=True)
            latest = sofr_data[0]
            prior = sofr_data[1] if len(sofr_data) > 1 else sofr_data[0]
            latest_date = latest.get("effectiveDate", "")
            rates["SOFR"] = {
                "name": "SOFR (Daily)",
                "desc": "Secured Overnight Financing Rate",
                "rate": round(float(latest.get("percentRate", 0)), 4),
                "prior": round(float(prior.get("percentRate", 0)), 4),
                "date": latest_date,
                "volume": latest.get("volumeInBillions"),
                "percentile_25": latest.get("percentPercentile25"),
                "percentile_75": latest.get("percentPercentile75"),
            }
            log.info(f"  SOFR daily: {rates['SOFR']['rate']}% ({latest_date})")
            for d in sofr_data:
                try:
                    history.append({"date": d["effectiveDate"], "rate": round(float(d["percentRate"]), 4)})
                except Exception:
                    pass
            history.sort(key=lambda x: x["date"])
    except Exception as e:
        log.warning(f"  SOFR NY Fed API: {e}")

    try:
        url = "https://markets.newyorkfed.org/api/rates/secured/sofr/last/1.json?productType=sofrAverage"
        raw = get(url, timeout=15)
        data = json.loads(raw)
        for item in data.get("refRates", []):
            avg_type = item.get("averagingMethod", "")
            if "30" in avg_type:
                rates["30D_AVG"] = {"name": "SOFR 30-Day Avg", "desc": "30-day compounded average", "rate": round(float(item.get("percentRate", 0)), 4), "prior": None, "date": item.get("effectiveDate", "")}
                log.info(f"  SOFR 30D: {rates['30D_AVG']['rate']}%")
            elif "90" in avg_type:
                rates["90D_AVG"] = {"name": "SOFR 90-Day Avg", "desc": "90-day compounded average", "rate": round(float(item.get("percentRate", 0)), 4), "prior": None, "date": item.get("effectiveDate", "")}
                log.info(f"  SOFR 90D: {rates['90D_AVG']['rate']}%")
            elif "180" in avg_type:
                rates["180D_AVG"] = {"name": "SOFR 180-Day Avg", "desc": "180-day compounded average", "rate": round(float(item.get("percentRate", 0)), 4), "prior": None, "date": item.get("effectiveDate", "")}
                log.info(f"  SOFR 180D: {rates['180D_AVG']['rate']}%")
    except Exception as e:
        log.warning(f"  SOFR averages: {e}")

    record_source("NY Fed", "SOFR rates", ok=bool(rates), fallback=None if rates else "FRED")
    if not rates:
        log.info("  SOFR: trying FRED fallback")
        for key, sid, name, desc in [
            ("SOFR", "SOFR", "SOFR (Daily)", "Secured Overnight Financing Rate"),
            ("30D_AVG", "SOFR30DAYAVG", "SOFR 30-Day Avg", "30-day compounded average"),
            ("90D_AVG", "SOFR90DAYAVG", "SOFR 90-Day Avg", "90-day compounded average"),
            ("180D_AVG", "SOFR180DAYAVG", "SOFR 180-Day Avg", "180-day compounded average"),
        ]:
            obs = fred_csv(sid, start="2025-01-01", retries=1)
            if obs:
                rates[key] = {"name": name, "desc": desc, "rate": round(obs[0]["value"], 4), "prior": round(obs[1]["value"], 4) if len(obs) > 1 else None, "date": obs[0]["date"]}
                if key == "SOFR":
                    for o in obs[:270]:
                        history.append({"date": o["date"], "rate": round(o["value"], 4)})
                    history.sort(key=lambda x: x["date"])
                    if obs[0]["date"] > latest_date:
                        latest_date = obs[0]["date"]
            time.sleep(1)

    assert rates, "SOFR: no data from NY Fed or FRED"

    ya_rate, ya_date = None, ""
    try:
        target = (datetime.utcnow() - timedelta(days=365)).strftime("%Y-%m-%d")
        url = f"https://markets.newyorkfed.org/api/rates/secured/sofr/search.json?startDate={(datetime.utcnow()-timedelta(days=370)).strftime('%Y-%m-%d')}&endDate={(datetime.utcnow()-timedelta(days=360)).strftime('%Y-%m-%d')}"
        raw = get(url, timeout=10)
        data = json.loads(raw)
        ya_data = data.get("refRates", [])
        if ya_data:
            best = min(ya_data, key=lambda x: abs((datetime.strptime(x["effectiveDate"], "%Y-%m-%d") - datetime.strptime(target, "%Y-%m-%d")).days))
            ya_rate = round(float(best["percentRate"]), 4)
            ya_date = best["effectiveDate"]
    except Exception:
        pass
    if ya_rate is None:
        ya_rate, ya_date = fred_year_ago_10y("SOFR")

    log.info(f"  SOFR year-ago: {ya_rate}% ({ya_date})")

    # Merge UST 3M and 1Y into history records
    try:
        one_yr_ago = (datetime.utcnow() - timedelta(days=380)).strftime("%Y-%m-%d")
        ust_raw = fred_multi_csv(["DGS3MO", "DGS1"], start=one_yr_ago)
        ust_3m_map = {o["date"]: round(o["value"], 4) for o in (ust_raw.get("DGS3MO") or [])}
        ust_1y_map = {o["date"]: round(o["value"], 4) for o in (ust_raw.get("DGS1")   or [])}
        for rec in history:
            rec["ust_3m"] = ust_3m_map.get(rec["date"])
            rec["ust_1y"] = ust_1y_map.get(rec["date"])
        log.info(f"  UST 3M/1Y merged: {len(ust_3m_map)} / {len(ust_1y_map)} observations")
    except Exception as e:
        log.warning(f"  UST history merge: {e}")

    # Compounded SOFR averages (NY Fed, published on FRED). CME Term SOFR is
    # licensed and not on FRED — the old SOFRTERM* series IDs never existed,
    # which is why this table was always empty.
    term_rates = {}
    try:
        tr_start = (datetime.utcnow() - timedelta(days=14)).strftime("%Y-%m-%d")
        tr_raw = fred_multi_csv(["SOFR30DAYAVG", "SOFR90DAYAVG", "SOFR180DAYAVG"], start=tr_start)
        term_map = {"SOFR30DAYAVG": "1M", "SOFR90DAYAVG": "3M", "SOFR180DAYAVG": "6M"}
        term_labels = {"1M": "SOFR 30D Avg", "3M": "SOFR 90D Avg", "6M": "SOFR 180D Avg"}
        for sid, key in term_map.items():
            obs = tr_raw.get(sid) or []
            if obs:
                cur = obs[0]
                prior = obs[1] if len(obs) > 1 else None
                term_rates[key] = {
                    "name": term_labels[key],
                    "rate": round(cur["value"], 4),
                    "prior": round(prior["value"], 4) if prior else None,
                    "date": cur["date"],
                }
        log.info(f"  SOFR averages: {list(term_rates.keys())}")
    except Exception as e:
        log.warning(f"  SOFR averages: {e}")

    write("sofr.json", {
        "date": latest_date,
        "source": "NY Fed / FRED",
        "url": "https://www.newyorkfed.org/markets/reference-rates/sofr",
        "rates": rates,
        "history": history,
        "year_ago": {"rate": ya_rate, "date": ya_date},
        "term_rates": term_rates,
        "note": "Published daily by NY Fed at ~8:00 AM ET. Averages are backward-looking compounded (30/90/180-day) via FRED."
    })
    log.info(f"  SOFR OK: {latest_date}")


def _parse_iso_prefix_date_from_url(url):
    m = re.search(r"/documents/(\d{4}-\d{2}-\d{2})-", url)
    if m:
        try:
            return datetime.strptime(m.group(1), "%Y-%m-%d")
        except Exception:
            return None
    return None

def _quarter_end_from_date(dt):
    q = (dt.month - 1) // 3 + 1
    if q == 1:
        return datetime(dt.year, 3, 31)
    if q == 2:
        return datetime(dt.year, 6, 30)
    if q == 3:
        return datetime(dt.year, 9, 30)
    return datetime(dt.year, 12, 31)

def _quarter_label(dt):
    q = (dt.month - 1) // 3 + 1
    return f"{dt.year} Q{q}"

def _bma_filename_title_date(url):
    return extract_date_from_url(url)

def _bma_normalize_tenor(v):
    if v is None:
        return None
    s = str(v).strip().lower()
    m = re.match(r"(\d+)\s*year", s)
    if m:
        return f"{int(m.group(1))}Y"
    m = re.match(r"(\d+)\s*month", s)
    if m:
        return f"{int(m.group(1))}M"
    return None

def _bma_currency_code(name):
    mapping = {
        "US": "USD",
        "UK": "GBP",
        "Switzerland": "CHF",
        "Canada": "CAD",
        "Japan": "JPY",
        "Australia": "AUD",
        "New Zealand": "NZD",
        "Euro Area": "EUR",
        "EUR": "EUR",
        "Europe": "EUR",
    }
    s = str(name).strip()
    return mapping.get(s, s.upper()[:3])

BMA_KNOWN_DISCOUNT_FILES = {
    "2026-03-31": "https://cdn.bma.bm/documents/2026-04-15-16-51-45-Discounts-Rates.-31-March-2026.xlsx",
    "2025-12-31": "https://cdn.bma.bm/documents/2026-01-15-11-20-15-Discount-Rates.-31-December-2025.xlsx",
    "2025-09-30": "https://cdn.bma.bm/documents/2025-10-22-15-18-14-Discount-Rates.-30-September-2025..xlsx",
    "2025-06-30": "https://cdn.bma.bm/documents/2025-07-18-10-22-07-Discount-Rates.-30-June-2025..xlsx",
    "2025-03-31": "https://cdn.bma.bm/documents/2025-04-15-14-44-04-Discount-Rates.-31-March-2025..xlsx",
    "2024-12-31": "https://cdn.bma.bm/documents/2025-01-17-16-39-24-Discount-Rates.-31-December-2024..xlsx",
}

BMA_DOC_PAGES = [
    "https://www.bma.bm/documents-centre/documents-reporting-forms-and-guidelines/documents-insurance",
    "https://www.bma.bm/documents-centre/documents-reporting-forms-and-guidelines",
    "https://www.bma.bm/document-centre/reporting-forms-and-guidelines-insurance",
    "https://www.bma.bm/document-centre/reporting-forms-and-guidelines",
]

def _bma_discover_discount_files():
    """
    Discover BMA discount-rate workbooks/attachments from several BMA document-centre pages.
    Falls back to a small recent-quarter map because the site markup and pagination are inconsistent.
    """
    entries = {}

    def upsert(as_of_dt, uploaded_dt, url, source_page):
        if not as_of_dt or not url:
            return
        key = as_of_dt.strftime("%Y-%m-%d")
        cur = entries.get(key)
        candidate = {
            "as_of_dt": as_of_dt,
            "as_of": as_of_dt.strftime("%d %B %Y").lstrip("0"),
            "uploaded_dt": uploaded_dt,
            "uploaded_on": uploaded_dt.strftime("%d %B %Y").lstrip("0") if uploaded_dt else "",
            "url": url,
            "source_page": source_page,
        }
        if (cur is None) or ((uploaded_dt or datetime.min) > (cur.get("uploaded_dt") or datetime.min)):
            entries[key] = candidate

    href_pat = re.compile(r'href="([^"]*(?:Discount[-\s_.]*Rates|discount[-\s_.]*rates)[^"]*\.(?:xlsx|xlsm|xls|pdf))"', re.I)
    title_pat = re.compile(r"Discount\s+Rates\.?\s*(\d{1,2}\s+\w+\s+\d{4})", re.I)
    upload_pat = re.compile(r"Uploaded on\s+(\d{1,2}\s+\w+\s+\d{4})", re.I)

    for page in BMA_DOC_PAGES:
        try:
            html = get(page, timeout=20)
        except Exception as e:
            log.warning(f"  BMA page fetch failed {page}: {e}")
            continue

        # Strong block-level parse: title + uploaded date + href in proximity.
        block_pat = re.compile(
            r"Discount\s+Rates\.?\s*(\d{1,2}\s+\w+\s+\d{4}).{0,1200}?Uploaded on\s+(\d{1,2}\s+\w+\s+\d{4}).{0,1200}?href=\"([^\"]*(?:Discount[-\s_.]*Rates|discount[-\s_.]*rates)[^\"]*\.(?:xlsx|xlsm|xls|pdf))\"",
            re.I | re.S
        )
        for asof_raw, uploaded_raw, href_raw in block_pat.findall(html):
            as_of_dt = parse_d(asof_raw)
            uploaded_dt = parse_d(uploaded_raw)
            url = href_raw if href_raw.startswith("http") else f"https://www.bma.bm{href_raw}"
            upsert(as_of_dt, uploaded_dt, url, page)

        # Generic href scan with context fallback.
        for m in href_pat.finditer(html):
            href_raw = m.group(1)
            url = href_raw if href_raw.startswith("http") else f"https://www.bma.bm{href_raw}"
            context = html[max(0, m.start()-1200):m.end()+1200]
            asof_dt = None
            uploaded_dt = None
            mt = title_pat.search(context)
            mu = upload_pat.search(context)
            if mt:
                asof_dt = parse_d(mt.group(1))
            if mu:
                uploaded_dt = parse_d(mu.group(1))
            if asof_dt is None:
                asof_dt = _bma_filename_title_date(url)
            if uploaded_dt is None:
                uploaded_dt = _parse_iso_prefix_date_from_url(url)
            upsert(asof_dt, uploaded_dt, url, page)

    # Recent-quarter hard fallback for resilience.
    for k, url in BMA_KNOWN_DISCOUNT_FILES.items():
        as_of_dt = datetime.strptime(k, "%Y-%m-%d")
        uploaded_dt = _parse_iso_prefix_date_from_url(url)
        upsert(as_of_dt, uploaded_dt, url, "known_fallback")

    # User-maintained override: bma.bm now blocks non-browser clients, so new
    # quarterly workbook URLs can be dropped into bma_rates_manual.json
    # ("known_files": {"YYYY-MM-DD": "https://cdn.bma.bm/...xlsx"}) and are
    # picked up here without a code change.
    try:
        manual_path = DATA / "bma_rates_manual.json"
        if manual_path.exists():
            manual_files = (json.loads(manual_path.read_text()) or {}).get("known_files") or {}
            for k, url in manual_files.items():
                if k.startswith("_") or not isinstance(url, str) or "cdn.bma.bm" not in url:
                    continue
                try:
                    as_of_dt = datetime.strptime(k, "%Y-%m-%d")
                except ValueError:
                    log.warning(f"  BMA manual known_files: bad date key {k!r} (want YYYY-MM-DD)")
                    continue
                uploaded_dt = _parse_iso_prefix_date_from_url(url)
                upsert(as_of_dt, uploaded_dt, url, "manual")
    except Exception as e:
        log.warning(f"  BMA manual known_files: {e}")

    out = list(entries.values())
    out.sort(key=lambda x: (x["as_of_dt"], x["uploaded_dt"] or datetime.min), reverse=True)
    return out

def _bma_extract_table(ws, title_text):
    title_cell = None
    for r in range(1, min(ws.max_row, 25) + 1):
        for c in range(1, min(ws.max_column, 30) + 1):
            v = ws.cell(r, c).value
            if isinstance(v, str) and title_text.lower() in v.lower():
                title_cell = (r, c)
                break
        if title_cell:
            break
    if not title_cell:
        return {}

    title_row, title_col = title_cell
    header_row = title_row + 1
    maturity_col = title_col
    currencies = []
    c = maturity_col + 1
    while c <= ws.max_column:
        hv = ws.cell(header_row, c).value
        if hv in (None, ""):
            break
        currencies.append((c, _bma_currency_code(hv)))
        c += 1

    table = {ccy: {} for _, ccy in currencies}
    r = header_row + 1
    blank_streak = 0
    while r <= ws.max_row:
        tenor = _bma_normalize_tenor(ws.cell(r, maturity_col).value)
        if not tenor:
            blank_streak += 1
            if blank_streak >= 2:
                break
            r += 1
            continue
        blank_streak = 0
        for c, ccy in currencies:
            val = ws.cell(r, c).value
            if isinstance(val, (int, float)):
                # Some BMA sheets store decimals (0.045) while others store percent values (4.5).
                v = float(val)
                v = v * 100.0 if abs(v) <= 1.0 else v
                table[ccy][tenor] = round(v, 6)
            else:
                parsed = _as_float(val)
                if parsed is not None and abs(parsed) <= 1.0:
                    parsed *= 100.0
                table[ccy][tenor] = round(parsed, 6) if parsed is not None else None
        r += 1
    return table

def _bma_parse_discount_workbook(blob):
    if load_workbook is None:
        raise RuntimeError("openpyxl not available for BMA workbook parsing")

    wb = load_workbook(io.BytesIO(blob), data_only=True, read_only=True)
    ws = wb[wb.sheetnames[0]]

    change_header = ""
    change_note = ""
    for r in range(1, 6):
        v = ws.cell(r, 2).value
        if isinstance(v, str) and "Changes for" in v:
            change_header = v.strip().rstrip(":")
            v2 = ws.cell(r + 1, 2).value
            if isinstance(v2, str):
                change_note = v2.strip()
            break

    risk_free = _bma_extract_table(ws, "Risk-Free Spot Rates")
    standard = _bma_extract_table(ws, "Standard Spot Rates")

    selected_tenors = ["0.5Y", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "25Y", "30Y", "40Y", "50Y"]
    all_currencies = sorted(set(risk_free.keys()) | set(standard.keys()))

    currencies = {}
    for ccy in all_currencies:
        currencies[ccy] = {
            "risk_free_rates": [risk_free.get(ccy, {}).get(t) for t in selected_tenors],
            "standard_spot_rates": [standard.get(ccy, {}).get(t) for t in selected_tenors],
            # Preserve a simple legacy alias for downstream consumers.
            "rates": [standard.get(ccy, {}).get(t) for t in selected_tenors],
        }

    return {
        "sheet": ws.title,
        "change_header": change_header,
        "change_note": change_note,
        "tenors": selected_tenors,
        "currencies": currencies,
        "available_currencies": all_currencies,
    }

def _bma_load_quarter_url_cache():
    f = DATA / "bma_discount_url_cache.json"
    try:
        if f.exists():
            return json.loads(f.read_text())
    except Exception:
        pass
    return {}

def _bma_validate_quarter_payload(quarter):
    """Validate quarter payload and reject obvious absolute-value parse errors."""
    tenors = quarter.get("tenors", [])
    currencies = quarter.get("currencies", {})
    if not tenors or not currencies:
        return False, "missing tenors/currencies"

    non_null = 0
    for ccy, cdata in currencies.items():
        for key in ("risk_free_rates", "standard_spot_rates"):
            arr = cdata.get(key, [])
            if len(arr) != len(tenors):
                return False, f"{ccy} {key} length mismatch"
            for v in arr:
                if v is None:
                    continue
                non_null += 1
                # Guardrail for incorrectly-scaled values like 450 instead of 4.50.
                if v < -5 or v > 30:
                    return False, f"{ccy} {key} out-of-range value {v}"
    if non_null < 20:
        return False, "too few populated points"
    return True, "ok"

def _bma_save_quarter_url_cache(entries):
    f = DATA / "bma_discount_url_cache.json"
    cache = {}
    for e in entries:
        key = e["as_of_dt"].strftime("%Y-%m-%d")
        cache[key] = {
            "url": e.get("url", ""),
            "uploaded_on": e.get("uploaded_on", ""),
            "source_page": e.get("source_page", ""),
        }
    try:
        f.write_text(json.dumps(cache, indent=2))
    except Exception as e:
        log.warning(f"  BMA cache write failed: {e}")

def _bma_merge_cache_entries(entries):
    merged = {e["as_of_dt"].strftime("%Y-%m-%d"): e for e in entries}
    cache = _bma_load_quarter_url_cache()
    for k, v in cache.items():
        if k not in merged and v.get("url"):
            try:
                as_of_dt = datetime.strptime(k, "%Y-%m-%d")
            except Exception:
                continue
            uploaded_dt = parse_d(v.get("uploaded_on", "")) or _parse_iso_prefix_date_from_url(v.get("url", ""))
            merged[k] = {
                "as_of_dt": as_of_dt,
                "as_of": as_of_dt.strftime("%d %B %Y").lstrip("0"),
                "uploaded_dt": uploaded_dt,
                "uploaded_on": uploaded_dt.strftime("%d %B %Y").lstrip("0") if uploaded_dt else v.get("uploaded_on", ""),
                "url": v.get("url", ""),
                "source_page": v.get("source_page", "cache"),
            }
    out = list(merged.values())
    out.sort(key=lambda x: (x["as_of_dt"], x["uploaded_dt"] or datetime.min), reverse=True)
    return out

def _bma_bp_diff(a, b):
    if a is None or b is None:
        return None
    return round((a - b) * 100, 2)

def _bma_build_comparison(quarters):
    if not quarters:
        return {}
    latest = quarters[0]
    prev = quarters[1] if len(quarters) > 1 else None
    oldest = quarters[-1] if len(quarters) > 1 else None
    all_ccy = sorted(set().union(*[set(q.get("currencies", {}).keys()) for q in quarters]))
    tenors = latest.get("tenors", [])
    out = {}
    for ccy in all_ccy:
        rf_latest = latest.get("currencies", {}).get(ccy, {}).get("risk_free_rates", [None] * len(tenors))
        ss_latest = latest.get("currencies", {}).get(ccy, {}).get("standard_spot_rates", [None] * len(tenors))
        rf_prev = prev.get("currencies", {}).get(ccy, {}).get("risk_free_rates", [None] * len(tenors)) if prev else [None] * len(tenors)
        ss_prev = prev.get("currencies", {}).get(ccy, {}).get("standard_spot_rates", [None] * len(tenors)) if prev else [None] * len(tenors)
        rf_old = oldest.get("currencies", {}).get(ccy, {}).get("risk_free_rates", [None] * len(tenors)) if oldest else [None] * len(tenors)
        ss_old = oldest.get("currencies", {}).get(ccy, {}).get("standard_spot_rates", [None] * len(tenors)) if oldest else [None] * len(tenors)
        out[ccy] = {
            "risk_free_qoq_bp": [_bma_bp_diff(a, b) for a, b in zip(rf_latest, rf_prev)],
            "standard_spot_qoq_bp": [_bma_bp_diff(a, b) for a, b in zip(ss_latest, ss_prev)],
            "risk_free_vs_3q_ago_bp": [_bma_bp_diff(a, b) for a, b in zip(rf_latest, rf_old)],
            "standard_spot_vs_3q_ago_bp": [_bma_bp_diff(a, b) for a, b in zip(ss_latest, ss_old)],
        }
    return out


# ── 8. BMA RATES ──
def fetch_bma_rates():
    log.info("BMA RATES: fetching")
    manual_file = DATA / "bma_rates_manual.json"
    manual = json.loads(manual_file.read_text()) if manual_file.exists() else None

    entries = _bma_merge_cache_entries(_bma_discover_discount_files())
    _bma_save_quarter_url_cache(entries)

    latest = entries[0] if entries else None
    quarter_entries = []
    seen_quarters = set()
    for e in entries:
        qkey = e["as_of_dt"].strftime("%Y-%m-%d")
        if qkey not in seen_quarters:
            quarter_entries.append(e)
            seen_quarters.add(qkey)
        if len(quarter_entries) >= 4:
            break

    quarter_data = []
    for e in quarter_entries:
        parsed = None
        try:
            if e["url"].lower().endswith((".xlsx", ".xlsm", ".xls")):
                blob = get_bytes(e["url"], timeout=30, retries=2)
                parsed = _bma_parse_discount_workbook(blob)
                log.info(f"  BMA parsed workbook: {e['as_of']} ({e['url']})")
        except Exception as ex:
            log.warning(f"  BMA workbook parse failed for {e['as_of']}: {ex}")

        if parsed is None and manual and "quarters" in manual:
            parsed = manual["quarters"].get(e["as_of_dt"].strftime("%Y-%m-%d"))

        if parsed is not None:
            candidate = {
                "as_of_date": e["as_of_dt"].strftime("%Y-%m-%d"),
                "as_of_display": e["as_of"],
                "publication_date": e["uploaded_dt"].strftime("%Y-%m-%d") if e.get("uploaded_dt") else "",
                "publication_display": e.get("uploaded_on", ""),
                "quarter": _quarter_label(e["as_of_dt"]),
                "url": e["url"],
                "source_page": e.get("source_page", ""),
                "change_header": parsed.get("change_header", ""),
                "change_note": parsed.get("change_note", ""),
                "tenors": parsed.get("tenors", []),
                "available_currencies": parsed.get("available_currencies", []),
                "currencies": parsed.get("currencies", {}),
            }
            ok, reason = _bma_validate_quarter_payload(candidate)
            if not ok:
                log.warning(f"  BMA validation rejected {candidate['as_of_date']}: {reason}")
                continue
            quarter_data.append(candidate)
        else:
            quarter_data.append({
                "as_of_date": e["as_of_dt"].strftime("%Y-%m-%d"),
                "as_of_display": e["as_of"],
                "publication_date": e["uploaded_dt"].strftime("%Y-%m-%d") if e.get("uploaded_dt") else "",
                "publication_display": e.get("uploaded_on", ""),
                "quarter": _quarter_label(e["as_of_dt"]),
                "url": e["url"],
                "source_page": e.get("source_page", ""),
                "change_header": "",
                "change_note": "",
                "tenors": ["0.5Y", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "25Y", "30Y", "40Y", "50Y"],
                "available_currencies": [],
                "currencies": {},
            })

    quarter_data = sorted(quarter_data, key=lambda q: q.get("as_of_date", ""), reverse=True)[:4]
    latest_q = quarter_data[0] if quarter_data else None
    comparison = _bma_build_comparison(quarter_data)

    # Preserve a compact top-level shape for downstream consumers.
    if latest_q:
        top_tenors = latest_q.get("tenors", ["0.5Y", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "25Y", "30Y", "40Y", "50Y"])
        top_currencies = latest_q.get("currencies", {})
    else:
        top_tenors = ["0.5Y", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "25Y", "30Y", "40Y", "50Y"]
        top_currencies = {}

    output = {
        "as_of_date": latest_q.get("as_of_display", "") if latest_q else (manual or {}).get("as_of_date", "Check BMA website"),
        "as_of_date_iso": latest_q.get("as_of_date", "") if latest_q else "",
        "publication_date": latest_q.get("publication_display", "") if latest_q else "",
        "publication_date_iso": latest_q.get("publication_date", "") if latest_q else "",
        "source": "BMA — EBS Discount Rates",
        "url": "https://www.bma.bm/documents-centre/documents-reporting-forms-and-guidelines/documents-insurance",
        "pdf_url": latest_q.get("url", "") if latest_q else "",
        "tenors": top_tenors,
        "currencies": top_currencies,
        "all_publications": [
            {
                "as_of": e["as_of"],
                "as_of_date": e["as_of_dt"].strftime("%Y-%m-%d"),
                "published": e.get("uploaded_on", ""),
                "published_date": e["uploaded_dt"].strftime("%Y-%m-%d") if e.get("uploaded_dt") else "",
                "url": e["url"],
                "source_page": e.get("source_page", ""),
            }
            for e in entries[:12]
        ],
        "quarter_history": quarter_data,
        "comparison": comparison,
        "note": (
            "Latest available BMA discount-rate workbook plus prior three quarter-end workbooks. "
            "Current top-level currencies are the latest quarter. "
            "For each currency, 'rates' aliases standard_spot_rates for backward compatibility."
        ),
    }

    # Optional manual override merge.
    if manual:
        if not output["currencies"] and manual.get("currencies"):
            output["currencies"] = manual["currencies"]
        if manual.get("tenors") and not latest_q:
            output["tenors"] = manual["tenors"]
        if manual.get("quarter_history") and not quarter_data:
            output["quarter_history"] = manual["quarter_history"]

    if not output["quarter_history"] and not output["currencies"]:
        last = load_last_bma()
        if last:
            output = last
            output["note"] = str(output.get("note", "")) + " Cache fallback used."

    # Staleness check: BMA publishes ~2-4 weeks after quarter end. If the most
    # recent completed quarter (with 35 days publication grace) is newer than
    # what we have, flag it so the dashboard says so explicitly.
    now = datetime.utcnow()
    grace = now - timedelta(days=35)
    q_month = ((grace.month - 1) // 3) * 3
    if q_month == 0:
        expected_q_end = datetime(grace.year - 1, 12, 31)
    else:
        last_day = {3: 31, 6: 30, 9: 30}[q_month]
        expected_q_end = datetime(grace.year, q_month, last_day)
    expected_iso = expected_q_end.strftime("%Y-%m-%d")
    have_iso = output.get("as_of_date_iso") or ""
    output["expected_as_of"] = expected_iso
    output["stale"] = bool(have_iso) and have_iso < expected_iso
    if output["stale"]:
        output["note"] = str(output.get("note", "")) + (
            f" STALE: the {expected_iso} workbook should be published by now but was not found —"
            " bma.bm blocks automated clients. Paste its URL into data/bma_rates_manual.json under known_files."
        )
        log.warning(f"  BMA RATES stale: have {have_iso}, expected {expected_iso}")
    discovered_live = any(
        e.get("source_page") not in ("known_fallback", "manual") for e in entries
    )
    record_source(
        "BMA", "EBS discount rates",
        ok=discovered_live and not output["stale"],
        fallback=None if discovered_live else ("manual known_files" if not output["stale"] else "cache"),
        note=f"latest quarter {have_iso or '?'}; expected {expected_iso}",
    )

    write("bma_rates.json", output)
    log.info(f"  BMA RATES OK: {output.get('as_of_date_iso') or output.get('as_of_date','')}")
    if output.get("stale"):
        return f"stale: latest workbook {have_iso}, expected {expected_iso}"

# ── 9. COMMODITIES ──
COMM_TENOR_NS = [("3M", 3), ("6M", 6), ("12M", 12), ("24M", 24)]
# (label, days back, match tolerance in days). Anchored on the spot's own date.
COMM_PRIOR_HORIZONS = [("1m", 30, 14), ("3m", 91, 14), ("1y", 365, 14), ("2y", 730, 21)]
# Futures history is roll-aware: further back the contract is less certain to
# have traded right on the target date, so 1y/2y get a wider window.
FUT_PRIOR_MAX_DIFF = {"1m": 5, "3m": 5, "1y": 7, "2y": 10}
# A quote older than this is treated as not trading (illiquid / delisted).
FUT_STALE_DAYS = 7
COMM_HISTORY_FILE = DATA / "commodities_history.jsonl"
COMM_HISTORY_KEEP_DAYS = 800

COMMODITY_SPECS = {
    # Gold "spot" is physical XAU/USD. The front-month future (GC=F) is the
    # same contract as the 3M tenor, so using it as spot would zero out the
    # curve's contango; it's only a sanity reference and last-resort proxy.
    # (FRED's LBMA series GOLDAMGBD228NLBM was discontinued; it 400s.)
    "gold":  {"label": "Gold", "unit": "USD/troy oz", "front": "GC=F", "fred": None,
              "te": "https://tradingeconomics.com/commodity/gold", "inv": "/commodities/gold",
              "true_spot": True, "tol": 0.08, "sym_fn": _gold_symbol},
    # Crude "spot" is quoted off the front-month future, which trades daily.
    # FRED's EIA series (DCOILWTICO/DCOILBRENTEU) publish weekly with a lag of
    # up to a week, so they're a fallback only.
    "wti":   {"label": "WTI", "unit": "USD/barrel", "front": "CL=F", "fred": "DCOILWTICO",
              "te": "https://tradingeconomics.com/commodity/crude-oil", "inv": "/commodities/crude-oil",
              "true_spot": False, "tol": 0.30, "sym_fn": _wti_symbol},
    "brent": {"label": "Brent", "unit": "USD/barrel", "front": "BZ=F", "fred": "DCOILBRENTEU",
              "te": "https://tradingeconomics.com/commodity/brent-crude-oil", "inv": "/commodities/brent-oil",
              "true_spot": False, "tol": 0.30, "sym_fn": _brent_symbol},
}

def _plausible(v, ref, tol):
    """Reject scraped values that are clearly the wrong number (e.g. a gold
    scrape once returned 91.5): within ±tol of a reference price."""
    if v is None or v <= 0:
        return False
    return ref is None or abs(v - ref) / ref <= tol

def swissquote_xau():
    """Keyless XAU/USD mid from Swissquote's public quote feed."""
    try:
        data = json.loads(get("https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD", timeout=8))
        for platform in data or []:
            for prof in platform.get("spreadProfilePrices") or []:
                bid, ask = prof.get("bid"), prof.get("ask")
                if bid and ask:
                    return round((float(bid) + float(ask)) / 2, 2)
    except Exception:
        pass
    return None

def gold_api_xau():
    """Keyless XAU/USD from gold-api.com."""
    try:
        v = float(json.loads(get("https://api.gold-api.com/price/XAU", timeout=8))["price"])
        return round(v, 2) if v > 0 else None
    except Exception:
        return None

def _spot_kind(key, source):
    """Which series a spot value belongs to, so priors are only ever compared
    like-for-like: 'spot' (physical XAU), 'front' (front-month future) or
    'fred' (EIA physical crude)."""
    source = source or ""
    if source.startswith("FRED"):
        return "fred"
    if source.startswith("Yahoo"):
        return "front"
    if source.startswith("cache"):
        return None
    return "spot" if COMMODITY_SPECS[key]["true_spot"] else "front"

def load_commodity_history():
    rows = []
    try:
        if COMM_HISTORY_FILE.exists():
            for line in COMM_HISTORY_FILE.read_text().splitlines():
                if line.strip():
                    rows.append(json.loads(line))
    except Exception as e:
        log.warning(f"  commodity history load failed: {e}")
    rows.sort(key=lambda r: r.get("date", ""))
    return rows

def commodity_history_row(payload, row_date, live=True):
    """Compact per-day snapshot of a commodities.json payload.

    live=True keeps only prices fetched this run (no cache carry-forwards);
    the git backfill passes live=False since old payloads lack those flags.
    """
    row = {"date": row_date}
    for key, spec in COMMODITY_SPECS.items():
        c = payload.get(key) or {}
        futs = {}
        for t, f in (c.get("futures") or {}).items():
            if not isinstance(f, dict) or f.get("price") is None:
                continue
            if live and (f.get("price_source") != "Yahoo" or f.get("stale")):
                continue
            futs[t] = {"price": f["price"], "contract": f.get("contract")}
        entry = {}
        spot = c.get("spot")
        kind = c.get("spot_kind") or _spot_kind(key, c.get("spot_source"))
        if live and c.get("spot_source") == "cache":
            kind = None
        ref = (futs.get("3M") or {}).get("price")
        if spot is not None and kind and kind != "fred" and _plausible(spot, ref, spec["tol"]):
            entry.update({"spot": spot, "spot_date": c.get("spot_date") or row_date, "spot_kind": kind})
        if futs:
            entry["futures"] = futs
        if entry:
            row[key] = entry
    return row

def save_commodity_history(row):
    """Upsert today's snapshot. Merges into an earlier run's row for the same
    day, so a later run where some source failed can't erase what the earlier
    one captured."""
    cutoff = (datetime.utcnow() - timedelta(days=COMM_HISTORY_KEEP_DAYS)).strftime("%Y-%m-%d")
    rows = [r for r in load_commodity_history() if r.get("date", "") >= cutoff]
    prev = next((r for r in rows if r["date"] == row["date"]), {})
    rows = [r for r in rows if r["date"] != row["date"]]
    for key in COMMODITY_SPECS:
        old, new = prev.get(key) or {}, row.get(key) or {}
        merged = {**old, **{k: v for k, v in new.items() if k != "futures"}}
        futs = {**(old.get("futures") or {}), **(new.get("futures") or {})}
        if futs:
            merged["futures"] = futs
        if merged:
            row[key] = merged
    rows.append(row)
    rows.sort(key=lambda r: r["date"])
    COMM_HISTORY_FILE.write_text("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in rows))

def _history_spot_bars(history, key, kind):
    by_date = {}
    for r in history:
        e = r.get(key) or {}
        if e.get("spot") is not None and e.get("spot_kind") == kind:
            by_date[e.get("spot_date") or r["date"]] = e["spot"]
    return sorted(by_date.items())

def _history_future(history, key, tenor, target, max_diff_days):
    cands = [(r["date"], ((r.get(key) or {}).get("futures") or {}).get(tenor)) for r in history]
    cands = [(d, f) for d, f in cands if f and f.get("price") is not None]
    if not cands:
        return None, "", ""
    d, f = min(cands, key=lambda x: abs((date.fromisoformat(x[0]) - target).days))
    if abs((date.fromisoformat(d) - target).days) > max_diff_days:
        return None, "", ""
    return f["price"], d, f.get("contract") or ""

def _priors_from_bars(bars, spot_date):
    """{horizon: (close, date)} from an oldest-first bar list.

    1d is the previous trading session before the spot's date, not "the bar
    nearest 24h ago" (on a Monday that is often Monday itself -> 0% change).
    """
    out = {}
    if not bars or not spot_date:
        return out
    anchor = date.fromisoformat(spot_date)
    prev = [b for b in bars if b[0] < spot_date]
    if prev and (anchor - date.fromisoformat(prev[-1][0])).days <= 5:
        out["1d"] = (round(prev[-1][1], 2), prev[-1][0])
    for lbl, days, tol in COMM_PRIOR_HORIZONS:
        v, d = bar_near(bars, anchor - timedelta(days=days), tol)
        if v is not None:
            out[lbl] = (round(v, 2), d)
    return out

def front_contract_prev_close(sym_fn, front, spot_date):
    """Previous session's close of the contract the front-month quote is
    actually tracking -> (close, date, contract) or None.

    Yahoo's continuous front month (CL=F/BZ=F) switches its live quote to the
    next contract days before its history follows, so near a roll the
    "previous bar" can belong to the expiring contract and the 1D change
    shows the calendar spread (Brent read about -5% from 28 Sep to 1 Oct
    2026 on moves that never happened). Match the live quote to a listed
    contract and use that contract's own prior bar.
    """
    if not front or not spot_date:
        return None
    last_d, last_px = front[-1]
    best = None
    for k in range(4):
        sym, _ = sym_fn(k)
        bars = yahoo_daily_bars(sym)
        if not bars or bars[-1][0] != last_d:
            continue
        diff = abs(bars[-1][1] - last_px)
        if best is None or diff < best[0]:
            best = (diff, sym, bars)
    if best is None or best[0] > max(0.02, 0.0005 * last_px):
        return None
    prev = [b for b in best[2] if b[0] < spot_date]
    if not prev or (date.fromisoformat(spot_date) - date.fromisoformat(prev[-1][0])).days > 5:
        return None
    return round(prev[-1][1], 2), prev[-1][0], best[1].split(".")[0]

def commodity_spot(key, history, last):
    """Spot, its date/source, and 1d..2y priors taken from the same series."""
    spec = COMMODITY_SPECS[key]
    today = datetime.utcnow().strftime("%Y-%m-%d")
    last_c = (last or {}).get(key) or {}
    front = yahoo_daily_bars(spec["front"])
    front_fresh = bool(front) and (date.fromisoformat(today) - date.fromisoformat(front[-1][0])).days <= FUT_STALE_DAYS
    ref = front[-1][1] if front else last_c.get("spot")
    spot = spot_date = source = None
    series = []

    if spec["true_spot"]:
        # Live scrapes carry no date; label them with the front month's latest
        # session so a weekend run reads as Friday's close, not Sunday's.
        as_of = front[-1][0] if front_fresh else today
        for name, fn in (("TradingEconomics", lambda: scrape_te_last_value(spec["te"])),
                         ("Swissquote", swissquote_xau),
                         ("gold-api.com", gold_api_xau),
                         ("Investing", lambda: scrape_commodity_spot(spec["inv"]))):
            v = fn()
            ok = _plausible(v, ref, spec["tol"])
            if name != "Investing":  # scrape_commodity_spot records its own health
                record_source(name, f"{spec['label']} spot", ok=ok,
                              note=None if ok or v is None else f"rejected implausible {v}")
            if ok:
                spot, spot_date, source = round(v, 2), as_of, name
                break
            if v is not None:
                log.warning(f"  {spec['label']} spot from {name} rejected: {v} vs reference {ref}")

    if spot is None and front_fresh:
        spot, spot_date = round(front[-1][1], 2), front[-1][0]
        source = f"Yahoo {spec['front']}" + (" (front-month proxy)" if spec["true_spot"] else " (front month)")
        series = front

    if spot is None and spec["fred"]:
        obs = fred_csv(spec["fred"], start=(datetime.utcnow() - timedelta(days=COMM_PRIOR_HORIZONS[-1][1] + 45)).strftime("%Y-%m-%d"), retries=1)
        if obs:
            spot, spot_date, source = round(obs[0]["value"], 2), obs[0]["date"], "FRED"
            series = [(o["date"], o["value"]) for o in reversed(obs)]

    if spot is None and not spec["true_spot"]:
        for name, fn in (("TradingEconomics", lambda: scrape_te_last_value(spec["te"])),
                         ("Investing", lambda: scrape_commodity_spot(spec["inv"]))):
            v = fn()
            if _plausible(v, ref, spec["tol"]):
                spot, spot_date, source = round(v, 2), today, name
                break

    kind = _spot_kind(key, source) if source else None
    if spot is None and last_c.get("spot") is not None:
        spot, spot_date = last_c["spot"], last_c.get("spot_date") or (last or {}).get("date", "")
        source, kind = "cache", last_c.get("spot_kind") or _spot_kind(key, last_c.get("spot_source"))
        log.warning(f"  {spec['label']} spot: all live sources failed, carrying forward cached {spot}")

    priors = _priors_from_bars(series, spot_date) if series else {}
    if series is front and not spec["true_spot"]:
        same = front_contract_prev_close(spec["sym_fn"], front, spot_date)
        if same:
            priors["1d"] = same[:2]
    if kind:
        hist = _priors_from_bars(_history_spot_bars(history, key, kind), spot_date)
        for h, v in hist.items():
            priors.setdefault(h, v)
    if kind == "spot":
        # Where our own spot history doesn't reach (it starts Apr 2026), fall
        # back to the front month: ~1% of futures basis is noise against a
        # 1m+ move, but it would swamp a 1d change, so 1d never falls back.
        for h, v in _priors_from_bars(front, spot_date).items():
            if h != "1d":
                priors.setdefault(h, v)

    out = {"spot": spot, "spot_date": spot_date or "", "spot_source": source, "spot_kind": kind, "unit": spec["unit"]}
    for h in ("1d", "1m", "3m", "1y", "2y"):
        v, d = priors.get(h, (None, ""))
        out[f"prior_{h}"], out[f"prior_{h}_date"] = v, d
    log.info(f"  {spec['label']} spot: {spot} ({spot_date}, {source})")
    return out

def futures_curve(sym_fn, label, history_key=None, history=None, last_futures=None, last_date=""):
    """Roll-aware futures curve with 1m/3m/1y/2y priors per tenor.

    Current price: the tenor's contract, else the next listed contract or two
    (Yahoo lists far-dated contracts patchily, and CME only lists Jun/Dec gold
    beyond ~2 years), else its last known quote flagged stale. Priors: the
    contract that was that tenor on the target date, else our own daily
    snapshot history (Yahoo drops expired contracts, so most 1y/2y lookups
    need it).
    """
    now_dt = datetime.utcnow()
    today = now_dt.date()
    history = history or []
    last_futures = last_futures or {}

    plan = {}
    for lbl, months in COMM_TENOR_NS:
        plan[lbl] = {h: (now_dt - timedelta(days=days),) + sym_fn(months, base_dt=now_dt - timedelta(days=days))
                     for h, days, _ in COMM_PRIOR_HORIZONS}
    symbols = {sym_fn(m, base_dt=now_dt)[0] for _, m in COMM_TENOR_NS}
    symbols |= {v[1] for p in plan.values() for v in p.values()}
    with ThreadPoolExecutor(max_workers=8) as ex:
        list(ex.map(yahoo_daily_bars, symbols))

    result = {}
    for lbl, months in COMM_TENOR_NS:
        entry = {"price": None, "price_date": "", "price_source": None}
        primary_sym, primary_exp = sym_fn(months, base_dt=now_dt)
        entry.update({"expiry": primary_exp, "contract": primary_sym.split(".")[0]})
        stale_pick = None
        tried = []
        for k in range(3):
            sym, exp = sym_fn(months + k, base_dt=now_dt)
            if sym in tried:
                continue
            tried.append(sym)
            bars = yahoo_daily_bars(sym)
            if not bars:
                continue
            pick = (round(bars[-1][1], 2), bars[-1][0], sym, exp)
            if (today - date.fromisoformat(bars[-1][0])).days <= FUT_STALE_DAYS:
                entry.update({"price": pick[0], "price_date": pick[1], "contract": sym.split(".")[0],
                              "expiry": exp, "price_source": "Yahoo"})
                if k:
                    log.info(f"  {label} {lbl}: {primary_sym} unavailable, used {sym}")
                break
            stale_pick = stale_pick or pick
        if entry["price"] is None:
            cached = last_futures.get(lbl) or {}
            if stale_pick:
                entry.update({"price": stale_pick[0], "price_date": stale_pick[1], "contract": stale_pick[2].split(".")[0],
                              "expiry": stale_pick[3], "price_source": "Yahoo", "stale": True})
            else:
                cached_date = cached.get("price_date") or last_date
                if cached.get("price") is not None and cached.get("contract") == entry["contract"] \
                        and cached.get("price_source") in ("Yahoo", "cache", None) and cached_date \
                        and (today - date.fromisoformat(cached_date)).days <= 14:
                    entry.update({"price": cached["price"], "price_date": cached_date,
                                  "price_source": "cache", "stale": True})

        for h, _, _ in COMM_PRIOR_HORIZONS:
            target_dt, hsym, _hexp = plan[lbl][h]
            v, d = bar_near(yahoo_daily_bars(hsym), target_dt.date(), FUT_PRIOR_MAX_DIFF[h])
            contract = hsym.split(".")[0]
            if v is None and history_key:
                v, d, hc = _history_future(history, history_key, lbl, target_dt.date(), FUT_PRIOR_MAX_DIFF[h])
                contract = hc or contract
            entry[f"prior_{h}"] = round(v, 2) if v is not None else None
            entry[f"prior_{h}_date"] = d or ""
            entry[f"prior_{h}_contract"] = contract
        result[lbl] = entry
        log.info(f"  {label} {lbl}: {entry['price']} via {entry['contract']}"
                 + (" (stale)" if entry.get("stale") else "")
                 + " | priors " + ", ".join(f"{h}={entry[f'prior_{h}']}" for h, _, _ in COMM_PRIOR_HORIZONS))
    return result

def fetch_commodities():
    log.info("COMMODITIES: fetching")
    last = load_last_commodities()
    history = load_commodity_history()

    blocks = {}
    for key, spec in COMMODITY_SPECS.items():
        block = commodity_spot(key, history, last)
        block["futures"] = futures_curve(spec["sym_fn"], spec["label"], history_key=key, history=history,
                                         last_futures=((last or {}).get(key) or {}).get("futures"),
                                         last_date=(last or {}).get("date", ""))
        blocks[key] = block

    # USD/INR spot and history from FRED DEXINUS (Indian Rupees per 1 USD)
    # Fallback for latest spot uses manual market scrape if FRED is stale/unavailable.
    usdinr_obs = fred_csv("DEXINUS", start="2023-01-01")
    if not usdinr_obs and last:
        usdinr_obs = []
    if usdinr_obs:
        usdinr_spot = round(usdinr_obs[0]["value"], 4)
        usdinr_spot_date = usdinr_obs[0]["date"]
        usdinr_spot_source = "FRED DEXINUS"
        def _usdinr_prior(days_back, max_diff=14):
            target = datetime.utcnow() - timedelta(days=days_back)
            best = min(usdinr_obs, key=lambda o: abs((datetime.strptime(o["date"], "%Y-%m-%d") - target).days))
            diff = abs((datetime.strptime(best["date"], "%Y-%m-%d") - target).days)
            return (round(best["value"], 4), best["date"]) if diff <= max_diff else (None, None)
        # 1d is the previous FRED print, not "the print nearest 24h ago" (with
        # FRED's lag that is often the spot print itself -> a fake 0% day).
        usdinr_1d, usdinr_1d_d = ((round(usdinr_obs[1]["value"], 4), usdinr_obs[1]["date"])
                                  if len(usdinr_obs) > 1 else (None, None))
        usdinr_1m, usdinr_1m_d = _usdinr_prior(30)
        usdinr_3m, usdinr_3m_d = _usdinr_prior(91)
        usdinr_1y, usdinr_1y_d = _usdinr_prior(365)
        usdinr_2y, usdinr_2y_d = _usdinr_prior(730, max_diff=21)
    else:
        usdinr_spot = last.get("usdinr", {}).get("spot") if last else None
        usdinr_spot_date = last.get("usdinr", {}).get("spot_date", "") if last else ""
        usdinr_spot_source = "cache"
        usdinr_1d = usdinr_1d_d = usdinr_1m = usdinr_1m_d = None
        usdinr_3m = usdinr_3m_d = usdinr_1y = usdinr_1y_d = None
        usdinr_2y = usdinr_2y_d = None

    # If FRED spot is stale (>2 days old) or missing, refresh from live sources.
    # DEXINUS publishes with up to a week's lag, so this triggers on most runs.
    try:
        spot_dt = datetime.strptime(usdinr_spot_date, "%Y-%m-%d") if usdinr_spot_date else None
        spot_age_days = (datetime.utcnow() - spot_dt).days if spot_dt else 999
    except Exception:
        spot_age_days = 999
    # Also trigger when FRED was unavailable and we fell through to cache — a cache
    # value can be arbitrarily old even if its date looks recent.
    if usdinr_spot is None or spot_age_days > 2 or usdinr_spot_source == "cache":
        # Yahoo INR=X is USD/INR spot and works from CI runners (same host that
        # serves the gold/oil futures above); Investing is blocked from CI but
        # kept as a local-run fallback.
        inr_bars = [b for b in yahoo_daily_bars("INR=X", "5d") if 50 <= b[1] <= 150]
        if inr_bars:
            usdinr_spot = round(inr_bars[-1][1], 4)
            usdinr_spot_date = inr_bars[-1][0]
            usdinr_spot_source = "Yahoo INR=X"
            # Day-over-day from the same series. Comparing Yahoo's live quote
            # with FRED's lagged noon rate read a two-session, two-source move
            # as "1D".
            usdinr_1d, usdinr_1d_d = ((round(inr_bars[-2][1], 4), inr_bars[-2][0])
                                      if len(inr_bars) > 1 else (None, None))
        else:
            scraped_usdinr = scrape_fx_spot("/currencies/usd-inr")
            if scraped_usdinr is not None:
                usdinr_spot = scraped_usdinr
                usdinr_spot_date = datetime.utcnow().strftime("%Y-%m-%d")
                usdinr_spot_source = "Investing scrape"

    # Last spot fallbacks: keyless JSON rate APIs. (exchangerate.host used to fill
    # this slot but now requires an API key and always fails.)
    if usdinr_spot is None:
        for api_url, tag in (
            ("https://open.er-api.com/v6/latest/USD", "open.er-api.com"),
            ("https://api.frankfurter.app/latest?from=USD&to=INR", "frankfurter.app (ECB ref)"),
        ):
            try:
                _v = float(json.loads(get(api_url, timeout=10))["rates"]["INR"])
                if 50 <= _v <= 150:
                    usdinr_spot = round(_v, 4)
                    usdinr_spot_date = datetime.utcnow().strftime("%Y-%m-%d")
                    usdinr_spot_source = tag
                    break
            except Exception:
                pass

    # Scrape / keyless-API spots have no history of their own: take the prior
    # session from Yahoo INR=X rather than FRED's lagged print.
    if usdinr_spot is not None and usdinr_spot_source not in ("FRED DEXINUS", "Yahoo INR=X"):
        usdinr_1d = usdinr_1d_d = None
        _v, _d = yahoo_price_near_date("INR=X", datetime.utcnow() - timedelta(days=1), max_diff_days=5)
        if _v is not None and 50 <= _v <= 150 and usdinr_spot_date and _d < usdinr_spot_date:
            usdinr_1d, usdinr_1d_d = _v, _d

    usdinr_futures = futures_curve(_usdinr_symbol, "USDINR")
    for source_name, fwds in [
        ("NSE-USDINR", nse_usdinr_forwards(usdinr_spot)),
        ("INV-FWD", scrape_usdinr_forwards(usdinr_spot)),
    ]:
        if not fwds:
            continue
        for t in ["3M", "6M", "12M", "24M"]:
            if t not in usdinr_futures:
                usdinr_futures[t] = {}
            if usdinr_futures[t].get("price") is None and fwds.get(t) is not None:
                usdinr_futures[t]["price"] = fwds[t]
                usdinr_futures[t]["contract"] = source_name
                usdinr_futures[t]["expiry"] = t
    filled = [t for t in ["3M", "6M", "12M", "24M"] if usdinr_futures.get(t, {}).get("price") is not None]
    missing = [t for t in ["3M", "6M", "12M", "24M"] if t not in filled]
    if missing:
        log.warning(f"  USD/INR forwards missing after Yahoo+NSE+Investing: {missing}")

    # Reject any forward price that is more than 3 INR below spot — these are stale or
    # misparsed values from a prior spot regime that slipped through scraper validation.
    if usdinr_spot is not None:
        for t in ["3M", "6M", "12M", "24M"]:
            px = (usdinr_futures.get(t) or {}).get("price")
            if px is not None and px < usdinr_spot - 3.0:
                usdinr_futures[t]["price"] = None

    # Derived fallback: CME INR contracts are dead on Yahoo and NSE/Investing block
    # CI runners, so live forwards rarely land. Fill remaining tenors via covered
    # interest parity from the sovereign curves fetched earlier in this run:
    # F = S * (1 + r_INR*t) / (1 + r_USD*t). India's curve starts at 1Y, so the
    # 3M/6M points borrow the 1Y INR rate — an approximation, labeled as derived.
    def _curve_yield(fname, tenor):
        try:
            d = json.loads((DATA / fname).read_text())
            v = d["yields"][d["tenors"].index(tenor)]
            return float(v) if v is not None else None
        except Exception:
            return None

    if usdinr_spot is not None:
        cip_specs = [("3M", "1Y", "3M", 0.25), ("6M", "1Y", "6M", 0.5),
                     ("12M", "1Y", "1Y", 1.0), ("24M", "2Y", "2Y", 2.0)]
        cip_filled = []
        for t, inr_ten, ust_ten, yrs in cip_specs:
            if (usdinr_futures.get(t) or {}).get("price") is not None:
                continue
            r_inr = _curve_yield("india.json", inr_ten)
            r_usd = _curve_yield("ust.json", ust_ten)
            if r_inr is None or r_usd is None:
                continue
            fwd = usdinr_spot * (1 + r_inr / 100 * yrs) / (1 + r_usd / 100 * yrs)
            usdinr_futures.setdefault(t, {})
            usdinr_futures[t].update({"price": round(fwd, 2), "contract": "CIP derived", "expiry": t})
            cip_filled.append(t)
        if cip_filled:
            log.info(f"  USD/INR forwards CIP-derived for {cip_filled}")

    # Last-resort cache fallback: use the previous run's forward price for any tenor still
    # missing a live price, provided the cached value is coherent with the current spot.
    if usdinr_spot is not None and last:
        last_futs = last.get("usdinr", {}).get("futures", {})
        for t in ["3M", "6M", "12M", "24M"]:
            if (usdinr_futures.get(t) or {}).get("price") is not None:
                continue
            cached_px = (last_futs.get(t) or {}).get("price")
            if cached_px is not None and cached_px >= usdinr_spot - 3.0 and cached_px <= usdinr_spot + 20.0:
                if t not in usdinr_futures:
                    usdinr_futures[t] = {}
                usdinr_futures[t]["price"] = cached_px
                usdinr_futures[t]["contract"] = "cache"
                usdinr_futures[t]["expiry"] = t

    payload = {
        "date": datetime.utcnow().strftime("%Y-%m-%d"),
        "source": "TradingEconomics / Swissquote (gold spot) / Yahoo Finance (crude spot, futures) / FRED",
        **blocks,
        "usdinr": {
            "spot": usdinr_spot,
            "spot_date": usdinr_spot_date,
            "spot_source": usdinr_spot_source,
            "unit": "INR per USD",
            "prior_1d": usdinr_1d, "prior_1d_date": usdinr_1d_d,
            "prior_1m": usdinr_1m, "prior_1m_date": usdinr_1m_d,
            "prior_3m": usdinr_3m, "prior_3m_date": usdinr_3m_d,
            "prior_1y": usdinr_1y, "prior_1y_date": usdinr_1y_d,
            "prior_2y": usdinr_2y, "prior_2y_date": usdinr_2y_d,
            "futures": usdinr_futures,
        },
        "note": "Gold spot is physical XAU/USD (TradingEconomics, then Swissquote / gold-api.com), sanity-checked against the front-month future. WTI/Brent spot is the front-month future (Yahoo), with FRED's weekly EIA series as fallback. Spot priors come from the same series as spot (1d = previous session). Futures history is roll-aware by target date, backed by data/commodities_history.jsonl where Yahoo no longer lists expired contracts. USD/INR latest spot: FRED DEXINUS, then Yahoo INR=X / keyless FX APIs when FRED lags; forwards fall back to CIP derivation from India/UST curves when market quotes are unavailable."
    }
    write("commodities.json", payload)
    try:
        save_commodity_history(commodity_history_row(payload, payload["date"]))
    except Exception as e:
        log.warning(f"  commodity history save failed: {e}")
    log.info("  COMMODITIES OK")
    cached_spots = [k for k in ("gold", "wti", "brent", "usdinr") if (payload.get(k) or {}).get("spot_source") == "cache"]
    if cached_spots:
        return f"{'stale' if len(cached_spots) == 4 else 'partial'}: cached spot for {', '.join(cached_spots)}"

# ── RUN ──
OECD_PRICES_URL = "https://sdmx.oecd.org/public/rest/data/OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL,1.0"

def oecd_cpi_yoy(ref_area, start_month):
    """Latest headline CPI YoY % for one country from OECD's keyless SDMX API
    -> (yoy, "YYYY-MM-01") or (None, None).

    FRED's OECD-sourced CPI series (JPNCPIALLMINMEI etc.) were discontinued,
    which blanked Japan / UK / India. Key: REF_AREA.FREQ.METHODOLOGY.MEASURE.
    UNIT_MEASURE.EXPENDITURE.ADJUSTMENT.TRANSFORMATION; methodology and
    adjustment are wildcarded and national, unadjusted rows preferred.
    """
    url = f"{OECD_PRICES_URL}/{ref_area}.M..CPI.PA._T..GY?startPeriod={start_month}&format=csvfile"
    try:
        rows = list(csv.DictReader(io.StringIO(get(url, timeout=20))))
    except Exception as e:
        log.warning(f"  OECD CPI {ref_area}: {e}")
        return None, None
    best = {}
    for r in rows:
        if r.get("REF_AREA") != ref_area or r.get("MEASURE", "CPI") != "CPI" or r.get("TRANSFORMATION", "GY") != "GY":
            continue
        try:
            v = float(r["OBS_VALUE"])
        except (KeyError, TypeError, ValueError):
            continue
        period = (r.get("TIME_PERIOD") or "")[:7]
        if not re.fullmatch(r"\d{4}-\d{2}", period):
            continue
        rank = (r.get("METHODOLOGY") == "N") + (r.get("ADJUSTMENT") == "N")
        if period not in best or rank > best[period][0]:
            best[period] = (rank, v)
    if not best:
        return None, None
    period = max(best)
    return round(best[period][1], 2), f"{period}-01"

def fetch_inflation():
    """Fetch CPI data for the 5 sovereign markets and write data/inflation.json.

    Uses the existing fred_fetch() helper (official API if keyed, fredgraph.csv
    otherwise). All five series are monthly; we compute YoY and MoM from the
    last 15 observations so we always have at least 13 data points for the
    YoY calculation.
    """
    log.info("INFLATION: fetching CPI series")
    series_map = {
        "us":  ("CPIAUCSL",           "US CPI-U (SA, BLS)"),
        "jp":  ("JPNCPIALLMINMEI",    "Japan CPI all items (OECD)"),
        "uk":  ("GBRCPIALLMINMEI",    "UK CPI all items (OECD)"),
        "eur": ("CP0000EZ19M086NEST", "Euro area HICP all items (ECB/FRED)"),
        "in":  ("INDCPIALLMINMEI",    "India CPI all items (OECD)"),
    }
    oecd_area = {"jp": "JPN", "uk": "GBR", "in": "IND"}
    # Fetch 15+ months so we always have obs[0] and obs[12] for YoY.
    from datetime import date, timedelta
    start = (date.today() - timedelta(days=480)).isoformat()
    series_ids = [v[0] for v in series_map.values()]
    raw = fred_fetch(series_ids, start=start)

    try:
        prev_countries = json.loads((DATA / "inflation.json").read_text()).get("countries", {})
    except Exception:
        prev_countries = {}
    countries = {}
    for key, (sid, label) in series_map.items():
        obs = raw.get(sid, [])  # newest-first list of {date, value}
        entry = {"series": sid, "label": label, "yoy": None, "mom": None,
                 "trend": None, "date": None}
        if len(obs) >= 13:
            entry["date"] = obs[0]["date"]
            yoy = round((obs[0]["value"] / obs[12]["value"] - 1) * 100, 2)
            entry["yoy"] = yoy
            if len(obs) >= 2:
                # Percent change, not index points (US printed 1.318 = points).
                mom = round((obs[0]["value"] / obs[1]["value"] - 1) * 100, 3)
                entry["mom"] = mom
                entry["trend"] = "up" if mom > 0 else ("down" if mom < 0 else "flat")
            log.info(f"  {key.upper()} ({sid}): YoY={entry['yoy']}%, date={entry['date']}")
        elif key in oecd_area:
            yoy, d = oecd_cpi_yoy(oecd_area[key], (date.today() - timedelta(days=200)).strftime("%Y-%m"))
            if yoy is not None:
                entry.update({"yoy": yoy, "date": d, "source": "OECD SDMX (FRED series discontinued)"})
                log.info(f"  {key.upper()} (OECD {oecd_area[key]}): YoY={yoy}%, date={d}")
            else:
                log.warning(f"  {key.upper()}: no data from FRED ({sid}) or OECD")
        else:
            log.warning(f"  {key.upper()} ({sid}): only {len(obs)} obs, skipping YoY")
        if entry["yoy"] is None and (prev_countries.get(key) or {}).get("yoy") is not None:
            # A failed fetch used to overwrite good figures with nulls.
            entry = dict(prev_countries[key], stale=True)
            log.warning(f"  {key.upper()}: carrying forward {entry['yoy']}% ({entry.get('date')})")
        countries[key] = entry

    write("inflation.json", {
        "updated": datetime.utcnow().isoformat() + "Z",
        "countries": countries,
    })
    log.info(f"  inflation.json written ({len([c for c in countries.values() if c['yoy'] is not None])}/5 with YoY)")
    stale = [k for k, c in countries.items() if c.get("stale")]
    if stale:
        return f"stale: carried forward {', '.join(stale)}"


def _fetch_myga():
    """MYGA new-money spreads by AM Best bucket (scripts/fetch_myga.py).

    Imported lazily so a syntax or import error in the newest, least-proven
    fetcher cannot take down the whole pipeline at module load.
    """
    from fetch_myga import fetch_myga
    return fetch_myga()


def main():
    log.info("=" * 50)
    results = {}
    for name, fn in [
        ("ust", fetch_ust),
        ("jgb", fetch_jgb),
        ("gilt", fetch_gilt),
        ("eur", fetch_eur),
        ("india", fetch_india),
        ("credit", fetch_credit),
        ("cds", fetch_cds),
        ("sofr", fetch_sofr),
        ("bma_rates", fetch_bma_rates),
        ("commodities", fetch_commodities),
        ("inflation", fetch_inflation),
        ("myga", _fetch_myga),
    ]:
        # A fetcher may return "stale: ..." / "partial: ..." to say it wrote
        # something but not fresh data; an exception records its type, since a
        # bare `assert` has an empty message (JGB once logged "" for days).
        try:
            outcome = fn()
            results[name] = outcome if isinstance(outcome, str) and outcome else "ok"
        except Exception as e:
            results[name] = f"error: {type(e).__name__}" + (f": {e}" if str(e) else "")
            log.error(f"  {name} FAILED: {results[name]}")
    write("manifest.json", {"results": results, "run": datetime.utcnow().isoformat() + "Z"})
    try:
        flush_source_health()
    except Exception as e:
        log.warning(f"  source health flush: {e}")
    failed = [k for k, v in results.items() if v != "ok"]
    log.info(f"Done: {len(results)-len(failed)}/{len(results)} ok" + (f", failed: {failed}" if failed else ""))

if __name__ == "__main__":
    main()

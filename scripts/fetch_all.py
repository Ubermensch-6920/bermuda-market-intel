#!/usr/bin/env python3
"""Bermuda Market Intel — Data Pipeline v8.
Improved India / UK rates sourcing and roll-aware commodity futures history.
"""
import json, re, sys, os, logging, time, io, zipfile
from datetime import datetime, timedelta, date
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib.request

try:
    from openpyxl import load_workbook
except Exception:
    load_workbook = None

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fetch")
DATA = Path(__file__).parent.parent / "data"
DATA.mkdir(exist_ok=True)
HDR = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

def get(url, timeout=12):
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

def fred_csv(series_id, start="2024-01-01", retries=1):
    """Fetch single FRED series CSV."""
    for attempt in range(retries + 1):
        try:
            url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}&cosd={start}"
            raw = get(url, timeout=10)
            obs = []
            for line in raw.strip().split("\n")[1:]:
                parts = line.split(",")
                if len(parts) >= 2 and parts[1] not in (".", ""):
                    try:
                        obs.append({"date": parts[0], "value": float(parts[1])})
                    except Exception:
                        pass
            obs.sort(key=lambda x: x["date"], reverse=True)
            if obs:
                return obs
        except Exception as e:
            log.warning(f"  FRED {series_id} attempt {attempt+1}: {e}")
            if attempt < retries:
                time.sleep(2)
    return []

def fred_multi_csv(series_ids, start="2024-01-01"):
    """Fetch MULTIPLE FRED series in ONE request. Returns {series_id: [obs]}."""
    joined = ",".join(series_ids)
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={joined}&cosd={start}"
    result = {sid: [] for sid in series_ids}
    try:
        raw = get(url, timeout=15)
        lines = raw.strip().split("\n")
        if len(lines) < 2:
            return result
        header = lines[0].split(",")
        col_map = {}
        for i, h in enumerate(header):
            h = h.strip().strip('"')
            if h in series_ids:
                col_map[i] = h
            elif h.upper() in [s.upper() for s in series_ids]:
                for sid in series_ids:
                    if sid.upper() == h.upper():
                        col_map[i] = sid
                        break
        for line in lines[1:]:
            parts = line.split(",")
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
                        except Exception:
                            pass
        for sid in result:
            result[sid].sort(key=lambda x: x["date"], reverse=True)
    except Exception as e:
        log.warning(f"  FRED multi fetch failed: {e}")
    return result

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
    obs = fred_csv(series_id, start=start, retries=1)
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

def append_curve_history(name, date_str, tenors, yields, source):
    path = DATA / f"{name}_history.jsonl"
    row = {
        "date": date_str,
        "source": source,
        "tenors": tenors,
        "yields": yields,
        "_fetched": datetime.utcnow().isoformat() + "Z",
    }
    try:
        existing = set()
        if path.exists():
            for line in path.read_text().splitlines():
                if line.strip():
                    obj = json.loads(line)
                    existing.add(obj.get("date"))
        if date_str not in existing:
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")
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
                    return v
    except Exception:
        pass
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
                    return round(v, 2)
    except Exception:
        pass
    return None

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
    return out

def yahoo_price(symbol):
    """Fetch latest close price for a Yahoo Finance symbol (futures, indices, etc.)."""
    try:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=5d"
        data = json.loads(get(url, timeout=6))
        closes = data["chart"]["result"][0]["indicators"]["quote"][0]["close"]
        for v in reversed(closes):
            if v is not None:
                return round(v, 2)
    except Exception:
        pass
    return None

def yahoo_price_at(symbol, days_ago, max_diff_days=5):
    """Fetch close price for a Yahoo Finance symbol approximately N days ago."""
    try:
        target_dt = datetime.utcnow() - timedelta(days=days_ago)
        p1 = int((target_dt - timedelta(days=10)).timestamp())
        p2 = int((target_dt + timedelta(days=3)).timestamp())
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&period1={p1}&period2={p2}"
        data = json.loads(get(url, timeout=6))
        result = data["chart"]["result"][0]
        timestamps = result.get("timestamp", [])
        closes = result["indicators"]["quote"][0]["close"]
        if not timestamps:
            return None, ""
        target_ts = int(target_dt.timestamp())
        pairs = [(ts, c) for ts, c in zip(timestamps, closes) if c is not None]
        if not pairs:
            return None, ""
        best_ts, best_c = min(pairs, key=lambda x: abs(x[0] - target_ts))
        if abs(best_ts - target_ts) > max_diff_days * 86400:
            return None, ""
        return round(best_c, 2), datetime.utcfromtimestamp(best_ts).strftime("%Y-%m-%d")
    except Exception:
        return None, ""

def yahoo_price_near_date(symbol, target_dt, max_diff_days=5):
    try:
        p1 = int((target_dt - timedelta(days=10)).timestamp())
        p2 = int((target_dt + timedelta(days=3)).timestamp())
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&period1={p1}&period2={p2}"
        data = json.loads(get(url, timeout=6))
        result = data["chart"]["result"][0]
        timestamps = result.get("timestamp", [])
        closes = result["indicators"]["quote"][0]["close"]
        if not timestamps:
            return None, ""
        target_ts = int(target_dt.timestamp())
        pairs = [(ts, c) for ts, c in zip(timestamps, closes) if c is not None]
        if not pairs:
            return None, ""
        best_ts, best_c = min(pairs, key=lambda x: abs(x[0] - target_ts))
        if abs(best_ts - target_ts) > max_diff_days * 86400:
            return None, ""
        return round(best_c, 2), datetime.utcfromtimestamp(best_ts).strftime("%Y-%m-%d")
    except Exception:
        return None, ""

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

def _boe_nominal_rows():
    """
    Official Bank of England daily nominal government liability curve archive.
    """
    if load_workbook is None:
        return []
    want = {"1Y": 1.0, "2Y": 2.0, "3Y": 3.0, "5Y": 5.0, "7Y": 7.0, "10Y": 10.0, "15Y": 15.0, "20Y": 20.0, "30Y": 30.0}
    blob = get_bytes("https://www.bankofengland.co.uk/-/media/boe/files/statistics/yield-curves/glcnominalddata.zip", timeout=40, retries=2)
    wb = load_workbook(_open_first_xlsx_from_zip(blob), data_only=True, read_only=True)
    ws = wb["4. spot curve"] if "4. spot curve" in wb.sheetnames else wb[wb.sheetnames[0]]
    return _extract_curve_rows_from_sheet(ws, want)

def _discover_fbil_xlsx_urls():
    urls = []
    try:
        html = get("https://www.fbil.org.in/", timeout=20)
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
    for url in _discover_fbil_xlsx_urls():
        try:
            low = url.lower()
            if low.endswith(".xlsx") or low.endswith(".xlsm"):
                wb = _load_workbook_from_bytes(get_bytes(url, timeout=30, retries=1))
            else:
                continue
            for s in wb.sheetnames:
                rows = _extract_curve_rows_from_sheet(wb[s], want)
                if rows:
                    return rows
        except Exception as e:
            log.warning(f"  FBIL parse failed for {url}: {e}")
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
    rows = parse_year(now.year)
    assert len(rows) >= 2
    target_ya = (now - timedelta(days=365)).strftime("%Y-%m-%d")
    ya_rows = parse_year(now.year - 1)
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
def fetch_jgb():
    log.info("JGB: fetching")
    want = ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "25Y", "30Y", "40Y"]
    raw = get("https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv")
    lines = raw.split("\n")
    hdr_idx, headers = -1, []
    for i, line in enumerate(lines[:5]):
        if "date" in line.lower():
            hdr_idx = i
            headers = [h.strip().strip('"') for h in line.split(",")]
            break
    assert hdr_idx >= 0
    col = {h.replace(" ", ""): j for j, h in enumerate(headers) if h.replace(" ", "") in want}
    rows = []
    for line in lines[hdr_idx+1:]:
        parts = [p.strip().strip('"') for p in line.split(",")]
        if len(parts) < 10:
            continue
        m = re.match(r"(\d{4})[/-](\d{1,2})[/-](\d{1,2})", parts[0])
        if not m:
            continue
        date_val = f"{m[1]}-{m[2].zfill(2)}-{m[3].zfill(2)}"
        yd = {}
        for t in want:
            if t in col:
                try:
                    yd[t] = round(float(parts[col[t]]), 4)
                except Exception:
                    yd[t] = None
        rows.append({"date": date_val, "yields": yd})
    rows.sort(key=lambda x: x["date"], reverse=True)
    assert len(rows) >= 2
    target_ya = (datetime.utcnow() - timedelta(days=365)).strftime("%Y-%m-%d")
    ya_candidates = [r for r in rows if r["date"] <= target_ya]
    ya_yields, ya_date = [None] * len(want), ""
    if ya_candidates:
        ya_yields = [ya_candidates[0]["yields"].get(t) for t in want]
        ya_date = ya_candidates[0]["date"]
    if not any(v is not None for v in ya_yields):
        fred_ya, fdate = fred_year_ago_10y("IRLTLT01JPM156N")
        if fred_ya:
            ya_yields[want.index("10Y")] = fred_ya
            ya_date = fdate
    p1m_yields, p1m_date = find_prior_date_yields(rows, 30, want)
    p3m_yields, p3m_date = find_prior_date_yields(rows, 91, want)
    log.info(f"  JGB 1M ago: {p1m_date}, 3M ago: {p3m_date}")
    write("jgb.json", {
        "date": rows[0]["date"],
        "prior_date": rows[1]["date"],
        "source": "Ministry of Finance Japan",
        "url": "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/",
        "tenors": want,
        "yields": [rows[0]["yields"].get(t) for t in want],
        "prior_yields": [rows[1]["yields"].get(t) for t in want],
        "prior_1m_yields": p1m_yields,
        "prior_1m_date": p1m_date,
        "prior_3m_yields": p3m_yields,
        "prior_3m_date": p3m_date,
        "year_ago_yields": ya_yields,
        "year_ago_date": ya_date
    })
    log.info(f"  JGB OK: {rows[0]['date']}")

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

        current = interpolate_curve(current, tenors)

        last = load_last_gilt()
        if last:
            last_y = dict(zip(last.get("tenors", []), last.get("yields", [])))
            for t in tenors:
                if current.get(t) is None and last_y.get(t) is not None:
                    current[t] = last_y[t]

        p1m_yields = [te.get(t, {}).get("m1") for t in tenors]
        p1m_date = "TE month delta reconstruction"
        p3m_yields, p3m_date = history_lookup("gilt", 91, tenors)
        ya_yields = [te.get(t, {}).get("y1") for t in tenors]
        ya_date = "TE year delta reconstruction"
        prior_yields = [None] * len(tenors)
        prior_date = ""
        date_str = datetime.utcnow().strftime("%Y-%m-%d")
        source = "Investing.com / TradingEconomics / FRED / cache"
        source_url = "https://www.investing.com/rates-bonds/uk-government-bonds"

    valid_count = sum(1 for v in current.values() if v is not None)
    if valid_count < 3:
        raise Exception(f"GILT: insufficient data ({valid_count} tenors)")

    append_curve_history("gilt", date_str, tenors, [current.get(t) for t in tenors], source)

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
        "note": "Official BoE daily archive first; then market scrapes; then local history / cache."
    })
    log.info(f"  GILT OK: {valid_count} tenors")

# ── 4. EUR ──
def fetch_eur():
    log.info("EUR: fetching")
    ecb_map = {"1Y": "SR_1Y", "2Y": "SR_2Y", "3Y": "SR_3Y", "5Y": "SR_5Y", "7Y": "SR_7Y", "10Y": "SR_10Y", "15Y": "SR_15Y", "20Y": "SR_20Y", "30Y": "SR_30Y"}
    tenors = list(ecb_map.keys())
    results = {}
    for tn, sk in ecb_map.items():
        try:
            raw = get(f"https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.{sk}?lastNObservations=70&format=csvdata", timeout=15)
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
        except Exception:
            pass
    assert results
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

    p1m_yields, p1m_date = ecb_find_prior(30)
    p3m_yields, p3m_date = ecb_find_prior(91)
    log.info(f"  EUR 1M ago: {p1m_date}, 3M ago: {p3m_date}")
    write("eur.json", {
        "date": latest,
        "prior_date": "",
        "source": "ECB SDW (EUR AAA Govt — EIOPA proxy)",
        "url": "https://data.ecb.europa.eu/",
        "tenors": tenors,
        "yields": [results.get(t, {}).get("value") for t in tenors],
        "prior_yields": [results.get(t, {}).get("prior") for t in tenors],
        "prior_1m_yields": p1m_yields,
        "prior_1m_date": p1m_date,
        "prior_3m_yields": p3m_yields,
        "prior_3m_date": p3m_date,
        "year_ago_yields": [None] * len(tenors),
        "year_ago_date": "",
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

    current = interpolate_curve(current, tenors)

    last = load_last_india()
    if last:
        last_y = dict(zip(last.get("tenors", []), last.get("yields", [])))
        for t in tenors:
            if current.get(t) is None and last_y.get(t) is not None:
                current[t] = last_y[t]

    valid_count = sum(1 for v in current.values() if v is not None)
    if valid_count < 3:
        raise Exception(f"INDIA: insufficient data ({valid_count} tenors)")

    if rows and len(rows) > 2:
        p1m_yields, p1m_date = find_prior_date_yields(rows, 30, tenors)
        p3m_yields, p3m_date = find_prior_date_yields(rows, 91, tenors)
        ya_yields, ya_date = find_prior_date_yields(rows, 365, tenors, max_diff_days=21)
    else:
        p1m_yields = [te.get(t, {}).get("m1") for t in tenors]
        p1m_date = "TE month delta reconstruction"
        p3m_yields, p3m_date = history_lookup("india", 91, tenors)
        ya_yields = [te.get(t, {}).get("y1") for t in tenors]
        ya_date = "TE year delta reconstruction"
        try:
            p1m_val, p1m_d = fred_prior_single("INDIRLTLT01STM", 30)
            p3m_val, p3m_d = fred_prior_single("INDIRLTLT01STM", 91)
            ya_val, ya_d = fred_year_ago_10y("INDIRLTLT01STM")
            if p1m_val is not None and p1m_yields[tenors.index("10Y")] is None:
                p1m_yields[tenors.index("10Y")] = p1m_val
                p1m_date = p1m_d or p1m_date
            if p3m_val is not None and p3m_yields[tenors.index("10Y")] is None:
                p3m_yields[tenors.index("10Y")] = p3m_val
                p3m_date = p3m_d or p3m_date
            if ya_val is not None and ya_yields[tenors.index("10Y")] is None:
                ya_yields[tenors.index("10Y")] = ya_val
                ya_date = ya_d or ya_date
        except Exception:
            pass

    append_curve_history("india", date_str, tenors, [current.get(t) for t in tenors], source)

    write("india.json", {
        "date": date_str,
        "source": source,
        "url": source_url,
        "tenors": tenors,
        "yields": [current.get(t) for t in tenors],
        "prior_yields": [None] * len(tenors),
        "prior_1m_yields": p1m_yields,
        "prior_1m_date": p1m_date,
        "prior_3m_yields": p3m_yields,
        "prior_3m_date": p3m_date,
        "year_ago_yields": ya_yields,
        "year_ago_date": ya_date,
        "note": "FBIL latest first, then Investing/TE/FRED, then local history / cache. India 3M curve is exact once local history accumulates."
    })
    log.info(f"  INDIA OK: {valid_count} tenors")

# ── 6. CREDIT ──
def fetch_credit():
    log.info("CREDIT: fetching all series in single request")
    series = {"ig": "BAMLC0A0CM", "aaa": "BAMLC0A1CAAA", "aa": "BAMLC0A2CAA", "a": "BAMLC0A3CA", "bbb": "BAMLC0A4CBBB", "hy": "BAMLH0A0HYM2", "bb": "BAMLH0A1HYBB", "b": "BAMLH0A2HYB", "ccc": "BAMLH0A3HYC"}
    names = {"ig": "US IG", "aaa": "US AAA", "aa": "US AA", "a": "US A", "bbb": "US BBB", "hy": "US HY", "bb": "US BB", "b": "US B", "ccc": "US CCC+"}
    buckets = {"ig": "IG", "aaa": "AAA", "aa": "AA", "a": "A", "bbb": "BBB", "hy": "HY", "bb": "BB", "b": "B", "ccc": "CCC"}

    all_sids = list(series.values())
    multi = fred_multi_csv(all_sids, start="2025-01-01")

    spreads = {}
    latest_date = ""
    for key, sid in series.items():
        obs = multi.get(sid, [])
        if obs:
            curr = round(obs[0]["value"] * 100)
            prev = round(obs[1]["value"] * 100) if len(obs) > 1 else curr
            if obs[0]["date"] > latest_date:
                latest_date = obs[0]["date"]
            spreads[key] = {"name": names[key], "spread": curr, "prior": prev, "bucket": buckets[key]}
            log.info(f"  Credit {key}: {curr}bp")
        else:
            log.warning(f"  Credit {key}: no data")

    if not spreads:
        log.info("  Credit: multi failed, trying individual requests")
        for key, sid in list(series.items())[:3]:
            obs = fred_csv(sid, start="2025-01-01", retries=1)
            if obs:
                curr = round(obs[0]["value"] * 100)
                prev = round(obs[1]["value"] * 100) if len(obs) > 1 else curr
                if obs[0]["date"] > latest_date:
                    latest_date = obs[0]["date"]
                spreads[key] = {"name": names[key], "spread": curr, "prior": prev, "bucket": buckets[key]}
            time.sleep(2)

    assert spreads, "CREDIT: no series"
    write("credit.json", {"date": latest_date, "source": "FRED / ICE BofA Indices", "url": "https://fred.stlouisfed.org/release?rid=209", "spreads": spreads})
    log.info(f"  CREDIT OK: {latest_date}, {len(spreads)} series")

# ── 7. SOFR ──
def fetch_sofr():
    log.info("SOFR: fetching from NY Fed API")
    rates = {}
    history = []
    latest_date = ""

    try:
        url = "https://markets.newyorkfed.org/api/rates/secured/sofr/last/30.json"
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
                    for o in obs[:30]:
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

    write("sofr.json", {
        "date": latest_date,
        "source": "NY Fed / FRED",
        "url": "https://www.newyorkfed.org/markets/reference-rates/sofr",
        "rates": rates,
        "history": history,
        "year_ago": {"rate": ya_rate, "date": ya_date},
        "note": "Published daily by NY Fed at ~8:00 AM ET. Averages are backward-looking compounded."
    })
    log.info(f"  SOFR OK: {latest_date}")

# ── 8. BMA RATES ──
def fetch_bma_rates():
    log.info("BMA RATES: fetching")
    latest_date, latest_pub, pdf_url = "", "", ""
    entries = []

    try:
        html = get("https://www.bma.bm/document-centre/reporting-forms-and-guidelines-insurance", timeout=20)
        for asof_raw, pub_raw, href_raw in re.findall(
            r'Discount\s+Rates.*?(\d{1,2}\s+\w+\s+\d{4}).*?(?:-\s*(\d{1,2}\s+\w+\s+\d{4}))?.*?href="([^"]+\.pdf)"',
            html, re.IGNORECASE | re.DOTALL
        ):
            dt = parse_d(asof_raw.strip())
            if dt is None:
                continue
            href = href_raw if href_raw.startswith("http") else f"https://www.bma.bm{href_raw}"
            entries.append({"as_of": asof_raw.strip(), "published": pub_raw.strip(), "url": href, "as_of_dt": dt, "published_dt": parse_d(pub_raw)})
        log.info(f"  BMA T1: {len(entries)} entries")

        if not entries:
            dr_matches = re.findall(
                r'Discount\s+Rates[.\s]*(\d{1,2}\s+\w+\s+\d{4})[.\s]*-?\s*(\d{1,2}\s+\w+\s+\d{4})?',
                html, re.IGNORECASE
            )
            pdf_matches = re.findall(r'href="([^"]*[Dd]iscount[^"]*)"', html)
            for i, m in enumerate(dr_matches):
                dt = parse_d(m[0].strip())
                if dt is None:
                    continue
                href_raw = pdf_matches[i] if i < len(pdf_matches) else ""
                href = (href_raw if href_raw.startswith("http") else f"https://www.bma.bm{href_raw}") if href_raw else ""
                entries.append({"as_of": m[0].strip(), "published": m[1].strip() if m[1] else "", "url": href, "as_of_dt": dt, "published_dt": parse_d(m[1] if m[1] else "")})
            log.info(f"  BMA T2: {len(entries)} entries")

        if not entries:
            for href_raw in re.findall(r'href="([^"]*[Dd]iscount[^"]*\.pdf)"', html):
                dt = extract_date_from_url(href_raw)
                if dt is None:
                    continue
                href = href_raw if href_raw.startswith("http") else f"https://www.bma.bm{href_raw}"
                entries.append({"as_of": dt.strftime("%d %B %Y").lstrip("0"), "published": "", "url": href, "as_of_dt": dt, "published_dt": None})
            log.info(f"  BMA T3: {len(entries)} entries")

        entries.sort(key=lambda x: (x["as_of_dt"], x["published_dt"] or datetime.min), reverse=True)
        if entries:
            latest_date = entries[0]["as_of"]
            latest_pub = entries[0]["published"]
            pdf_url = entries[0]["url"]
            log.info(f"  BMA selected: {latest_date}")
        else:
            log.warning("  BMA: no structured matches found in any tier")

    except Exception as e:
        log.warning(f"  BMA scrape failed: {e}")

    if not latest_date:
        last = load_last_bma()
        if last:
            latest_date = last.get("as_of_date", "")
            latest_pub = last.get("publication_date", "")
            pdf_url = last.get("pdf_url", "")
            log.warning("  BMA: using T4 cache fallback")

    all_publications = [{"as_of": e["as_of"], "published": e["published"], "url": e["url"]} for e in entries[:6]]

    manual_file = DATA / "bma_rates_manual.json"
    manual = json.loads(manual_file.read_text()) if manual_file.exists() else None
    bma_tenors = ["0.5Y", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "25Y", "30Y", "40Y", "50Y"]
    currencies = ["USD", "GBP", "EUR", "JPY", "CAD", "AUD", "CHF"]
    output = {
        "as_of_date": latest_date or (manual or {}).get("as_of_date", "Check BMA website"),
        "publication_date": latest_pub,
        "source": "BMA — EBS Discount Rates",
        "url": "https://www.bma.bm/document-centre/reporting-forms-and-guidelines-insurance",
        "pdf_url": pdf_url,
        "tenors": bma_tenors,
        "all_publications": all_publications,
        "currencies": {},
        "note": f"Latest: {latest_date or 'unknown'}. " + ("Rates from manual file." if manual else "Populate data/bma_rates_manual.json.")
    }
    if manual and "currencies" in manual:
        output["currencies"] = manual["currencies"]
        if manual.get("as_of_date"):
            output["as_of_date"] = manual["as_of_date"]
    else:
        for ccy in currencies:
            output["currencies"][ccy] = {"rates": [None] * len(bma_tenors), "prior_1m_rates": [None] * len(bma_tenors), "prior_rates": [None] * len(bma_tenors)}
    write("bma_rates.json", output)
    log.info("  BMA RATES OK")

# ── 9. COMMODITIES ──
def fetch_commodities():
    log.info("COMMODITIES: fetching")
    TENOR_ORDER = ["3M", "6M", "12M", "24M"]
    TENOR_NS = [("3M", 3), ("6M", 6), ("12M", 12), ("24M", 24)]
    last = load_last_commodities()

    def get_spot(fred_series, inv_path, yahoo_front, te_url=None):
        obs = fred_csv(fred_series, start="2023-01-01")
        if obs:
            return round(obs[0]["value"], 2), obs[0]["date"], "FRED"
        if te_url:
            v = scrape_te_last_value(te_url)
            if v:
                return v, "", "TradingEconomics"
        v = scrape_commodity_spot(inv_path)
        if v:
            return v, "", "Investing"
        v = yahoo_price(yahoo_front)
        return v, "", "Yahoo"

    def fetch_all_futures(sym_fn, label_prefix):
        now_dt = datetime.utcnow()
        tasks = []
        for lbl, months in TENOR_NS:
            cur_sym, cur_exp = sym_fn(months, base_dt=now_dt)
            tasks.append((lbl, months, cur_sym, cur_exp, "now", now_dt))
            tasks.append((lbl, months, None, None, "1m", now_dt - timedelta(days=30)))
            tasks.append((lbl, months, None, None, "3m", now_dt - timedelta(days=91)))

        raw = {}

        def run(task):
            lbl, months, sym, exp, kind, target_dt = task
            if kind == "now":
                return lbl, kind, yahoo_price(sym), "", sym, exp
            hist_sym, hist_exp = sym_fn(months, base_dt=target_dt)
            v, d = yahoo_price_near_date(hist_sym, target_dt)
            return lbl, kind, v, d, hist_sym, hist_exp

        with ThreadPoolExecutor(max_workers=12) as ex:
            fmap = {ex.submit(run, t): t for t in tasks}
            for fut in as_completed(fmap):
                try:
                    lbl, kind, price, d, sym, exp = fut.result()
                    raw.setdefault(lbl, {})[kind] = {"price": price, "date": d, "symbol": sym, "expiry": exp}
                    log.info(f"  {label_prefix} {lbl}/{kind}: {price} via {sym}")
                except Exception:
                    pass

        result = {}
        for lbl, months in TENOR_NS:
            r = raw.get(lbl, {})
            cur = r.get("now", {})
            p1m = r.get("1m", {})
            p3m = r.get("3m", {})
            result[lbl] = {
                "price": cur.get("price"),
                "expiry": cur.get("expiry"),
                "contract": (cur.get("symbol") or "").split(".")[0],
                "prior_1m": p1m.get("price"),
                "prior_1m_date": p1m.get("date"),
                "prior_1m_contract": (p1m.get("symbol") or "").split(".")[0],
                "prior_3m": p3m.get("price"),
                "prior_3m_date": p3m.get("date"),
                "prior_3m_contract": (p3m.get("symbol") or "").split(".")[0],
            }
        return {lbl: result[lbl] for lbl in TENOR_ORDER if lbl in result}

    gold_spot, gold_spot_date, gold_spot_source = get_spot("GOLDAMGBD228NLBM", "/commodities/gold", "GC=F", "https://tradingeconomics.com/commodity/gold")
    gold_1m, gold_1m_d = fred_prior_single("GOLDAMGBD228NLBM", 30)
    gold_3m, gold_3m_d = fred_prior_single("GOLDAMGBD228NLBM", 91)
    gold_1y, gold_1y_d = fred_prior_single("GOLDAMGBD228NLBM", 365)
    gold_futures = fetch_all_futures(_gold_symbol, "Gold")

    wti_spot, wti_spot_date, wti_spot_source = get_spot("DCOILWTICO", "/commodities/crude-oil", "CL=F", "https://tradingeconomics.com/commodity/crude-oil")
    wti_1m, wti_1m_d = fred_prior_single("DCOILWTICO", 30)
    wti_3m, wti_3m_d = fred_prior_single("DCOILWTICO", 91)
    wti_1y, wti_1y_d = fred_prior_single("DCOILWTICO", 365)
    wti_futures = fetch_all_futures(_wti_symbol, "WTI")

    brent_spot, brent_spot_date, brent_spot_source = get_spot("DCOILBRENTEU", "/commodities/brent-oil", "BZ=F", "https://tradingeconomics.com/commodity/brent-crude-oil")
    brent_1m, brent_1m_d = fred_prior_single("DCOILBRENTEU", 30)
    brent_3m, brent_3m_d = fred_prior_single("DCOILBRENTEU", 91)
    brent_1y, brent_1y_d = fred_prior_single("DCOILBRENTEU", 365)
    brent_futures = fetch_all_futures(_brent_symbol, "Brent")

    if last:
        if gold_spot is None:
            gold_spot = last.get("gold", {}).get("spot")
        if wti_spot is None:
            wti_spot = last.get("wti", {}).get("spot")
        if brent_spot is None:
            brent_spot = last.get("brent", {}).get("spot")

    write("commodities.json", {
        "date": datetime.utcnow().strftime("%Y-%m-%d"),
        "source": "FRED / TradingEconomics / Investing / Yahoo Finance",
        "gold": {
            "spot": gold_spot,
            "spot_date": gold_spot_date,
            "spot_source": gold_spot_source,
            "unit": "USD/troy oz",
            "prior_1m": gold_1m, "prior_1m_date": gold_1m_d,
            "prior_3m": gold_3m, "prior_3m_date": gold_3m_d,
            "prior_1y": gold_1y, "prior_1y_date": gold_1y_d,
            "futures": gold_futures
        },
        "wti": {
            "spot": wti_spot,
            "spot_date": wti_spot_date,
            "spot_source": wti_spot_source,
            "unit": "USD/barrel",
            "prior_1m": wti_1m, "prior_1m_date": wti_1m_d,
            "prior_3m": wti_3m, "prior_3m_date": wti_3m_d,
            "prior_1y": wti_1y, "prior_1y_date": wti_1y_d,
            "futures": wti_futures
        },
        "brent": {
            "spot": brent_spot,
            "spot_date": brent_spot_date,
            "spot_source": brent_spot_source,
            "unit": "USD/barrel",
            "prior_1m": brent_1m, "prior_1m_date": brent_1m_d,
            "prior_3m": brent_3m, "prior_3m_date": brent_3m_d,
            "prior_1y": brent_1y, "prior_1y_date": brent_1y_d,
            "futures": brent_futures
        },
        "note": "Spot history comes from daily FRED series. Futures history is roll-aware by target date."
    })
    log.info("  COMMODITIES OK")

# ── RUN ──
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
        ("sofr", fetch_sofr),
        ("bma_rates", fetch_bma_rates),
        ("commodities", fetch_commodities),
    ]:
        try:
            fn()
            results[name] = "ok"
        except Exception as e:
            log.error(f"  {name} FAILED: {e}")
            results[name] = str(e)
    write("manifest.json", {"results": results, "run": datetime.utcnow().isoformat() + "Z"})
    failed = [k for k, v in results.items() if v != "ok"]
    log.info(f"Done: {len(results)-len(failed)}/{len(results)} ok" + (f", failed: {failed}" if failed else ""))

if __name__ == "__main__":
    main()

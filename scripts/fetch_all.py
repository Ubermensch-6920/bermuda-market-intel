#!/usr/bin/env python3
"""Bermuda Market Intel — Data Pipeline v7. SOFR via NY Fed API, FRED with retries."""
import json, re, sys, os, logging, time
from datetime import datetime, timedelta
from pathlib import Path
import urllib.request

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fetch")
DATA = Path(__file__).parent.parent / "data"
DATA.mkdir(exist_ok=True)
HDR = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
       "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9"}

def get(url, timeout=25):
    req = urllib.request.Request(url, headers=HDR)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")

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
                    try: obs.append({"date": parts[0], "value": float(parts[1])})
                    except: pass
            obs.sort(key=lambda x: x["date"], reverse=True)
            if obs: return obs
        except Exception as e:
            log.warning(f"  FRED {series_id} attempt {attempt+1}: {e}")
            if attempt < retries: time.sleep(2)
    return []

def fred_multi_csv(series_ids, start="2024-01-01"):
    """Fetch MULTIPLE FRED series in ONE request. Returns {series_id: [obs]}."""
    joined = ",".join(series_ids)
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={joined}&cosd={start}"
    result = {sid: [] for sid in series_ids}
    try:
        raw = get(url, timeout=15)
        lines = raw.strip().split("\n")
        if len(lines) < 2: return result
        header = lines[0].split(",")  # DATE, SERIES1, SERIES2, ...
        # Map column index to series_id
        col_map = {}
        for i, h in enumerate(header):
            h = h.strip().strip('"')
            if h in series_ids: col_map[i] = h
            elif h.upper() in [s.upper() for s in series_ids]:
                # Case-insensitive match
                for sid in series_ids:
                    if sid.upper() == h.upper(): col_map[i] = sid; break
        for line in lines[1:]:
            parts = line.split(",")
            if len(parts) < 2: continue
            date = parts[0].strip().strip('"')
            if not re.match(r"\d{4}-\d{2}-\d{2}", date): continue
            for ci, sid in col_map.items():
                if ci < len(parts):
                    val = parts[ci].strip().strip('"')
                    if val not in (".", ""):
                        try: result[sid].append({"date": date, "value": float(val)})
                        except: pass
        for sid in result:
            result[sid].sort(key=lambda x: x["date"], reverse=True)
    except Exception as e:
        log.warning(f"  FRED multi fetch failed: {e}")
    return result

def fred_year_ago_10y(series_id):
    target = (datetime.utcnow() - timedelta(days=365)).strftime("%Y-%m-%d")
    obs = fred_csv(series_id, start=(datetime.utcnow() - timedelta(days=400)).strftime("%Y-%m-%d"))
    if not obs: return None, ""
    best = min(obs, key=lambda o: abs((datetime.strptime(o["date"],"%Y-%m-%d") - datetime.strptime(target,"%Y-%m-%d")).days))
    return round(best["value"], 4), best["date"]

def find_prior_date_yields(rows, days_ago, tenors, max_diff_days=14):
    """Find yields from rows list closest to N days ago. rows: [{date, yields}] sorted desc."""
    target = (datetime.utcnow() - timedelta(days=days_ago)).strftime("%Y-%m-%d")
    if not rows: return [None]*len(tenors), ""
    best = min(rows, key=lambda r: abs((datetime.strptime(r["date"],"%Y-%m-%d") - datetime.strptime(target,"%Y-%m-%d")).days))
    diff = abs((datetime.strptime(best["date"],"%Y-%m-%d") - datetime.strptime(target,"%Y-%m-%d")).days)
    if diff > max_diff_days: return [None]*len(tenors), ""
    return [best["yields"].get(t) for t in tenors], best["date"]

def fred_prior_single(series_id, days_ago, max_diff_days=14):
    """Fetch a single FRED series value closest to N days ago. Returns (value, date)."""
    target_dt = datetime.utcnow() - timedelta(days=days_ago)
    start = (target_dt - timedelta(days=30)).strftime("%Y-%m-%d")
    obs = fred_csv(series_id, start=start, retries=1)
    if not obs: return None, ""
    target = target_dt.strftime("%Y-%m-%d")
    best = min(obs, key=lambda o: abs((datetime.strptime(o["date"],"%Y-%m-%d") - datetime.strptime(target,"%Y-%m-%d")).days))
    diff = abs((datetime.strptime(best["date"],"%Y-%m-%d") - datetime.strptime(target,"%Y-%m-%d")).days)
    if diff > max_diff_days: return None, ""
    return round(best["value"], 4), best["date"]

def scrape_investing_yield(url_path):
    try:
        html = get(f"https://www.investing.com{url_path}", timeout=15)
        for pat in [r'data-test="instrument-price-last"[^>]*>([\d.]+)<',
                    r'class="text-5xl[^"]*"[^>]*>([\d.]+)<',
                    r'class="text-2xl[^"]*"[^>]*>([\d.]+)<',
                    r'"last":\s*([\d.]+)', r'"last_numeric":\s*([\d.]+)']:
            m = re.search(pat, html)
            if m:
                v = float(m.group(1))
                if 0 < v < 20: return v
    except: pass
    return None

# ── 1. UST ──
def fetch_ust():
    log.info("UST: fetching")
    import xml.etree.ElementTree as ET
    ns = {"a":"http://www.w3.org/2005/Atom","m":"http://schemas.microsoft.com/ado/2007/08/dataservices/metadata","d":"http://schemas.microsoft.com/ado/2007/08/dataservices"}
    tmap = {"BC_1MONTH":"1M","BC_3MONTH":"3M","BC_6MONTH":"6M","BC_1YEAR":"1Y","BC_2YEAR":"2Y","BC_3YEAR":"3Y","BC_5YEAR":"5Y","BC_7YEAR":"7Y","BC_10YEAR":"10Y","BC_20YEAR":"20Y","BC_30YEAR":"30Y"}
    tenors = list(tmap.values())
    def parse_year(year):
        raw = get(f"https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value={year}")
        rows = []
        for entry in ET.fromstring(raw).findall("a:entry", ns):
            props = entry.find("a:content/m:properties", ns)
            if props is None: continue
            de = props.find("d:NEW_DATE", ns)
            if de is None or not de.text: continue
            yd = {}
            for xf, tn in tmap.items():
                el = props.find(f"d:{xf}", ns)
                try: yd[tn] = round(float(el.text), 4)
                except: yd[tn] = None
            rows.append({"date": de.text[:10], "yields": yd})
        rows.sort(key=lambda x: x["date"], reverse=True)
        return rows
    now = datetime.utcnow(); rows = parse_year(now.year)
    assert len(rows) >= 2
    target_ya = (now - timedelta(days=365)).strftime("%Y-%m-%d")
    ya_rows = parse_year(now.year - 1)
    ya_yields, ya_date = [None]*len(tenors), ""
    if ya_rows:
        best = min(ya_rows, key=lambda r: abs((datetime.strptime(r["date"],"%Y-%m-%d") - datetime.strptime(target_ya,"%Y-%m-%d")).days))
        ya_yields = [best["yields"].get(t) for t in tenors]; ya_date = best["date"]
    all_rows = rows + ya_rows
    p1m_yields, p1m_date = find_prior_date_yields(all_rows, 30, tenors)
    p3m_yields, p3m_date = find_prior_date_yields(all_rows, 91, tenors)
    log.info(f"  UST 1M ago: {p1m_date}, 3M ago: {p3m_date}")
    write("ust.json", {"date": rows[0]["date"], "prior_date": rows[1]["date"],
        "source": "US Treasury Daily Par Yield Curve", "url": "https://home.treasury.gov/resource-center/data-chart-center/interest-rates",
        "tenors": tenors, "yields": [rows[0]["yields"].get(t) for t in tenors],
        "prior_yields": [rows[1]["yields"].get(t) for t in tenors],
        "prior_1m_yields": p1m_yields, "prior_1m_date": p1m_date,
        "prior_3m_yields": p3m_yields, "prior_3m_date": p3m_date,
        "year_ago_yields": ya_yields, "year_ago_date": ya_date})
    log.info(f"  UST OK: {rows[0]['date']}")

# ── 2. JGB ──
def fetch_jgb():
    log.info("JGB: fetching")
    want = ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","25Y","30Y","40Y"]
    raw = get("https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv")
    lines = raw.split("\n"); hdr_idx, headers = -1, []
    for i, line in enumerate(lines[:5]):
        if "date" in line.lower(): hdr_idx = i; headers = [h.strip().strip('"') for h in line.split(",")]; break
    assert hdr_idx >= 0
    col = {h.replace(" ",""): j for j, h in enumerate(headers) if h.replace(" ","") in want}
    rows = []
    for line in lines[hdr_idx+1:]:
        parts = [p.strip().strip('"') for p in line.split(",")]
        if len(parts) < 10: continue
        m = re.match(r"(\d{4})[/-](\d{1,2})[/-](\d{1,2})", parts[0])
        if not m: continue
        date = f"{m[1]}-{m[2].zfill(2)}-{m[3].zfill(2)}"
        yd = {}
        for t in want:
            if t in col:
                try: yd[t] = round(float(parts[col[t]]), 4)
                except: yd[t] = None
        rows.append({"date": date, "yields": yd})
    rows.sort(key=lambda x: x["date"], reverse=True)
    assert len(rows) >= 2
    target_ya = (datetime.utcnow() - timedelta(days=365)).strftime("%Y-%m-%d")
    ya_candidates = [r for r in rows if r["date"] <= target_ya]
    ya_yields, ya_date = [None]*len(want), ""
    if ya_candidates: ya_yields = [ya_candidates[0]["yields"].get(t) for t in want]; ya_date = ya_candidates[0]["date"]
    if not any(v is not None for v in ya_yields):
        fred_ya, fdate = fred_year_ago_10y("IRLTLT01JPM156N")
        if fred_ya: ya_yields[want.index("10Y")] = fred_ya; ya_date = fdate
    p1m_yields, p1m_date = find_prior_date_yields(rows, 30, want)
    p3m_yields, p3m_date = find_prior_date_yields(rows, 91, want)
    log.info(f"  JGB 1M ago: {p1m_date}, 3M ago: {p3m_date}")
    write("jgb.json", {"date": rows[0]["date"], "prior_date": rows[1]["date"],
        "source": "Ministry of Finance Japan", "url": "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/",
        "tenors": want, "yields": [rows[0]["yields"].get(t) for t in want],
        "prior_yields": [rows[1]["yields"].get(t) for t in want],
        "prior_1m_yields": p1m_yields, "prior_1m_date": p1m_date,
        "prior_3m_yields": p3m_yields, "prior_3m_date": p3m_date,
        "year_ago_yields": ya_yields, "year_ago_date": ya_date})
    log.info(f"  JGB OK: {rows[0]['date']}")

# ── 3. GILT ──
GILT_INV = {"1Y":"/rates-bonds/uk-1-year-bond-yield","2Y":"/rates-bonds/uk-2-year-bond-yield","3Y":"/rates-bonds/uk-3-year-bond-yield","5Y":"/rates-bonds/uk-5-year-bond-yield","7Y":"/rates-bonds/uk-7-year-bond-yield","10Y":"/rates-bonds/uk-10-year-bond-yield","15Y":"/rates-bonds/uk-15-year-bond-yield","20Y":"/rates-bonds/uk-20-year-bond-yield","30Y":"/rates-bonds/uk-30-year-bond-yield"}
def fetch_gilt():
    log.info("GILT: fetching"); tenors = list(GILT_INV.keys()); yields = {}
    for tenor, path in GILT_INV.items():
        v = scrape_investing_yield(path)
        if v: yields[tenor] = v; log.info(f"  Gilt {tenor}: {v}%")
        else: log.warning(f"  Gilt {tenor}: failed")
        time.sleep(0.5)
    assert len(yields) >= 3
    ya_yields = [None]*len(tenors); ya_date = ""
    fred_ya, fdate = fred_year_ago_10y("IRLTLT01GBM156N")
    if fred_ya: ya_yields[tenors.index("10Y")] = fred_ya; ya_date = fdate
    p1m_yields = [None]*len(tenors); p1m_date = ""
    p3m_yields = [None]*len(tenors); p3m_date = ""
    p1m_val, p1m_d = fred_prior_single("IRLTLT01GBM156N", 30)
    p3m_val, p3m_d = fred_prior_single("IRLTLT01GBM156N", 91)
    if p1m_val: p1m_yields[tenors.index("10Y")] = p1m_val; p1m_date = p1m_d
    if p3m_val: p3m_yields[tenors.index("10Y")] = p3m_val; p3m_date = p3m_d
    log.info(f"  Gilt 1M ago (10Y): {p1m_val} ({p1m_date}), 3M ago (10Y): {p3m_val} ({p3m_date})")
    write("gilt.json", {"date": datetime.utcnow().strftime("%Y-%m-%d"), "prior_date": "",
        "source": "Investing.com / FRED", "url": "https://www.investing.com/rates-bonds/uk-government-bonds",
        "tenors": tenors, "yields": [yields.get(t) for t in tenors], "prior_yields": [None]*len(tenors),
        "prior_1m_yields": p1m_yields, "prior_1m_date": p1m_date,
        "prior_3m_yields": p3m_yields, "prior_3m_date": p3m_date,
        "year_ago_yields": ya_yields, "year_ago_date": ya_date})
    log.info(f"  GILT OK: {len(yields)} tenors")

# ── 4. EUR ──
def fetch_eur():
    log.info("EUR: fetching")
    ecb_map = {"1Y":"SR_1Y","2Y":"SR_2Y","3Y":"SR_3Y","5Y":"SR_5Y","7Y":"SR_7Y","10Y":"SR_10Y","15Y":"SR_15Y","20Y":"SR_20Y","30Y":"SR_30Y"}
    tenors = list(ecb_map.keys()); results = {}
    for tn, sk in ecb_map.items():
        try:
            raw = get(f"https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.{sk}?lastNObservations=70&format=csvdata", timeout=15)
            lines = raw.strip().split("\n")
            if len(lines) < 2: continue
            header = lines[0].split(",")
            oi = next((i for i,h in enumerate(header) if "OBS_VALUE" in h), -1)
            ti = next((i for i,h in enumerate(header) if "TIME_PERIOD" in h), -1)
            if oi < 0: continue
            obs = []
            for line in lines[1:]:
                p = line.split(",")
                try: obs.append({"date": p[ti].strip('"'), "value": round(float(p[oi]), 4)})
                except: pass
            obs.sort(key=lambda x: x["date"], reverse=True)
            if obs:
                results[tn] = {"value": obs[0]["value"], "prior": obs[1]["value"] if len(obs)>1 else None,
                               "date": obs[0]["date"], "all_obs": obs}
        except: pass
    assert results
    latest = max(r["date"] for r in results.values())
    def ecb_find_prior(days_ago):
        target = (datetime.utcnow() - timedelta(days=days_ago)).strftime("%Y-%m-%d")
        out = []; d_used = ""
        for tn in tenors:
            obs_list = results.get(tn, {}).get("all_obs", [])
            if not obs_list: out.append(None); continue
            best = min(obs_list, key=lambda o: abs((datetime.strptime(o["date"],"%Y-%m-%d") - datetime.strptime(target,"%Y-%m-%d")).days))
            diff = abs((datetime.strptime(best["date"],"%Y-%m-%d") - datetime.strptime(target,"%Y-%m-%d")).days)
            if diff > 14: out.append(None)
            else: out.append(best["value"]); d_used = best["date"]
        return out, d_used
    p1m_yields, p1m_date = ecb_find_prior(30)
    p3m_yields, p3m_date = ecb_find_prior(91)
    log.info(f"  EUR 1M ago: {p1m_date}, 3M ago: {p3m_date}")
    write("eur.json", {"date": latest, "prior_date": "",
        "source": "ECB SDW (EUR AAA Govt — EIOPA proxy)", "url": "https://data.ecb.europa.eu/",
        "tenors": tenors, "yields": [results.get(t,{}).get("value") for t in tenors],
        "prior_yields": [results.get(t,{}).get("prior") for t in tenors],
        "prior_1m_yields": p1m_yields, "prior_1m_date": p1m_date,
        "prior_3m_yields": p3m_yields, "prior_3m_date": p3m_date,
        "year_ago_yields": [None]*len(tenors), "year_ago_date": "",
        "note": "EUR AAA govt curve proxy. Actual EIOPA RFR includes UFR extrapolation."})
    log.info(f"  EUR OK: {latest}")

# ── 5. INDIA ──
INDIA_INV = {"1Y":"/rates-bonds/india-1-year-bond-yield","2Y":"/rates-bonds/india-2-year-bond-yield","3Y":"/rates-bonds/india-3-year-bond-yield","5Y":"/rates-bonds/india-5-year-bond-yield","7Y":"/rates-bonds/india-7-year-bond-yield","10Y":"/rates-bonds/india-10-year-bond-yield","15Y":"/rates-bonds/india-15-year-bond-yield","20Y":"/rates-bonds/india-20-year-bond-yield","30Y":"/rates-bonds/india-30-year-bond-yield"}
def fetch_india():
    log.info("INDIA: fetching"); tenors = list(INDIA_INV.keys()); yields = {}
    for tenor, path in INDIA_INV.items():
        v = scrape_investing_yield(path)
        if v: yields[tenor] = v; log.info(f"  India {tenor}: {v}%")
        else: log.warning(f"  India {tenor}: failed")
        time.sleep(0.5)
    try:
        obs = fred_csv("INDIRLTLT01STM", start="2025-01-01")
        if obs and "10Y" not in yields: yields["10Y"] = round(obs[0]["value"], 2)
    except: pass
    assert len(yields) >= 1
    ya_yields = [None]*len(tenors); ya_date = ""
    fred_ya, fdate = fred_year_ago_10y("INDIRLTLT01STM")
    if fred_ya: ya_yields[tenors.index("10Y")] = fred_ya; ya_date = fdate
    p1m_yields = [None]*len(tenors); p1m_date = ""
    p3m_yields = [None]*len(tenors); p3m_date = ""
    p1m_val, p1m_d = fred_prior_single("INDIRLTLT01STM", 30)
    p3m_val, p3m_d = fred_prior_single("INDIRLTLT01STM", 91)
    if p1m_val: p1m_yields[tenors.index("10Y")] = p1m_val; p1m_date = p1m_d
    if p3m_val: p3m_yields[tenors.index("10Y")] = p3m_val; p3m_date = p3m_d
    log.info(f"  India 1M ago (10Y): {p1m_val} ({p1m_date}), 3M ago (10Y): {p3m_val} ({p3m_date})")
    write("india.json", {"date": datetime.utcnow().strftime("%Y-%m-%d"), "prior_date": "",
        "source": "Investing.com / FRED", "url": "https://www.investing.com/rates-bonds/india-government-bonds",
        "tenors": tenors, "yields": [yields.get(t) for t in tenors], "prior_yields": [None]*len(tenors),
        "prior_1m_yields": p1m_yields, "prior_1m_date": p1m_date,
        "prior_3m_yields": p3m_yields, "prior_3m_date": p3m_date,
        "year_ago_yields": ya_yields, "year_ago_date": ya_date})
    log.info(f"  INDIA OK: {len(yields)} tenors")

# ── 6. CREDIT (ONE FRED request for all 9 series) ──
def fetch_credit():
    log.info("CREDIT: fetching all series in single request")
    series = {"ig":"BAMLC0A0CM","aaa":"BAMLC0A1CAAA","aa":"BAMLC0A2CAA","a":"BAMLC0A3CA",
              "bbb":"BAMLC0A4CBBB","hy":"BAMLH0A0HYM2","bb":"BAMLH0A1HYBB","b":"BAMLH0A2HYB","ccc":"BAMLH0A3HYC"}
    names = {"ig":"US IG","aaa":"US AAA","aa":"US AA","a":"US A","bbb":"US BBB","hy":"US HY","bb":"US BB","b":"US B","ccc":"US CCC+"}
    buckets = {"ig":"IG","aaa":"AAA","aa":"AA","a":"A","bbb":"BBB","hy":"HY","bb":"BB","b":"B","ccc":"CCC"}
    
    # Single request for all 9 series
    all_sids = list(series.values())
    multi = fred_multi_csv(all_sids, start="2025-01-01")
    
    spreads = {}; latest_date = ""
    for key, sid in series.items():
        obs = multi.get(sid, [])
        if obs:
            curr = round(obs[0]["value"]*100); prev = round(obs[1]["value"]*100) if len(obs)>1 else curr
            if obs[0]["date"] > latest_date: latest_date = obs[0]["date"]
            spreads[key] = {"name": names[key], "spread": curr, "prior": prev, "bucket": buckets[key]}
            log.info(f"  Credit {key}: {curr}bp")
        else:
            log.warning(f"  Credit {key}: no data")
    
    # Fallback: try individual requests if multi failed entirely
    if not spreads:
        log.info("  Credit: multi failed, trying individual requests")
        for key, sid in list(series.items())[:3]:  # Only try first 3 to avoid timeout
            obs = fred_csv(sid, start="2025-01-01", retries=1)
            if obs:
                curr = round(obs[0]["value"]*100); prev = round(obs[1]["value"]*100) if len(obs)>1 else curr
                if obs[0]["date"] > latest_date: latest_date = obs[0]["date"]
                spreads[key] = {"name": names[key], "spread": curr, "prior": prev, "bucket": buckets[key]}
            time.sleep(2)
    
    assert spreads, "CREDIT: no series"
    write("credit.json", {"date": latest_date, "source": "FRED / ICE BofA Indices",
        "url": "https://fred.stlouisfed.org/release?rid=209", "spreads": spreads})
    log.info(f"  CREDIT OK: {latest_date}, {len(spreads)} series")

# ── 7. SOFR (NY Fed direct API — no FRED needed) ──
def fetch_sofr():
    log.info("SOFR: fetching from NY Fed API")
    rates = {}; history = []; latest_date = ""

    # NY Fed Markets API — returns JSON directly, no auth needed
    # Docs: https://markets.newyorkfed.org/static/docs/markets-api.html
    try:
        # Last 30 days of SOFR
        url = "https://markets.newyorkfed.org/api/rates/secured/sofr/last/30.json"
        raw = get(url, timeout=15)
        data = json.loads(raw)
        sofr_data = data.get("refRates", [])
        if sofr_data:
            # Sort by date descending
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

            # Build history for chart
            for d in sofr_data:
                try:
                    history.append({
                        "date": d["effectiveDate"],
                        "rate": round(float(d["percentRate"]), 4)
                    })
                except: pass
            history.sort(key=lambda x: x["date"])
    except Exception as e:
        log.warning(f"  SOFR NY Fed API: {e}")

    # SOFR Averages from NY Fed
    try:
        url = "https://markets.newyorkfed.org/api/rates/secured/sofr/last/1.json?productType=sofrAverage"
        raw = get(url, timeout=15)
        data = json.loads(raw)
        for item in data.get("refRates", []):
            avg_type = item.get("averagingMethod", "")
            if "30" in avg_type:
                rates["30D_AVG"] = {"name": "SOFR 30-Day Avg", "desc": "30-day compounded average",
                    "rate": round(float(item.get("percentRate", 0)), 4), "prior": None, "date": item.get("effectiveDate", "")}
                log.info(f"  SOFR 30D: {rates['30D_AVG']['rate']}%")
            elif "90" in avg_type:
                rates["90D_AVG"] = {"name": "SOFR 90-Day Avg", "desc": "90-day compounded average",
                    "rate": round(float(item.get("percentRate", 0)), 4), "prior": None, "date": item.get("effectiveDate", "")}
                log.info(f"  SOFR 90D: {rates['90D_AVG']['rate']}%")
            elif "180" in avg_type:
                rates["180D_AVG"] = {"name": "SOFR 180-Day Avg", "desc": "180-day compounded average",
                    "rate": round(float(item.get("percentRate", 0)), 4), "prior": None, "date": item.get("effectiveDate", "")}
                log.info(f"  SOFR 180D: {rates['180D_AVG']['rate']}%")
    except Exception as e:
        log.warning(f"  SOFR averages: {e}")

    # Fallback: FRED if NY Fed API fails
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
                rates[key] = {"name": name, "desc": desc, "rate": round(obs[0]["value"], 4),
                    "prior": round(obs[1]["value"], 4) if len(obs) > 1 else None, "date": obs[0]["date"]}
                if key == "SOFR":
                    for o in obs[:30]: history.append({"date": o["date"], "rate": round(o["value"], 4)})
                    history.sort(key=lambda x: x["date"])
                    if obs[0]["date"] > latest_date: latest_date = obs[0]["date"]
            time.sleep(1)

    assert rates, "SOFR: no data from NY Fed or FRED"

    # Year-ago
    ya_rate, ya_date = None, ""
    try:
        target = (datetime.utcnow() - timedelta(days=365)).strftime("%Y-%m-%d")
        # Try NY Fed API for year-ago
        url = f"https://markets.newyorkfed.org/api/rates/secured/sofr/search.json?startDate={(datetime.utcnow()-timedelta(days=370)).strftime('%Y-%m-%d')}&endDate={(datetime.utcnow()-timedelta(days=360)).strftime('%Y-%m-%d')}"
        raw = get(url, timeout=10)
        data = json.loads(raw)
        ya_data = data.get("refRates", [])
        if ya_data:
            best = min(ya_data, key=lambda x: abs((datetime.strptime(x["effectiveDate"],"%Y-%m-%d") - datetime.strptime(target,"%Y-%m-%d")).days))
            ya_rate = round(float(best["percentRate"]), 4); ya_date = best["effectiveDate"]
    except: pass
    # FRED fallback for year-ago
    if ya_rate is None:
        ya_rate, ya_date = fred_year_ago_10y("SOFR")  # reuse helper, works for any series

    log.info(f"  SOFR year-ago: {ya_rate}% ({ya_date})")

    write("sofr.json", {
        "date": latest_date, "source": "NY Fed / FRED",
        "url": "https://www.newyorkfed.org/markets/reference-rates/sofr",
        "rates": rates, "history": history,
        "year_ago": {"rate": ya_rate, "date": ya_date},
        "note": "Published daily by NY Fed at ~8:00 AM ET. Averages are backward-looking compounded."})
    log.info(f"  SOFR OK: {latest_date}")

# ── 8. BMA RATES ──
def fetch_bma_rates():
    log.info("BMA RATES: fetching")
    latest_date, latest_pub, pdf_url = "", "", ""
    all_dr = []
    try:
        html = get("https://www.bma.bm/document-centre/reporting-forms-and-guidelines-insurance", timeout=20)
        matches = re.findall(r'Discount\s+Rates[.\s]*(\d{1,2}\s+\w+\s+\d{4})[.\s]*-?\s*(\d{1,2}\s+\w+\s+\d{4})?', html, re.IGNORECASE)
        for m in matches: all_dr.append({"as_of": m[0].strip(), "published": m[1].strip() if m[1] else ""})
        def parse_d(s):
            for fmt in ["%d %B %Y", "%d %b %Y"]:
                try: return datetime.strptime(s.strip(), fmt)
                except: pass
            return datetime(2000,1,1)
        if all_dr:
            all_dr.sort(key=lambda x: parse_d(x["as_of"]), reverse=True)
            latest_date = all_dr[0]["as_of"]; latest_pub = all_dr[0]["published"]
        pdfs = re.findall(r'href="([^"]*[Dd]iscount[^"]*)"', html)
        if pdfs: pdf_url = pdfs[0] if pdfs[0].startswith("http") else f"https://www.bma.bm{pdfs[0]}"
    except Exception as e: log.warning(f"  BMA: {e}")
    manual_file = DATA / "bma_rates_manual.json"
    manual = json.loads(manual_file.read_text()) if manual_file.exists() else None
    bma_tenors = ["0.5Y","1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","25Y","30Y","40Y","50Y"]
    currencies = ["USD","GBP","EUR","JPY","CAD","AUD","CHF"]
    output = {"as_of_date": latest_date or (manual or {}).get("as_of_date","Check BMA website"),
        "publication_date": latest_pub, "source": "BMA — EBS Discount Rates",
        "url": "https://www.bma.bm/document-centre/reporting-forms-and-guidelines-insurance",
        "pdf_url": pdf_url, "tenors": bma_tenors, "all_publications": all_dr[:6], "currencies": {},
        "note": f"Latest: {latest_date or 'unknown'}. " + ("Rates from manual file." if manual else "Populate data/bma_rates_manual.json.")}
    if manual and "currencies" in manual:
        output["currencies"] = manual["currencies"]
        if manual.get("as_of_date"): output["as_of_date"] = manual["as_of_date"]
    else:
        for ccy in currencies: output["currencies"][ccy] = {"rates": [None]*len(bma_tenors), "prior_1m_rates": [None]*len(bma_tenors), "prior_rates": [None]*len(bma_tenors)}
    write("bma_rates.json", output)
    log.info(f"  BMA RATES OK")

# ── RUN ──
def main():
    log.info("=" * 50)
    results = {}
    for name, fn in [("ust",fetch_ust),("jgb",fetch_jgb),("gilt",fetch_gilt),("eur",fetch_eur),
                     ("india",fetch_india),("credit",fetch_credit),("sofr",fetch_sofr),("bma_rates",fetch_bma_rates)]:
        try: fn(); results[name] = "ok"
        except Exception as e: log.error(f"  {name} FAILED: {e}"); results[name] = str(e)
    write("manifest.json", {"results": results, "run": datetime.utcnow().isoformat()+"Z"})
    failed = [k for k,v in results.items() if v != "ok"]
    log.info(f"Done: {len(results)-len(failed)}/{len(results)} ok" + (f", failed: {failed}" if failed else ""))

if __name__ == "__main__":
    main()

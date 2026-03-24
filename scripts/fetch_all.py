#!/usr/bin/env python3
"""Bermuda Market Intel — Data Pipeline. Runs in GitHub Actions, writes JSON to data/."""
import json, csv, io, re, sys, os, logging
from datetime import datetime, timedelta
from pathlib import Path
import urllib.request

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fetch")
DATA = Path(__file__).parent.parent / "data"
DATA.mkdir(exist_ok=True)

HDR = {"User-Agent": "BermudaMarketIntel/1.0 (github.com)"}

def get(url, timeout=25):
    req = urllib.request.Request(url, headers=HDR)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")

def write(name, obj):
    obj["_fetched"] = datetime.utcnow().isoformat() + "Z"
    p = DATA / name
    p.write_text(json.dumps(obj, indent=2, default=str))
    log.info(f"  wrote {p} ({p.stat().st_size:,}b)")

# ─── 1. US TREASURY (XML feed, no key needed) ───
def fetch_ust():
    log.info("UST: fetching XML")
    year = datetime.utcnow().year
    url = f"https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value={year}"
    raw = get(url)
    import xml.etree.ElementTree as ET
    ns = {"a":"http://www.w3.org/2005/Atom","m":"http://schemas.microsoft.com/ado/2007/08/dataservices/metadata","d":"http://schemas.microsoft.com/ado/2007/08/dataservices"}
    tmap = {"BC_1MONTH":"1M","BC_3MONTH":"3M","BC_6MONTH":"6M","BC_1YEAR":"1Y","BC_2YEAR":"2Y","BC_3YEAR":"3Y","BC_5YEAR":"5Y","BC_7YEAR":"7Y","BC_10YEAR":"10Y","BC_20YEAR":"20Y","BC_30YEAR":"30Y"}
    tenors = list(tmap.values())
    root = ET.fromstring(raw)
    rows = []
    for entry in root.findall("a:entry", ns):
        props = entry.find("a:content/m:properties", ns)
        if props is None: continue
        de = props.find("d:NEW_DATE", ns)
        if de is None or not de.text: continue
        date = de.text[:10]
        yd = {}
        for xf, tn in tmap.items():
            el = props.find(f"d:{xf}", ns)
            try: yd[tn] = round(float(el.text), 4)
            except: yd[tn] = None
        rows.append({"date": date, "yields": yd})
    rows.sort(key=lambda x: x["date"], reverse=True)
    if len(rows) < 2: raise Exception(f"UST: only {len(rows)} rows")
    write("ust.json", {
        "date": rows[0]["date"], "prior_date": rows[1]["date"],
        "source": "US Treasury Daily Par Yield Curve",
        "url": "https://home.treasury.gov/resource-center/data-chart-center/interest-rates",
        "tenors": tenors,
        "yields": [rows[0]["yields"].get(t) for t in tenors],
        "prior_yields": [rows[1]["yields"].get(t) for t in tenors],
    })
    log.info(f"  UST OK: {rows[0]['date']}")

# ─── 2. JAPAN JGB (MOF CSV) ───
def fetch_jgb():
    log.info("JGB: fetching CSV")
    raw = get("https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv")
    lines = raw.split("\n")
    hdr_idx = -1
    headers = []
    for i, line in enumerate(lines[:5]):
        if "date" in line.lower():
            hdr_idx = i
            headers = [h.strip().strip('"') for h in line.split(",")]
            break
    if hdr_idx < 0: raise Exception("JGB: no header")
    want = ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","25Y","30Y","40Y"]
    col = {}
    for j, h in enumerate(headers):
        c = h.replace(" ","")
        if c in want: col[c] = j
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
            else: yd[t] = None
        rows.append({"date": date, "yields": yd})
    rows.sort(key=lambda x: x["date"], reverse=True)
    if len(rows) < 2: raise Exception(f"JGB: only {len(rows)} rows")
    write("jgb.json", {
        "date": rows[0]["date"], "prior_date": rows[1]["date"],
        "source": "Ministry of Finance Japan",
        "url": "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/",
        "tenors": want,
        "yields": [rows[0]["yields"].get(t) for t in want],
        "prior_yields": [rows[1]["yields"].get(t) for t in want],
    })
    log.info(f"  JGB OK: {rows[0]['date']}")

# ─── 3. UK GILTS (BoE CSV API) ───
def fetch_gilt():
    log.info("GILT: fetching BoE")
    codes = {"1Y":"IUMALNPY","2Y":"IUMALNP2","3Y":"IUMALNP3","5Y":"IUMALNP5","7Y":"IUMALNP7","10Y":"IUMALNP10","15Y":"IUMALNP15","20Y":"IUMALNP20","25Y":"IUMALNP25","30Y":"IUMALNP30"}
    tenors = list(codes.keys())
    series = ",".join(codes.values())
    end = datetime.utcnow()
    start = end - timedelta(days=30)
    months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    fmt = lambda d: f"{d.day}/{months[d.month-1]}/{d.year}"
    url = f"https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&SeriesCodes={series}&CSVF=TN&Datefrom={fmt(start)}&Dateto={fmt(end)}"
    raw = get(url, timeout=30)
    lines = raw.strip().split("\n")
    if len(lines) < 2: raise Exception("GILT: empty CSV")
    header = [h.strip().strip('"') for h in lines[0].split(",")]
    mon_map = {m.lower(): i for i, m in enumerate(months)}
    by_date = {}
    for line in lines[1:]:
        cols = [c.strip().strip('"') for c in line.split(",")]
        m = re.match(r"(\d{1,2})\s+(\w{3})\s+(\d{4})", cols[0]) if cols else None
        if not m: continue
        mi = mon_map.get(m[2].lower())
        if mi is None: continue
        dk = f"{m[3]}-{str(mi+1).zfill(2)}-{m[1].zfill(2)}"
        yd = {}
        for tn, code in codes.items():
            ci = header.index(code) if code in header else -1
            if ci >= 0 and ci < len(cols):
                try: yd[tn] = round(float(cols[ci]), 4)
                except: yd[tn] = None
            else: yd[tn] = None
        by_date[dk] = yd
    dates = sorted(by_date.keys(), reverse=True)
    if len(dates) < 1: raise Exception(f"GILT: 0 dates from {len(lines)} lines")
    write("gilt.json", {
        "date": dates[0], "prior_date": dates[1] if len(dates) > 1 else "",
        "source": "Bank of England",
        "url": "https://www.bankofengland.co.uk/statistics/yield-curves",
        "tenors": tenors,
        "yields": [by_date[dates[0]].get(t) for t in tenors],
        "prior_yields": [by_date[dates[1]].get(t) for t in tenors] if len(dates) > 1 else [None]*len(tenors),
    })
    log.info(f"  GILT OK: {dates[0]}")

# ─── 4. EUR (ECB SDW API) ───
def fetch_eur():
    log.info("EUR: fetching ECB")
    ecb_map = {"1Y":"SR_1Y","2Y":"SR_2Y","3Y":"SR_3Y","5Y":"SR_5Y","7Y":"SR_7Y","10Y":"SR_10Y","15Y":"SR_15Y","20Y":"SR_20Y","30Y":"SR_30Y"}
    tenors = list(ecb_map.keys())
    results = {}
    for tn, sk in ecb_map.items():
        try:
            url = f"https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.{sk}?lastNObservations=5&format=csvdata"
            raw = get(url, timeout=15)
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
            if obs: results[tn] = {"value": obs[0]["value"], "prior": obs[1]["value"] if len(obs)>1 else None, "date": obs[0]["date"]}
        except Exception as e:
            log.warning(f"  EUR {tn}: {e}")
    if not results: raise Exception("EUR: no tenors")
    latest = max(r["date"] for r in results.values())
    write("eur.json", {
        "date": latest, "prior_date": "",
        "source": "ECB SDW (EUR AAA Govt — EIOPA proxy)",
        "url": "https://data.ecb.europa.eu/",
        "tenors": tenors,
        "yields": [results.get(t, {}).get("value") for t in tenors],
        "prior_yields": [results.get(t, {}).get("prior") for t in tenors],
        "note": "EUR AAA govt curve. Actual EIOPA RFR includes UFR extrapolation.",
    })
    log.info(f"  EUR OK: {latest}")

# ─── 5. INDIA (FRED monthly 10Y + tradingeconomics page) ───
def fetch_india():
    log.info("INDIA: fetching")
    tenors = ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","30Y"]
    yields = {t: None for t in tenors}
    # Try FRED for 10Y (free CSV endpoint, no key)
    try:
        url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=INDIRLTLT01STM&cosd=2025-01-01"
        raw = get(url, timeout=15)
        for line in reversed(raw.strip().split("\n")):
            parts = line.split(",")
            if len(parts) >= 2 and parts[1].replace(".","").replace("-","").isdigit():
                yields["10Y"] = round(float(parts[1]), 2)
                break
    except Exception as e:
        log.warning(f"  India FRED fallback failed: {e}")
    # Note: Full India curve needs a JS-rendered page or paid API.
    # FRED gives us the 10Y monthly. For full curve, add investing.com
    # scraping in GitHub Actions with playwright if needed.
    write("india.json", {
        "date": datetime.utcnow().strftime("%Y-%m-%d"), "prior_date": "",
        "source": "FRED (India 10Y monthly) + manual",
        "url": "https://fred.stlouisfed.org/series/INDIRLTLT01STM",
        "tenors": tenors,
        "yields": [yields.get(t) for t in tenors],
        "prior_yields": [None]*len(tenors),
        "note": "Only 10Y via FRED (monthly). Full curve needs server-side browser scraping.",
    })
    log.info(f"  INDIA OK (10Y: {yields.get('10Y')})")

# ─── 6. CREDIT SPREADS (FRED CSV, no key) ───
def fetch_credit():
    log.info("CREDIT: fetching FRED")
    series = {
        "ig":"BAMLC0A0CM","aaa":"BAMLC0A1CAAA","aa":"BAMLC0A2CAA","a":"BAMLC0A3CA",
        "bbb":"BAMLC0A4CBBB","hy":"BAMLH0A0HYM2","bb":"BAMLH0A1HYBB","b":"BAMLH0A2HYB","ccc":"BAMLH0A3HYC",
    }
    names = {"ig":"US IG","aaa":"US AAA","aa":"US AA","a":"US A","bbb":"US BBB","hy":"US HY","bb":"US BB","b":"US B","ccc":"US CCC+"}
    buckets = {"ig":"IG","aaa":"AAA","aa":"AA","a":"A","bbb":"BBB","hy":"HY","bb":"BB","b":"B","ccc":"CCC"}
    spreads = {}
    latest_date = ""
    for key, sid in series.items():
        try:
            url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}&cosd=2025-01-01"
            raw = get(url, timeout=15)
            lines = raw.strip().split("\n")
            obs = []
            for line in lines[1:]:
                parts = line.split(",")
                if len(parts) >= 2 and parts[1] != ".":
                    try: obs.append({"date": parts[0], "value": float(parts[1])})
                    except: pass
            obs.sort(key=lambda x: x["date"], reverse=True)
            if obs:
                curr = round(obs[0]["value"] * 100)
                prev = round(obs[1]["value"] * 100) if len(obs) > 1 else curr
                if obs[0]["date"] > latest_date: latest_date = obs[0]["date"]
                spreads[key] = {"name": names[key], "spread": curr, "prior": prev, "bucket": buckets[key]}
        except Exception as e:
            log.warning(f"  Credit {key}: {e}")
    if not spreads: raise Exception("CREDIT: no series returned")
    write("credit.json", {
        "date": latest_date,
        "source": "FRED / ICE BofA Indices",
        "url": "https://fred.stlouisfed.org/release?rid=209",
        "spreads": spreads,
    })
    log.info(f"  CREDIT OK: {latest_date}, {len(spreads)} series")

# ─── RUN ALL ───
def main():
    log.info("=" * 50)
    log.info("Bermuda Market Intel — Data Refresh")
    log.info("=" * 50)
    results = {}
    for name, fn in [("ust",fetch_ust),("jgb",fetch_jgb),("gilt",fetch_gilt),("eur",fetch_eur),("india",fetch_india),("credit",fetch_credit)]:
        try:
            fn()
            results[name] = "ok"
        except Exception as e:
            log.error(f"  {name} FAILED: {e}")
            results[name] = str(e)
    write("manifest.json", {"results": results, "run": datetime.utcnow().isoformat()+"Z"})
    failed = [k for k,v in results.items() if v != "ok"]
    log.info(f"Done: {len(results)-len(failed)}/{len(results)} ok" + (f", failed: {failed}" if failed else ""))

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Bermuda Market Intel — Data Pipeline v2. Runs in GitHub Actions."""
import json, csv, io, re, sys, os, logging
from datetime import datetime, timedelta
from pathlib import Path
import urllib.request

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fetch")
DATA = Path(__file__).parent.parent / "data"
DATA.mkdir(exist_ok=True)
HDR = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"}

def get(url, timeout=25):
    req = urllib.request.Request(url, headers=HDR)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")

def write(name, obj):
    obj["_fetched"] = datetime.utcnow().isoformat() + "Z"
    p = DATA / name
    p.write_text(json.dumps(obj, indent=2, default=str))
    log.info(f"  wrote {p} ({p.stat().st_size:,}b)")

# ─── 1. US TREASURY ───
def fetch_ust():
    log.info("UST: fetching")
    import xml.etree.ElementTree as ET
    year = datetime.utcnow().year
    url = f"https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value={year}"
    raw = get(url)
    ns = {"a":"http://www.w3.org/2005/Atom","m":"http://schemas.microsoft.com/ado/2007/08/dataservices/metadata","d":"http://schemas.microsoft.com/ado/2007/08/dataservices"}
    tmap = {"BC_1MONTH":"1M","BC_3MONTH":"3M","BC_6MONTH":"6M","BC_1YEAR":"1Y","BC_2YEAR":"2Y","BC_3YEAR":"3Y","BC_5YEAR":"5Y","BC_7YEAR":"7Y","BC_10YEAR":"10Y","BC_20YEAR":"20Y","BC_30YEAR":"30Y"}
    tenors = list(tmap.values())
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
    assert len(rows) >= 2, f"UST: only {len(rows)} rows"
    write("ust.json", {"date": rows[0]["date"], "prior_date": rows[1]["date"],
        "source": "US Treasury Daily Par Yield Curve", "url": "https://home.treasury.gov/resource-center/data-chart-center/interest-rates",
        "tenors": tenors, "yields": [rows[0]["yields"].get(t) for t in tenors], "prior_yields": [rows[1]["yields"].get(t) for t in tenors]})
    log.info(f"  UST: {rows[0]['date']}")

# ─── 2. JAPAN JGB ───
def fetch_jgb():
    log.info("JGB: fetching")
    raw = get("https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv")
    lines = raw.split("\n")
    hdr_idx, headers = -1, []
    for i, line in enumerate(lines[:5]):
        if "date" in line.lower():
            hdr_idx = i; headers = [h.strip().strip('"') for h in line.split(",")]; break
    assert hdr_idx >= 0, "JGB: no header found"
    want = ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","25Y","30Y","40Y"]
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
    assert len(rows) >= 2, f"JGB: only {len(rows)} rows"
    write("jgb.json", {"date": rows[0]["date"], "prior_date": rows[1]["date"],
        "source": "Ministry of Finance Japan", "url": "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/",
        "tenors": want, "yields": [rows[0]["yields"].get(t) for t in want], "prior_yields": [rows[1]["yields"].get(t) for t in want]})
    log.info(f"  JGB: {rows[0]['date']}")

# ─── 3. UK GILTS ───
def fetch_gilt():
    log.info("GILT: fetching")
    codes = {"1Y":"IUMALNPY","2Y":"IUMALNP2","3Y":"IUMALNP3","5Y":"IUMALNP5","7Y":"IUMALNP7",
             "10Y":"IUMALNP10","15Y":"IUMALNP15","20Y":"IUMALNP20","25Y":"IUMALNP25","30Y":"IUMALNP30"}
    tenors = list(codes.keys())
    series = ",".join(codes.values())
    end = datetime.utcnow(); start = end - timedelta(days=30)
    mons = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    fmt = lambda d: f"{d.day}/{mons[d.month-1]}/{d.year}"
    url = f"https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&SeriesCodes={series}&CSVF=TN&Datefrom={fmt(start)}&Dateto={fmt(end)}"
    raw = get(url, timeout=30)
    lines = [l for l in raw.strip().split("\n") if l.strip()]
    assert len(lines) >= 2, f"GILT: empty response ({len(raw)} chars)"
    header = [h.strip().strip('"') for h in lines[0].split(",")]
    # BoE sometimes returns a header like "DATE  ,IUMALNPY ..." with extra spaces
    header_clean = [h.strip() for h in header]
    mon_map = {m.lower(): i for i, m in enumerate(mons)}
    by_date = {}
    for line in lines[1:]:
        cols = [c.strip().strip('"') for c in line.split(",")]
        if not cols or not cols[0]: continue
        # Parse date: "20 Mar 2026" or " 20 Mar 2026"
        raw_date = cols[0].strip()
        m = re.match(r"(\d{1,2})\s+(\w{3})\s+(\d{4})", raw_date)
        if not m: continue
        mi = mon_map.get(m[2].lower())
        if mi is None: continue
        dk = f"{m[3]}-{str(mi+1).zfill(2)}-{m[1].zfill(2)}"
        yd = {}
        for tn, code in codes.items():
            # Find column by matching cleaned header
            ci = -1
            for idx, h in enumerate(header_clean):
                if h == code:
                    ci = idx; break
            if ci >= 0 and ci < len(cols) and cols[ci].strip():
                try: yd[tn] = round(float(cols[ci].strip()), 4)
                except: yd[tn] = None
            else: yd[tn] = None
        by_date[dk] = yd
    dates = sorted(by_date.keys(), reverse=True)
    assert len(dates) >= 1, f"GILT: 0 valid dates from {len(lines)} lines. Header: {header_clean[:5]}"
    write("gilt.json", {"date": dates[0], "prior_date": dates[1] if len(dates) > 1 else "",
        "source": "Bank of England", "url": "https://www.bankofengland.co.uk/statistics/yield-curves",
        "tenors": tenors, "yields": [by_date[dates[0]].get(t) for t in tenors],
        "prior_yields": [by_date[dates[1]].get(t) for t in tenors] if len(dates) > 1 else [None]*len(tenors)})
    log.info(f"  GILT: {dates[0]}")

# ─── 4. EUR (ECB SDW) ───
def fetch_eur():
    log.info("EUR: fetching")
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
            if obs: results[tn] = {"value": obs[0]["value"], "prior": obs[1]["value"] if len(obs) > 1 else None, "date": obs[0]["date"]}
        except Exception as e:
            log.warning(f"  EUR {tn}: {e}")
    assert results, "EUR: no tenors returned"
    latest = max(r["date"] for r in results.values())
    write("eur.json", {"date": latest, "prior_date": "",
        "source": "ECB SDW (EUR AAA Govt — EIOPA proxy)", "url": "https://data.ecb.europa.eu/",
        "tenors": tenors, "yields": [results.get(t, {}).get("value") for t in tenors],
        "prior_yields": [results.get(t, {}).get("prior") for t in tenors],
        "note": "EUR AAA govt curve proxy. Actual EIOPA RFR includes UFR extrapolation."})
    log.info(f"  EUR: {latest}")

# ─── 5. INDIA (CCIL tenorwise yields + RBI DBIE + FRED fallback) ───
def fetch_india():
    log.info("INDIA: fetching")
    tenors = ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","30Y"]
    yields = {t: None for t in tenors}
    date_str = ""
    
    # Approach 1: CCIL Tenorwise Indicative Yields page
    try:
        log.info("  Trying CCIL tenorwise yields...")
        html = get("https://www.ccilindia.com/web/ccil/tenorwise-indicative-yields", timeout=20)
        # CCIL page may have data in HTML tables or JSON embedded in script tags
        # Look for patterns like: 1 Year ... 5.729 or data in script tags
        # Try finding JSON data in script tags
        json_match = re.search(r'var\s+\w*[Dd]ata\w*\s*=\s*(\[[\s\S]*?\]);', html)
        if json_match:
            try:
                jdata = json.loads(json_match.group(1))
                log.info(f"  CCIL JSON data found: {len(jdata)} items")
            except: pass
        # Try HTML table extraction
        # Pattern: <td>1 Year</td><td>...</td><td>5.729</td>
        rows_html = re.findall(r'<tr[^>]*>(.*?)</tr>', html, re.DOTALL)
        for row in rows_html:
            cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
            cells = [re.sub(r'<[^>]+>', '', c).strip() for c in cells]
            for ci, cell in enumerate(cells):
                tm = re.match(r'^(\d+)\s*(Year|Yr)', cell, re.IGNORECASE)
                if tm:
                    num = int(tm.group(1))
                    key = f"{num}Y"
                    if key in yields:
                        for j in range(ci+1, len(cells)):
                            vm = re.search(r'([\d]+\.[\d]+)', cells[j])
                            if vm:
                                v = float(vm.group(1))
                                if 0 < v < 20:
                                    yields[key] = v; break
        found = sum(1 for v in yields.values() if v is not None)
        log.info(f"  CCIL: extracted {found} tenors")
        if found >= 3:
            date_str = datetime.utcnow().strftime("%Y-%m-%d")
    except Exception as e:
        log.warning(f"  CCIL failed: {e}")

    # Approach 2: RBI DBIE API for benchmark yields
    if sum(1 for v in yields.values() if v is not None) < 3:
        try:
            log.info("  Trying RBI DBIE...")
            rbi_url = "https://data.rbi.org.in/DBIE/dbie.rbi?site=statistics&uri=/DBIE/dbie.rbi&access_token=&lnk=GOI"
            html = get(rbi_url, timeout=15)
            # Try to extract yields from RBI page
            rows_html = re.findall(r'<tr[^>]*>(.*?)</tr>', html, re.DOTALL)
            for row in rows_html:
                cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
                cells = [re.sub(r'<[^>]+>', '', c).strip() for c in cells]
                for ci, cell in enumerate(cells):
                    tm = re.match(r'^(\d+)\s*(Year|Yr)', cell, re.IGNORECASE)
                    if tm:
                        num = int(tm.group(1))
                        key = f"{num}Y"
                        if key in yields and yields[key] is None:
                            for j in range(ci+1, len(cells)):
                                vm = re.search(r'([\d]+\.[\d]+)', cells[j])
                                if vm:
                                    v = float(vm.group(1))
                                    if 0 < v < 20: yields[key] = v; break
            found = sum(1 for v in yields.values() if v is not None)
            log.info(f"  RBI: now have {found} tenors")
        except Exception as e:
            log.warning(f"  RBI failed: {e}")

    # Approach 3: FRED CSV for individual tenor series
    fred_series = {
        "10Y": "INDIRLTLT01STM",  # monthly
    }
    for tenor, sid in fred_series.items():
        if yields.get(tenor) is not None: continue
        try:
            url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}&cosd=2025-01-01"
            raw = get(url, timeout=15)
            for line in reversed(raw.strip().split("\n")):
                parts = line.split(",")
                if len(parts) >= 2 and parts[1] not in (".", ""):
                    try:
                        yields[tenor] = round(float(parts[1]), 2)
                        if not date_str: date_str = parts[0]
                        break
                    except: pass
        except Exception as e:
            log.warning(f"  FRED India {tenor}: {e}")
    
    if not date_str: date_str = datetime.utcnow().strftime("%Y-%m-%d")
    found = sum(1 for v in yields.values() if v is not None)
    note = ""
    if found <= 1:
        note = "Only 10Y available (FRED monthly). Full curve needs CCIL/RBI server-side browser scraping."
    elif found < len(tenors):
        note = f"{found}/{len(tenors)} tenors available. Some tenors need additional data sources."
    
    write("india.json", {"date": date_str, "prior_date": "",
        "source": "CCIL / RBI / FRED", "url": "https://www.ccilindia.com/web/ccil/tenorwise-indicative-yields",
        "tenors": tenors, "yields": [yields.get(t) for t in tenors], "prior_yields": [None]*len(tenors),
        "note": note})
    log.info(f"  INDIA: {found} tenors, date={date_str}")

# ─── 6. CREDIT SPREADS (FRED CSV, no key needed) ───
def fetch_credit():
    log.info("CREDIT: fetching")
    series = {"ig":"BAMLC0A0CM","aaa":"BAMLC0A1CAAA","aa":"BAMLC0A2CAA","a":"BAMLC0A3CA",
              "bbb":"BAMLC0A4CBBB","hy":"BAMLH0A0HYM2","bb":"BAMLH0A1HYBB","b":"BAMLH0A2HYB","ccc":"BAMLH0A3HYC"}
    names = {"ig":"US IG","aaa":"US AAA","aa":"US AA","a":"US A","bbb":"US BBB","hy":"US HY","bb":"US BB","b":"US B","ccc":"US CCC+"}
    buckets = {"ig":"IG","aaa":"AAA","aa":"AA","a":"A","bbb":"BBB","hy":"HY","bb":"BB","b":"B","ccc":"CCC"}
    spreads = {}; latest_date = ""
    for key, sid in series.items():
        try:
            url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}&cosd=2025-01-01"
            raw = get(url, timeout=15)
            obs = []
            for line in raw.strip().split("\n")[1:]:
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
    assert spreads, "CREDIT: no series"
    write("credit.json", {"date": latest_date, "source": "FRED / ICE BofA Indices",
        "url": "https://fred.stlouisfed.org/release?rid=209", "spreads": spreads})
    log.info(f"  CREDIT: {latest_date}, {len(spreads)} series")

# ─── RUN ───
def main():
    log.info("=" * 50)
    results = {}
    for name, fn in [("ust",fetch_ust),("jgb",fetch_jgb),("gilt",fetch_gilt),("eur",fetch_eur),("india",fetch_india),("credit",fetch_credit)]:
        try: fn(); results[name] = "ok"
        except Exception as e: log.error(f"  {name} FAILED: {e}"); results[name] = str(e)
    write("manifest.json", {"results": results, "run": datetime.utcnow().isoformat()+"Z"})
    failed = [k for k,v in results.items() if v != "ok"]
    log.info(f"Done: {len(results)-len(failed)}/{len(results)} ok" + (f", failed: {failed}" if failed else ""))

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Bermuda Market Intel — Data Pipeline v4. Adds year-ago yields + BMA discount rates."""
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

def get(url, timeout=25, extra_headers=None):
    h = dict(HDR)
    if extra_headers: h.update(extra_headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")

def write(name, obj):
    obj["_fetched"] = datetime.utcnow().isoformat() + "Z"
    p = DATA / name
    p.write_text(json.dumps(obj, indent=2, default=str))
    log.info(f"  wrote {p} ({p.stat().st_size:,}b)")

# ═══════════════════════════════════════════
# INVESTING.COM YIELD SCRAPER
# ═══════════════════════════════════════════
def scrape_investing_yield(url_path):
    full_url = f"https://www.investing.com{url_path}"
    try:
        html = get(full_url, timeout=15)
        for pat in [r'data-test="instrument-price-last"[^>]*>([\d.]+)<',
                    r'class="text-5xl[^"]*"[^>]*>([\d.]+)<',
                    r'class="text-2xl[^"]*"[^>]*>([\d.]+)<',
                    r'"last":\s*([\d.]+)', r'"last_numeric":\s*([\d.]+)']:
            m = re.search(pat, html)
            if m:
                v = float(m.group(1))
                if 0 < v < 20: return v
    except Exception as e:
        log.debug(f"  investing.com {url_path}: {e}")
    return None

# ═══════════════════════════════════════════
# 1. US TREASURY (XML feed — current year + prior year for year-ago)
# ═══════════════════════════════════════════
def fetch_ust():
    log.info("UST: fetching")
    import xml.etree.ElementTree as ET
    ns = {"a":"http://www.w3.org/2005/Atom","m":"http://schemas.microsoft.com/ado/2007/08/dataservices/metadata","d":"http://schemas.microsoft.com/ado/2007/08/dataservices"}
    tmap = {"BC_1MONTH":"1M","BC_3MONTH":"3M","BC_6MONTH":"6M","BC_1YEAR":"1Y","BC_2YEAR":"2Y","BC_3YEAR":"3Y","BC_5YEAR":"5Y","BC_7YEAR":"7Y","BC_10YEAR":"10Y","BC_20YEAR":"20Y","BC_30YEAR":"30Y"}
    tenors = list(tmap.values())

    def parse_xml(year):
        url = f"https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value={year}"
        raw = get(url)
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

    now = datetime.utcnow()
    rows = parse_xml(now.year)
    assert len(rows) >= 2, f"UST: only {len(rows)} rows"

    # Get year-ago yields: find closest date to (today - 365 days)
    target_ya = (now - timedelta(days=365)).strftime("%Y-%m-%d")
    ya_rows = parse_xml(now.year - 1)
    ya_yields = [None] * len(tenors)
    ya_date = ""
    if ya_rows:
        # Find closest date to target
        best = min(ya_rows, key=lambda r: abs((datetime.strptime(r["date"], "%Y-%m-%d") - datetime.strptime(target_ya, "%Y-%m-%d")).days))
        ya_yields = [best["yields"].get(t) for t in tenors]
        ya_date = best["date"]
        log.info(f"  UST year-ago: {ya_date}")

    write("ust.json", {"date": rows[0]["date"], "prior_date": rows[1]["date"],
        "source": "US Treasury Daily Par Yield Curve",
        "url": "https://home.treasury.gov/resource-center/data-chart-center/interest-rates",
        "tenors": tenors,
        "yields": [rows[0]["yields"].get(t) for t in tenors],
        "prior_yields": [rows[1]["yields"].get(t) for t in tenors],
        "year_ago_yields": ya_yields, "year_ago_date": ya_date})
    log.info(f"  UST OK: {rows[0]['date']}")

# ═══════════════════════════════════════════
# 2. JAPAN JGB (MOF CSV — includes historical, can get year-ago)
# ═══════════════════════════════════════════
def fetch_jgb():
    log.info("JGB: fetching")
    want = ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","25Y","30Y","40Y"]
    all_rows = []
    # Fetch current year + prior year for year-ago comparison
    for csv_url in [
        "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv",
    ]:
        raw = get(csv_url)
        lines = raw.split("\n")
        hdr_idx, headers = -1, []
        for i, line in enumerate(lines[:5]):
            if "date" in line.lower():
                hdr_idx = i; headers = [h.strip().strip('"') for h in line.split(",")]; break
        if hdr_idx < 0: continue
        col = {h.replace(" ",""): j for j, h in enumerate(headers) if h.replace(" ","") in want}
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
            all_rows.append({"date": date, "yields": yd})

    all_rows.sort(key=lambda x: x["date"], reverse=True)
    assert len(all_rows) >= 2, f"JGB: only {len(all_rows)} rows"

    # Year-ago
    target_ya = (datetime.utcnow() - timedelta(days=365)).strftime("%Y-%m-%d")
    ya_yields = [None] * len(want)
    ya_date = ""
    ya_candidates = [r for r in all_rows if r["date"] <= target_ya]
    if ya_candidates:
        ya_yields = [ya_candidates[0]["yields"].get(t) for t in want]
        ya_date = ya_candidates[0]["date"]

    write("jgb.json", {"date": all_rows[0]["date"], "prior_date": all_rows[1]["date"],
        "source": "Ministry of Finance Japan",
        "url": "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/",
        "tenors": want,
        "yields": [all_rows[0]["yields"].get(t) for t in want],
        "prior_yields": [all_rows[1]["yields"].get(t) for t in want],
        "year_ago_yields": ya_yields, "year_ago_date": ya_date})
    log.info(f"  JGB OK: {all_rows[0]['date']}, year-ago: {ya_date}")

# ═══════════════════════════════════════════
# 3. UK GILTS (investing.com)
# ═══════════════════════════════════════════
GILT_INVESTING = {"1Y":"/rates-bonds/uk-1-year-bond-yield","2Y":"/rates-bonds/uk-2-year-bond-yield",
    "3Y":"/rates-bonds/uk-3-year-bond-yield","5Y":"/rates-bonds/uk-5-year-bond-yield",
    "7Y":"/rates-bonds/uk-7-year-bond-yield","10Y":"/rates-bonds/uk-10-year-bond-yield",
    "15Y":"/rates-bonds/uk-15-year-bond-yield","20Y":"/rates-bonds/uk-20-year-bond-yield",
    "30Y":"/rates-bonds/uk-30-year-bond-yield"}

def fetch_gilt():
    log.info("GILT: fetching")
    tenors = list(GILT_INVESTING.keys())
    yields = {}
    for tenor, path in GILT_INVESTING.items():
        v = scrape_investing_yield(path)
        if v is not None: yields[tenor] = v; log.info(f"  Gilt {tenor}: {v}%")
        else: log.warning(f"  Gilt {tenor}: failed")
        time.sleep(0.5)
    assert len(yields) >= 3, f"GILT: only {len(yields)} tenors"
    write("gilt.json", {"date": datetime.utcnow().strftime("%Y-%m-%d"), "prior_date": "",
        "source": "Investing.com", "url": "https://www.investing.com/rates-bonds/uk-government-bonds",
        "tenors": tenors, "yields": [yields.get(t) for t in tenors], "prior_yields": [None]*len(tenors),
        "year_ago_yields": [None]*len(tenors), "year_ago_date": ""})
    log.info(f"  GILT OK: {len(yields)} tenors")

# ═══════════════════════════════════════════
# 4. EUR (ECB SDW)
# ═══════════════════════════════════════════
def fetch_eur():
    log.info("EUR: fetching")
    ecb_map = {"1Y":"SR_1Y","2Y":"SR_2Y","3Y":"SR_3Y","5Y":"SR_5Y","7Y":"SR_7Y",
               "10Y":"SR_10Y","15Y":"SR_15Y","20Y":"SR_20Y","30Y":"SR_30Y"}
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
        except Exception as e: log.warning(f"  EUR {tn}: {e}")
    assert results, "EUR: no tenors"
    latest = max(r["date"] for r in results.values())
    write("eur.json", {"date": latest, "prior_date": "",
        "source": "ECB SDW (EUR AAA Govt — EIOPA proxy)", "url": "https://data.ecb.europa.eu/",
        "tenors": tenors, "yields": [results.get(t,{}).get("value") for t in tenors],
        "prior_yields": [results.get(t,{}).get("prior") for t in tenors],
        "year_ago_yields": [None]*len(tenors), "year_ago_date": "",
        "note": "EUR AAA govt curve proxy. Actual EIOPA RFR includes UFR extrapolation."})
    log.info(f"  EUR OK: {latest}")

# ═══════════════════════════════════════════
# 5. INDIA (investing.com + FRED cross-ref)
# ═══════════════════════════════════════════
INDIA_INVESTING = {"1Y":"/rates-bonds/india-1-year-bond-yield","2Y":"/rates-bonds/india-2-year-bond-yield",
    "3Y":"/rates-bonds/india-3-year-bond-yield","5Y":"/rates-bonds/india-5-year-bond-yield",
    "7Y":"/rates-bonds/india-7-year-bond-yield","10Y":"/rates-bonds/india-10-year-bond-yield",
    "15Y":"/rates-bonds/india-15-year-bond-yield","20Y":"/rates-bonds/india-20-year-bond-yield",
    "30Y":"/rates-bonds/india-30-year-bond-yield"}

def fetch_india():
    log.info("INDIA: fetching")
    tenors = list(INDIA_INVESTING.keys())
    yields = {}
    for tenor, path in INDIA_INVESTING.items():
        v = scrape_investing_yield(path)
        if v is not None: yields[tenor] = v; log.info(f"  India {tenor}: {v}%")
        else: log.warning(f"  India {tenor}: failed")
        time.sleep(0.5)
    # FRED 10Y cross-ref
    try:
        raw = get("https://fred.stlouisfed.org/graph/fredgraph.csv?id=INDIRLTLT01STM&cosd=2025-01-01", timeout=15)
        for line in reversed(raw.strip().split("\n")):
            parts = line.split(",")
            if len(parts) >= 2 and parts[1] not in (".",""): 
                fred_10y = round(float(parts[1]), 2)
                log.info(f"  India 10Y FRED: {fred_10y}% vs investing: {yields.get('10Y','N/A')}")
                if "10Y" not in yields: yields["10Y"] = fred_10y
                break
    except: pass
    assert len(yields) >= 1, "INDIA: no yields"
    write("india.json", {"date": datetime.utcnow().strftime("%Y-%m-%d"), "prior_date": "",
        "source": "Investing.com / FRED", "url": "https://www.investing.com/rates-bonds/india-government-bonds",
        "tenors": tenors, "yields": [yields.get(t) for t in tenors], "prior_yields": [None]*len(tenors),
        "year_ago_yields": [None]*len(tenors), "year_ago_date": ""})
    log.info(f"  INDIA OK: {len(yields)} tenors")

# ═══════════════════════════════════════════
# 6. CREDIT SPREADS (FRED CSV)
# ═══════════════════════════════════════════
def fetch_credit():
    log.info("CREDIT: fetching")
    series = {"ig":"BAMLC0A0CM","aaa":"BAMLC0A1CAAA","aa":"BAMLC0A2CAA","a":"BAMLC0A3CA",
              "bbb":"BAMLC0A4CBBB","hy":"BAMLH0A0HYM2","bb":"BAMLH0A1HYBB","b":"BAMLH0A2HYB","ccc":"BAMLH0A3HYC"}
    names = {"ig":"US IG","aaa":"US AAA","aa":"US AA","a":"US A","bbb":"US BBB","hy":"US HY","bb":"US BB","b":"US B","ccc":"US CCC+"}
    buckets = {"ig":"IG","aaa":"AAA","aa":"AA","a":"A","bbb":"BBB","hy":"HY","bb":"BB","b":"B","ccc":"CCC"}
    spreads = {}; latest_date = ""
    for key, sid in series.items():
        try:
            raw = get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}&cosd=2025-01-01", timeout=15)
            obs = []
            for line in raw.strip().split("\n")[1:]:
                parts = line.split(",")
                if len(parts) >= 2 and parts[1] != ".":
                    try: obs.append({"date": parts[0], "value": float(parts[1])})
                    except: pass
            obs.sort(key=lambda x: x["date"], reverse=True)
            if obs:
                curr = round(obs[0]["value"] * 100); prev = round(obs[1]["value"] * 100) if len(obs)>1 else curr
                if obs[0]["date"] > latest_date: latest_date = obs[0]["date"]
                spreads[key] = {"name": names[key], "spread": curr, "prior": prev, "bucket": buckets[key]}
        except Exception as e: log.warning(f"  Credit {key}: {e}")
    assert spreads, "CREDIT: no series"
    write("credit.json", {"date": latest_date, "source": "FRED / ICE BofA Indices",
        "url": "https://fred.stlouisfed.org/release?rid=209", "spreads": spreads})
    log.info(f"  CREDIT OK: {latest_date}")

# ═══════════════════════════════════════════
# 7. BMA DISCOUNT RATES (quarterly, from BMA website)
# ═══════════════════════════════════════════
def fetch_bma_rates():
    log.info("BMA RATES: fetching")
    # BMA publishes discount rates quarterly as PDFs on their reporting forms page.
    # The PDFs contain spot rates by currency (USD, GBP, EUR, JPY, etc.) at various tenors.
    # Since PDFs require special parsing, we scrape the page to find the latest publication
    # dates and provide a manual-update JSON structure.
    
    # Try to find latest publication info from BMA page
    latest_pub = ""
    pub_url = ""
    try:
        html = get("https://www.bma.bm/document-centre/reporting-forms-and-guidelines-insurance", timeout=20)
        # Look for "Discount Rates" entries with dates
        # Pattern: "Discount Rates. 30 June 2025. - 18 July 2025"
        dr_matches = re.findall(r'Discount\s+Rates[.\s]*(\d{1,2}\s+\w+\s+\d{4})[.\s]*-?\s*(\d{1,2}\s+\w+\s+\d{4})?', html, re.IGNORECASE)
        if dr_matches:
            latest_pub = dr_matches[0][0].strip()
            log.info(f"  BMA latest discount rate date: {latest_pub}")
        # Try to find PDF link
        pdf_matches = re.findall(r'href="([^"]*[Dd]iscount[^"]*\.pdf)"', html)
        if pdf_matches:
            pub_url = pdf_matches[0] if pdf_matches[0].startswith("http") else f"https://www.bma.bm{pdf_matches[0]}"
    except Exception as e:
        log.warning(f"  BMA page scrape failed: {e}")

    # Check if we have a manually maintained BMA rates file
    manual_file = DATA / "bma_rates_manual.json"
    manual_data = None
    if manual_file.exists():
        try:
            manual_data = json.loads(manual_file.read_text())
            log.info(f"  BMA: loaded manual rates file")
        except: pass

    # Standard BMA EBS discount rate tenors (years)
    bma_tenors = ["0.5Y","1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","25Y","30Y","40Y","50Y"]
    
    # BMA publishes rates for multiple currencies
    currencies = ["USD", "GBP", "EUR", "JPY", "CAD", "AUD", "CHF"]
    
    output = {
        "as_of_date": latest_pub or "See BMA website",
        "publication_info": f"Published: {latest_pub}" if latest_pub else "Check BMA website for latest",
        "source": "Bermuda Monetary Authority — EBS Discount Rates",
        "url": "https://www.bma.bm/document-centre/reporting-forms-and-guidelines-insurance",
        "pdf_url": pub_url,
        "tenors": bma_tenors,
        "currencies": {},
        "note": "BMA publishes quarterly EBS discount rate curves as PDFs. "
                "Rates below are from the manual file (data/bma_rates_manual.json) if available. "
                "Update by downloading the latest PDF from the BMA website and editing that file.",
    }

    if manual_data and "currencies" in manual_data:
        output["currencies"] = manual_data["currencies"]
        output["as_of_date"] = manual_data.get("as_of_date", output["as_of_date"])
    else:
        # Provide empty structure for manual population
        for ccy in currencies:
            output["currencies"][ccy] = {
                "rates": [None] * len(bma_tenors),
                "prior_rates": [None] * len(bma_tenors),
            }

    write("bma_rates.json", output)
    log.info(f"  BMA RATES OK: as_of={output['as_of_date']}")

# ═══════════════════════════════════════════
# RUN ALL
# ═══════════════════════════════════════════
def main():
    log.info("=" * 50)
    results = {}
    for name, fn in [("ust",fetch_ust),("jgb",fetch_jgb),("gilt",fetch_gilt),
                     ("eur",fetch_eur),("india",fetch_india),("credit",fetch_credit),
                     ("bma_rates",fetch_bma_rates)]:
        try: fn(); results[name] = "ok"
        except Exception as e: log.error(f"  {name} FAILED: {e}"); results[name] = str(e)
    write("manifest.json", {"results": results, "run": datetime.utcnow().isoformat()+"Z"})
    failed = [k for k,v in results.items() if v != "ok"]
    log.info(f"Done: {len(results)-len(failed)}/{len(results)} ok" + (f", failed: {failed}" if failed else ""))

if __name__ == "__main__":
    main()

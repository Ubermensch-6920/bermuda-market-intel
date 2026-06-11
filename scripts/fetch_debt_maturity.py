#!/usr/bin/env python3
"""Fetch weighted average maturity (WAM) of outstanding government debt for GENESIS.

Standalone script — runs after the main pipeline. Writes data/debt_maturity.json.
Sources:
  USA   — FRED AVMATPUSDM (monthly, value in months)
  Japan — MOF JGB Outstanding CSV gbb{YYYYMM}.csv (monthly)
  UK    — UK DMO ExportReport?reportCode=D5I (monthly)
  EUR   — OECD SDMX DEU.WAMTD (Germany proxy, annual)
  India — Static seed from RBI Annual Report 2024 (annual)

Each country: primary → fallback API → prior-run cache → static default.
"""

import csv
import io
import json
import logging
import re
import sys
import time
import urllib.request
import urllib.parse
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from fetchlib import fred_fetch, record_source, flush_source_health

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("debt_maturity")

DATA = Path(__file__).parent.parent / "data"
DATA.mkdir(exist_ok=True)

HDR = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,text/csv,application/json,*/*",
    "Accept-Language": "en-US,en;q=0.9",
}

STATIC_DEFAULTS = {
    "usa":   {"wam_years": 6.4,  "prior_wam_years": None, "prior_date": "", "data_date": "", "frequency": "monthly",
              "source": "static_default", "source_url": "https://fred.stlouisfed.org/series/AVMATPUSDM", "note": "Static default — pipeline fetch failed."},
    "japan": {"wam_years": 9.7,  "prior_wam_years": None, "prior_date": "", "data_date": "", "frequency": "monthly",
              "source": "static_default", "source_url": "https://www.mof.go.jp/english/policy/jgbs/statistics/outstanding/", "note": "Static default — pipeline fetch failed."},
    "uk":    {"wam_years": 14.5, "prior_wam_years": None, "prior_date": "", "data_date": "", "frequency": "monthly",
              "source": "static_default", "source_url": "https://www.dmo.gov.uk/data/gilt-market/", "note": "Static default — pipeline fetch failed."},
    "eur":   {"wam_years": 7.0,  "prior_wam_years": None, "prior_date": "", "data_date": "", "frequency": "annual",
              "source": "static_default", "source_url": "https://www.oecd.org/finance/sovereign-borrowing/", "note": "Germany WAM proxy. Static default — pipeline fetch failed."},
    "india": {"wam_years": 11.5, "prior_wam_years": 11.2, "prior_date": "2024-04-01", "data_date": "2024-04-01", "frequency": "annual",
              "source": "RBI Annual Report 2024", "source_url": "https://www.rbi.org.in/Scripts/AnnualReportPublications.aspx",
              "note": "Static value from RBI Annual Report 2024. Updated annually."},
}


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def get(url, timeout=12):
    req = urllib.request.Request(url, headers=HDR)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


def write(name, obj):
    obj["_fetched"] = datetime.utcnow().isoformat() + "Z"
    (DATA / name).write_text(json.dumps(obj, indent=2, default=str))
    log.info(f"  wrote {name}")


def fred_csv(series_id, start="2015-01-01", retries=2):
    """Fetch single FRED series, return list of {date, value} sorted newest first."""
    return fred_fetch([series_id], start=start, retries=retries).get(series_id, [])


# ── Cache ─────────────────────────────────────────────────────────────────────

def _load_last():
    try:
        f = DATA / "debt_maturity.json"
        if f.exists():
            return json.loads(f.read_text())
    except Exception:
        pass
    return None


def _cached_country(last, key):
    """Return prior country dict from cache, or None."""
    return (last or {}).get("countries", {}).get(key)


# ── Per-country fetch helpers ─────────────────────────────────────────────────

def _fiscaldata_mspd_wam():
    """FiscalData Treasury MSPD Table 5 — fallback USA source. Returns (wam_years, date_str)."""
    try:
        params = urllib.parse.urlencode({
            "fields": "record_date,avg_maturity_months,security_class1_desc",
            "filter": "security_class1_desc:eq:Total Marketable",
            "sort": "-record_date",
            "page[size]": "5",
        })
        url = f"https://api.fiscaldata.treasury.gov/services/api/v1/debt/mspd/mspd_table_5?{params}"
        raw = get(url, timeout=15)
        rows = json.loads(raw).get("data", [])
        if rows:
            months = float(rows[0]["avg_maturity_months"])
            return round(months / 12, 2), rows[0]["record_date"]
    except Exception as e:
        log.warning(f"  FiscalData MSPD: {e}")
    return None, ""


def _jgb_wam_from_mof():
    """Probe MOF gbb{YYYYMM}.csv up to 4 months back for average remaining life. Returns (wam_years, date_str)."""
    now = datetime.utcnow()
    for delta in range(0, 5):
        month = now.month - delta
        year = now.year
        while month <= 0:
            month += 12
            year -= 1
        url = f"https://www.mof.go.jp/english/policy/jgbs/statistics/outstanding/gbb{year}{month:02d}.csv"
        try:
            raw = get(url, timeout=15)
            for line in raw.split("\n"):
                low = line.lower()
                if "average remaining life" in low or "average maturity" in low:
                    parts = re.split(r"[,\t]", line)
                    for p in reversed(parts):
                        p = p.strip().strip('"').strip()
                        try:
                            v = float(p)
                            if 5.0 < v < 20.0:
                                date_str = f"{year}-{month:02d}-01"
                                log.info(f"  MOF JGB WAM: {v}yr ({date_str})")
                                return round(v, 2), date_str
                        except ValueError:
                            pass
        except Exception as e:
            log.debug(f"  MOF gbb{year}{month:02d}: {e}")
    return None, ""


def _uk_dmo_wam():
    """GET DMO ExportReport D5I, scan for float in 10–25yr range with adjacent date. Returns (wam_years, date_str)."""
    try:
        url = "https://www.dmo.gov.uk/data/ExportReport?reportCode=D5I"
        raw = get(url, timeout=20)
        # Each row may be CSV or tab-separated; look for a numeric value in 10–25yr range
        date_found = ""
        for line in raw.split("\n"):
            parts = re.split(r"[,\t]", line)
            # Look for a date in the line
            date_match = re.search(r"(\d{2}/\d{2}/\d{4}|\d{4}-\d{2}-\d{2})", line)
            candidate = None
            for p in parts:
                p = p.strip().strip('"')
                try:
                    v = float(p)
                    if 10.0 < v < 25.0:
                        candidate = round(v, 2)
                        break
                except ValueError:
                    pass
            if candidate is not None:
                if date_match:
                    raw_date = date_match.group(1)
                    # Normalise dd/mm/yyyy → yyyy-mm-dd
                    if "/" in raw_date:
                        d, m, y = raw_date.split("/")
                        date_found = f"{y}-{m}-{d}"
                    else:
                        date_found = raw_date
                log.info(f"  UK DMO WAM: {candidate}yr ({date_found})")
                return candidate, date_found
    except Exception as e:
        log.warning(f"  UK DMO ExportReport: {e}")
    return None, ""


def _oecd_germany_wam():
    """Fetch Germany WAM from OECD SDMX API (DEU, measure WAMTD). Returns (wam_years, date_str)."""
    try:
        # OECD SDMX v2.1 REST endpoint for sovereign borrowing statistics
        url = (
            "https://sdmx.oecd.org/public/rest/data/"
            "OECD.SDD.NAD,DSD_SOSS@DF_SOSS,1.0/DEU.WAMTD....."
            "?startPeriod=2018&format=csvfilewithlabels"
        )
        raw = get(url, timeout=20)
        reader = csv.DictReader(io.StringIO(raw))
        best_date, best_val = "", None
        for row in reader:
            val_str = row.get("OBS_VALUE", "").strip()
            period = row.get("TIME_PERIOD", "").strip()
            try:
                v = float(val_str)
                if 3.0 < v < 20.0 and period > best_date:
                    best_date = period
                    best_val = round(v, 2)
            except (ValueError, TypeError):
                pass
        if best_val is not None:
            # Period may be "2024" (annual) — normalise to ISO date
            date_str = best_date + "-01-01" if len(best_date) == 4 else best_date
            log.info(f"  OECD Germany WAM: {best_val}yr ({date_str})")
            return best_val, date_str
    except Exception as e:
        log.warning(f"  OECD Germany WAM: {e}")
    return None, ""


# ── Main fetch ────────────────────────────────────────────────────────────────

def _make_country(wam_years, prior_wam_years, prior_date, data_date, source, source_url, frequency, note):
    change = round(wam_years - prior_wam_years, 2) if wam_years is not None and prior_wam_years is not None else None
    return {
        "wam_years": wam_years,
        "wam_months": round(wam_years * 12, 1) if wam_years is not None else None,
        "prior_wam_years": prior_wam_years,
        "prior_date": prior_date,
        "change_years": change,
        "data_date": data_date,
        "source": source,
        "source_url": source_url,
        "frequency": frequency,
        "note": note,
    }


def fetch_debt_maturity():
    log.info("DEBT_MATURITY: fetching WAM for USA, Japan, UK, EUR, India")
    last = _load_last()
    countries = {}

    # ── USA ───────────────────────────────────────────────────────────────────
    log.info("  USA: FRED AVMATPUSDM")
    usa_wam, usa_date, usa_source, usa_url = None, "", "FRED AVMATPUSDM", "https://fred.stlouisfed.org/series/AVMATPUSDM"
    usa_prior, usa_prior_date = None, ""
    try:
        obs = fred_csv("AVMATPUSDM", start="2015-01-01", retries=1)
        if obs:
            usa_wam = round(obs[0]["value"] / 12, 2)
            usa_date = obs[0]["date"]
            if len(obs) > 1:
                usa_prior = round(obs[1]["value"] / 12, 2)
                usa_prior_date = obs[1]["date"]
            log.info(f"    FRED: {usa_wam}yr ({usa_date})")
    except Exception as e:
        log.warning(f"    FRED failed: {e}")

    if usa_wam is None:
        log.info("  USA: trying FiscalData MSPD fallback")
        usa_wam, usa_date = _fiscaldata_mspd_wam()
        if usa_wam:
            usa_source = "FiscalData Treasury MSPD"
            usa_url = "https://fiscaldata.treasury.gov/datasets/monthly-statement-public-debt/"
            cached = _cached_country(last, "usa")
            if cached:
                usa_prior = cached.get("wam_years")
                usa_prior_date = cached.get("data_date", "")

    if usa_wam is None:
        cached = _cached_country(last, "usa")
        if cached and cached.get("wam_years"):
            log.info("  USA: using cache")
            countries["usa"] = {**cached, "source": "cache"}
        else:
            countries["usa"] = {**STATIC_DEFAULTS["usa"]}
    else:
        countries["usa"] = _make_country(usa_wam, usa_prior, usa_prior_date, usa_date, usa_source, usa_url, "monthly", None)

    # ── Japan ─────────────────────────────────────────────────────────────────
    log.info("  Japan: MOF JGB Outstanding CSV")
    jpn_wam, jpn_date = _jgb_wam_from_mof()
    if jpn_wam is None:
        cached = _cached_country(last, "japan")
        if cached and cached.get("wam_years"):
            log.info("  Japan: using cache")
            countries["japan"] = {**cached, "source": "cache"}
        else:
            countries["japan"] = {**STATIC_DEFAULTS["japan"]}
    else:
        cached = _cached_country(last, "japan")
        prior_wam = cached.get("wam_years") if cached else None
        prior_date = cached.get("data_date", "") if cached else ""
        countries["japan"] = _make_country(
            jpn_wam, prior_wam, prior_date, jpn_date,
            "Japan Ministry of Finance — JGB Outstanding",
            "https://www.mof.go.jp/english/policy/jgbs/statistics/outstanding/",
            "monthly", None
        )

    # ── UK ────────────────────────────────────────────────────────────────────
    log.info("  UK: DMO ExportReport D5I")
    uk_wam, uk_date = _uk_dmo_wam()
    if uk_wam is None:
        cached = _cached_country(last, "uk")
        if cached and cached.get("wam_years"):
            log.info("  UK: using cache")
            countries["uk"] = {**cached, "source": "cache"}
        else:
            countries["uk"] = {**STATIC_DEFAULTS["uk"]}
    else:
        cached = _cached_country(last, "uk")
        prior_wam = cached.get("wam_years") if cached else None
        prior_date = cached.get("data_date", "") if cached else ""
        countries["uk"] = _make_country(
            uk_wam, prior_wam, prior_date, uk_date,
            "UK Debt Management Office — D5I",
            "https://www.dmo.gov.uk/data/gilt-market/",
            "monthly", None
        )

    # ── EUR (Germany proxy) ───────────────────────────────────────────────────
    log.info("  EUR: OECD Germany WAM")
    eur_wam, eur_date = _oecd_germany_wam()
    if eur_wam is None:
        cached = _cached_country(last, "eur")
        if cached and cached.get("wam_years") and cached.get("source") not in ("static_default",):
            log.info("  EUR: using cache")
            countries["eur"] = {**cached, "source": "cache"}
        else:
            countries["eur"] = {**STATIC_DEFAULTS["eur"]}
    else:
        cached = _cached_country(last, "eur")
        prior_wam = cached.get("wam_years") if cached and cached.get("source") != "static_default" else None
        prior_date = cached.get("data_date", "") if cached else ""
        countries["eur"] = _make_country(
            eur_wam, prior_wam, prior_date, eur_date,
            "OECD Sovereign Borrowing — Germany proxy",
            "https://www.oecd.org/finance/sovereign-borrowing/",
            "annual",
            "Germany WAM used as Eurozone proxy (largest issuer). Annual OECD data."
        )

    # ── India (static, updated annually) ─────────────────────────────────────
    log.info("  India: static RBI value")
    cached = _cached_country(last, "india")
    # Keep cached value if it differs from the hardcoded static (means someone updated it)
    if cached and cached.get("wam_years") and cached.get("source") not in ("static_default",):
        countries["india"] = cached
    else:
        countries["india"] = {**STATIC_DEFAULTS["india"], "wam_months": round(STATIC_DEFAULTS["india"]["wam_years"] * 12, 1), "change_years": 0.3}

    # Cached/static entries can predate the wam_months field — derive it from
    # wam_years so the dashboard always has the months value.
    for c in countries.values():
        if c.get("wam_months") is None and c.get("wam_years") is not None:
            c["wam_months"] = round(c["wam_years"] * 12, 1)

    record_source("MOF Japan", "JGB weighted avg maturity", ok=jpn_wam is not None,
                  fallback=None if jpn_wam is not None else "cache")
    record_source("UK DMO", "gilt weighted avg maturity", ok=uk_wam is not None,
                  fallback=None if uk_wam is not None else "cache")
    record_source("OECD", "Germany weighted avg maturity (EUR proxy)", ok=eur_wam is not None,
                  fallback=None if eur_wam is not None else "cache")

    # ── Write output ──────────────────────────────────────────────────────────
    latest_date = max(
        (c.get("data_date", "") for c in countries.values() if c.get("data_date")),
        default=datetime.utcnow().strftime("%Y-%m-%d"),
    )
    write("debt_maturity.json", {
        "date": latest_date,
        "countries": countries,
        "note": (
            "WAM = weighted average remaining maturity of outstanding central govt "
            "marketable debt (not duration). "
            "USA monthly via FRED AVMATPUSDM; "
            "Japan monthly via MOF JGB Outstanding; "
            "UK monthly via UK DMO; "
            "EUR annual via OECD (Germany proxy); "
            "India annual via RBI Annual Report."
        ),
    })
    log.info("DEBT_MATURITY: done")


def main():
    fetch_debt_maturity()
    try:
        flush_source_health()
    except Exception as e:
        log.warning(f"source health flush: {e}")


if __name__ == "__main__":
    main()

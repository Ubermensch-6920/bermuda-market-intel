#!/usr/bin/env python3
"""
usdinr_forward_calc.py — USD/INR spot and forward rate utility.

Fetches live spot from exchangerate.host and computes outright forward rates
from annualised forward-premia percentages sourced from RBI/FBIL publications.
Writes results to usd_inr_forward_rates.csv for offline inspection.

In a production setting get_forward_premia() would download the RBI or FBIL
CSV for the relevant date and parse the appropriate row rather than embedding
hard-coded values.
"""
import csv
import datetime as dt
import json
import logging
import urllib.request

log = logging.getLogger(__name__)


def fetch_json(url, headers=None, timeout=15):
    """Fetch JSON data from a URL with basic error handling."""
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def get_spot():
    """Try multiple sources to fetch USD/INR spot; return None on failure."""
    try:
        data = fetch_json(
            'https://api.exchangerate.host/latest?base=USD&symbols=INR'
        )
        return data['rates']['INR']
    except Exception:
        return None


def get_forward_premia():
    """
    Hard‑code RBI forward premia values from public data (May 2026).
    In a production setting you'd download the RBI/FBIL CSV and parse the
    appropriate date; here we embed the numbers for demonstration.
    """
    return {
        '3M': 2.930 / 100.0,   # 2.93 % p.a.
        '6M': 3.010 / 100.0,   # 3.01 % p.a.
        '12M': 2.65 / 100.0    # from Reuters, ~2.65 % p.a.
    }


def compute_forward_rates(spot, premia_pct):
    """
    Compute forward rates and points from spot and annualised forward premia.
    Returns a list of dictionaries for easy CSV export.
    """
    results = []
    tenors = {'3M': 3, '6M': 6, '12M': 12}
    days = {'3M': 91, '6M': 182, '12M': 365}
    for tenor, months in tenors.items():
        p = premia_pct[tenor]
        forward = spot * (1 + p * months / 12)
        points = (forward - spot) * 100  # convert rupee difference to paise
        annualised = ((forward / spot) - 1) * 365 / days[tenor] * 100
        results.append({
            'label': 'current',
            'tenor': tenor,
            'spot': round(spot, 4),
            'forward': round(forward, 4),
            'forward_points_paise': round(points, 2),
            'annualised_premium_pct': round(annualised, 3)
        })
    return results


def main():
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    spot = get_spot()
    if spot is None:
        log.warning("live spot unavailable; using fallback spot 96.2959")
        spot = 96.2959  # fallback spot
    else:
        log.info(f"spot fetched: {spot}")
    premia = get_forward_premia()
    rows = compute_forward_rates(spot, premia)
    with open('usd_inr_forward_rates.csv', 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=rows[0].keys())
        w.writeheader()
        w.writerows(rows)
    log.info(f"wrote {len(rows)} rows to usd_inr_forward_rates.csv")


if __name__ == '__main__':
    main()

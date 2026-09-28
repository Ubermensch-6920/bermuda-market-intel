#!/usr/bin/env python3
"""Offline checks for the commodity pipeline (network is mocked).

Run: python scripts/test_commodities.py
"""
import io
import json
import sys
import tempfile
import unittest
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import fetch_all as fa  # noqa: E402

TODAY = datetime.utcnow().date()


def trading_days(n, end=TODAY):
    """The last n weekdays up to and including `end`, oldest first."""
    out, d = [], end
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d -= timedelta(days=1)
    return out[::-1]


def series(start_price, n=800, step=0.1, end=TODAY):
    return [(d.isoformat(), start_price + i * step) for i, d in enumerate(trading_days(n, end))]


def chart_json(bars):
    off = -4 * 3600  # exchange local = UTC-4, bars stamped at local midnight
    ts = [int(datetime.fromisoformat(d).replace(tzinfo=timezone.utc).timestamp()) - off for d, _ in bars]
    return json.dumps({"chart": {"result": [{
        "meta": {"gmtoffset": off},
        "timestamp": ts,
        "indicators": {"quote": [{"close": [c for _, c in bars]}]},
    }], "error": None}})


class FakeWeb:
    def __init__(self, yahoo, pages=None, fail_first=()):
        self.yahoo, self.pages, self.calls = yahoo, pages or {}, []
        self.fail_first = set(fail_first)

    def __call__(self, url, timeout=8):
        self.calls.append(url)
        if "/v8/finance/chart/" in url:
            sym = url.split("/v8/finance/chart/")[1].split("?")[0]
            if sym in self.fail_first:
                self.fail_first.discard(sym)
                raise urllib.error.HTTPError(url, 429, "Too Many Requests", {}, io.BytesIO())
            if sym not in self.yahoo:
                raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO())
            return chart_json(self.yahoo[sym])
        for key, body in self.pages.items():
            if key in url:
                if isinstance(body, Exception):
                    raise body
                return body
        raise urllib.error.URLError("blocked")


def base_yahoo():
    y = {"GC=F": series(4000, step=0.3), "CL=F": series(80, step=0.01), "BZ=F": series(85, step=0.01)}
    now = datetime.utcnow()
    for fn, px in ((fa._gold_symbol, 4100), (fa._wti_symbol, 75), (fa._brent_symbol, 80)):
        for _, months in fa.COMM_TENOR_NS:
            y[fn(months, base_dt=now)[0]] = series(px + months, n=200)
    return y


class Base(unittest.TestCase):
    def setUp(self):
        fa._yahoo_cache.clear()
        self.tmp = tempfile.TemporaryDirectory()
        patches = [
            mock.patch.object(fa, "DATA", Path(self.tmp.name)),
            mock.patch.object(fa, "COMM_HISTORY_FILE", Path(self.tmp.name) / "commodities_history.jsonl"),
            mock.patch.object(fa.time, "sleep", lambda s: None),
            mock.patch.object(fa, "fred_csv", mock.Mock(return_value=[])),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.tmp.cleanup)

    def web(self, web):
        p = mock.patch.object(fa, "get", web)
        p.start()
        self.addCleanup(p.stop)
        return web


class SpotTests(Base):
    def test_crude_spot_is_live_front_month_with_previous_session_1d(self):
        y = base_yahoo()
        self.web(FakeWeb(y))
        out = fa.commodity_spot("wti", [], None)
        last, prev = y["CL=F"][-1], y["CL=F"][-2]
        self.assertEqual(out["spot"], round(last[1], 2))
        self.assertEqual(out["spot_date"], last[0])
        self.assertEqual(out["prior_1d_date"], prev[0])  # never the spot's own bar
        self.assertNotEqual(out["prior_1d"], out["spot"])
        for h in ("1m", "3m", "1y", "2y"):
            self.assertIsNotNone(out[f"prior_{h}"], h)
        fa.fred_csv.assert_not_called()  # weekly EIA series only as fallback

    def test_crude_falls_back_to_fred_when_yahoo_down(self):
        self.web(FakeWeb({}))
        obs = [{"date": d, "value": v} for d, v in reversed(series(90, n=600))]
        fa.fred_csv.return_value = obs
        out = fa.commodity_spot("brent", [], None)
        self.assertEqual(out["spot_source"], "FRED")
        self.assertEqual(out["spot"], round(obs[0]["value"], 2))
        self.assertEqual(out["prior_1d_date"], obs[1]["date"])

    def test_gold_rejects_implausible_scrape_and_uses_next_source(self):
        y = base_yahoo()
        self.web(FakeWeb(y, pages={
            "tradingeconomics.com": "<p>Gold fell to 91.5 USD per unit</p>",
            "swissquote.com": json.dumps([{"spreadProfilePrices": [{"bid": 4390.0, "ask": 4391.0}]}]),
        }))
        out = fa.commodity_spot("gold", [], None)
        self.assertEqual(out["spot"], 4390.5)
        self.assertEqual(out["spot_source"], "Swissquote")
        self.assertEqual(out["spot_date"], y["GC=F"][-1][0])

    def test_gold_1d_comes_from_own_spot_history_not_futures(self):
        y = base_yahoo()
        self.web(FakeWeb(y, pages={"tradingeconomics.com": "Gold rose to 4,380.00 USD/t.oz"}))
        spot_day = y["GC=F"][-1][0]
        prev_day = y["GC=F"][-2][0]
        history = [{"date": prev_day, "gold": {"spot": 4350.0, "spot_date": prev_day, "spot_kind": "spot"}}]
        out = fa.commodity_spot("gold", history, None)
        self.assertEqual((out["spot"], out["spot_source"], out["spot_date"]), (4380.0, "TradingEconomics", spot_day))
        self.assertEqual((out["prior_1d"], out["prior_1d_date"]), (4350.0, prev_day))
        self.assertIsNotNone(out["prior_1y"])  # front-month fallback beyond own history

    def test_gold_without_history_leaves_1d_blank_rather_than_mixing_basis(self):
        self.web(FakeWeb(base_yahoo(), pages={"tradingeconomics.com": "Gold rose to 4380 USD"}))
        out = fa.commodity_spot("gold", [], None)
        self.assertIsNone(out["prior_1d"])


class FuturesTests(Base):
    def test_unlisted_contract_uses_next_listed_month(self):
        y = base_yahoo()
        now = datetime.utcnow()
        missing = fa._gold_symbol(24, base_dt=now)[0]
        del y[missing]
        nxt = next(fa._gold_symbol(24 + k, base_dt=now)[0] for k in (1, 2)
                   if fa._gold_symbol(24 + k, base_dt=now)[0] != missing)
        y[nxt] = series(4200, n=100)
        self.web(FakeWeb(y))
        curve = fa.futures_curve(fa._gold_symbol, "Gold")
        self.assertEqual(curve["24M"]["contract"], nxt.split(".")[0])
        self.assertIsNotNone(curve["24M"]["price"])

    def test_expired_contract_priors_come_from_own_history(self):
        y = base_yahoo()
        self.web(FakeWeb(y))
        target = TODAY - timedelta(days=365)
        history = [{"date": target.isoformat(), "wti": {"futures": {"3M": {"price": 61.5, "contract": "CLOLD"}}}}]
        curve = fa.futures_curve(fa._wti_symbol, "WTI", history_key="wti", history=history)
        self.assertEqual(curve["3M"]["prior_1y"], 61.5)
        self.assertEqual(curve["3M"]["prior_1y_contract"], "CLOLD")

    def test_stale_quote_is_flagged(self):
        y = base_yahoo()
        now = datetime.utcnow()
        sym = fa._wti_symbol(24, base_dt=now)[0]
        y[sym] = series(70, n=50, end=TODAY - timedelta(days=30))
        for k in (1, 2):
            y.pop(fa._wti_symbol(24 + k, base_dt=now)[0], None)
        self.web(FakeWeb(y))
        e = fa.futures_curve(fa._wti_symbol, "WTI")["24M"]
        self.assertTrue(e.get("stale"))
        self.assertLess(e["price_date"], (TODAY - timedelta(days=fa.FUT_STALE_DAYS)).isoformat())

    def test_rate_limit_is_retried_and_contracts_fetched_once(self):
        y = base_yahoo()
        web = self.web(FakeWeb(y, fail_first={"CL=F"}))
        fa.yahoo_daily_bars("CL=F")
        fa.yahoo_daily_bars("CL=F")
        cl_calls = [u for u in web.calls if "/chart/CL=F" in u]
        self.assertEqual(len(cl_calls), 2)  # one 429, one retry, then cached
        self.assertIn("query2", cl_calls[1])


class HistoryTests(Base):
    def test_failed_later_run_does_not_erase_or_pollute_todays_row(self):
        day = TODAY.isoformat()
        good = {"gold": {"spot": 4380.0, "spot_source": "TradingEconomics", "spot_kind": "spot", "spot_date": day,
                         "futures": {"3M": {"price": 4400.0, "contract": "GCZ26", "price_source": "Yahoo"}}}}
        fa.save_commodity_history(fa.commodity_history_row(good, day))
        failed = {"gold": {"spot": 4100.0, "spot_source": "cache", "spot_kind": "spot", "spot_date": day,
                           "futures": {"3M": {"price": 4090.0, "contract": "GCZ26", "price_source": "cache", "stale": True}}}}
        fa.save_commodity_history(fa.commodity_history_row(failed, day))
        rows = fa.load_commodity_history()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["gold"]["spot"], 4380.0)
        self.assertEqual(rows[0]["gold"]["futures"]["3M"]["price"], 4400.0)

    def test_backfill_row_drops_implausible_spot(self):
        payload = {"gold": {"spot": 91.5, "spot_source": "TradingEconomics",
                            "futures": {"3M": {"price": 4321.1, "contract": "GCZ26"}}}}
        row = fa.commodity_history_row(payload, "2026-09-24", live=False)
        self.assertNotIn("spot", row["gold"])
        self.assertEqual(row["gold"]["futures"]["3M"]["price"], 4321.1)


class EndToEnd(Base):
    def test_fetch_commodities_writes_payload_and_history(self):
        self.web(FakeWeb(base_yahoo(), pages={"tradingeconomics.com": "Gold rose to 4380 USD"}))
        fa.fetch_commodities()
        d = json.loads((Path(self.tmp.name) / "commodities.json").read_text())
        for k in ("gold", "wti", "brent"):
            self.assertIsNotNone(d[k]["spot"], k)
            self.assertEqual(len(d[k]["futures"]), 4)
        rows = fa.load_commodity_history()
        self.assertEqual(len(rows), 1)
        self.assertEqual(set(rows[0]["gold"]["futures"]), {"3M", "6M", "12M", "24M"})
        self.assertEqual(d["wti"]["spot_source"], "Yahoo CL=F (front month)")
        self.assertEqual(rows[0]["wti"]["spot_kind"], "front")
        self.assertEqual(rows[0]["gold"]["spot_kind"], "spot")


if __name__ == "__main__":
    unittest.main(verbosity=2)

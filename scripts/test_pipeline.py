#!/usr/bin/env python3
"""Offline checks for the rates / macro / news pipeline (network is mocked).

Run: python scripts/test_pipeline.py
"""
import json
import sys
import tempfile
import unittest
import urllib.error
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import fetch_all as fa  # noqa: E402
import fetchlib  # noqa: E402

TODAY = datetime.utcnow().date()


def days_back(n):
    return (TODAY - timedelta(days=n)).isoformat()


class Web:
    """get() stand-in: first matching URL substring wins; unknown URLs fail."""
    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def __call__(self, url, timeout=8):
        self.calls.append(url)
        for key, body in self.routes.items():
            if key in url:
                if isinstance(body, Exception):
                    raise body
                return body(url) if callable(body) else body
        raise urllib.error.URLError(f"blocked: {url}")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        for p in (mock.patch.object(fa, "DATA", self.data),
                  mock.patch.object(fa, "fred_csv", mock.Mock(return_value=[])),
                  mock.patch.object(fa, "get_bytes", mock.Mock(side_effect=urllib.error.URLError("blocked"))),
                  mock.patch.object(fa.time, "sleep", lambda s: None)):
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.tmp.cleanup)

    def web(self, routes):
        w = Web(routes)
        p = mock.patch.object(fa, "get", w)
        p.start()
        self.addCleanup(p.stop)
        return w

    def out(self, name):
        return json.loads((self.data / name).read_text())


# ── JGB ──────────────────────────────────────────────────────────────

def mof_csv(rows):
    head = "Interest Rate\nDate,1Y,2Y,3Y,4Y,5Y,6Y,7Y,8Y,9Y,10Y,15Y,20Y,25Y,30Y,40Y\n"
    body = ""
    for d, base in rows:
        y, m, dd = d.split("-")
        vals = [base + i * 0.1 for i in range(15)]
        body += f"{int(y)}/{int(m)}/{int(dd)}," + ",".join(f"{v:.3f}" for v in vals) + "\n"
    return head + body


class JgbTests(Base):
    def test_first_business_day_of_month_no_longer_crashes(self):
        # One current-month row (the 1st business day) used to hit
        # `assert len(rows) >= 2` and leave the curve stuck for days.
        hist = [(days_back(i), 1.0 + i * 0.001) for i in range(1, 400)]
        self.web({"historical/jgbcme_all.csv": mof_csv(hist), "jgbcme.csv": mof_csv([(days_back(0), 1.5)])})
        fa.fetch_jgb()
        d = self.out("jgb.json")
        self.assertEqual(d["date"], days_back(0))
        self.assertEqual(d["prior_date"], days_back(1))
        self.assertEqual(d["yields"][0], 1.5)
        for k in ("prior_1m_yields", "prior_3m_yields", "year_ago_yields"):
            self.assertTrue(all(v is not None for v in d[k]), k)
        self.assertTrue(d["prior_1m_date"] and d["prior_3m_date"] and d["year_ago_date"])

    def test_history_file_unreachable_falls_back_to_own_snapshots(self):
        fa.append_curve_history("jgb", days_back(3), fa.JGB_TENORS, [1.1] * 11, "MOF Japan")
        self.web({"jgbcme_all.csv": urllib.error.HTTPError("u", 404, "nf", {}, None),
                  "jgbcme.csv": mof_csv([(days_back(0), 1.5)])})
        fa.fetch_jgb()
        d = self.out("jgb.json")
        self.assertEqual(d["prior_date"], days_back(3))
        self.assertEqual(d["prior_yields"][0], 1.1)

    def test_single_row_and_no_history_still_writes(self):
        self.web({"jgbcme_all.csv": urllib.error.URLError("x"), "jgbcme.csv": mof_csv([(days_back(0), 1.5)])})
        fa.fetch_jgb()
        d = self.out("jgb.json")
        self.assertEqual(d["prior_date"], "")
        self.assertTrue(all(v is None for v in d["prior_yields"]))

    def test_parser_skips_missing_values(self):
        raw = mof_csv([(days_back(0), 1.0)]).replace("1.000,", "-,", 1)
        rows = fa.parse_mof_jgb_csv(raw)
        self.assertIsNone(rows[0]["yields"]["1Y"])
        self.assertEqual(rows[0]["yields"]["2Y"], 1.1)


# ── EUR ──────────────────────────────────────────────────────────────

class EurTests(Base):
    def test_year_ago_and_prior_date_populated(self):
        def ecb(url):
            lines = ["KEY,TIME_PERIOD,OBS_VALUE"]
            for i in range(280):
                d = TODAY - timedelta(days=int(i * 1.4))
                lines.append(f"x,{d.isoformat()},{3.0 - i * 0.001:.4f}")
            return "\n".join(lines)
        self.web({"data-api.ecb.europa.eu": ecb})
        fa.fetch_eur()
        d = self.out("eur.json")
        self.assertEqual(d["prior_date"], (TODAY - timedelta(days=1)).isoformat())
        self.assertTrue(all(v is not None for v in d["year_ago_yields"]))
        self.assertTrue(d["year_ago_date"])


# ── Gilt / India scraped curves ──────────────────────────────────────

def te_table(country, rows):
    return " ".join(f"{country} {label} {v:.3f} 0.01% 0.10% 0.50% Oct/06" for label, v in rows)


class GiltTests(Base):
    UK = [("52W", 4.55), ("2Y", 4.69), ("3Y", 4.88), ("5Y", 4.93), ("7Y", 5.16),
          ("10Y", 5.38), ("20Y", 5.85), ("30Y", 5.91)]  # no 15Y quote

    def test_prior_day_from_history_and_interpolation_flagged(self):
        tenors = ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"]
        fa.append_curve_history("gilt", days_back(1), tenors, [4.5, 4.6, 4.8, 4.9, 5.1, 5.3, 5.6, 5.8, 5.9], "TE")
        self.web({"tradingeconomics.com/united-kingdom": te_table("UK", self.UK)})
        fa.fetch_gilt()
        d = self.out("gilt.json")
        self.assertEqual(d["prior_date"], days_back(1))
        self.assertEqual(d["prior_yields"][5], 5.3)
        self.assertEqual(d["interpolated"], ["15Y"])
        self.assertEqual(d["yields"][6], round((5.38 + 5.85) / 2, 4))
        self.assertEqual(d["prior_1m_date"], "")  # no prose in a date field
        self.assertEqual(d["derived"]["prior_1m"], "TE month delta reconstruction")
        self.assertEqual(d["derived"]["prior_day"], "own history")

    def test_history_upsert_keeps_last_run_of_day(self):
        t = ["10Y"]
        fa.append_curve_history("gilt", days_back(0), t, [5.0], "a")
        fa.append_curve_history("gilt", days_back(0), t, [5.2], "b")
        rows = fa.load_curve_history("gilt")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["yields"]["10Y"], 5.2)


class OfflineCarryForwardTests(Base):
    def test_gilt_with_no_live_quotes_keeps_previous_file_and_history(self):
        tenors = ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"]
        prev = {"date": days_back(1), "tenors": tenors, "yields": [4.5] * 9, "source": "TE"}
        (self.data / "gilt.json").write_text(json.dumps(prev))
        self.web({})  # everything unreachable
        status = fa.fetch_gilt()
        self.assertTrue(status.startswith("stale: no live gilt quotes"))
        self.assertEqual(self.out("gilt.json"), prev)
        self.assertEqual(fa.load_curve_history("gilt"), [])

    def test_inflation_outage_keeps_previous_figures(self):
        prev = {"countries": {"us": {"series": "CPIAUCSL", "label": "US", "yoy": 3.71, "mom": 0.4,
                                     "trend": "up", "date": "2026-08-01"}}}
        (self.data / "inflation.json").write_text(json.dumps(prev))
        self.web({})
        with mock.patch.object(fa, "fred_fetch", mock.Mock(return_value={})):
            status = fa.fetch_inflation()
        us = self.out("inflation.json")["countries"]["us"]
        self.assertEqual((us["yoy"], us["date"], us["stale"]), (3.71, "2026-08-01", True))
        self.assertEqual(status, "stale: carried forward us")


class SpikeTests(unittest.TestCase):
    T = ["1Y", "2Y", "3Y", "5Y", "10Y"]

    def last(self, yields, held=None, age=0):
        return {"date": days_back(age), "tenors": self.T, "yields": yields, "held": held or {}}

    def test_one_tenor_jump_is_held(self):
        cur = {"1Y": 6.48, "2Y": 6.68, "3Y": 6.91, "5Y": 6.94, "10Y": 7.21}
        held = fa.hold_spikes(cur, self.T, self.last([6.10, 6.68, 6.91, 6.95, 7.21]))
        self.assertEqual(held, {"1Y": 1})
        self.assertEqual(cur["1Y"], 6.10)

    def test_broad_move_is_not_held(self):
        cur = {"1Y": 6.50, "2Y": 7.00, "3Y": 7.20, "5Y": 7.30, "10Y": 7.50}
        self.assertEqual(fa.hold_spikes(cur, self.T, self.last([6.10, 6.68, 6.91, 6.95, 7.21])), {})
        self.assertEqual(cur["1Y"], 6.50)

    def test_hold_expires_so_real_shifts_get_through(self):
        cur = {"1Y": 6.48, "2Y": 6.68, "3Y": 6.91, "5Y": 6.94, "10Y": 7.21}
        held = fa.hold_spikes(cur, self.T, self.last([6.10, 6.68, 6.91, 6.95, 7.21], held={"1Y": 3}))
        self.assertEqual(held, {})
        self.assertEqual(cur["1Y"], 6.48)

    def test_stale_previous_curve_is_ignored(self):
        cur = {"1Y": 6.48, "2Y": 6.68, "3Y": 6.91, "5Y": 6.94, "10Y": 7.21}
        self.assertEqual(fa.hold_spikes(cur, self.T, self.last([6.10, 6.68, 6.91, 6.95, 7.21], age=9)), {})


class IndiaTests(Base):
    def test_te_52w_flip_is_held_at_previous_value(self):
        tenors = ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"]
        prev = [6.10, 6.68, 6.91, 6.94, 7.16, 7.21, 7.32, 7.44, 7.68]
        (self.data / "india.json").write_text(json.dumps({"date": days_back(0), "tenors": tenors, "yields": prev}))
        rows = [("52W", 6.48), ("2Y", 6.68), ("3Y", 6.91), ("5Y", 6.94), ("7Y", 7.16),
                ("10Y", 7.21), ("15Y", 7.32), ("20Y", 7.44), ("30Y", 7.68)]
        self.web({"tradingeconomics.com/india": te_table("India", rows), "fbil.org.in": "<html></html>"})
        fa.fetch_india()
        d = self.out("india.json")
        self.assertEqual(d["yields"][0], 6.10)
        self.assertEqual(d["held"], {"1Y": 1})
        self.assertEqual(d["interpolated"], [])


# ── Data-source plumbing ─────────────────────────────────────────────

class FredTests(unittest.TestCase):
    def test_unknown_series_fails_fast_without_csv_fallback(self):
        calls = []

        def http_get(url, timeout=10):
            calls.append(url)
            if "api.stlouisfed.org" in url:
                raise urllib.error.HTTPError(url, 400, "Bad Request", {}, None)
            raise AssertionError("fredgraph fallback should not be tried for a 400")
        with mock.patch.object(fetchlib, "FRED_API_KEY", "k"), \
             mock.patch.object(fetchlib, "_http_get", http_get), \
             mock.patch.object(fetchlib.time, "sleep", lambda s: None):
            out = fetchlib.fred_fetch(["NOTASERIES"])
        self.assertEqual(out, {"NOTASERIES": []})
        self.assertEqual(len(calls), 1)
        self.assertIn("unknown IDs: NOTASERIES", fetchlib._health_this_run["FRED"]["note"])

    def test_transient_api_error_still_falls_back_to_csv(self):
        def http_get(url, timeout=10):
            if "api.stlouisfed.org" in url:
                raise urllib.error.HTTPError(url, 503, "Unavailable", {}, None)
            return "DATE,DGS10\n2026-10-05,4.10\n"
        with mock.patch.object(fetchlib, "FRED_API_KEY", "k"), \
             mock.patch.object(fetchlib, "_http_get", http_get), \
             mock.patch.object(fetchlib.time, "sleep", lambda s: None):
            out = fetchlib.fred_fetch(["DGS10"])
        self.assertEqual(out["DGS10"], [{"date": "2026-10-05", "value": 4.10}])


class ManifestTests(Base):
    NAMES = ["fetch_ust", "fetch_jgb", "fetch_gilt", "fetch_eur", "fetch_india", "fetch_credit",
             "fetch_cds", "fetch_sofr", "fetch_bma_rates", "fetch_commodities", "fetch_inflation", "_fetch_myga"]

    def test_manifest_records_real_outcomes(self):
        outcomes = {n: mock.Mock(return_value=None) for n in self.NAMES}
        outcomes["fetch_jgb"].side_effect = AssertionError()
        outcomes["_fetch_myga"].return_value = "stale: no quotes parsed"
        with mock.patch.multiple(fa, **outcomes), mock.patch.object(fa, "flush_source_health"):
            fa.main()
        r = self.out("manifest.json")["results"]
        self.assertEqual(r["ust"], "ok")
        self.assertEqual(r["jgb"], "error: AssertionError")
        self.assertEqual(r["myga"], "stale: no quotes parsed")


class InflationTests(Base):
    def test_mom_is_percent_and_oecd_fills_discontinued_series(self):
        us = [{"date": f"2026-{m:02d}-01", "value": 300.0 + m} for m in range(8, 0, -1)]
        us += [{"date": f"2025-{m:02d}-01", "value": 290.0 + m} for m in range(12, 0, -1)]
        oecd = ("STRUCTURE,STRUCTURE_ID,ACTION,REF_AREA,FREQ,METHODOLOGY,MEASURE,UNIT_MEASURE,EXPENDITURE,"
                "ADJUSTMENT,TRANSFORMATION,TIME_PERIOD,OBS_VALUE\n"
                "DATAFLOW,x,I,GBR,M,N,CPI,PA,_T,N,GY,2026-07,3.4\n"
                "DATAFLOW,x,I,GBR,M,N,CPI,PA,_T,N,GY,2026-08,3.6\n"
                "DATAFLOW,x,I,GBR,M,HICP,CPI,PA,_T,N,GY,2026-08,9.9\n")
        self.web({"GBR.M..CPI": oecd})
        with mock.patch.object(fa, "fred_fetch", mock.Mock(return_value={"CPIAUCSL": us})):
            fa.fetch_inflation()
        c = self.out("inflation.json")["countries"]
        self.assertEqual(c["us"]["mom"], round((308 / 307 - 1) * 100, 3))
        self.assertEqual((c["uk"]["yoy"], c["uk"]["date"]), (3.6, "2026-08-01"))  # national, not HICP
        self.assertIsNone(c["jp"]["yoy"])  # OECD unreachable for JPN in this test


class CdsTests(Base):
    def test_no_dead_sector_series_and_cached_sovereign_is_partial(self):
        spreads = {k: {"spread": 100 + i, "prior": 99 + i, "date": days_back(1)}
                   for i, k in enumerate(["aaa", "aa", "a", "bbb", "bb", "b", "ccc"])}
        (self.data / "credit.json").write_text(json.dumps({"spreads": spreads}))
        (self.data / "cds.json").write_text(json.dumps(
            {"sovereign": {"us_5y": {"spread": 16.0, "date": days_back(14), "source": "worldgovernmentbonds"}}}))
        self.web({})
        status = fa.fetch_cds()
        d = self.out("cds.json")
        self.assertEqual(d["sector"], {})
        self.assertEqual(len(d["corporate"]), 7)
        self.assertEqual(d["sovereign"]["us_5y"]["source"], "cache")
        self.assertEqual(d["status"], "partial")
        self.assertTrue(status.startswith("partial: sovereign cache"))
        fa.fred_csv.assert_not_called()


class MygaTests(Base):
    def test_no_quotes_reports_stale(self):
        import fetch_myga as fm
        with mock.patch.object(fm, "_recent_enough", return_value=(False, {"status": "ok"})), \
             mock.patch.object(fm, "load_ust", return_value=(["5Y"], [4.0], days_back(1))), \
             mock.patch.object(fm, "fetch_term", return_value=([], "u")), \
             mock.patch.object(fm.time, "sleep", lambda s: None):
            self.assertTrue(fm.fetch_myga().startswith("stale: no quotes parsed"))


class SourceHealthTests(unittest.TestCase):
    def flush(self, last_success_ago):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        health = Path(tmp.name) / "source_health.json"
        ts = (datetime.utcnow() - last_success_ago).isoformat() + "Z"
        health.write_text(json.dumps({"sources": [{"source": "FRED", "feeds": "x", "last_attempt": ts,
                                                    "last_success": ts, "status": "active"}]}))
        with mock.patch.object(fetchlib, "HEALTH_FILE", health), mock.patch.object(fetchlib, "_health_this_run", {}):
            fetchlib.record_source("FRED", "x", ok=False, note="0/1 series returned data")
            out = fetchlib.flush_source_health()
        return next(x for x in out["sources"] if x["source"] == "FRED")["status"]

    def test_earlier_success_in_same_workflow_keeps_source_active(self):
        self.assertEqual(self.flush(timedelta(minutes=3)), "active")

    def test_failure_after_an_older_success_is_fallback(self):
        self.assertEqual(self.flush(timedelta(days=1)), "fallback")


# ── News / regulatory feeds ──────────────────────────────────────────

class RegulatoryTests(unittest.TestCase):
    def setUp(self):
        import fetch_news
        self.fn = fetch_news
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def item(self, title, source="", date=None):
        return {"title": title, "summary": "", "source": source, "link": f"https://x/{abs(hash(title))}",
                "date": datetime.utcnow() - timedelta(days=date or 0)}

    def test_african_cima_and_off_topic_items_are_dropped(self):
        rel = self.fn.reg_relevant
        self.assertFalse(rel("cayman", {"title": "Cameroon Warns 20 Insurance Brokers", "source": "Business in Cameroon"}))
        self.assertFalse(rel("cayman", {"title": "CIMA region apart in Africa's Islamic insurance market", "source": "africabusinessplus.com"}))
        self.assertTrue(rel("cayman", {"title": "CIMA removals hit record high in 2026", "source": "Cayman Compass"}))
        self.assertTrue(rel("cayman", {"title": "CIMA issues rule on reinsurance arrangements", "source": "Insurance Business"}))
        self.assertFalse(rel("bma", {"title": "Hanwha Life enters Abu Dhabi through blockchain", "source": "Insurance Business"}))
        self.assertTrue(rel("bma", {"title": "Consultation On Proposed Insurance Rules", "source": "Bernews"}))
        self.assertTrue(rel("naic", {"title": "Insurance Regulators Back State-Led Model in Reply to Warren", "source": "Bloomberg.com"}))
        self.assertFalse(rel("naic", {"title": "Start a prior auth working group, patient advocate says", "source": "benefitspro.com"}))

    def test_build_regulatory_filters_fresh_and_saved_items_and_marks_new_weekly(self):
        reg_file = Path(self.tmp.name) / "regulatory.json"
        reg_file.write_text(json.dumps({"cayman": [{"id": "old", "title": "Chanas Assurances Plans to Double Capital",
                                                    "source": "Business in Cameroon", "date": days_back(20)}]}))
        feeds = {
            "naic": [self.item("NAIC adopts framework", date=2), self.item("NAIC exposure draft", date=20)],
            "bma": [self.item("BMA proposes framework for failing insurers", "Royal Gazette | Bermuda", 1)],
            "cayman": [self.item("Cameroon Warns 20 Insurance Brokers", "Business in Cameroon", 1),
                       self.item("CIMA statement on investment activities", "Cayman Compass", 1)],
        }
        def fake_rss(query):
            key = "naic" if '"NAIC"' in query else "bma" if "Bermuda" in query else "cayman"
            return feeds[key]
        with mock.patch.object(self.fn, "REG_FILE", reg_file), mock.patch.object(self.fn, "fetch_rss", fake_rss), \
             mock.patch.object(self.fn, "_resolve_many", lambda links: {}):
            self.fn.build_regulatory()
        out = json.loads(reg_file.read_text())
        self.assertEqual([i["title"] for i in out["cayman"]], ["CIMA statement on investment activities"])
        naic = {i["title"]: i["isNew"] for i in out["naic"]}
        self.assertEqual(naic, {"NAIC adopts framework": True, "NAIC exposure draft": False})

    def test_no_seed_items_when_feeds_and_cache_are_empty(self):
        news_file = Path(self.tmp.name) / "news.json"
        with mock.patch.object(self.fn, "NEWS_FILE", news_file), \
             mock.patch.object(self.fn, "fetch_rss", mock.Mock(side_effect=urllib.error.URLError("down"))):
            self.fn.build_news()
        self.assertEqual(json.loads(news_file.read_text())["items"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)

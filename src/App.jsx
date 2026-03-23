import { useState, useEffect, useCallback, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, AreaChart, Area, Legend
} from "recharts";
import {
  TrendingUp, Globe, Shield, Newspaper, BarChart3,
  ChevronRight, ExternalLink, Clock, RefreshCw,
  Activity, Database, DollarSign, Percent,
  ArrowUpRight, ArrowDownRight, Minus, Menu
} from "lucide-react";

/* ═══════════════════════════════════════════════════════════════════
   BERMUDA MARKET INTELLIGENCE TERMINAL v1.1
   Rates as of 2026-03-19/20 from US Treasury, TradingEconomics, etc.
   ═══════════════════════════════════════════════════════════════════ */

// ─── ACTUAL MARKET DATA (Mar 19-20, 2026) ───

const SAMPLE_UST = {
  date: "2026-03-19",
  prior_date: "2026-03-18",
  source: "US Treasury – Daily Par Yield Curve Rates",
  url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve&field_tdr_date_value=2026",
  tenors: ["1M","3M","6M","1Y","2Y","3Y","5Y","7Y","10Y","20Y","30Y"],
  yields: [3.73, 3.73, 3.76, 3.73, 3.79, 3.79, 3.88, 4.06, 4.25, 4.82, 4.83],
  prior_yields: [3.73, 3.73, 3.74, 3.68, 3.76, 3.76, 3.87, 4.05, 4.26, 4.84, 4.88],
  history: [
    { date: "2026-03-12", yields: [3.76,3.72,3.70,3.66,3.76,3.75,3.88,4.06,4.27,4.86,4.88] },
    { date: "2026-03-13", yields: [3.75,3.72,3.70,3.66,3.73,3.74,3.87,4.07,4.28,4.89,4.90] },
    { date: "2026-03-16", yields: [3.75,3.72,3.72,3.64,3.68,3.69,3.80,4.00,4.23,4.83,4.86] },
    { date: "2026-03-17", yields: [3.74,3.72,3.71,3.63,3.68,3.68,3.79,3.98,4.20,4.81,4.85] },
    { date: "2026-03-18", yields: [3.73,3.73,3.74,3.68,3.76,3.76,3.87,4.05,4.26,4.84,4.88] },
    { date: "2026-03-19", yields: [3.73,3.73,3.76,3.73,3.79,3.79,3.88,4.06,4.25,4.82,4.83] },
  ]
};

const SAMPLE_JGB = {
  date: "2026-03-19", prior_date: "2026-03-18",
  source: "Ministry of Finance Japan / TradingEconomics",
  url: "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/",
  tenors: ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","30Y","40Y"],
  yields: [0.82, 0.98, 1.12, 1.45, 1.72, 2.26, 2.58, 2.72, 2.88, 3.02],
  prior_yields: [0.80, 0.96, 1.10, 1.43, 1.70, 2.23, 2.55, 2.70, 2.86, 3.00],
};

const SAMPLE_GILT = {
  date: "2026-03-20", prior_date: "2026-03-19",
  source: "Bank of England / TradingEconomics",
  url: "https://www.bankofengland.co.uk/statistics/yield-curves",
  tenors: ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","30Y","50Y"],
  yields: [4.55, 4.48, 4.45, 4.52, 4.68, 4.94, 5.12, 5.18, 5.22, 4.95],
  prior_yields: [4.42, 4.35, 4.32, 4.38, 4.55, 4.82, 5.00, 5.05, 5.10, 4.82],
};

const SAMPLE_EIOPA = {
  date: "2026-03-19", prior_date: "2026-03-18",
  source: "ECB SDW (proxy for EIOPA RFR)",
  url: "https://www.eiopa.europa.eu/tools-and-data/risk-free-interest-rate-term-structures",
  tenors: ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","30Y","50Y"],
  yields: [2.38, 2.42, 2.45, 2.55, 2.62, 2.72, 2.80, 2.75, 2.58, 2.38],
  prior_yields: [2.35, 2.39, 2.42, 2.52, 2.59, 2.69, 2.77, 2.72, 2.55, 2.35],
};

const SAMPLE_INDIA = {
  date: "2026-03-20", prior_date: "2026-03-19",
  source: "CCIL / RBI / TradingEconomics",
  url: "https://www.ccilindia.com/RBIBenchmarkRate.aspx",
  tenors: ["1Y","2Y","3Y","5Y","7Y","10Y","14Y","20Y","30Y","40Y"],
  yields: [5.73, 6.05, 6.18, 6.42, 6.58, 6.70, 6.82, 6.90, 6.95, 6.98],
  prior_yields: [5.72, 6.04, 6.17, 6.41, 6.57, 6.68, 6.80, 6.88, 6.93, 6.96],
};

const SAMPLE_CREDIT = {
  date: "2026-03-20",
  source: "FRED / ICE BofA Indices",
  url: "https://fred.stlouisfed.org/release?rid=209",
  us: {
    ig: { name: "US IG (Master)", spread: 98, prior: 101, ytd_avg: 108, bucket: "IG" },
    aaa: { name: "US AAA", spread: 42, prior: 44, ytd_avg: 50, bucket: "AAA" },
    aa: { name: "US AA", spread: 56, prior: 58, ytd_avg: 64, bucket: "AA" },
    a: { name: "US A", spread: 79, prior: 82, ytd_avg: 88, bucket: "A" },
    bbb: { name: "US BBB", spread: 130, prior: 134, ytd_avg: 142, bucket: "BBB" },
    hy: { name: "US HY", spread: 345, prior: 352, ytd_avg: 368, bucket: "HY" },
    bb: { name: "US BB", spread: 198, prior: 205, ytd_avg: 220, bucket: "BB" },
    b: { name: "US B", spread: 362, prior: 370, ytd_avg: 390, bucket: "B" },
    ccc: { name: "US CCC+", spread: 850, prior: 865, ytd_avg: 910, bucket: "CCC" },
  },
  eu: {
    ig: { name: "EUR IG", spread: 112, prior: 115, ytd_avg: 120, bucket: "IG" },
    hy: { name: "EUR HY", spread: 365, prior: 372, ytd_avg: 388, bucket: "HY" },
  },
  history: [
    { date: "2025-10", ig: 118, hy: 385, aaa: 55, bbb: 155 },
    { date: "2025-11", ig: 112, hy: 370, aaa: 52, bbb: 148 },
    { date: "2025-12", ig: 115, hy: 378, aaa: 53, bbb: 150 },
    { date: "2026-01", ig: 110, hy: 372, aaa: 51, bbb: 145 },
    { date: "2026-02", ig: 105, hy: 360, aaa: 48, bbb: 138 },
    { date: "2026-03", ig: 98, hy: 345, aaa: 42, bbb: 130 },
  ]
};

const INITIAL_NEWS = [
  { id: 1, title: "Apollo Global raises $8.2B for new private credit fund targeting insurance mandates", source: "Reuters", date: "2026-03-20T14:30:00Z", topic: "Private Credit", url: "#", summary: "Fund will focus on investment-grade private placements and asset-backed finance for insurance balance sheets." },
  { id: 2, title: "US IG corporate spreads compress to near post-pandemic lows amid strong demand", source: "Bloomberg", date: "2026-03-20T12:15:00Z", topic: "Credit Markets", url: "#", summary: "Investment grade OAS compressed below 100bp as insurance and pension demand outpaces new issuance supply." },
  { id: 3, title: "BOE holds rates at 3.75%; warns Iran conflict could drive inflation higher", source: "Financial Times", date: "2026-03-20T10:00:00Z", topic: "Rates & Macro", url: "#", summary: "MPC voted unanimously to hold. Gilt 10Y touched 5% as markets now price in multiple hikes." },
  { id: 4, title: "UK gilt 10Y yield hits 5% for first time since 2008 on energy price surge", source: "CNBC", date: "2026-03-20T09:30:00Z", topic: "Rates & Macro", url: "https://www.cnbc.com/2026/03/20/uk-gilt-market-interest-rates-boe-inflation-reeves.html", summary: "Gilt sell-off driven by soaring energy prices and hawkish BOE. UK public borrowing surged to £14.3B in February." },
  { id: 5, title: "BOJ holds rates steady, Takata dissents again calling for 25bp hike to 1%", source: "Reuters", date: "2026-03-19T08:00:00Z", topic: "Rates & Macro", url: "#", summary: "Governor Ueda signaled rate increase possible if Iran conflict slowdown is temporary. JGB 10Y at 2.26%." },
  { id: 6, title: "Bermuda reinsurer completes $1.5B structured credit portfolio acquisition", source: "Insurance Insider", date: "2026-03-19T16:45:00Z", topic: "Structured Credit", url: "#", summary: "CLO and ABS portfolio transfer from European bank to Bermuda Class E insurer." },
  { id: 7, title: "NAIC proposes enhanced reporting for insurer private credit allocations", source: "AM Best", date: "2026-03-19T14:20:00Z", topic: "Insurance AM", url: "#", summary: "New disclosure requirements would increase transparency on illiquid asset holdings." },
  { id: 8, title: "Japanese lifers accelerate USD credit allocation amid yen weakness", source: "Nikkei Asia", date: "2026-03-19T09:30:00Z", topic: "Insurance AM", url: "#", summary: "Major Japanese life insurers plan to increase unhedged USD credit exposures in FY2026." },
  { id: 9, title: "US CLO new issuance hits record $45B in Q1 2026", source: "S&P LCD", date: "2026-03-17T16:00:00Z", topic: "Structured Credit", url: "#", summary: "Strong demand from insurance portfolios and Asian investors driving record CLO volumes." },
  { id: 10, title: "Pension risk transfer market expected to exceed $60B in 2026", source: "P&I", date: "2026-03-17T10:30:00Z", topic: "Pension/Insurance", url: "#", summary: "UK and US PRT pipelines remain robust with several mega-deals in negotiation." },
];

const SAMPLE_BMA = [
  { id: 1, title: "Notice – Pre-Approval Process for New Bermuda Insurance Registrations", date: "2026-03-19", category: "Licensing", url: "https://www.bma.bm", summary: "Updated pre-approval requirements for new Class D and Class E registrations.", isNew: true },
  { id: 2, title: "Notice – Regulatory Burden Reduction for Better Supervision", date: "2026-02-19", category: "Governance", url: "https://www.bma.bm", summary: "BMA initiative to streamline reporting and reduce regulatory burden on commercial insurers.", isNew: true },
  { id: 3, title: "Notice – 2025 Year-End BSCR Model Republication", date: "2026-02-18", category: "Capital/Solvency", url: "https://www.bma.bm", summary: "Republished BSCR models for Class D and E with optional data validation feature.", isNew: true },
  { id: 4, title: "Discussion Paper – AI Governance Framework for Financial Services", date: "2026-02-09", category: "Governance", url: "https://www.bma.bm", summary: "Outcomes-based risk management framework for AI governance. Final proposal expected Q3 2026.", isNew: true },
  { id: 5, title: "Consultation Paper – Prudent Person Principle Instructions & Guidance", date: "2025-12-15", category: "Investment", url: "https://www.bma.bm", summary: "Proposed guidance on PPP application for commercial insurers with NPTA allocations.", isNew: false },
  { id: 6, title: "Insurance (Prudential Standards) (Class C, D, E Solvency) Amendment Rules 2025", date: "2025-12-01", category: "Capital/Solvency", url: "https://www.bma.bm", summary: "New paragraphs 7A and 7B on Asset and Liability Statement disclosure. Effective Jan 1, 2026.", isNew: false },
  { id: 7, title: "Proposed Enhancements to Public Disclosure Regime", date: "2025-12-01", category: "Disclosure", url: "https://www.bma.bm", summary: "Enhanced public disclosure requirements on investments for long-term commercial insurers.", isNew: false },
  { id: 8, title: "2025 GFC Stress Test Instructions – Class C, D and E", date: "2025-05-30", category: "Stress Testing", url: "https://www.bma.bm", summary: "Specific GFC stress test scenarios for long-term commercial insurers.", isNew: false },
];

// ─── UTILITIES ───

const formatYield = (v) => v != null ? v.toFixed(2) + "%" : "N/A";
const changeBp = (curr, prior) => ((curr - prior) * 100).toFixed(1);
const getChangeColor = (val) => val > 0 ? "#ef4444" : val < 0 ? "#22c55e" : "#64748b";
const getChangeIcon = (val) => val > 0 ? ArrowUpRight : val < 0 ? ArrowDownRight : Minus;

const timeAgo = (dateStr) => {
  const now = new Date("2026-03-23T12:00:00Z");
  const d = new Date(dateStr);
  const hours = Math.floor((now - d) / 3600000);
  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

// ─── SHARED COMPONENTS ───

const Badge = ({ children, color = "#3b82f6" }) => (
  <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", padding: "2px 8px", borderRadius: 4, background: color + "18", color, whiteSpace: "nowrap" }}>{children}</span>
);

const DataFreshness = ({ date, source, url }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#64748b", flexWrap: "wrap" }}>
    <Clock size={12} />
    <span>As of {date}</span>
    <span style={{ color: "#334155" }}>|</span>
    <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "#3b82f6", textDecoration: "none", display: "flex", alignItems: "center", gap: 3 }}>{source} <ExternalLink size={10} /></a>
  </div>
);

const CurveTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#1a1d23", border: "1px solid #2a2d35", borderRadius: 6, padding: "10px 14px", fontSize: 12 }}>
      <div style={{ color: "#94a3b8", marginBottom: 4, fontWeight: 600 }}>{label}</div>
      {payload.filter(p => p.value != null).map((p, i) => (
        <div key={i} style={{ color: p.color, display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: p.color, display: "inline-block" }} />
          <span>{p.name}: {typeof p.value === "number" ? p.value.toFixed(2) + "%" : p.value}</span>
        </div>
      ))}
    </div>
  );
};

const SpreadTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#1a1d23", border: "1px solid #2a2d35", borderRadius: 6, padding: "10px 14px", fontSize: 12 }}>
      <div style={{ color: "#94a3b8", marginBottom: 4, fontWeight: 600 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: p.color, display: "inline-block" }} />
          <span>{p.name}: {p.value}bp</span>
        </div>
      ))}
    </div>
  );
};

const MetricCard = ({ label, value, change }) => {
  const numChange = parseFloat(change);
  const Icon = getChangeIcon(numChange);
  const color = getChangeColor(numChange);
  return (
    <div style={{ background: "#12141a", border: "1px solid #1e2028", borderRadius: 8, padding: "14px 18px", minWidth: 160 }}>
      <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace" }}>{value}</span>
        {change !== undefined && (
          <span style={{ fontSize: 12, color, display: "flex", alignItems: "center", gap: 2, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>
            <Icon size={14} /> {Math.abs(numChange).toFixed(1)}bp
          </span>
        )}
      </div>
    </div>
  );
};

// ─── SOVEREIGN YIELD SECTION (Chart + Table together) ───

const SovereignYieldSection = ({ data, title, accentColor }) => {
  const curveData = data.tenors.map((t, i) => ({
    tenor: t, current: data.yields[i], prior: data.prior_yields[i],
    change: data.yields[i] != null && data.prior_yields[i] != null ? ((data.yields[i] - data.prior_yields[i]) * 100).toFixed(1) : null,
  }));

  return (
    <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "14px 20px", borderBottom: "1px solid #1e2028" }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>{title}</h3>
        <DataFreshness date={data.date} source={data.source} url={data.url} />
      </div>
      {/* Chart */}
      <div style={{ padding: "12px 12px 4px" }}>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={curveData}>
            <defs>
              <linearGradient id={`g-${accentColor.slice(1)}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={accentColor} stopOpacity={0.25} />
                <stop offset="95%" stopColor={accentColor} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1a1d23" />
            <XAxis dataKey="tenor" tick={{ fill: "#64748b", fontSize: 11 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} />
            <YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} domain={["auto", "auto"]} tickFormatter={(v) => v.toFixed(1)} />
            <Tooltip content={<CurveTooltip />} />
            <Area type="monotone" dataKey="current" stroke={accentColor} strokeWidth={2.5} fill={`url(#g-${accentColor.slice(1)})`} name="Current" dot={{ r: 3, fill: accentColor }} />
            <Line type="monotone" dataKey="prior" stroke="#475569" strokeWidth={1.5} strokeDasharray="5 5" name="Prior" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {/* Table directly below */}
      <div style={{ padding: "0 20px 14px", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #1e2028" }}>
              <th style={{ textAlign: "left", padding: "6px 10px", color: "#64748b", fontWeight: 600, fontSize: 11 }}>Tenor</th>
              <th style={{ textAlign: "right", padding: "6px 10px", color: "#64748b", fontWeight: 600, fontSize: 11 }}>Yield</th>
              <th style={{ textAlign: "right", padding: "6px 10px", color: "#64748b", fontWeight: 600, fontSize: 11 }}>Prior</th>
              <th style={{ textAlign: "right", padding: "6px 10px", color: "#64748b", fontWeight: 600, fontSize: 11 }}>Chg (bp)</th>
            </tr>
          </thead>
          <tbody>
            {curveData.map((row, i) => {
              const ch = parseFloat(row.change);
              return (
                <tr key={i} style={{ borderBottom: "1px solid #13151b" }}>
                  <td style={{ padding: "5px 10px", color: "#e2e8f0", fontWeight: 600, fontFamily: "monospace" }}>{row.tenor}</td>
                  <td style={{ padding: "5px 10px", color: "#e2e8f0", textAlign: "right", fontFamily: "monospace" }}>{formatYield(row.current)}</td>
                  <td style={{ padding: "5px 10px", color: "#94a3b8", textAlign: "right", fontFamily: "monospace" }}>{formatYield(row.prior)}</td>
                  <td style={{ padding: "5px 10px", textAlign: "right", fontFamily: "monospace", color: getChangeColor(ch), fontWeight: 600 }}>
                    {row.change != null ? (ch > 0 ? "+" : "") + row.change : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ─── CREDIT SPREAD SECTION ───

const CreditSpreadSection = ({ data }) => {
  const [mkt, setMkt] = useState("us");
  const entries = Object.values(mkt === "us" ? data.us : data.eu);
  return (
    <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "14px 20px", borderBottom: "1px solid #1e2028", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>Corporate Credit Spreads (OAS to Treasuries)</h3>
          <DataFreshness date={data.date} source={data.source} url={data.url} />
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {["us", "eu"].map(m => (
            <button key={m} onClick={() => setMkt(m)} style={{
              background: mkt === m ? "#3b82f6" : "transparent", border: "1px solid #2a2d35",
              borderRadius: 6, padding: "5px 14px", fontSize: 11, color: mkt === m ? "#fff" : "#94a3b8",
              cursor: "pointer", fontWeight: 600, textTransform: "uppercase"
            }}>{m === "us" ? "US" : "EUR"}</button>
          ))}
        </div>
      </div>
      <div style={{ padding: "8px 20px", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #1e2028" }}>
              {["Index","OAS (bp)","Prior","Chg","YTD Avg"].map(h => (
                <th key={h} style={{ textAlign: h === "Index" ? "left" : "right", padding: "6px 10px", color: "#64748b", fontWeight: 600, fontSize: 11 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((row, i) => {
              const chg = row.spread - row.prior;
              return (
                <tr key={i} style={{ borderBottom: "1px solid #13151b" }}>
                  <td style={{ padding: "6px 10px", color: "#e2e8f0", fontWeight: 600 }}>
                    {row.name} <Badge color={["HY","BB","B","CCC"].includes(row.bucket) ? "#ef4444" : "#22c55e"}>{row.bucket}</Badge>
                  </td>
                  <td style={{ padding: "6px 10px", color: "#e2e8f0", textAlign: "right", fontFamily: "monospace", fontWeight: 700 }}>{row.spread}</td>
                  <td style={{ padding: "6px 10px", color: "#94a3b8", textAlign: "right", fontFamily: "monospace" }}>{row.prior}</td>
                  <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "monospace", color: getChangeColor(chg * -1), fontWeight: 600 }}>{chg > 0 ? "+" : ""}{chg}</td>
                  <td style={{ padding: "6px 10px", color: "#94a3b8", textAlign: "right", fontFamily: "monospace" }}>{row.ytd_avg}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ padding: "12px 12px 8px" }}>
        <ResponsiveContainer width="100%" height={190}>
          <BarChart data={data.history}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1a1d23" />
            <XAxis dataKey="date" tick={{ fill: "#64748b", fontSize: 11 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} />
            <YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} />
            <Tooltip content={<SpreadTooltip />} />
            <Bar dataKey="ig" fill="#3b82f6" name="IG" radius={[3,3,0,0]} />
            <Bar dataKey="bbb" fill="#f59e0b" name="BBB" radius={[3,3,0,0]} />
            <Bar dataKey="hy" fill="#ef4444" name="HY" radius={[3,3,0,0]} />
            <Legend wrapperStyle={{ fontSize: 11, color: "#64748b" }} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

// ─── NEWS SECTION WITH REFRESH ───

const NewsSection = ({ initialNews }) => {
  const [news, setNews] = useState(initialNews);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(new Date().toLocaleTimeString());
  const topics = [...new Set(news.map(n => n.topic))];
  const [selectedTopic, setSelectedTopic] = useState("All");
  const filtered = selectedTopic === "All" ? news : news.filter(n => n.topic === selectedTopic);

  const topicColors = { "Private Credit": "#8b5cf6", "Credit Markets": "#3b82f6", "Rates & Macro": "#22c55e", "Structured Credit": "#f59e0b", "Insurance AM": "#ec4899", "Pension/Insurance": "#14b8a6" };

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    // In production, this would fetch /data/news/news.json
    // For MVP, simulate a refresh with a timestamp update
    setTimeout(() => {
      setLastRefresh(new Date().toLocaleTimeString());
      setRefreshing(false);
    }, 1200);
  }, []);

  return (
    <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "14px 20px", borderBottom: "1px solid #1e2028" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>
            <Newspaper size={16} style={{ verticalAlign: "middle", marginRight: 8 }} /> Financial Markets News
          </h3>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 10, color: "#475569" }}>Updated {lastRefresh}</span>
            <button onClick={handleRefresh} disabled={refreshing} style={{
              background: "#1e2028", border: "1px solid #2a2d35", borderRadius: 6,
              padding: "6px 14px", fontSize: 11, color: refreshing ? "#475569" : "#e2e8f0",
              cursor: refreshing ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 5, fontWeight: 600
            }}>
              <RefreshCw size={12} style={{ animation: refreshing ? "spin 1s linear infinite" : "none" }} />
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {["All", ...topics].map(t => (
            <button key={t} onClick={() => setSelectedTopic(t)} style={{
              background: selectedTopic === t ? (topicColors[t] || "#3b82f6") : "transparent",
              border: `1px solid ${selectedTopic === t ? (topicColors[t] || "#3b82f6") : "#2a2d35"}`,
              borderRadius: 20, padding: "4px 14px", fontSize: 11,
              color: selectedTopic === t ? "#fff" : "#94a3b8", cursor: "pointer", fontWeight: 600
            }}>{t}</button>
          ))}
        </div>
      </div>
      <div style={{ maxHeight: 500, overflowY: "auto" }}>
        {filtered.map(item => (
          <div key={item.id} style={{ padding: "12px 20px", borderBottom: "1px solid #13151b", cursor: "pointer" }}
               onMouseEnter={(e) => e.currentTarget.style.background = "#12141a"}
               onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
              <Badge color={topicColors[item.topic] || "#3b82f6"}>{item.topic}</Badge>
              <span style={{ fontSize: 11, color: "#475569" }}>{item.source}</span>
              <span style={{ fontSize: 11, color: "#334155" }}>•</span>
              <span style={{ fontSize: 11, color: "#475569" }}>{timeAgo(item.date)}</span>
            </div>
            <h4 style={{ margin: "0 0 3px", fontSize: 13, fontWeight: 600, color: "#e2e8f0", lineHeight: 1.4 }}>{item.title}</h4>
            <p style={{ margin: 0, fontSize: 12, color: "#64748b", lineHeight: 1.5 }}>{item.summary}</p>
          </div>
        ))}
      </div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
};

// ─── BMA SECTION ───

const BMASection = ({ updates }) => {
  const categories = [...new Set(updates.map(u => u.category))];
  const [catFilter, setCatFilter] = useState("All");
  const filtered = catFilter === "All" ? updates : updates.filter(u => u.category === catFilter);
  const catColors = { "Capital/Solvency": "#ef4444", "Investment": "#f59e0b", "Governance": "#8b5cf6", "Disclosure": "#3b82f6", "Licensing": "#22c55e", "Stress Testing": "#ec4899" };
  return (
    <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "14px 20px", borderBottom: "1px solid #1e2028" }}>
        <h3 style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}><Shield size={16} style={{ verticalAlign: "middle", marginRight: 8 }} /> BMA Regulatory Updates</h3>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {["All", ...categories].map(c => (
            <button key={c} onClick={() => setCatFilter(c)} style={{
              background: catFilter === c ? (catColors[c] || "#3b82f6") : "transparent",
              border: `1px solid ${catFilter === c ? (catColors[c] || "#3b82f6") : "#2a2d35"}`,
              borderRadius: 20, padding: "4px 14px", fontSize: 11,
              color: catFilter === c ? "#fff" : "#94a3b8", cursor: "pointer", fontWeight: 500
            }}>{c}</button>
          ))}
        </div>
      </div>
      <div>
        {filtered.map(item => (
          <div key={item.id} style={{ padding: "12px 20px", borderBottom: "1px solid #13151b" }}
               onMouseEnter={(e) => e.currentTarget.style.background = "#12141a"}
               onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
              <Badge color={catColors[item.category] || "#3b82f6"}>{item.category}</Badge>
              {item.isNew && <Badge color="#22c55e">NEW</Badge>}
              <span style={{ fontSize: 11, color: "#475569" }}>{item.date}</span>
            </div>
            <h4 style={{ margin: "0 0 3px", fontSize: 13, fontWeight: 600, color: "#e2e8f0", lineHeight: 1.4 }}>{item.title}</h4>
            <p style={{ margin: 0, fontSize: 12, color: "#64748b", lineHeight: 1.5 }}>{item.summary}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

// ─── MAIN APP ───

const PAGES = [
  { id: "home", label: "Overview", icon: Activity },
  { id: "ust", label: "US Treasuries", icon: DollarSign },
  { id: "jgb", label: "Japan JGB", icon: Globe },
  { id: "gilt", label: "UK Gilts", icon: Globe },
  { id: "eiopa", label: "EIOPA EUR", icon: Globe },
  { id: "india", label: "India Govt", icon: Globe },
  { id: "credit", label: "Credit Spreads", icon: Percent },
  { id: "news", label: "News", icon: Newspaper },
  { id: "bma", label: "BMA Updates", icon: Shield },
];

export default function App() {
  const [page, setPage] = useState("home");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [clock, setClock] = useState(new Date().toLocaleTimeString("en-US", { hour12: false }));
  useEffect(() => { const t = setInterval(() => setClock(new Date().toLocaleTimeString("en-US", { hour12: false })), 1000); return () => clearInterval(t); }, []);

  // Key rates
  const idx = (arr, t) => arr.indexOf(t);
  const ust10y = SAMPLE_UST.yields[idx(SAMPLE_UST.tenors, "10Y")];
  const ust10yP = SAMPLE_UST.prior_yields[idx(SAMPLE_UST.tenors, "10Y")];
  const ust2y = SAMPLE_UST.yields[idx(SAMPLE_UST.tenors, "2Y")];
  const ust2yP = SAMPLE_UST.prior_yields[idx(SAMPLE_UST.tenors, "2Y")];
  const jgb10y = SAMPLE_JGB.yields[idx(SAMPLE_JGB.tenors, "10Y")];
  const jgb10yP = SAMPLE_JGB.prior_yields[idx(SAMPLE_JGB.tenors, "10Y")];
  const gilt10y = SAMPLE_GILT.yields[idx(SAMPLE_GILT.tenors, "10Y")];
  const gilt10yP = SAMPLE_GILT.prior_yields[idx(SAMPLE_GILT.tenors, "10Y")];
  const india10y = SAMPLE_INDIA.yields[idx(SAMPLE_INDIA.tenors, "10Y")];
  const india10yP = SAMPLE_INDIA.prior_yields[idx(SAMPLE_INDIA.tenors, "10Y")];

  // FULL Global Yield Curve with all available common tenors
  const allTenors = ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","30Y"];
  const multiCurveData = allTenors.map(t => {
    const get = (d, tn) => { const i = d.tenors.indexOf(tn); return i >= 0 ? d.yields[i] : null; };
    return { tenor: t, UST: get(SAMPLE_UST, t), JGB: get(SAMPLE_JGB, t), Gilt: get(SAMPLE_GILT, t), EIOPA: get(SAMPLE_EIOPA, t), India: get(SAMPLE_INDIA, t) };
  });

  const renderPage = () => {
    switch (page) {
      case "ust": return <SovereignYieldSection data={SAMPLE_UST} title="US Treasury Par Yield Curve (CMT)" accentColor="#3b82f6" />;
      case "jgb": return <SovereignYieldSection data={SAMPLE_JGB} title="Japan Government Bond Yields" accentColor="#ef4444" />;
      case "gilt": return <SovereignYieldSection data={SAMPLE_GILT} title="UK Gilt Yields" accentColor="#22c55e" />;
      case "eiopa": return <SovereignYieldSection data={SAMPLE_EIOPA} title="EIOPA Risk-Free Rate Term Structure (EUR)" accentColor="#f59e0b" />;
      case "india": return <SovereignYieldSection data={SAMPLE_INDIA} title="India Government Bond Yields" accentColor="#ec4899" />;
      case "credit": return <CreditSpreadSection data={SAMPLE_CREDIT} />;
      case "news": return <NewsSection initialNews={INITIAL_NEWS} />;
      case "bma": return <BMASection updates={SAMPLE_BMA} />;
      default: return (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Key Rates */}
          <div>
            <h3 style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.1em" }}>Key Rates Snapshot (as of {SAMPLE_UST.date})</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(165px, 1fr))", gap: 10 }}>
              <MetricCard label="UST 10Y" value={formatYield(ust10y)} change={changeBp(ust10y, ust10yP)} />
              <MetricCard label="UST 2Y" value={formatYield(ust2y)} change={changeBp(ust2y, ust2yP)} />
              <MetricCard label="UST 2s10s" value={((ust10y - ust2y) * 100).toFixed(0) + "bp"} change={((ust10y - ust2y - (ust10yP - ust2yP)) * 100).toFixed(1)} />
              <MetricCard label="JGB 10Y" value={formatYield(jgb10y)} change={changeBp(jgb10y, jgb10yP)} />
              <MetricCard label="UK Gilt 10Y" value={formatYield(gilt10y)} change={changeBp(gilt10y, gilt10yP)} />
              <MetricCard label="India 10Y" value={formatYield(india10y)} change={changeBp(india10y, india10yP)} />
              <MetricCard label="US IG OAS" value={SAMPLE_CREDIT.us.ig.spread + "bp"} change={(SAMPLE_CREDIT.us.ig.spread - SAMPLE_CREDIT.us.ig.prior).toFixed(0)} />
              <MetricCard label="US HY OAS" value={SAMPLE_CREDIT.us.hy.spread + "bp"} change={(SAMPLE_CREDIT.us.hy.spread - SAMPLE_CREDIT.us.hy.prior).toFixed(0)} />
            </div>
          </div>

          {/* Global Yield Curve — ALL tenors, ALL curves */}
          <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: "14px 14px 6px" }}>
            <h3 style={{ margin: "0 0 10px 6px", fontSize: 13, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.1em" }}>
              Global Yield Curve Comparison (1Y–30Y)
            </h3>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={multiCurveData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1a1d23" />
                <XAxis dataKey="tenor" tick={{ fill: "#64748b", fontSize: 11 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} />
                <YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} domain={[0, "auto"]} tickFormatter={(v) => v.toFixed(1) + "%"} />
                <Tooltip content={<CurveTooltip />} />
                <Line type="monotone" dataKey="India" stroke="#ec4899" strokeWidth={2} name="India" dot={{ r: 4 }} connectNulls />
                <Line type="monotone" dataKey="Gilt" stroke="#22c55e" strokeWidth={2} name="UK Gilt" dot={{ r: 4 }} connectNulls />
                <Line type="monotone" dataKey="UST" stroke="#3b82f6" strokeWidth={2.5} name="US Treasury" dot={{ r: 4 }} connectNulls />
                <Line type="monotone" dataKey="EIOPA" stroke="#f59e0b" strokeWidth={2} name="EIOPA EUR" dot={{ r: 4 }} connectNulls />
                <Line type="monotone" dataKey="JGB" stroke="#ef4444" strokeWidth={2} name="Japan JGB" dot={{ r: 4 }} connectNulls />
                <Legend wrapperStyle={{ fontSize: 11, color: "#64748b", paddingTop: 8 }} />
              </LineChart>
            </ResponsiveContainer>
            {/* Comparison table */}
            <div style={{ overflowX: "auto", padding: "4px 6px 10px" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #1e2028" }}>
                    <th style={{ textAlign: "left", padding: "5px 8px", color: "#64748b", fontWeight: 600 }}>Tenor</th>
                    <th style={{ textAlign: "right", padding: "5px 8px", color: "#3b82f6", fontWeight: 600 }}>UST</th>
                    <th style={{ textAlign: "right", padding: "5px 8px", color: "#ef4444", fontWeight: 600 }}>JGB</th>
                    <th style={{ textAlign: "right", padding: "5px 8px", color: "#22c55e", fontWeight: 600 }}>Gilt</th>
                    <th style={{ textAlign: "right", padding: "5px 8px", color: "#f59e0b", fontWeight: 600 }}>EIOPA</th>
                    <th style={{ textAlign: "right", padding: "5px 8px", color: "#ec4899", fontWeight: 600 }}>India</th>
                  </tr>
                </thead>
                <tbody>
                  {multiCurveData.map((row, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid #13151b" }}>
                      <td style={{ padding: "4px 8px", color: "#e2e8f0", fontWeight: 600, fontFamily: "monospace" }}>{row.tenor}</td>
                      {["UST","JGB","Gilt","EIOPA","India"].map(k => (
                        <td key={k} style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", color: row[k] != null ? "#e2e8f0" : "#334155" }}>
                          {row[k] != null ? row[k].toFixed(2) + "%" : "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* News + BMA side by side */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ padding: "12px 20px", borderBottom: "1px solid #1e2028", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}><Newspaper size={14} style={{ verticalAlign: "middle", marginRight: 6 }} /> Latest News</h3>
                <button onClick={() => setPage("news")} style={{ background: "transparent", border: "none", color: "#3b82f6", fontSize: 11, cursor: "pointer", fontWeight: 600 }}>View All <ChevronRight size={12} style={{ verticalAlign: "middle" }} /></button>
              </div>
              {INITIAL_NEWS.slice(0, 5).map(item => (
                <div key={item.id} style={{ padding: "8px 20px", borderBottom: "1px solid #13151b" }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 2 }}>
                    <Badge color="#3b82f6">{item.topic}</Badge>
                    <span style={{ fontSize: 10, color: "#475569" }}>{timeAgo(item.date)}</span>
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0", lineHeight: 1.4 }}>{item.title}</div>
                </div>
              ))}
            </div>
            <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ padding: "12px 20px", borderBottom: "1px solid #1e2028", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}><Shield size={14} style={{ verticalAlign: "middle", marginRight: 6 }} /> BMA Updates</h3>
                <button onClick={() => setPage("bma")} style={{ background: "transparent", border: "none", color: "#3b82f6", fontSize: 11, cursor: "pointer", fontWeight: 600 }}>View All <ChevronRight size={12} style={{ verticalAlign: "middle" }} /></button>
              </div>
              {SAMPLE_BMA.filter(u => u.isNew).slice(0, 4).map(item => (
                <div key={item.id} style={{ padding: "8px 20px", borderBottom: "1px solid #13151b" }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 2 }}>
                    <Badge color="#22c55e">NEW</Badge>
                    <Badge>{item.category}</Badge>
                    <span style={{ fontSize: 10, color: "#475569" }}>{item.date}</span>
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0", lineHeight: 1.4 }}>{item.title}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    }
  };

  return (
    <div style={{ display: "flex", height: "100vh", background: "#080a0f", color: "#e2e8f0", fontFamily: "'JetBrains Mono', 'IBM Plex Sans', -apple-system, sans-serif", fontSize: 13, overflow: "hidden" }}>
      {/* Sidebar */}
      <div style={{ width: sidebarOpen ? 210 : 52, transition: "width 0.2s ease", background: "#0a0c12", borderRight: "1px solid #1a1d23", display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden" }}>
        <div style={{ padding: sidebarOpen ? "14px 16px" : "14px 10px", borderBottom: "1px solid #1a1d23", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", minHeight: 52 }} onClick={() => setSidebarOpen(!sidebarOpen)}>
          <div style={{ width: 28, height: 28, borderRadius: 6, background: "linear-gradient(135deg, #3b82f6, #8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <BarChart3 size={16} color="#fff" />
          </div>
          {sidebarOpen && <div><div style={{ fontSize: 13, fontWeight: 800, color: "#e2e8f0", letterSpacing: "-0.02em", lineHeight: 1.1 }}>BERMUDA</div><div style={{ fontSize: 9, fontWeight: 600, color: "#3b82f6", letterSpacing: "0.15em", textTransform: "uppercase" }}>MARKET INTEL</div></div>}
        </div>
        <div style={{ flex: 1, padding: "6px 6px", overflowY: "auto" }}>
          {PAGES.map(p => {
            const Icon = p.icon; const isActive = page === p.id;
            return (
              <button key={p.id} onClick={() => setPage(p.id)} style={{
                width: "100%", display: "flex", alignItems: "center", gap: 10,
                padding: sidebarOpen ? "8px 10px" : "8px 8px", marginBottom: 1, borderRadius: 6, border: "none",
                background: isActive ? "#1e2028" : "transparent", color: isActive ? "#e2e8f0" : "#64748b",
                cursor: "pointer", fontSize: 12, fontWeight: isActive ? 600 : 500, textAlign: "left",
                justifyContent: sidebarOpen ? "flex-start" : "center"
              }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "#12141a"; }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}>
                <Icon size={15} style={{ flexShrink: 0 }} />
                {sidebarOpen && <span>{p.label}</span>}
              </button>
            );
          })}
        </div>
        {sidebarOpen && <div style={{ padding: "10px 14px", borderTop: "1px solid #1a1d23", fontSize: 10, color: "#334155" }}>Data: Treasury.gov, MOF JP, BoE, ECB, RBI, FRED, BMA</div>}
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ height: 42, padding: "0 20px", borderBottom: "1px solid #1a1d23", background: "#0a0c12", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{PAGES.find(p => p.id === page)?.label || "Overview"}</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 11 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5, color: "#64748b" }}><div style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e" }} />LIVE</div>
            <span style={{ color: "#3b82f6", fontFamily: "monospace", fontWeight: 700, fontSize: 13 }}>{clock}</span>
          </div>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 18 }}>{renderPage()}</div>
        <div style={{ height: 26, padding: "0 20px", borderTop: "1px solid #1a1d23", background: "#0a0c12", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 10, color: "#334155", flexShrink: 0 }}>
          <div style={{ display: "flex", gap: 14 }}>
            <span>UST 10Y: {formatYield(ust10y)}</span>
            <span>JGB 10Y: {formatYield(jgb10y)}</span>
            <span>Gilt 10Y: {formatYield(gilt10y)}</span>
            <span>India 10Y: {formatYield(india10y)}</span>
            <span>IG OAS: {SAMPLE_CREDIT.us.ig.spread}bp</span>
            <span>HY OAS: {SAMPLE_CREDIT.us.hy.spread}bp</span>
          </div>
          <span>Bermuda Market Intelligence Terminal v1.1</span>
        </div>
      </div>
    </div>
  );
}

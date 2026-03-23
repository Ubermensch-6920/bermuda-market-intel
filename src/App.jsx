import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, AreaChart, Area, Legend, ReferenceLine
} from "recharts";
import {
  TrendingUp, TrendingDown, Globe, Shield, Newspaper, BarChart3,
  ChevronRight, ExternalLink, Clock, AlertTriangle, RefreshCw,
  Search, Filter, Download, Sun, Moon, Menu, X, ArrowUpRight,
  ArrowDownRight, Minus, Activity, Database, BookOpen, Bell,
  ChevronDown, ChevronUp, Layers, DollarSign, Percent
} from "lucide-react";

/* ═══════════════════════════════════════════════════════════════════
   BERMUDA MARKET INTELLIGENCE TERMINAL
   A professional financial dashboard for Bermuda life insurance actuaries
   ═══════════════════════════════════════════════════════════════════ */

// ─── SAMPLE DATA (replaced by JSON files from GitHub Actions in production) ───

const SAMPLE_UST = {
  date: "2026-03-20",
  prior_date: "2026-03-19",
  source: "US Treasury – Daily Par Yield Curve",
  url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates",
  tenors: ["1M","3M","6M","1Y","2Y","3Y","5Y","7Y","10Y","20Y","30Y"],
  yields: [4.32, 4.28, 4.15, 3.98, 3.89, 3.85, 3.92, 4.01, 4.18, 4.52, 4.38],
  prior_yields: [4.33, 4.30, 4.17, 4.00, 3.92, 3.88, 3.94, 4.03, 4.20, 4.54, 4.40],
  history: [
    { date: "2026-03-16", yields: [4.35, 4.32, 4.20, 4.05, 3.96, 3.92, 3.98, 4.07, 4.24, 4.58, 4.44] },
    { date: "2026-03-17", yields: [4.34, 4.31, 4.18, 4.02, 3.93, 3.89, 3.95, 4.04, 4.21, 4.55, 4.41] },
    { date: "2026-03-18", yields: [4.34, 4.31, 4.18, 4.01, 3.93, 3.89, 3.95, 4.04, 4.21, 4.55, 4.41] },
    { date: "2026-03-19", yields: [4.33, 4.30, 4.17, 4.00, 3.92, 3.88, 3.94, 4.03, 4.20, 4.54, 4.40] },
    { date: "2026-03-20", yields: [4.32, 4.28, 4.15, 3.98, 3.89, 3.85, 3.92, 4.01, 4.18, 4.52, 4.38] },
  ]
};

const SAMPLE_JGB = {
  date: "2026-03-20", prior_date: "2026-03-19",
  source: "Ministry of Finance Japan",
  url: "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/",
  tenors: ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","30Y","40Y"],
  yields: [0.42, 0.68, 0.82, 1.05, 1.22, 1.38, 1.72, 1.95, 2.18, 2.32],
  prior_yields: [0.41, 0.67, 0.81, 1.04, 1.21, 1.36, 1.70, 1.93, 2.16, 2.30],
};

const SAMPLE_GILT = {
  date: "2026-03-20", prior_date: "2026-03-19",
  source: "Bank of England",
  url: "https://www.bankofengland.co.uk/statistics/yield-curves",
  tenors: ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","30Y","50Y"],
  yields: [4.22, 4.05, 3.98, 3.95, 4.02, 4.15, 4.38, 4.52, 4.68, 4.45],
  prior_yields: [4.24, 4.07, 4.00, 3.97, 4.04, 4.17, 4.40, 4.54, 4.70, 4.47],
};

const SAMPLE_EIOPA = {
  date: "2026-03-20", prior_date: "2026-02-28",
  source: "EIOPA Risk-Free Rate",
  url: "https://www.eiopa.europa.eu/tools-and-data/risk-free-interest-rate-term-structures",
  tenors: ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","30Y","50Y"],
  yields: [2.52, 2.48, 2.45, 2.55, 2.62, 2.68, 2.72, 2.65, 2.48, 2.32],
  prior_yields: [2.55, 2.50, 2.47, 2.57, 2.64, 2.70, 2.74, 2.67, 2.50, 2.34],
};

const SAMPLE_INDIA = {
  date: "2026-03-20", prior_date: "2026-03-19",
  source: "Reserve Bank of India / CCIL",
  url: "https://www.ccilindia.com/RBIBenchmarkRate.aspx",
  tenors: ["1Y","2Y","3Y","5Y","7Y","10Y","14Y","20Y","30Y","40Y"],
  yields: [6.72, 6.68, 6.65, 6.78, 6.85, 6.92, 7.05, 7.12, 7.18, 7.22],
  prior_yields: [6.74, 6.70, 6.67, 6.80, 6.87, 6.94, 7.07, 7.14, 7.20, 7.24],
};

const SAMPLE_CREDIT = {
  date: "2026-03-20",
  source: "FRED / ICE BofA Indices",
  url: "https://fred.stlouisfed.org/release?rid=209",
  us: {
    ig: { name: "US IG (ICE BofA)", spread: 98, prior: 101, ytd_avg: 105, bucket: "IG" },
    aaa: { name: "US AAA", spread: 42, prior: 43, ytd_avg: 48, bucket: "AAA" },
    aa: { name: "US AA", spread: 55, prior: 57, ytd_avg: 62, bucket: "AA" },
    a: { name: "US A", spread: 78, prior: 80, ytd_avg: 85, bucket: "A" },
    bbb: { name: "US BBB", spread: 128, prior: 131, ytd_avg: 138, bucket: "BBB" },
    hy: { name: "US HY", spread: 328, prior: 335, ytd_avg: 355, bucket: "HY" },
    bb: { name: "US BB", spread: 195, prior: 200, ytd_avg: 215, bucket: "BB" },
    b: { name: "US B", spread: 345, prior: 352, ytd_avg: 375, bucket: "B" },
    ccc: { name: "US CCC", spread: 825, prior: 840, ytd_avg: 890, bucket: "CCC" },
  },
  eu: {
    ig: { name: "EUR IG", spread: 108, prior: 111, ytd_avg: 115, bucket: "IG" },
    hy: { name: "EUR HY", spread: 348, prior: 355, ytd_avg: 372, bucket: "HY" },
  },
  history: [
    { date: "2026-01", ig: 115, hy: 375, aaa: 52, bbb: 148 },
    { date: "2026-02", ig: 108, hy: 358, aaa: 47, bbb: 140 },
    { date: "2026-03", ig: 98, hy: 328, aaa: 42, bbb: 128 },
  ]
};

const SAMPLE_NEWS = [
  { id: 1, title: "Apollo Global raises $8.2B for new private credit fund targeting insurance mandates", source: "Reuters", date: "2026-03-20T14:30:00Z", topic: "Private Credit", url: "#", summary: "Fund will focus on investment-grade private placements and asset-backed finance for insurance balance sheets." },
  { id: 2, title: "US IG corporate spreads tighten to post-pandemic lows amid strong demand", source: "Bloomberg", date: "2026-03-20T12:15:00Z", topic: "Credit Markets", url: "#", summary: "Investment grade OAS compressed below 100bp as insurance and pension demand outpaces supply." },
  { id: 3, title: "BOE holds rates steady at 4.25%; signals gradual easing path for H2 2026", source: "Financial Times", date: "2026-03-20T10:00:00Z", topic: "Rates & Macro", url: "#", summary: "MPC voted 7-2 to hold. Forward guidance suggests 50bp of cuts possible by year-end." },
  { id: 4, title: "Bermuda reinsurer completes $1.5B structured credit portfolio acquisition", source: "Insurance Insider", date: "2026-03-19T16:45:00Z", topic: "Structured Credit", url: "#", summary: "CLO and ABS portfolio transfer from European bank to Bermuda Class E insurer." },
  { id: 5, title: "NAIC proposes enhanced reporting for insurer private credit allocations", source: "AM Best", date: "2026-03-19T14:20:00Z", topic: "Insurance AM", url: "#", summary: "New disclosure requirements would increase transparency on illiquid asset holdings." },
  { id: 6, title: "Japanese lifers accelerate USD credit allocation amid yen weakness", source: "Nikkei Asia", date: "2026-03-19T09:30:00Z", topic: "Insurance AM", url: "#", summary: "Major Japanese life insurers plan to increase unhedged USD credit exposures in FY2026." },
  { id: 7, title: "ECB publishes updated Solvency II matching adjustment rules", source: "Risk.net", date: "2026-03-18T15:00:00Z", topic: "Rates & Macro", url: "#", summary: "Revised rules expand eligible asset classes for matching adjustment portfolios." },
  { id: 8, title: "Private debt AUM projected to reach $3.5T by 2028 driven by insurer demand", source: "Preqin", date: "2026-03-18T11:00:00Z", topic: "Private Credit", url: "#", summary: "Insurance companies now represent 35% of private credit LP commitments globally." },
  { id: 9, title: "US CLO new issuance hits record $45B in Q1 2026", source: "S&P LCD", date: "2026-03-17T16:00:00Z", topic: "Structured Credit", url: "#", summary: "Strong demand from insurance portfolios and Asian investors driving record CLO volumes." },
  { id: 10, title: "Pension risk transfer market expected to exceed $60B in 2026", source: "P&I", date: "2026-03-17T10:30:00Z", topic: "Pension/Insurance", url: "#", summary: "UK and US PRT pipelines remain robust with several mega-deals in negotiation." },
];

const SAMPLE_BMA = [
  { id: 1, title: "Notice – Pre-Approval Process for New Bermuda Insurance Registrations", date: "2026-03-19", category: "Licensing", url: "https://www.bma.bm", summary: "Updated pre-approval requirements for new Class D and Class E registrations.", isNew: true },
  { id: 2, title: "Notice – Regulatory Burden Reduction for Better Supervision", date: "2026-02-19", category: "Governance", url: "https://www.bma.bm", summary: "BMA initiative to streamline reporting and reduce regulatory burden on commercial insurers.", isNew: true },
  { id: 3, title: "Notice – 2025 Year-End BSCR Model Republication", date: "2026-02-18", category: "Capital/Solvency", url: "https://www.bma.bm", summary: "Republished BSCR models for Class D and E with optional data validation feature.", isNew: true },
  { id: 4, title: "Consultation Paper – Prudent Person Principle Instructions & Guidance", date: "2025-12-15", category: "Investment", url: "https://www.bma.bm", summary: "Proposed guidance on PPP application for commercial insurers with NPTA allocations.", isNew: false },
  { id: 5, title: "Insurance (Prudential Standards) (Class C, D, E Solvency) Amendment Rules 2025", date: "2025-12-01", category: "Capital/Solvency", url: "https://www.bma.bm", summary: "New paragraphs 7A and 7B on Asset and Liability Statement disclosure requirements. Effective Jan 1, 2026.", isNew: false },
  { id: 6, title: "Proposed Enhancements to Public Disclosure Regime", date: "2025-12-01", category: "Disclosure", url: "https://www.bma.bm", summary: "Enhanced public disclosure requirements on investments for long-term commercial insurers.", isNew: false },
  { id: 7, title: "Discussion Paper – AI Governance Framework for Financial Services", date: "2026-02-09", category: "Governance", url: "https://www.bma.bm", summary: "Outcomes-based risk management framework for AI governance. Final proposal expected Q3 2026.", isNew: true },
  { id: 8, title: "2025 GFC Stress Test Instructions – Class C, D and E", date: "2025-05-30", category: "Stress Testing", url: "https://www.bma.bm", summary: "Specific GFC stress test scenarios for long-term commercial insurers.", isNew: false },
];

// ─── UTILITY FUNCTIONS ───

const formatBp = (v) => v >= 0 ? `+${v.toFixed(0)}bp` : `${v.toFixed(0)}bp`;
const formatYield = (v) => v?.toFixed(2) + "%";
const formatSpread = (v) => v + "bp";
const changeBp = (curr, prior) => ((curr - prior) * 100).toFixed(1);
const changeSpreadBp = (curr, prior) => curr - prior;

const getChangeColor = (val) => {
  if (val > 0) return "#ef4444";
  if (val < 0) return "#22c55e";
  return "#94a3b8";
};

const getChangeIcon = (val) => {
  if (val > 0) return ArrowUpRight;
  if (val < 0) return ArrowDownRight;
  return Minus;
};

const timeAgo = (dateStr) => {
  const now = new Date("2026-03-23T12:00:00Z");
  const d = new Date(dateStr);
  const hours = Math.floor((now - d) / 3600000);
  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

// ─── CUSTOM TOOLTIP ───
const CurveTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#1a1d23", border: "1px solid #2a2d35", borderRadius: 6, padding: "10px 14px", fontSize: 12 }}>
      <div style={{ color: "#94a3b8", marginBottom: 4, fontWeight: 600 }}>{label}</div>
      {payload.map((p, i) => (
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

// ─── COMPONENTS ───

const Badge = ({ children, color = "#3b82f6" }) => (
  <span style={{
    fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em",
    padding: "2px 8px", borderRadius: 4, background: color + "18", color: color, whiteSpace: "nowrap"
  }}>{children}</span>
);

const DataFreshness = ({ date, source, url }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#64748b", flexWrap: "wrap" }}>
    <Clock size={12} />
    <span>As of {date}</span>
    <span style={{ color: "#334155" }}>|</span>
    <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "#3b82f6", textDecoration: "none", display: "flex", alignItems: "center", gap: 3 }}>
      {source} <ExternalLink size={10} />
    </a>
  </div>
);

const MetricCard = ({ label, value, change, unit = "", small = false }) => {
  const numChange = parseFloat(change);
  const Icon = getChangeIcon(numChange);
  const color = getChangeColor(numChange);
  return (
    <div style={{
      background: "#12141a", border: "1px solid #1e2028", borderRadius: 8,
      padding: small ? "12px 16px" : "16px 20px", minWidth: small ? 120 : 160
    }}>
      <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: small ? 18 : 24, fontWeight: 700, color: "#e2e8f0", fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>
          {value}{unit}
        </span>
        {change !== undefined && (
          <span style={{ fontSize: 12, color, display: "flex", alignItems: "center", gap: 2, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>
            <Icon size={14} /> {Math.abs(numChange).toFixed(1)}{unit === "%" ? "bp" : unit === "bp" ? "bp" : ""}
          </span>
        )}
      </div>
    </div>
  );
};

const SovereignYieldSection = ({ data, title, accentColor }) => {
  const curveData = data.tenors.map((t, i) => ({
    tenor: t,
    current: data.yields[i],
    prior: data.prior_yields[i],
    change: ((data.yields[i] - data.prior_yields[i]) * 100).toFixed(1),
  }));
  const [showTable, setShowTable] = useState(false);
  return (
    <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "16px 20px", borderBottom: "1px solid #1e2028", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>{title}</h3>
          <DataFreshness date={data.date} source={data.source} url={data.url} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setShowTable(!showTable)} style={{
            background: showTable ? "#1e2028" : "transparent", border: "1px solid #2a2d35", borderRadius: 6,
            padding: "6px 12px", fontSize: 11, color: "#94a3b8", cursor: "pointer", display: "flex", alignItems: "center", gap: 4
          }}>
            <Database size={12} /> {showTable ? "Chart" : "Table"}
          </button>
        </div>
      </div>
      {showTable ? (
        <div style={{ padding: "12px 20px", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #1e2028" }}>
                <th style={{ textAlign: "left", padding: "8px 12px", color: "#64748b", fontWeight: 600, fontSize: 11 }}>Tenor</th>
                <th style={{ textAlign: "right", padding: "8px 12px", color: "#64748b", fontWeight: 600, fontSize: 11 }}>Yield</th>
                <th style={{ textAlign: "right", padding: "8px 12px", color: "#64748b", fontWeight: 600, fontSize: 11 }}>Prior</th>
                <th style={{ textAlign: "right", padding: "8px 12px", color: "#64748b", fontWeight: 600, fontSize: 11 }}>Chg (bp)</th>
              </tr>
            </thead>
            <tbody>
              {curveData.map((row, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #13151b" }}>
                  <td style={{ padding: "8px 12px", color: "#e2e8f0", fontWeight: 600, fontFamily: "monospace" }}>{row.tenor}</td>
                  <td style={{ padding: "8px 12px", color: "#e2e8f0", textAlign: "right", fontFamily: "monospace" }}>{formatYield(row.current)}</td>
                  <td style={{ padding: "8px 12px", color: "#94a3b8", textAlign: "right", fontFamily: "monospace" }}>{formatYield(row.prior)}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", color: getChangeColor(parseFloat(row.change)), fontWeight: 600 }}>
                    {parseFloat(row.change) > 0 ? "+" : ""}{row.change}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ padding: "16px 12px 8px" }}>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={curveData}>
              <defs>
                <linearGradient id={`grad-${accentColor.slice(1)}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={accentColor} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={accentColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1d23" />
              <XAxis dataKey="tenor" tick={{ fill: "#64748b", fontSize: 11 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} />
              <YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} domain={["auto", "auto"]} tickFormatter={(v) => v.toFixed(1)} />
              <Tooltip content={<CurveTooltip />} />
              <Area type="monotone" dataKey="current" stroke={accentColor} strokeWidth={2.5} fill={`url(#grad-${accentColor.slice(1)})`} name="Current" dot={{ r: 3, fill: accentColor }} />
              <Line type="monotone" dataKey="prior" stroke="#475569" strokeWidth={1.5} strokeDasharray="5 5" name="Prior" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
      {/* Quick stats row */}
      <div style={{ padding: "10px 20px 14px", display: "flex", gap: 16, flexWrap: "wrap" }}>
        {[
          { label: "2Y", idx: data.tenors.indexOf("2Y") >= 0 ? data.tenors.indexOf("2Y") : 4 },
          { label: "10Y", idx: data.tenors.indexOf("10Y") >= 0 ? data.tenors.indexOf("10Y") : data.tenors.length - 3 },
          { label: "30Y", idx: data.tenors.indexOf("30Y") >= 0 ? data.tenors.indexOf("30Y") : data.tenors.length - 1 },
        ].filter(s => s.idx >= 0 && s.idx < data.yields.length).map(s => {
          const chg = ((data.yields[s.idx] - data.prior_yields[s.idx]) * 100).toFixed(1);
          const color = getChangeColor(parseFloat(chg));
          return (
            <div key={s.label} style={{ fontSize: 11, color: "#94a3b8" }}>
              <span style={{ fontWeight: 700, color: "#e2e8f0", fontFamily: "monospace" }}>{s.label}:</span>{" "}
              <span style={{ fontFamily: "monospace", color: "#e2e8f0" }}>{formatYield(data.yields[s.idx])}</span>{" "}
              <span style={{ color, fontWeight: 600, fontFamily: "monospace" }}>({parseFloat(chg) > 0 ? "+" : ""}{chg}bp)</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const CreditSpreadSection = ({ data }) => {
  const usEntries = Object.values(data.us);
  const euEntries = Object.values(data.eu);
  const [marketFilter, setMarketFilter] = useState("us");
  const entries = marketFilter === "us" ? usEntries : euEntries;

  return (
    <div style={{ background: "#0d0f14", border: "1px solid #1e2028

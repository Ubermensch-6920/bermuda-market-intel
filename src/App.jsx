import { useState, useEffect, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, AreaChart, Area, Legend
} from "recharts";
import {
  Globe, Shield, Newspaper, BarChart3, ChevronRight, ExternalLink,
  Clock, RefreshCw, Activity, DollarSign, Percent, ArrowUpRight,
  ArrowDownRight, Minus, AlertTriangle, Loader, Landmark, TrendingUp
} from "lucide-react";

/* ═══════════════════════════════════════════════════════════════════
   BERMUDA MARKET INTELLIGENCE TERMINAL v8
   Reads data/*.json from GitHub Actions pipeline.
   v8: improved legibility, year-ago yields, BMA discount rates tab
   ═══════════════════════════════════════════════════════════════════ */

const DATA_BASE = import.meta.env.BASE_URL + "data/";
async function loadJson(f) { const r = await fetch(`${DATA_BASE}${f}?t=${Date.now()}`); if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.json(); }

// ── Utilities ──
const fmtY = v => v != null ? v.toFixed(2) + "%" : "—";
const chgBp = (c, p) => c != null && p != null ? ((c - p) * 100).toFixed(1) : null;
const chgCol = v => v > 0 ? "#f87171" : v < 0 ? "#4ade80" : "#94a3b8";
const ChgIcon = ({ v }) => { const n = parseFloat(v); return n > 0 ? <ArrowUpRight size={14} /> : n < 0 ? <ArrowDownRight size={14} /> : <Minus size={14} />; };
const timeAgo = ds => { const h = Math.floor((Date.now() - new Date(ds)) / 36e5); if (h < 1) return "Now"; if (h < 24) return h + "h ago"; const d = Math.floor(h / 24); return d < 7 ? d + "d" : new Date(ds).toLocaleDateString("en-US", { month: "short", day: "numeric" }); };

// ── Shared Components (legibility improved: larger text, more padding, brighter) ──

const Badge = ({ children, color = "#60a5fa" }) => (
  <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em",
    padding: "3px 9px", borderRadius: 4, background: color + "20", color, whiteSpace: "nowrap" }}>{children}</span>
);

const DataFresh = ({ date, source, url }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#94a3b8", flexWrap: "wrap", marginTop: 5 }}>
    <Clock size={13} /><span>As of {date || "—"}</span>
    {source && <><span style={{ color: "#475569" }}>|</span>
      <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "#60a5fa", textDecoration: "none", display: "flex", alignItems: "center", gap: 3 }}>{source} <ExternalLink size={11} /></a></>}
  </div>
);

const CTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (<div style={{ background: "#1e2028", border: "1px solid #334155", borderRadius: 8, padding: "12px 16px", fontSize: 13 }}>
    <div style={{ color: "#cbd5e1", marginBottom: 6, fontWeight: 700 }}>{label}</div>
    {payload.filter(p => p.value != null).map((p, i) => (
      <div key={i} style={{ color: p.color, display: "flex", gap: 10, alignItems: "center", marginBottom: 3 }}>
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: p.color, display: "inline-block" }} />
        <span style={{ fontWeight: 500 }}>{p.name}: {p.value?.toFixed(2)}%</span>
      </div>
    ))}
  </div>);
};

const MetricCard = ({ label, value, change, loading: ld }) => {
  const n = parseFloat(change);
  return (<div style={{ background: "#12141a", border: "1px solid #1e2028", borderRadius: 10, padding: "16px 20px", minWidth: 170 }}>
    <div style={{ fontSize: 12, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8, fontWeight: 600 }}>{label}</div>
    {ld ? <Loader size={18} style={{ color: "#60a5fa", animation: "spin 1s linear infinite" }} /> :
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: 24, fontWeight: 700, color: "#f1f5f9", fontFamily: "'JetBrains Mono', monospace" }}>{value}</span>
        {change != null && !isNaN(n) && <span style={{ fontSize: 13, color: chgCol(n), display: "flex", alignItems: "center", gap: 3, fontWeight: 600, fontFamily: "monospace" }}><ChgIcon v={change} />{Math.abs(n).toFixed(1)}bp</span>}
      </div>}
  </div>);
};

// ═══════════════════════════════════════════
// SOVEREIGN YIELD SECTION (chart + table + year-ago row)
// ═══════════════════════════════════════════

const SovSection = ({ data, title, accentColor, loading: ld, error }) => {
  if (ld) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 40, textAlign: "center", color: "#94a3b8" }}><Loader size={24} style={{ animation: "spin 1s linear infinite", margin: "0 auto 12px", display: "block", color: "#60a5fa" }} />Loading {title}…</div>;
  if (error) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 20 }}><h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700, color: "#f1f5f9" }}>{title}</h3><div style={{ color: "#f87171", fontSize: 13 }}><AlertTriangle size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />{error}</div></div>;
  if (!data) return null;

  const hasYearAgo = data.year_ago_yields?.some(v => v != null);
  const hasPrior = data.prior_yields?.some(v => v != null);

  const curveData = data.tenors.map((t, i) => ({
    tenor: t, current: data.yields[i], prior: data.prior_yields?.[i],
    yearAgo: data.year_ago_yields?.[i],
    change: data.yields[i] != null && data.prior_yields?.[i] != null ? ((data.yields[i] - data.prior_yields[i]) * 100).toFixed(1) : null,
    yaChange: data.yields[i] != null && data.year_ago_yields?.[i] != null ? ((data.yields[i] - data.year_ago_yields[i]) * 100).toFixed(1) : null,
  }));

  return (<div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
    <div style={{ padding: "16px 22px", borderBottom: "1px solid #1e2028" }}>
      <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#f1f5f9" }}>{title}</h3>
      <DataFresh date={data.date} source={data.source} url={data.url} />
      {data.note && <div style={{ fontSize: 11, color: "#f59e0b", marginTop: 5 }}>{data.note}</div>}
    </div>

    {/* Chart */}
    <div style={{ padding: "14px 14px 6px" }}>
      <ResponsiveContainer width="100%" height={230}>
        <AreaChart data={curveData}>
          <defs><linearGradient id={`g${accentColor.slice(1)}`} x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={accentColor} stopOpacity={0.3} /><stop offset="95%" stopColor={accentColor} stopOpacity={0} /></linearGradient></defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e2028" />
          <XAxis dataKey="tenor" tick={{ fill: "#94a3b8", fontSize: 12, fontWeight: 500 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} />
          <YAxis tick={{ fill: "#94a3b8", fontSize: 12 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} domain={["auto", "auto"]} tickFormatter={v => v?.toFixed(1)} />
          <Tooltip content={<CTooltip />} />
          <Area type="monotone" dataKey="current" stroke={accentColor} strokeWidth={2.5} fill={`url(#g${accentColor.slice(1)})`} name="Current" dot={{ r: 4, fill: accentColor }} connectNulls />
          {hasPrior && <Line type="monotone" dataKey="prior" stroke="#64748b" strokeWidth={1.5} strokeDasharray="5 5" name="Prior Day" dot={false} connectNulls />}
          {hasYearAgo && <Line type="monotone" dataKey="yearAgo" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="3 6" name="1 Year Ago" dot={false} connectNulls />}
        </AreaChart>
      </ResponsiveContainer>
    </div>

    {/* Table with year-ago row */}
    <div style={{ padding: "0 22px 16px", overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #1e2028" }}>
            <th style={{ textAlign: "left", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12, letterSpacing: "0.03em" }}>Tenor</th>
            <th style={{ textAlign: "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Yield</th>
            {hasPrior && <th style={{ textAlign: "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Prior</th>}
            {hasPrior && <th style={{ textAlign: "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Chg (bp)</th>}
            {hasYearAgo && <th style={{ textAlign: "right", padding: "8px 12px", color: "#f59e0b", fontWeight: 700, fontSize: 12 }}>1Y Ago{data.year_ago_date ? ` (${data.year_ago_date})` : ""}</th>}
            {hasYearAgo && <th style={{ textAlign: "right", padding: "8px 12px", color: "#f59e0b", fontWeight: 700, fontSize: 12 }}>YoY (bp)</th>}
          </tr>
        </thead>
        <tbody>
          {curveData.map((r, i) => {
            const ch = parseFloat(r.change);
            const ya = parseFloat(r.yaChange);
            return (<tr key={i} style={{ borderBottom: "1px solid #151820" }}>
              <td style={{ padding: "7px 12px", color: "#f1f5f9", fontWeight: 700, fontFamily: "monospace", fontSize: 13 }}>{r.tenor}</td>
              <td style={{ padding: "7px 12px", color: "#f1f5f9", textAlign: "right", fontFamily: "monospace", fontWeight: 600, fontSize: 14 }}>{fmtY(r.current)}</td>
              {hasPrior && <td style={{ padding: "7px 12px", color: "#94a3b8", textAlign: "right", fontFamily: "monospace" }}>{fmtY(r.prior)}</td>}
              {hasPrior && <td style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: chgCol(ch), fontWeight: 600 }}>{r.change != null ? (ch > 0 ? "+" : "") + r.change : "—"}</td>}
              {hasYearAgo && <td style={{ padding: "7px 12px", color: "#d4a057", textAlign: "right", fontFamily: "monospace" }}>{fmtY(r.yearAgo)}</td>}
              {hasYearAgo && <td style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: chgCol(ya), fontWeight: 600 }}>{r.yaChange != null ? (ya > 0 ? "+" : "") + r.yaChange : "—"}</td>}
            </tr>);
          })}
        </tbody>
      </table>
    </div>
  </div>);
};

// ═══════════════════════════════════════════
// CREDIT SPREAD SECTION
// ═══════════════════════════════════════════
const CreditSection = ({ data, loading: ld, error }) => {
  if (ld) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 40, textAlign: "center", color: "#94a3b8" }}><Loader size={24} style={{ animation: "spin 1s linear infinite", margin: "0 auto 10px", display: "block", color: "#60a5fa" }} />Loading…</div>;
  if (error) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 20 }}><h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700, color: "#f1f5f9" }}>Credit Spreads</h3><div style={{ color: "#f87171", fontSize: 13 }}><AlertTriangle size={14} style={{ verticalAlign: "middle", marginRight: 6 }} />{error}</div></div>;
  if (!data) return null;
  const entries = Object.values(data.spreads || {}).filter(e => e.spread != null);
  return (<div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
    <div style={{ padding: "16px 22px", borderBottom: "1px solid #1e2028" }}>
      <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#f1f5f9" }}>US Corporate Credit Spreads (OAS)</h3>
      <DataFresh date={data.date} source={data.source} url={data.url} />
    </div>
    <div style={{ padding: "10px 22px 16px", overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead><tr style={{ borderBottom: "2px solid #1e2028" }}>{["Index", "OAS (bp)", "Prior", "Chg"].map(h => <th key={h} style={{ textAlign: h === "Index" ? "left" : "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>{h}</th>)}</tr></thead>
        <tbody>{entries.map((r, i) => { const c = (r.spread || 0) - (r.prior || 0); return (<tr key={i} style={{ borderBottom: "1px solid #151820" }}>
          <td style={{ padding: "7px 12px", color: "#f1f5f9", fontWeight: 600, fontSize: 13 }}>{r.name} <Badge color={["HY", "BB", "B", "CCC"].includes(r.bucket) ? "#f87171" : "#4ade80"}>{r.bucket}</Badge></td>
          <td style={{ padding: "7px 12px", color: "#f1f5f9", textAlign: "right", fontFamily: "monospace", fontWeight: 700, fontSize: 14 }}>{r.spread}</td>
          <td style={{ padding: "7px 12px", color: "#94a3b8", textAlign: "right", fontFamily: "monospace" }}>{r.prior || "—"}</td>
          <td style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: chgCol(c * -1), fontWeight: 600 }}>{r.prior ? (c > 0 ? "+" : "") + c : "—"}</td>
        </tr>); })}</tbody>
      </table>
    </div>
  </div>);
};

// ═══════════════════════════════════════════
// BMA DISCOUNT RATES SECTION (new)
// ═══════════════════════════════════════════
const BmaRatesSection = ({ data, loading: ld, error }) => {
  const [selectedCcy, setSelectedCcy] = useState("USD");

  if (ld) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 40, textAlign: "center", color: "#94a3b8" }}><Loader size={24} style={{ animation: "spin 1s linear infinite", margin: "0 auto 10px", display: "block", color: "#60a5fa" }} />Loading BMA rates…</div>;
  if (error) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 20 }}><h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700, color: "#f1f5f9" }}>BMA EBS Discount Rates</h3><div style={{ color: "#f87171", fontSize: 13 }}><AlertTriangle size={14} style={{ verticalAlign: "middle", marginRight: 6 }} />{error}</div></div>;
  if (!data) return null;

  const ccys = Object.keys(data.currencies || {});
  const ccyData = data.currencies?.[selectedCcy];
  const tenors = data.tenors || [];
  const hasRates = ccyData?.rates?.some(v => v != null);

  return (<div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
    <div style={{ padding: "16px 22px", borderBottom: "1px solid #1e2028" }}>
      <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#f1f5f9" }}>
        <Landmark size={18} style={{ verticalAlign: "middle", marginRight: 8 }} />
        BMA EBS Discount Rates (Quarterly)
      </h3>
      <DataFresh date={data.as_of_date} source={data.source} url={data.url} />
      {data.note && <div style={{ fontSize: 11, color: "#f59e0b", marginTop: 5, lineHeight: 1.5 }}>{data.note}</div>}
      {data.pdf_url && <div style={{ marginTop: 5 }}><a href={data.pdf_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "#60a5fa", textDecoration: "none" }}>Download latest PDF <ExternalLink size={11} style={{ verticalAlign: "middle" }} /></a></div>}
    </div>

    {/* Currency selector */}
    <div style={{ padding: "12px 22px", display: "flex", gap: 6, flexWrap: "wrap", borderBottom: "1px solid #1e2028" }}>
      {ccys.map(ccy => (
        <button key={ccy} onClick={() => setSelectedCcy(ccy)} style={{
          background: selectedCcy === ccy ? "#3b82f6" : "transparent",
          border: `1px solid ${selectedCcy === ccy ? "#3b82f6" : "#2a2d35"}`,
          borderRadius: 6, padding: "6px 16px", fontSize: 13, fontWeight: 700,
          color: selectedCcy === ccy ? "#fff" : "#94a3b8", cursor: "pointer",
          letterSpacing: "0.03em"
        }}>{ccy}</button>
      ))}
    </div>

    {/* Rates table */}
    <div style={{ padding: "10px 22px 16px", overflowX: "auto" }}>
      {!hasRates ? (
        <div style={{ padding: "30px 0", textAlign: "center", color: "#64748b", fontSize: 13, lineHeight: 1.6 }}>
          <AlertTriangle size={20} style={{ display: "block", margin: "0 auto 10px", color: "#f59e0b" }} />
          No rates data yet for {selectedCcy}.<br />
          Download the latest BMA discount rate PDF and populate <code style={{ color: "#f1f5f9" }}>data/bma_rates_manual.json</code>
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #1e2028" }}>
              <th style={{ textAlign: "left", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Tenor</th>
              <th style={{ textAlign: "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Spot Rate</th>
              {ccyData?.prior_rates?.some(v => v != null) && <th style={{ textAlign: "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Prior Quarter</th>}
              {ccyData?.prior_rates?.some(v => v != null) && <th style={{ textAlign: "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Chg (bp)</th>}
            </tr>
          </thead>
          <tbody>
            {tenors.map((t, i) => {
              const curr = ccyData?.rates?.[i];
              const prev = ccyData?.prior_rates?.[i];
              const ch = curr != null && prev != null ? ((curr - prev) * 100).toFixed(1) : null;
              const chNum = parseFloat(ch);
              return (<tr key={i} style={{ borderBottom: "1px solid #151820" }}>
                <td style={{ padding: "7px 12px", color: "#f1f5f9", fontWeight: 700, fontFamily: "monospace" }}>{t}</td>
                <td style={{ padding: "7px 12px", color: "#f1f5f9", textAlign: "right", fontFamily: "monospace", fontWeight: 600, fontSize: 14 }}>{curr != null ? curr.toFixed(4) + "%" : "—"}</td>
                {ccyData?.prior_rates?.some(v => v != null) && <td style={{ padding: "7px 12px", color: "#94a3b8", textAlign: "right", fontFamily: "monospace" }}>{prev != null ? prev.toFixed(4) + "%" : "—"}</td>}
                {ccyData?.prior_rates?.some(v => v != null) && <td style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: chgCol(chNum), fontWeight: 600 }}>{ch != null ? (chNum > 0 ? "+" : "") + ch : "—"}</td>}
              </tr>);
            })}
          </tbody>
        </table>
      )}
    </div>
  </div>);
};

// ═══════════════════════════════════════════
// SOFR SECTION
// ═══════════════════════════════════════════
const SofrSection = ({ data, loading: ld, error }) => {
  if (ld) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 40, textAlign: "center", color: "#94a3b8" }}><Loader size={24} style={{ animation: "spin 1s linear infinite", margin: "0 auto 12px", display: "block", color: "#60a5fa" }} />Loading SOFR…</div>;
  if (error) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 20 }}><h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700, color: "#f1f5f9" }}>SOFR</h3><div style={{ color: "#f87171", fontSize: 13 }}><AlertTriangle size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />{error}</div></div>;
  if (!data) return null;

  const rates = data.rates || {};
  const history = data.history || [];
  const ya = data.year_ago || {};

  return (<div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
    <div style={{ padding: "16px 22px", borderBottom: "1px solid #1e2028" }}>
      <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#f1f5f9" }}>
        <TrendingUp size={18} style={{ verticalAlign: "middle", marginRight: 8 }} />
        SOFR — Secured Overnight Financing Rate
      </h3>
      <DataFresh date={data.date} source={data.source} url={data.url} />
      {data.note && <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 5 }}>{data.note}</div>}
    </div>

    {/* Rate cards */}
    <div style={{ padding: "16px 22px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
      {Object.entries(rates).map(([key, r]) => {
        const chg = r.rate != null && r.prior != null ? ((r.rate - r.prior) * 100).toFixed(1) : null;
        const chgNum = parseFloat(chg);
        return (<div key={key} style={{ background: "#12141a", border: "1px solid #1e2028", borderRadius: 10, padding: "16px 20px" }}>
          <div style={{ fontSize: 12, color: "#94a3b8", fontWeight: 600, marginBottom: 4 }}>{r.name}</div>
          <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8 }}>{r.desc}</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontSize: 26, fontWeight: 700, color: "#f1f5f9", fontFamily: "'JetBrains Mono', monospace" }}>
              {r.rate != null ? r.rate.toFixed(2) + "%" : "—"}
            </span>
            {chg != null && !isNaN(chgNum) && (
              <span style={{ fontSize: 13, color: chgCol(chgNum), display: "flex", alignItems: "center", gap: 3, fontWeight: 600, fontFamily: "monospace" }}>
                <ChgIcon v={chg} />{Math.abs(chgNum).toFixed(1)}bp
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>Prior: {r.prior != null ? r.prior.toFixed(2) + "%" : "—"}</div>
        </div>);
      })}

      {/* Year-ago card */}
      {ya.rate != null && (<div style={{ background: "#12141a", border: "1px solid #1e2028", borderRadius: 10, padding: "16px 20px" }}>
        <div style={{ fontSize: 12, color: "#f59e0b", fontWeight: 600, marginBottom: 4 }}>1 Year Ago</div>
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8 }}>{ya.date || ""}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontSize: 26, fontWeight: 700, color: "#d4a057", fontFamily: "'JetBrains Mono', monospace" }}>
            {ya.rate.toFixed(2)}%
          </span>
          {rates.SOFR?.rate != null && (() => {
            const yoyChg = ((rates.SOFR.rate - ya.rate) * 100).toFixed(1);
            const yoyNum = parseFloat(yoyChg);
            return <span style={{ fontSize: 13, color: chgCol(yoyNum), fontWeight: 600, fontFamily: "monospace" }}>
              {yoyNum > 0 ? "+" : ""}{yoyChg}bp YoY
            </span>;
          })()}
        </div>
      </div>)}
    </div>

    {/* Daily SOFR history chart */}
    {history.length > 5 && (<div style={{ padding: "8px 14px 16px" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#94a3b8", marginBottom: 8, marginLeft: 8 }}>DAILY SOFR — LAST 30 BUSINESS DAYS</div>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={history}>
          <defs><linearGradient id="gSofr" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#60a5fa" stopOpacity={0.3} /><stop offset="95%" stopColor="#60a5fa" stopOpacity={0} /></linearGradient></defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e2028" />
          <XAxis dataKey="date" tick={{ fill: "#94a3b8", fontSize: 10 }} axisLine={{ stroke: "#1e2028" }} tickLine={false}
            tickFormatter={d => { const p = d.split("-"); return p[1] + "/" + p[2]; }} />
          <YAxis tick={{ fill: "#94a3b8", fontSize: 12 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} domain={["auto", "auto"]}
            tickFormatter={v => v.toFixed(2) + "%"} />
          <Tooltip content={<CTooltip />} />
          <Area type="monotone" dataKey="rate" stroke="#60a5fa" strokeWidth={2} fill="url(#gSofr)" name="SOFR" dot={false} />
          {ya.rate != null && <Line type="monotone" dataKey={() => ya.rate} stroke="#f59e0b" strokeWidth={1} strokeDasharray="6 4" name="1Y Ago" dot={false} />}
        </AreaChart>
      </ResponsiveContainer>
    </div>)}

    {/* Summary table */}
    <div style={{ padding: "0 22px 16px", overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #1e2028" }}>
            <th style={{ textAlign: "left", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Metric</th>
            <th style={{ textAlign: "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Rate</th>
            <th style={{ textAlign: "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Prior</th>
            <th style={{ textAlign: "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Chg (bp)</th>
            <th style={{ textAlign: "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Date</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(rates).map(([key, r]) => {
            const ch = r.rate != null && r.prior != null ? ((r.rate - r.prior) * 100).toFixed(1) : null;
            const chNum = parseFloat(ch);
            return (<tr key={key} style={{ borderBottom: "1px solid #151820" }}>
              <td style={{ padding: "7px 12px", color: "#f1f5f9", fontWeight: 600 }}>{r.name}</td>
              <td style={{ padding: "7px 12px", color: "#f1f5f9", textAlign: "right", fontFamily: "monospace", fontWeight: 700, fontSize: 14 }}>{r.rate != null ? r.rate.toFixed(4) + "%" : "—"}</td>
              <td style={{ padding: "7px 12px", color: "#94a3b8", textAlign: "right", fontFamily: "monospace" }}>{r.prior != null ? r.prior.toFixed(4) + "%" : "—"}</td>
              <td style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: chgCol(chNum), fontWeight: 600 }}>{ch != null ? (chNum > 0 ? "+" : "") + ch : "—"}</td>
              <td style={{ padding: "7px 12px", color: "#64748b", textAlign: "right", fontSize: 12 }}>{r.date || "—"}</td>
            </tr>);
          })}
          {ya.rate != null && (<tr style={{ borderBottom: "1px solid #151820", background: "#111318" }}>
            <td style={{ padding: "7px 12px", color: "#f59e0b", fontWeight: 600 }}>1 Year Ago</td>
            <td style={{ padding: "7px 12px", color: "#d4a057", textAlign: "right", fontFamily: "monospace", fontWeight: 700, fontSize: 14 }}>{ya.rate.toFixed(4)}%</td>
            <td colSpan={2} style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: chgCol(parseFloat(((rates.SOFR?.rate - ya.rate) * 100).toFixed(1))), fontWeight: 600 }}>
              {rates.SOFR?.rate != null ? (((rates.SOFR.rate - ya.rate) * 100) > 0 ? "+" : "") + ((rates.SOFR.rate - ya.rate) * 100).toFixed(1) + "bp YoY" : "—"}
            </td>
            <td style={{ padding: "7px 12px", color: "#64748b", textAlign: "right", fontSize: 12 }}>{ya.date}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </div>);
};

// ═══════════════════════════════════════════
// NEWS & BMA UPDATES (curated)
// ═══════════════════════════════════════════
const NEWS = [
  { id: 1, title: "UK gilt 10Y hits 5% for first time since 2008", source: "CNBC", date: "2026-03-20T09:30:00Z", topic: "Rates & Macro", summary: "Energy surge + hawkish BOE." },
  { id: 2, title: "BOJ holds; Takata dissents, calls for 25bp hike", source: "Reuters", date: "2026-03-19T08:00:00Z", topic: "Rates & Macro", summary: "Ueda signals possible rate hike." },
  { id: 3, title: "Apollo raises $8.2B for insurance private credit", source: "Reuters", date: "2026-03-20T14:30:00Z", topic: "Private Credit", summary: "IG private placements for insurance." },
  { id: 4, title: "BOE holds at 3.75%; inflation warning from conflict", source: "FT", date: "2026-03-20T10:00:00Z", topic: "Rates & Macro", summary: "Markets price in rate hikes." },
  { id: 5, title: "Bermuda reinsurer completes $1.5B structured credit deal", source: "Ins. Insider", date: "2026-03-19T16:45:00Z", topic: "Structured Credit", summary: "CLO/ABS to Class E insurer." },
  { id: 6, title: "NAIC proposes enhanced private credit reporting", source: "AM Best", date: "2026-03-19T14:20:00Z", topic: "Insurance AM", summary: "More transparency on illiquid assets." },
];
const BMA_UPDATES = [
  { id: 1, title: "Notice – Pre-Approval for New Insurance Registrations", date: "2026-03-19", cat: "Licensing", summary: "Updated Class D/E requirements.", isNew: true },
  { id: 2, title: "Notice – Regulatory Burden Reduction", date: "2026-02-19", cat: "Governance", summary: "Streamlined reporting.", isNew: true },
  { id: 3, title: "Notice – 2025 Year-End BSCR Model Republication", date: "2026-02-18", cat: "Capital/Solvency", summary: "Republished BSCR with validation.", isNew: true },
  { id: 4, title: "DP – AI Governance Framework", date: "2026-02-09", cat: "Governance", summary: "Final proposal Q3 2026.", isNew: true },
  { id: 5, title: "CP – Prudent Person Principle", date: "2025-12-15", cat: "Investment", summary: "PPP guidance for NPTA.", isNew: false },
  { id: 6, title: "Class C,D,E Solvency Amendment Rules 2025", date: "2025-12-01", cat: "Capital/Solvency", summary: "New A&L disclosure.", isNew: false },
];
const TC = { "Private Credit": "#8b5cf6", "Rates & Macro": "#4ade80", "Structured Credit": "#fbbf24", "Insurance AM": "#f472b6" };
const CC = { "Capital/Solvency": "#f87171", Investment: "#fbbf24", Governance: "#a78bfa", Licensing: "#4ade80" };

const NewsSection = () => { const topics = [...new Set(NEWS.map(n => n.topic))]; const [sel, setSel] = useState("All"); const filtered = sel === "All" ? NEWS : NEWS.filter(n => n.topic === sel); return (<div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}><div style={{ padding: "16px 22px", borderBottom: "1px solid #1e2028" }}><h3 style={{ margin: "0 0 10px", fontSize: 17, fontWeight: 700, color: "#f1f5f9" }}><Newspaper size={18} style={{ verticalAlign: "middle", marginRight: 8 }} /> News</h3><div style={{ fontSize: 12, color: "#fbbf24", marginBottom: 10 }}><AlertTriangle size={13} style={{ verticalAlign: "middle", marginRight: 4 }} />Curated — live RSS via GitHub Actions (Phase 2).</div><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{["All", ...topics].map(t => <button key={t} onClick={() => setSel(t)} style={{ background: sel === t ? (TC[t] || "#3b82f6") : "transparent", border: `1px solid ${sel === t ? (TC[t] || "#3b82f6") : "#334155"}`, borderRadius: 20, padding: "5px 16px", fontSize: 12, color: sel === t ? "#fff" : "#94a3b8", cursor: "pointer", fontWeight: 600 }}>{t}</button>)}</div></div><div style={{ maxHeight: 500, overflowY: "auto" }}>{filtered.map(item => (<div key={item.id} style={{ padding: "14px 22px", borderBottom: "1px solid #151820" }} onMouseEnter={e => e.currentTarget.style.background = "#12141a"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}><div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 5 }}><Badge color={TC[item.topic] || "#60a5fa"}>{item.topic}</Badge><span style={{ fontSize: 12, color: "#64748b" }}>{item.source} • {timeAgo(item.date)}</span></div><h4 style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 600, color: "#f1f5f9", lineHeight: 1.4 }}>{item.title}</h4><p style={{ margin: 0, fontSize: 13, color: "#94a3b8", lineHeight: 1.5 }}>{item.summary}</p></div>))}</div></div>); };
const BMAUpdSection = () => { const cats = [...new Set(BMA_UPDATES.map(u => u.cat))]; const [cf, setCf] = useState("All"); const filtered = cf === "All" ? BMA_UPDATES : BMA_UPDATES.filter(u => u.cat === cf); return (<div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}><div style={{ padding: "16px 22px", borderBottom: "1px solid #1e2028" }}><h3 style={{ margin: "0 0 10px", fontSize: 17, fontWeight: 700, color: "#f1f5f9" }}><Shield size={18} style={{ verticalAlign: "middle", marginRight: 8 }} /> BMA Regulatory Updates</h3><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{["All", ...cats].map(c => <button key={c} onClick={() => setCf(c)} style={{ background: cf === c ? (CC[c] || "#3b82f6") : "transparent", border: `1px solid ${cf === c ? (CC[c] || "#3b82f6") : "#334155"}`, borderRadius: 20, padding: "5px 16px", fontSize: 12, color: cf === c ? "#fff" : "#94a3b8", cursor: "pointer", fontWeight: 500 }}>{c}</button>)}</div></div><div>{filtered.map(item => (<div key={item.id} style={{ padding: "14px 22px", borderBottom: "1px solid #151820" }} onMouseEnter={e => e.currentTarget.style.background = "#12141a"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}><div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 5 }}><Badge color={CC[item.cat] || "#60a5fa"}>{item.cat}</Badge>{item.isNew && <Badge color="#4ade80">NEW</Badge>}<span style={{ fontSize: 12, color: "#64748b" }}>{item.date}</span></div><h4 style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 600, color: "#f1f5f9", lineHeight: 1.4 }}>{item.title}</h4><p style={{ margin: 0, fontSize: 13, color: "#94a3b8", lineHeight: 1.5 }}>{item.summary}</p></div>))}</div></div>); };

// ═══════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════
const PAGES = [
  { id: "home", label: "Overview", icon: Activity }, { id: "ust", label: "US Treasuries", icon: DollarSign },
  { id: "jgb", label: "Japan JGB", icon: Globe }, { id: "gilt", label: "UK Gilts", icon: Globe },
  { id: "eiopa", label: "EIOPA EUR", icon: Globe }, { id: "india", label: "India Govt", icon: Globe },
  { id: "bma_rates", label: "BMA Rates", icon: Landmark },
  { id: "sofr", label: "SOFR", icon: TrendingUp },
  { id: "credit", label: "Credit Spreads", icon: Percent },
  { id: "news", label: "News", icon: Newspaper }, { id: "bma", label: "BMA Updates", icon: Shield },
];
const FILES = { ust: "ust.json", jgb: "jgb.json", gilt: "gilt.json", eiopa: "eur.json", india: "india.json", credit: "credit.json", sofr: "sofr.json", bma_rates: "bma_rates.json" };

export default function App() {
  const [page, setPage] = useState("home");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [clock, setClock] = useState("");
  const [data, setData] = useState({});
  const [ls, setLs] = useState({});
  const [errs, setErrs] = useState({});
  const [gLoad, setGLoad] = useState(false);
  const [lastRef, setLastRef] = useState(null);
  const [manifest, setManifest] = useState(null);

  useEffect(() => { const t = setInterval(() => setClock(new Date().toLocaleTimeString("en-US", { hour12: false })), 1000); setClock(new Date().toLocaleTimeString("en-US", { hour12: false })); return () => clearInterval(t); }, []);

  const loadData = useCallback(async () => {
    setGLoad(true); const newLs = {}, newErrs = {}, newData = {};
    Object.keys(FILES).forEach(k => newLs[k] = true); setLs(newLs); setErrs({});
    try { setManifest(await loadJson("manifest.json")); } catch {}
    await Promise.all(Object.entries(FILES).map(async ([key, file]) => {
      try { newData[key] = await loadJson(file); } catch (e) { newErrs[key] = e.message; }
      finally { setLs(p => ({ ...p, [key]: false })); }
    }));
    setData(prev => ({ ...prev, ...newData })); setErrs(newErrs); setLastRef(new Date()); setGLoad(false);
  }, []);

  useEffect(() => { loadData(); }, []);

  const gv = (key, tenor) => { const d = data[key]; if (!d) return null; const i = d.tenors?.indexOf(tenor); return i >= 0 ? d.yields?.[i] : null; };
  const gp = (key, tenor) => { const d = data[key]; if (!d) return null; const i = d.tenors?.indexOf(tenor); return i >= 0 ? d.prior_yields?.[i] : null; };
  const ust10y = gv("ust", "10Y"), ust10yP = gp("ust", "10Y"), ust2y = gv("ust", "2Y"), ust2yP = gp("ust", "2Y");
  const jgb10y = gv("jgb", "10Y"), jgb10yP = gp("jgb", "10Y"), gilt10y = gv("gilt", "10Y"), gilt10yP = gp("gilt", "10Y");
  const india10y = gv("india", "10Y"), india10yP = gp("india", "10Y");
  const igS = data.credit?.spreads?.ig?.spread, igP = data.credit?.spreads?.ig?.prior;
  const hyS = data.credit?.spreads?.hy?.spread, hyP = data.credit?.spreads?.hy?.prior;
  const sofrRate = data.sofr?.rates?.SOFR?.rate, sofrPrior = data.sofr?.rates?.SOFR?.prior;

  const compT = ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"];
  const mc = compT.map(t => ({ tenor: t, UST: gv("ust", t), JGB: gv("jgb", t), Gilt: gv("gilt", t), EUR: gv("eiopa", t), India: gv("india", t) }));
  const hasCurve = data.ust || data.jgb || data.gilt || data.eiopa || data.india;
  const noData = Object.keys(data).length === 0 && !gLoad;

  const renderPage = () => {
    switch (page) {
      case "ust": return <SovSection data={data.ust} title="US Treasury Par Yield Curve" accentColor="#3b82f6" loading={ls.ust} error={errs.ust} />;
      case "jgb": return <SovSection data={data.jgb} title="Japan Government Bond Yields" accentColor="#ef4444" loading={ls.jgb} error={errs.jgb} />;
      case "gilt": return <SovSection data={data.gilt} title="UK Gilt Nominal Par Yields" accentColor="#22c55e" loading={ls.gilt} error={errs.gilt} />;
      case "eiopa": return <SovSection data={data.eiopa} title="EUR Govt Yield Curve (EIOPA proxy)" accentColor="#f59e0b" loading={ls.eiopa} error={errs.eiopa} />;
      case "india": return <SovSection data={data.india} title="India Government Bond Yields" accentColor="#ec4899" loading={ls.india} error={errs.india} />;
      case "bma_rates": return <BmaRatesSection data={data.bma_rates} loading={ls.bma_rates} error={errs.bma_rates} />;
      case "sofr": return <SofrSection data={data.sofr} loading={ls.sofr} error={errs.sofr} />;
      case "credit": return <CreditSection data={data.credit} loading={ls.credit} error={errs.credit} />;
      case "news": return <NewsSection />; case "bma": return <BMAUpdSection />;
      default: return (<div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {noData && <div style={{ background: "#1a1206", border: "1px solid #854d0e", borderRadius: 10, padding: "18px 22px" }}>
          <div style={{ color: "#fbbf24", fontWeight: 700, fontSize: 15, marginBottom: 6 }}>No data files found</div>
          <div style={{ color: "#cbd5e1", fontSize: 13, lineHeight: 1.6 }}>Run the GitHub Actions workflow: Actions → "Refresh Data and Deploy" → Run workflow.<br />Or locally: <code style={{ color: "#f1f5f9", background: "#1e2028", padding: "2px 6px", borderRadius: 3 }}>python scripts/fetch_all.py</code></div>
        </div>}
        {Object.keys(errs).length > 0 && !noData && <div style={{ background: "#1a0a0a", border: "1px solid #7f1d1d", borderRadius: 10, padding: "14px 22px" }}>
          <div style={{ color: "#f87171", fontWeight: 700, fontSize: 13, marginBottom: 5 }}><AlertTriangle size={15} style={{ verticalAlign: "middle", marginRight: 5 }} />Errors:</div>
          {Object.entries(errs).map(([k, v]) => <div key={k} style={{ color: "#cbd5e1", fontSize: 12, marginBottom: 2 }}>• <strong>{k}</strong>: {v}</div>)}
        </div>}
        {manifest && <div style={{ fontSize: 12, color: "#64748b" }}>Pipeline: {manifest.run ? new Date(manifest.run).toLocaleString() : "—"}</div>}

        {/* Key Rates */}
        <div>
          <h3 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em" }}>Key Rates {data.ust ? `(${data.ust.date})` : ""}</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(175px, 1fr))", gap: 12 }}>
            <MetricCard label="UST 10Y" value={fmtY(ust10y)} change={chgBp(ust10y, ust10yP)} loading={ls.ust} />
            <MetricCard label="UST 2Y" value={fmtY(ust2y)} change={chgBp(ust2y, ust2yP)} loading={ls.ust} />
            <MetricCard label="UST 2s10s" value={ust10y != null && ust2y != null ? ((ust10y - ust2y) * 100).toFixed(0) + "bp" : "—"} change={ust10yP != null ? chgBp(ust10y - ust2y, ust10yP - ust2yP) : null} loading={ls.ust} />
            <MetricCard label="JGB 10Y" value={fmtY(jgb10y)} change={chgBp(jgb10y, jgb10yP)} loading={ls.jgb} />
            <MetricCard label="UK Gilt 10Y" value={fmtY(gilt10y)} change={chgBp(gilt10y, gilt10yP)} loading={ls.gilt} />
            <MetricCard label="India 10Y" value={fmtY(india10y)} change={chgBp(india10y, india10yP)} loading={ls.india} />
            <MetricCard label="US IG OAS" value={igS != null ? igS + "bp" : "—"} change={igP != null ? (igS - igP).toFixed(0) : null} loading={ls.credit} />
            <MetricCard label="US HY OAS" value={hyS != null ? hyS + "bp" : "—"} change={hyP != null ? (hyS - hyP).toFixed(0) : null} loading={ls.credit} />
            <MetricCard label="SOFR" value={sofrRate != null ? sofrRate.toFixed(2) + "%" : "—"} change={chgBp(sofrRate, sofrPrior)} loading={ls.sofr} />
          </div>
        </div>

        {/* Global Curve */}
        {hasCurve && <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: "16px 16px 8px" }}>
          <h3 style={{ margin: "0 0 12px 8px", fontSize: 14, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em" }}>Global Yield Curve Comparison</h3>
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={mc}><CartesianGrid strokeDasharray="3 3" stroke="#1e2028" /><XAxis dataKey="tenor" tick={{ fill: "#94a3b8", fontSize: 12 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} /><YAxis tick={{ fill: "#94a3b8", fontSize: 12 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} domain={[0, "auto"]} tickFormatter={v => v.toFixed(1) + "%"} /><Tooltip content={<CTooltip />} />
              <Line type="monotone" dataKey="India" stroke="#f472b6" strokeWidth={2} name="India" dot={{ r: 3 }} connectNulls />
              <Line type="monotone" dataKey="Gilt" stroke="#4ade80" strokeWidth={2} name="UK Gilt" dot={{ r: 3 }} connectNulls />
              <Line type="monotone" dataKey="UST" stroke="#60a5fa" strokeWidth={2.5} name="US Treasury" dot={{ r: 4 }} connectNulls />
              <Line type="monotone" dataKey="EUR" stroke="#fbbf24" strokeWidth={2} name="EUR" dot={{ r: 3 }} connectNulls />
              <Line type="monotone" dataKey="JGB" stroke="#f87171" strokeWidth={2} name="Japan JGB" dot={{ r: 3 }} connectNulls />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 10 }} /></LineChart>
          </ResponsiveContainer>
          <div style={{ overflowX: "auto", padding: "6px 8px 12px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr style={{ borderBottom: "2px solid #1e2028" }}><th style={{ textAlign: "left", padding: "6px 10px", color: "#94a3b8" }}>Tenor</th><th style={{ textAlign: "right", padding: "6px 10px", color: "#60a5fa" }}>UST</th><th style={{ textAlign: "right", padding: "6px 10px", color: "#f87171" }}>JGB</th><th style={{ textAlign: "right", padding: "6px 10px", color: "#4ade80" }}>Gilt</th><th style={{ textAlign: "right", padding: "6px 10px", color: "#fbbf24" }}>EUR</th><th style={{ textAlign: "right", padding: "6px 10px", color: "#f472b6" }}>India</th></tr></thead>
              <tbody>{mc.map((r, i) => (<tr key={i} style={{ borderBottom: "1px solid #151820" }}><td style={{ padding: "5px 10px", color: "#f1f5f9", fontWeight: 700, fontFamily: "monospace" }}>{r.tenor}</td>{["UST", "JGB", "Gilt", "EUR", "India"].map(k => <td key={k} style={{ padding: "5px 10px", textAlign: "right", fontFamily: "monospace", color: r[k] != null ? "#f1f5f9" : "#334155", fontWeight: 500 }}>{r[k] != null ? r[k].toFixed(2) + "%" : "—"}</td>)}</tr>))}</tbody>
            </table>
          </div>
          <div style={{ padding: "4px 10px 12px", display: "flex", gap: 18, flexWrap: "wrap", fontSize: 11, color: "#64748b" }}>
            {data.ust && <span>UST: {data.ust.date}</span>}{data.jgb && <span>JGB: {data.jgb.date}</span>}{data.gilt && <span>Gilt: {data.gilt.date}</span>}{data.eiopa && <span>EUR: {data.eiopa.date}</span>}{data.india && <span>India: {data.india.date}</span>}
          </div>
        </div>}

        {/* News + BMA Updates */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "14px 22px", borderBottom: "1px solid #1e2028", display: "flex", justifyContent: "space-between", alignItems: "center" }}><h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#f1f5f9" }}><Newspaper size={15} style={{ verticalAlign: "middle", marginRight: 6 }} /> News</h3><button onClick={() => setPage("news")} style={{ background: "transparent", border: "none", color: "#60a5fa", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>All <ChevronRight size={13} style={{ verticalAlign: "middle" }} /></button></div>
            {NEWS.slice(0, 4).map(item => <div key={item.id} style={{ padding: "10px 22px", borderBottom: "1px solid #151820" }}><div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 3 }}><Badge>{item.topic}</Badge><span style={{ fontSize: 11, color: "#64748b" }}>{timeAgo(item.date)}</span></div><div style={{ fontSize: 13, fontWeight: 600, color: "#f1f5f9", lineHeight: 1.4 }}>{item.title}</div></div>)}
          </div>
          <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "14px 22px", borderBottom: "1px solid #1e2028", display: "flex", justifyContent: "space-between", alignItems: "center" }}><h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#f1f5f9" }}><Shield size={15} style={{ verticalAlign: "middle", marginRight: 6 }} /> BMA</h3><button onClick={() => setPage("bma")} style={{ background: "transparent", border: "none", color: "#60a5fa", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>All <ChevronRight size={13} style={{ verticalAlign: "middle" }} /></button></div>
            {BMA_UPDATES.filter(u => u.isNew).slice(0, 4).map(item => <div key={item.id} style={{ padding: "10px 22px", borderBottom: "1px solid #151820" }}><div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 3 }}><Badge color="#4ade80">NEW</Badge><Badge>{item.cat}</Badge><span style={{ fontSize: 11, color: "#64748b" }}>{item.date}</span></div><div style={{ fontSize: 13, fontWeight: 600, color: "#f1f5f9", lineHeight: 1.4 }}>{item.title}</div></div>)}
          </div>
        </div>
      </div>);
    }
  };

  return (<div style={{ display: "flex", height: "100vh", background: "#080a0f", color: "#e2e8f0", fontFamily: "'JetBrains Mono', 'IBM Plex Sans', -apple-system, sans-serif", fontSize: 14, overflow: "hidden" }}>
    <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>

    {/* Sidebar */}
    <div style={{ width: sidebarOpen ? 220 : 54, transition: "width 0.2s", background: "#0a0c12", borderRight: "1px solid #1a1d23", display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden" }}>
      <div style={{ padding: sidebarOpen ? "16px 18px" : "16px 12px", borderBottom: "1px solid #1a1d23", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", minHeight: 56 }} onClick={() => setSidebarOpen(!sidebarOpen)}>
        <div style={{ width: 30, height: 30, borderRadius: 7, background: "linear-gradient(135deg, #3b82f6, #8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><BarChart3 size={17} color="#fff" /></div>
        {sidebarOpen && <div><div style={{ fontSize: 14, fontWeight: 800, color: "#f1f5f9", letterSpacing: "-0.02em", lineHeight: 1.1 }}>BERMUDA</div><div style={{ fontSize: 10, fontWeight: 600, color: "#60a5fa", letterSpacing: "0.15em", textTransform: "uppercase" }}>MARKET INTEL</div></div>}
      </div>
      <div style={{ flex: 1, padding: "8px 7px", overflowY: "auto" }}>{PAGES.map(p => { const Icon = p.icon; const a = page === p.id; return <button key={p.id} onClick={() => setPage(p.id)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 11, padding: sidebarOpen ? "9px 12px" : "9px", marginBottom: 2, borderRadius: 7, border: "none", background: a ? "#1e2028" : "transparent", color: a ? "#f1f5f9" : "#94a3b8", cursor: "pointer", fontSize: 13, fontWeight: a ? 600 : 500, textAlign: "left", justifyContent: sidebarOpen ? "flex-start" : "center" }} onMouseEnter={e => { if (!a) e.currentTarget.style.background = "#12141a" }} onMouseLeave={e => { if (!a) e.currentTarget.style.background = "transparent" }}><Icon size={16} style={{ flexShrink: 0 }} />{sidebarOpen && <span>{p.label}</span>}</button>; })}</div>
      {sidebarOpen && <div style={{ padding: "12px 16px", borderTop: "1px solid #1a1d23", fontSize: 11, color: "#475569" }}>Data via GitHub Actions</div>}
    </div>

    {/* Main */}
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ height: 46, padding: "0 22px", borderBottom: "1px solid #1a1d23", background: "#0a0c12", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#f1f5f9" }}>{PAGES.find(p => p.id === page)?.label || "Overview"}</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12 }}>
          {lastRef && <span style={{ color: "#64748b", fontSize: 11 }}>Loaded: {lastRef.toLocaleTimeString()}</span>}
          {gLoad && <Loader size={15} style={{ color: "#60a5fa", animation: "spin 1s linear infinite" }} />}
          <button onClick={loadData} disabled={gLoad} style={{ background: gLoad ? "#1e2028" : "#3b82f6", border: "none", borderRadius: 7, padding: "6px 16px", color: gLoad ? "#94a3b8" : "#fff", cursor: gLoad ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 6, fontWeight: 700, fontSize: 13 }}>
            <RefreshCw size={14} style={{ animation: gLoad ? "spin 1s linear infinite" : "none" }} />{gLoad ? "Loading…" : "Refresh"}
          </button>
          <span style={{ color: "#60a5fa", fontFamily: "monospace", fontWeight: 700, fontSize: 14 }}>{clock}</span>
        </div>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 20 }}>{renderPage()}</div>
      <div style={{ height: 28, padding: "0 22px", borderTop: "1px solid #1a1d23", background: "#0a0c12", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11, color: "#475569", flexShrink: 0 }}>
        <div style={{ display: "flex", gap: 16 }}>{ust10y != null && <span>UST 10Y: {fmtY(ust10y)}</span>}{jgb10y != null && <span>JGB 10Y: {fmtY(jgb10y)}</span>}{gilt10y != null && <span>Gilt 10Y: {fmtY(gilt10y)}</span>}{india10y != null && <span>India 10Y: {fmtY(india10y)}</span>}{sofrRate != null && <span>SOFR: {sofrRate.toFixed(2)}%</span>}{igS != null && <span>IG: {igS}bp</span>}{hyS != null && <span>HY: {hyS}bp</span>}</div>
        <span>Bermuda Market Intel v9</span>
      </div>
    </div>
  </div>);
}

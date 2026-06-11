import { useState, useEffect, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, AreaChart, Area, Legend, ReferenceLine
} from "recharts";
import {
  Shield, Newspaper, BarChart3, ChevronRight, ExternalLink,
  Clock, RefreshCw, Activity, DollarSign, Percent, ArrowUpRight,
  ArrowDownRight, Minus, AlertTriangle, Loader, Landmark, TrendingUp, Gem,
  Copy, Check
} from "lucide-react";

const PLATFORM_NAME = "GENESIS";
const TOOL_NAME = "GENESIS // CORE";

const CurrencySymbolIcon = symbol => ({ size = 16, style = {} }) => (
  <span style={{
    fontSize: size + 1, fontWeight: 800, lineHeight: 1,
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: size, height: size, flexShrink: 0, ...style
  }}>{symbol}</span>
);

/* ═══════════════════════════════════════════════════════════════════
   GENESIS MARKET INTELLIGENCE TERMINAL v8
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
const fmtWAM = v => v != null ? v.toFixed(1) + "yr" : "—";
const TENOR_YEARS = { "1Y": 1, "2Y": 2, "3Y": 3, "5Y": 5, "7Y": 7, "10Y": 10, "15Y": 15, "20Y": 20, "30Y": 30 };
const wamToTenor = years => { if (years == null) return null; let best = null, minDiff = Infinity; for (const [t, y] of Object.entries(TENOR_YEARS)) { const d = Math.abs(y - years); if (d < minDiff) { minDiff = d; best = t; } } return best; };

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
// GOVT DEBT WAM COMPARISON SECTION
// ═══════════════════════════════════════════

const WAM_COUNTRY_CONFIG = {
  usa:   { label: "USA",   color: "#3b82f6" },
  japan: { label: "Japan", color: "#ef4444" },
  uk:    { label: "UK",    color: "#22c55e" },
  eur:   { label: "EUR",   color: "#f59e0b" },
  india: { label: "India", color: "#ec4899" },
};
const WAM_COUNTRY_KEYS = ["usa", "japan", "uk", "eur", "india"];

const WamComparisonSection = ({ data, loading: ld, error }) => {
  if (ld) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 30, textAlign: "center", color: "#94a3b8" }}><Loader size={20} style={{ animation: "spin 1s linear infinite", display: "block", margin: "0 auto 10px", color: "#a78bfa" }} />Loading debt maturity data…</div>;
  if (error || !data) return null;
  const countries = data.countries || {};
  return (
    <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "16px 22px", borderBottom: "1px solid #1e2028" }}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#f1f5f9" }}>Govt Debt — Avg Weighted Maturity</h3>
        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>Remaining maturity of outstanding central govt marketable debt. Longer = more financing locked in at current rates.</div>
        <DataFresh date={data.date} source="FRED / MOF / DMO / OECD / RBI" url="https://fred.stlouisfed.org/series/AVMATPUSDM" />
      </div>

      {/* Cards */}
      <div style={{ padding: "16px 22px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(155px, 1fr))", gap: 12 }}>
        {WAM_COUNTRY_KEYS.map(k => {
          const c = countries[k];
          if (!c) return null;
          const cfg = WAM_COUNTRY_CONFIG[k];
          const chg = c.change_years;
          const isStale = c.source === "cache" || c.source === "static_default";
          return (
            <div key={k} style={{ background: "#12141a", border: `1px solid ${cfg.color}33`, borderRadius: 10, padding: "14px 16px" }}>
              <div style={{ fontSize: 11, color: cfg.color, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>{cfg.label}</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#f1f5f9", fontFamily: "'JetBrains Mono', monospace", lineHeight: 1 }}>{fmtWAM(c.wam_years)}</div>
              {chg != null && (
                <div style={{ fontSize: 11, color: chg > 0 ? "#f59e0b" : chg < 0 ? "#60a5fa" : "#64748b", marginTop: 6, fontFamily: "monospace" }}>
                  {chg > 0 ? "+" : ""}{chg.toFixed(2)}yr vs prior
                </div>
              )}
              <div style={{ fontSize: 10, color: "#475569", marginTop: 4 }}>
                {c.data_date || "—"} · {c.frequency}
                {isStale && <span style={{ marginLeft: 5 }}><Badge color="#f59e0b">{c.source === "cache" ? "cached" : "static default"}</Badge></span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Table */}
      <div style={{ padding: "0 22px 16px", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #1e2028" }}>
              <th style={{ textAlign: "left", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Country</th>
              <th style={{ textAlign: "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>WAM</th>
              <th style={{ textAlign: "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Prior</th>
              <th style={{ textAlign: "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Change</th>
              <th style={{ textAlign: "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>As of</th>
              <th style={{ textAlign: "left", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Source</th>
            </tr>
          </thead>
          <tbody>
            {WAM_COUNTRY_KEYS.map(k => {
              const c = countries[k];
              if (!c) return null;
              const cfg = WAM_COUNTRY_CONFIG[k];
              const chg = c.change_years;
              return (
                <tr key={k} style={{ borderBottom: "1px solid #151820" }}>
                  <td style={{ padding: "7px 12px", color: cfg.color, fontWeight: 700, fontFamily: "monospace" }}>{cfg.label}</td>
                  <td style={{ padding: "7px 12px", color: "#f1f5f9", textAlign: "right", fontFamily: "monospace", fontWeight: 700, fontSize: 15 }}>{fmtWAM(c.wam_years)}</td>
                  <td style={{ padding: "7px 12px", color: "#94a3b8", textAlign: "right", fontFamily: "monospace" }}>{fmtWAM(c.prior_wam_years)}</td>
                  <td style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", fontWeight: 600, color: chg != null ? (chg > 0 ? "#f59e0b" : "#60a5fa") : "#64748b" }}>
                    {chg != null ? (chg > 0 ? "+" : "") + chg.toFixed(2) + "yr" : "—"}
                  </td>
                  <td style={{ padding: "7px 12px", color: "#64748b", textAlign: "right", fontSize: 12 }}>{c.data_date || "—"}</td>
                  <td style={{ padding: "7px 12px", fontSize: 11 }}>
                    {c.source === "cache" ? <Badge color="#f59e0b">Cached</Badge>
                      : c.source === "static_default" ? <Badge color="#64748b">Static</Badge>
                      : <a href={c.source_url} target="_blank" rel="noopener noreferrer" style={{ color: "#60a5fa", textDecoration: "none" }}>
                          {c.source?.split("—")[0]?.trim() || c.source} <ExternalLink size={10} style={{ verticalAlign: "middle" }} />
                        </a>
                    }
                    {c.note && <span title={c.note} style={{ color: "#64748b", marginLeft: 5, cursor: "help" }}>ⓘ</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data.note && <div style={{ padding: "0 22px 14px", fontSize: 11, color: "#475569", lineHeight: 1.6 }}>{data.note}</div>}
    </div>
  );
};

// ═══════════════════════════════════════════
// SOVEREIGN YIELD SECTION (chart + table + year-ago row)
// ═══════════════════════════════════════════

// Common x-axis for all sovereign rate charts — enables direct visual comparison across views
const STANDARD_TENORS = ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"];
const DERIVED_LABELS = { prior_day: "Prior day", prior_1m: "1M", prior_3m: "3M", year_ago: "1Y ago" };

const SovSection = ({ data, title, accentColor, loading: ld, error, wamData }) => {
  if (ld) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 40, textAlign: "center", color: "#94a3b8" }}><Loader size={24} style={{ animation: "spin 1s linear infinite", margin: "0 auto 12px", display: "block", color: "#60a5fa" }} />Loading {title}…</div>;
  if (error) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 20 }}><h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700, color: "#f1f5f9" }}>{title}</h3><div style={{ color: "#f87171", fontSize: 13 }}><AlertTriangle size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />{error}</div></div>;
  if (!data) return null;

  const hasYearAgo = data.year_ago_yields?.some(v => v != null);
  const hasPrior = data.prior_yields?.some(v => v != null);
  const has1m = data.prior_1m_yields?.some(v => v != null);
  const has3m = data.prior_3m_yields?.some(v => v != null);

  // Build per-tenor lookups for the chart (standardized x-axis across all rate views)
  const yByT = {}, pByT = {}, p1mByT = {}, p3mByT = {}, yaByT = {};
  data.tenors.forEach((t, i) => {
    yByT[t] = data.yields[i];
    pByT[t] = data.prior_yields?.[i];
    p1mByT[t] = data.prior_1m_yields?.[i];
    p3mByT[t] = data.prior_3m_yields?.[i];
    yaByT[t] = data.year_ago_yields?.[i];
  });
  const chartData = STANDARD_TENORS.map(t => ({
    tenor: t,
    current: yByT[t] ?? null,
    prior: pByT[t] ?? null,
    yearAgo: yaByT[t] ?? null,
  }));

  // Table uses all tenors available in the dataset (including short-end for UST)
  const curveData = data.tenors.map((t, i) => ({
    tenor: t, current: data.yields[i], prior: data.prior_yields?.[i],
    prior1m: data.prior_1m_yields?.[i], prior3m: data.prior_3m_yields?.[i],
    yearAgo: data.year_ago_yields?.[i],
    change: data.yields[i] != null && data.prior_yields?.[i] != null ? ((data.yields[i] - data.prior_yields[i]) * 100).toFixed(1) : null,
    change1m: data.yields[i] != null && data.prior_1m_yields?.[i] != null ? ((data.yields[i] - data.prior_1m_yields[i]) * 100).toFixed(1) : null,
    change3m: data.yields[i] != null && data.prior_3m_yields?.[i] != null ? ((data.yields[i] - data.prior_3m_yields[i]) * 100).toFixed(1) : null,
    yaChange: data.yields[i] != null && data.year_ago_yields?.[i] != null ? ((data.yields[i] - data.year_ago_yields[i]) * 100).toFixed(1) : null,
  }));

  return (<div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
    <div style={{ padding: "16px 22px", borderBottom: "1px solid #1e2028" }}>
      <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#f1f5f9" }}>{title}</h3>
      <DataFresh date={data.date} source={data.source} url={data.url} />
      {data.note && <div style={{ fontSize: 11, color: "#f59e0b", marginTop: 5 }}>{data.note}</div>}
      {data.derived && Object.keys(data.derived).length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "#94a3b8" }}>Derived (not direct market quotes):</span>
          {Object.entries(data.derived).map(([k, v]) => (
            <Badge key={k} color="#f59e0b">{DERIVED_LABELS[k] || k}: {v}</Badge>
          ))}
        </div>
      )}
      {!hasPrior && (
        <div style={{ fontSize: 11, color: "#64748b", marginTop: 5 }}>
          No prior-day data available yet for this market — day-over-day comparisons appear once the pipeline has history.
        </div>
      )}
      {wamData?.wam_years != null && (
        <div style={{ fontSize: 11, color: "#a78bfa", marginTop: 5 }}>
          Avg debt maturity: <strong style={{ color: "#c4b5fd" }}>{fmtWAM(wamData.wam_years)}</strong>
          {wamData.change_years != null && (
            <span style={{ color: "#64748b" }}> ({wamData.change_years > 0 ? "+" : ""}{wamData.change_years.toFixed(2)}yr vs prior)</span>
          )}
          <span style={{ color: "#475569" }}> · {wamData.source} · {wamData.data_date}</span>
          {wamData.note && <span style={{ color: "#64748b" }}> · {wamData.note}</span>}
        </div>
      )}
    </div>

    {/* Chart — uses STANDARD_TENORS for a consistent x-axis across all rate views */}
    <div style={{ padding: "14px 14px 6px" }}>
      <ResponsiveContainer width="100%" height={230}>
        <AreaChart data={chartData}>
          <defs><linearGradient id={`g${accentColor.slice(1)}`} x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={accentColor} stopOpacity={0.3} /><stop offset="95%" stopColor={accentColor} stopOpacity={0} /></linearGradient></defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e2028" />
          <XAxis dataKey="tenor" tick={{ fill: "#94a3b8", fontSize: 12, fontWeight: 500 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} />
          <YAxis tick={{ fill: "#94a3b8", fontSize: 12 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} domain={["auto", "auto"]} tickFormatter={v => v?.toFixed(1)} />
          <Tooltip content={<CTooltip />} />
          <Area type="monotone" dataKey="current" stroke={accentColor} strokeWidth={2.5} fill={`url(#g${accentColor.slice(1)})`} name="Current" dot={{ r: 4, fill: accentColor }} />
          {hasPrior && <Line type="monotone" dataKey="prior" stroke="#64748b" strokeWidth={1.5} strokeDasharray="5 5" name="Prior Day" dot={false} />}
          {hasYearAgo && <Line type="monotone" dataKey="yearAgo" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="3 6" name="1 Year Ago" dot={false} />}
          {wamData?.wam_years != null && (() => {
            const t = wamToTenor(wamData.wam_years);
            return t ? <ReferenceLine x={t} stroke="#a78bfa" strokeWidth={1.5} strokeDasharray="4 3" label={{ value: `WAM ${fmtWAM(wamData.wam_years)}`, position: "insideTopRight", fill: "#a78bfa", fontSize: 11, fontWeight: 700 }} /> : null;
          })()}
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
            {hasPrior && <th style={{ textAlign: "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Prior Day</th>}
            {hasPrior && <th style={{ textAlign: "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Chg (bp)</th>}
            {has1m && <th style={{ textAlign: "right", padding: "8px 12px", color: "#818cf8", fontWeight: 700, fontSize: 12 }}>Prior 1M{data.prior_1m_date ? ` (${data.prior_1m_date})` : ""}</th>}
            {has1m && <th style={{ textAlign: "right", padding: "8px 12px", color: "#818cf8", fontWeight: 700, fontSize: 12 }}>1M (bp)</th>}
            {has3m && <th style={{ textAlign: "right", padding: "8px 12px", color: "#34d399", fontWeight: 700, fontSize: 12 }}>Prior 3M{data.prior_3m_date ? ` (${data.prior_3m_date})` : ""}</th>}
            {has3m && <th style={{ textAlign: "right", padding: "8px 12px", color: "#34d399", fontWeight: 700, fontSize: 12 }}>3M (bp)</th>}
            {hasYearAgo && <th style={{ textAlign: "right", padding: "8px 12px", color: "#f59e0b", fontWeight: 700, fontSize: 12 }}>1Y Ago{data.year_ago_date ? ` (${data.year_ago_date})` : ""}</th>}
            {hasYearAgo && <th style={{ textAlign: "right", padding: "8px 12px", color: "#f59e0b", fontWeight: 700, fontSize: 12 }}>YoY (bp)</th>}
          </tr>
        </thead>
        <tbody>
          {curveData.map((r, i) => {
            const ch = parseFloat(r.change);
            const ch1m = parseFloat(r.change1m);
            const ch3m = parseFloat(r.change3m);
            const ya = parseFloat(r.yaChange);
            return (<tr key={i} style={{ borderBottom: "1px solid #151820" }}>
              <td style={{ padding: "7px 12px", color: "#f1f5f9", fontWeight: 700, fontFamily: "monospace", fontSize: 13 }}>{r.tenor}</td>
              <td style={{ padding: "7px 12px", color: "#f1f5f9", textAlign: "right", fontFamily: "monospace", fontWeight: 600, fontSize: 14 }}>{fmtY(r.current)}</td>
              {hasPrior && <td style={{ padding: "7px 12px", color: "#94a3b8", textAlign: "right", fontFamily: "monospace" }}>{fmtY(r.prior)}</td>}
              {hasPrior && <td style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: chgCol(ch), fontWeight: 600 }}>{r.change != null ? (ch > 0 ? "+" : "") + r.change : "—"}</td>}
              {has1m && <td style={{ padding: "7px 12px", color: "#a5b4fc", textAlign: "right", fontFamily: "monospace" }}>{fmtY(r.prior1m)}</td>}
              {has1m && <td style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: chgCol(ch1m), fontWeight: 600 }}>{r.change1m != null ? (ch1m > 0 ? "+" : "") + r.change1m : "—"}</td>}
              {has3m && <td style={{ padding: "7px 12px", color: "#6ee7b7", textAlign: "right", fontFamily: "monospace" }}>{fmtY(r.prior3m)}</td>}
              {has3m && <td style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: chgCol(ch3m), fontWeight: 600 }}>{r.change3m != null ? (ch3m > 0 ? "+" : "") + r.change3m : "—"}</td>}
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
const srcLabel = s => {
  if (!s) return null;
  if (s === "cache") return { label: "Cached", color: "#f59e0b" };
  if (s.startsWith("fred_download")) return { label: "FRED↓", color: "#60a5fa" };
  if (s.startsWith("fred")) return { label: "FRED", color: "#60a5fa" };
  return null;
};

const CreditSection = ({ data, loading: ld, error }) => {
  const [copied, setCopied] = useState("");
  if (ld) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 40, textAlign: "center", color: "#94a3b8" }}><Loader size={24} style={{ animation: "spin 1s linear infinite", margin: "0 auto 10px", display: "block", color: "#60a5fa" }} />Loading…</div>;
  if (error) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 20 }}><h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700, color: "#f1f5f9" }}>Credit Spreads</h3><div style={{ color: "#f87171", fontSize: 13 }}><AlertTriangle size={14} style={{ verticalAlign: "middle", marginRight: 6 }} />{error}</div></div>;
  if (!data) return null;
  const entries = Object.values(data.spreads || {}).filter(e => e.spread != null);
  const hasCache = entries.some(e => e.source === "cache");

  // Quarter-end history (written by fetch_credit_latest.py), newest first.
  const creditQs = (data.quarter_history || []).slice(0, 4);
  const spreadKeys = Object.keys(data.spreads || {});
  const buildCreditQTsv = () => {
    const lines = [["Index", "Current (bp)", ...creditQs.map(q => `${q.quarter} (${q.date})`), "QoQ (bp)"].join("\t")];
    spreadKeys.forEach(k => {
      const vals = creditQs.map(q => q.spreads?.[k]);
      const qoq = vals[0] != null && vals[1] != null ? vals[0] - vals[1] : "";
      lines.push([data.spreads[k]?.name || k, data.spreads[k]?.spread ?? "", ...vals.map(v => v ?? ""), qoq].join("\t"));
    });
    return lines.join("\n");
  };
  return (<div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
    <div style={{ padding: "16px 22px", borderBottom: "1px solid #1e2028" }}>
      <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#f1f5f9" }}>US Corporate Credit Spreads (OAS)</h3>
      <DataFresh date={data.date || (data._fetched ? `${data._fetched.slice(0, 10)} (last attempt — serving cache)` : "")} source={data.source} url={data.url} />
      {data.note && <div style={{ fontSize: 11, color: "#64748b", marginTop: 5, lineHeight: 1.5 }}>{data.note}</div>}
    </div>
    {hasCache && (
      <div style={{ padding: "8px 22px", background: "#1a1206", borderBottom: "1px solid #854d0e", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#fbbf24" }}>
        <AlertTriangle size={13} />
        Some spreads are using cached data — FRED was unavailable at last run.
      </div>
    )}
    <div style={{ padding: "10px 22px 16px", overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead><tr style={{ borderBottom: "2px solid #1e2028" }}>{["Index", "OAS (bp)", "Prior", "Chg", "Source"].map(h => <th key={h} style={{ textAlign: h === "Index" ? "left" : "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>{h}</th>)}</tr></thead>
        <tbody>{entries.map((r, i) => {
          const c = (r.spread || 0) - (r.prior || 0);
          const sl = srcLabel(r.source);
          return (<tr key={i} style={{ borderBottom: "1px solid #151820" }}>
            <td style={{ padding: "7px 12px", color: "#f1f5f9", fontWeight: 600, fontSize: 13 }}>{r.name} <Badge color={["HY", "BB", "B", "CCC"].includes(r.bucket) ? "#f87171" : "#4ade80"}>{r.bucket}</Badge></td>
            <td style={{ padding: "7px 12px", color: "#f1f5f9", textAlign: "right", fontFamily: "monospace", fontWeight: 700, fontSize: 14 }}>{r.spread}</td>
            <td style={{ padding: "7px 12px", color: "#94a3b8", textAlign: "right", fontFamily: "monospace" }}>{r.prior || "—"}</td>
            <td style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: chgCol(c * -1), fontWeight: 600 }}>{r.prior ? (c > 0 ? "+" : "") + c : "—"}</td>
            <td style={{ padding: "7px 12px", textAlign: "right" }}>{sl && <Badge color={sl.color}>{sl.label}</Badge>}</td>
          </tr>);
        })}</tbody>
      </table>
    </div>

    {/* Quarter-end history */}
    {creditQs.length > 1 && (
      <div style={{ padding: "4px 22px 18px", borderTop: "1px solid #1e2028" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "12px 0 10px" }}>
          <div style={{ fontSize: 12, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Last {creditQs.length} Quarters — OAS (bp)
          </div>
          <div style={{ marginLeft: "auto" }}>
            <CopyTableButton label="Copy quarters" id="creditQ" buildText={buildCreditQTsv} copied={copied} setCopied={setCopied} />
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #1e2028" }}>
                <th style={{ textAlign: "left", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Index</th>
                <th style={{ textAlign: "right", padding: "8px 12px", color: "#f1f5f9", fontWeight: 700, fontSize: 12 }}>Current</th>
                {creditQs.map(q => (
                  <th key={q.date} style={{ textAlign: "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>
                    {q.quarter}<div style={{ fontSize: 10, fontWeight: 500, color: "#475569" }}>{q.date}</div>
                  </th>
                ))}
                <th style={{ textAlign: "right", padding: "8px 12px", color: "#34d399", fontWeight: 700, fontSize: 12 }}>QoQ (bp)</th>
              </tr>
            </thead>
            <tbody>
              {spreadKeys.map(k => {
                const meta = data.spreads[k] || {};
                const vals = creditQs.map(q => q.spreads?.[k]);
                const qoq = vals[0] != null && vals[1] != null ? vals[0] - vals[1] : null;
                return (
                  <tr key={k} style={{ borderBottom: "1px solid #151820" }}>
                    <td style={{ padding: "7px 12px", color: "#f1f5f9", fontWeight: 600, fontSize: 13 }}>{meta.name || k} {meta.bucket && <Badge color={["HY", "BB", "B", "CCC"].includes(meta.bucket) ? "#f87171" : "#4ade80"}>{meta.bucket}</Badge>}</td>
                    <td style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: "#f1f5f9", fontWeight: 700, fontSize: 14 }}>{meta.spread ?? "—"}</td>
                    {vals.map((v, vi) => (
                      <td key={vi} style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: "#94a3b8" }}>{v ?? "—"}</td>
                    ))}
                    <td style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: chgCol(qoq), fontWeight: 600 }}>
                      {qoq != null ? (qoq > 0 ? "+" : "") + qoq : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 10, color: "#475569", marginTop: 8 }}>
          Quarter-end ICE BofA OAS snapshots (nearest business day on or before quarter end). QoQ compares the two most recent quarter ends.
        </div>
      </div>
    )}
  </div>);
};

// ═══════════════════════════════════════════
// CDS SPREADS SECTION
// ═══════════════════════════════════════════
const CORP_ORDER = ["aaa", "aa", "a", "bbb", "bb", "b", "ccc"];
const CORP_LABELS = { aaa: "AAA", aa: "AA", a: "A", bbb: "BBB", bb: "BB", b: "B", ccc: "CCC" };
const IS_HY = new Set(["bb", "b", "ccc"]);
const SECTOR_ORDER = ["financial_ig", "financial_hy", "tech_ig", "tech_hy"];

const CDSSection = ({ data, loading: ld, error }) => {
  if (ld) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 40, textAlign: "center", color: "#94a3b8" }}><Loader size={24} style={{ animation: "spin 1s linear infinite", margin: "0 auto 10px", display: "block", color: "#60a5fa" }} />Loading…</div>;
  if (error) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 20 }}><h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700, color: "#f1f5f9" }}>CDS Spreads</h3><div style={{ color: "#f87171", fontSize: 13 }}><AlertTriangle size={14} style={{ verticalAlign: "middle", marginRight: 6 }} />{error}</div></div>;
  if (!data) return null;

  const sovereign = data.sovereign?.us_5y;
  const corporate = data.corporate || {};
  const sector = data.sector || {};

  const fmtBp = v => v != null ? v + "bp" : "—";
  const cdsChgCol = v => v > 0 ? "#f87171" : v < 0 ? "#4ade80" : "#94a3b8";
  const spreadChg = (curr, prior) => curr != null && prior != null ? curr - prior : null;

  const hasCache = (
    Object.values(corporate).some(r => r.source === "cache") ||
    Object.values(sector).some(r => r.source === "cache") ||
    sovereign?.source === "cache"
  );

  return (<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
    <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>

      {/* Header */}
      <div style={{ padding: "16px 22px", borderBottom: "1px solid #1e2028" }}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#f1f5f9" }}>CDS Spreads</h3>
        <DataFresh date={data.date} source={data.source} />
        {data.status && data.status !== "ok" && (
          <div style={{ fontSize: 11, color: "#f59e0b", marginTop: 5 }}>
            <AlertTriangle size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
            Data status: {data.status}
          </div>
        )}
      </div>

      {hasCache && (
        <div style={{ padding: "8px 22px", background: "#1a1206", borderBottom: "1px solid #854d0e", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#fbbf24" }}>
          <AlertTriangle size={13} />
          Some data is from cache — live fetch was unavailable at last run.
        </div>
      )}

      {/* Panel A: US Sovereign CDS */}
      <div style={{ padding: "16px 22px", borderBottom: "1px solid #1e2028" }}>
        <div style={{ fontSize: 12, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>US Sovereign CDS</div>
        {sovereign && sovereign.spread != null ? (
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <div style={{ background: "#12141a", border: "1px solid #2a2d35", borderRadius: 10, padding: "14px 20px", minWidth: 200 }}>
              <div style={{ fontSize: 12, color: "#94a3b8", fontWeight: 600, marginBottom: 6 }}>{sovereign.name || "US 5Y CDS"}</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ fontSize: 28, fontWeight: 700, color: "#f1f5f9", fontFamily: "monospace" }}>{sovereign.spread}bp</span>
                {(() => { const chg = spreadChg(sovereign.spread, sovereign.prior); if (chg == null) return null; return <span style={{ fontSize: 13, color: cdsChgCol(chg), fontWeight: 600, fontFamily: "monospace", display: "flex", alignItems: "center", gap: 3 }}><ChgIcon v={chg} />{Math.abs(chg).toFixed(1)}bp</span>; })()}
              </div>
              <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>
                5Y CDS on US Treasuries{sovereign.date ? ` • ${sovereign.date}` : ""}{sovereign.source && sovereign.source !== "cache" ? ` • ${sovereign.source}` : ""}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ color: "#64748b", fontSize: 13 }}>No sovereign CDS data available — will populate from TradingEconomics on next pipeline run.</div>
        )}
      </div>

      {/* Panel B: Corporate CDS by Rating */}
      <div style={{ padding: "10px 22px 16px", borderBottom: "1px solid #1e2028", overflowX: "auto" }}>
        <div style={{ fontSize: 12, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Corporate CDS Equivalent — By Rating</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #1e2028" }}>
              {["Rating", "Spread (bp)", "Prior", "Chg (bp)", "Source"].map(h => (
                <th key={h} style={{ textAlign: h === "Rating" ? "left" : "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CORP_ORDER.map(k => {
              const r = corporate[k];
              const isHY = IS_HY.has(k);
              if (!r) return (
                <tr key={k} style={{ borderBottom: "1px solid #151820" }}>
                  <td style={{ padding: "7px 12px", color: "#f1f5f9", fontWeight: 600 }}>{CORP_LABELS[k]} <Badge color={isHY ? "#f87171" : "#4ade80"}>{isHY ? "HY" : "IG"}</Badge></td>
                  <td colSpan={4} style={{ padding: "7px 12px", color: "#475569", textAlign: "right", fontSize: 12 }}>—</td>
                </tr>
              );
              const chg = spreadChg(r.spread, r.prior);
              return (
                <tr key={k} style={{ borderBottom: "1px solid #151820" }}>
                  <td style={{ padding: "7px 12px", color: "#f1f5f9", fontWeight: 600, fontSize: 13 }}>
                    {r.name || CORP_LABELS[k]} <Badge color={isHY ? "#f87171" : "#4ade80"}>{isHY ? "HY" : "IG"}</Badge>
                  </td>
                  <td style={{ padding: "7px 12px", color: "#f1f5f9", textAlign: "right", fontFamily: "monospace", fontWeight: 700, fontSize: 14 }}>{fmtBp(r.spread)}</td>
                  <td style={{ padding: "7px 12px", color: "#94a3b8", textAlign: "right", fontFamily: "monospace" }}>{r.prior != null ? r.prior + "bp" : "—"}</td>
                  <td style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: chg != null ? cdsChgCol(chg) : "#94a3b8", fontWeight: 600 }}>
                    {chg != null ? (chg > 0 ? "+" : "") + chg : "—"}
                  </td>
                  <td style={{ padding: "7px 12px", textAlign: "right" }}>
                    {r.source === "cache" && <Badge color="#f59e0b">Cached</Badge>}
                    {r.source === "credit.json" && <Badge color="#60a5fa">FRED</Badge>}
                    {r.source?.startsWith("fred") && <Badge color="#60a5fa">FRED</Badge>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ fontSize: 11, color: "#475569", marginTop: 8 }}>ICE BofA OAS indices via FRED — used as 5Y CDS spread proxy.</div>
      </div>

      {/* Panel C: Sector CDS Indices */}
      <div style={{ padding: "10px 22px 16px", overflowX: "auto" }}>
        <div style={{ fontSize: 12, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Sector CDS Indices — Tech &amp; Finance</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #1e2028" }}>
              {["Sector", "Spread (bp)", "Prior", "Chg (bp)", "Series", "Source"].map(h => (
                <th key={h} style={{ textAlign: h === "Sector" ? "left" : "right", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SECTOR_ORDER.map(k => {
              const r = sector[k];
              const isHY = k.endsWith("_hy");
              if (!r || r.spread == null) return (
                <tr key={k} style={{ borderBottom: "1px solid #151820" }}>
                  <td style={{ padding: "7px 12px", color: "#f1f5f9", fontWeight: 600 }}>
                    {r?.name || k} <Badge color={isHY ? "#f87171" : "#4ade80"}>{isHY ? "HY" : "IG"}</Badge>
                  </td>
                  <td colSpan={5} style={{ padding: "7px 12px", color: "#475569", textAlign: "right", fontSize: 12 }}>
                    {r?.source === "unavailable" ? "Series unavailable on FRED" : "—"}
                  </td>
                </tr>
              );
              const chg = spreadChg(r.spread, r.prior);
              return (
                <tr key={k} style={{ borderBottom: "1px solid #151820" }}>
                  <td style={{ padding: "7px 12px", color: "#f1f5f9", fontWeight: 600 }}>
                    {r.name} <Badge color={isHY ? "#f87171" : "#4ade80"}>{isHY ? "HY" : "IG"}</Badge>
                  </td>
                  <td style={{ padding: "7px 12px", color: "#f1f5f9", textAlign: "right", fontFamily: "monospace", fontWeight: 700, fontSize: 14 }}>{fmtBp(r.spread)}</td>
                  <td style={{ padding: "7px 12px", color: "#94a3b8", textAlign: "right", fontFamily: "monospace" }}>{r.prior != null ? r.prior + "bp" : "—"}</td>
                  <td style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: chg != null ? cdsChgCol(chg) : "#94a3b8", fontWeight: 600 }}>
                    {chg != null ? (chg > 0 ? "+" : "") + chg : "—"}
                  </td>
                  <td style={{ padding: "7px 12px", color: "#475569", textAlign: "right", fontFamily: "monospace", fontSize: 11 }}>{r.series_id || "—"}</td>
                  <td style={{ padding: "7px 12px", textAlign: "right" }}>
                    {r.source === "cache" && <Badge color="#f59e0b">Cached</Badge>}
                    {r.source?.startsWith("fred") && <Badge color="#60a5fa">FRED</Badge>}
                    {r.source === "unavailable" && <Badge color="#475569">N/A</Badge>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ fontSize: 11, color: "#475569", marginTop: 8 }}>Sector OAS sub-indices from FRED ICE BofA. Series availability varies.</div>
      </div>
    </div>
  </div>);
};

// ═══════════════════════════════════════════
// BMA DISCOUNT RATES SECTION (new)
// ═══════════════════════════════════════════
// Copy text to clipboard with a fallback for non-secure contexts.
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

const CopyTableButton = ({ label, buildText, id, copied, setCopied }) => (
  <button
    onClick={async () => { if (await copyToClipboard(buildText())) { setCopied(id); setTimeout(() => setCopied(c => (c === id ? "" : c)), 2000); } }}
    style={{ background: "transparent", border: "1px solid #2a2d35", borderRadius: 6, padding: "5px 12px", fontSize: 12, fontWeight: 600, color: copied === id ? "#4ade80" : "#94a3b8", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
    {copied === id ? <Check size={13} /> : <Copy size={13} />}
    {copied === id ? "Copied" : label}
  </button>
);

const BmaRatesSection = ({ data, loading: ld, error }) => {
  const [selectedCcy, setSelectedCcy] = useState("USD");
  const [copied, setCopied] = useState("");
  const [rateType, setRateType] = useState("standard_spot_rates");

  if (ld) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 40, textAlign: "center", color: "#94a3b8" }}><Loader size={24} style={{ animation: "spin 1s linear infinite", margin: "0 auto 10px", display: "block", color: "#60a5fa" }} />Loading BMA rates…</div>;
  if (error) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 20 }}><h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700, color: "#f1f5f9" }}>BMA EBS Discount Rates</h3><div style={{ color: "#f87171", fontSize: 13 }}><AlertTriangle size={14} style={{ verticalAlign: "middle", marginRight: 6 }} />{error}</div></div>;
  if (!data) return null;

  const ccys = Object.keys(data.currencies || {});
  const ccyData = data.currencies?.[selectedCcy];
  const tenors = data.tenors || [];
  const hasRates = ccyData?.rates?.some(v => v != null);
  const has1mBma = ccyData?.prior_1m_rates?.some(v => v != null);
  const hasQtrBma = ccyData?.prior_rates?.some(v => v != null);

  // TSV builders — tab-separated so the table pastes straight into Excel/Sheets.
  const num = v => (v == null ? "" : String(v));
  const buildCcyTsv = () => {
    const head = ["Tenor", `${selectedCcy} Spot Rate (%)`];
    if (has1mBma) head.push("Prior 1M (%)", "Chg 1M (bp)");
    if (hasQtrBma) head.push("Prior Qtr (%)", "Chg Qtr (bp)");
    const lines = [head.join("\t")];
    tenors.forEach((t, i) => {
      const curr = ccyData?.rates?.[i], p1m = ccyData?.prior_1m_rates?.[i], prev = ccyData?.prior_rates?.[i];
      const row = [t, num(curr)];
      if (has1mBma) row.push(num(p1m), curr != null && p1m != null ? ((curr - p1m) * 100).toFixed(1) : "");
      if (hasQtrBma) row.push(num(prev), curr != null && prev != null ? ((curr - prev) * 100).toFixed(1) : "");
      lines.push(row.join("\t"));
    });
    return lines.join("\n");
  };
  const buildAllTsv = () => {
    const lines = [["Tenor", ...ccys].join("\t")];
    tenors.forEach((t, i) => lines.push([t, ...ccys.map(c => num(data.currencies?.[c]?.rates?.[i]))].join("\t")));
    return lines.join("\n");
  };

  // Quarter history, tenor-aligned per quarter (newest first). Each quarter
  // carries its own tenor list, so align via per-quarter tenor→value maps.
  const qCols = (data.quarter_history || []).slice(0, 4).map(q => {
    const series = q.currencies?.[selectedCcy]?.[rateType];
    const map = {};
    (q.tenors || []).forEach((t, i) => { map[t] = series?.[i] ?? null; });
    return { label: q.quarter || q.as_of_display || q.as_of_date, asOf: q.as_of_date, map };
  });
  const buildQuartersTsv = () => {
    const lines = [["Tenor", ...qCols.map(q => `${q.label} (${q.asOf})`), "QoQ (bp)"].join("\t")];
    tenors.forEach(t => {
      const vals = qCols.map(q => q.map[t]);
      const qoq = vals[0] != null && vals[1] != null ? ((vals[0] - vals[1]) * 100).toFixed(1) : "";
      lines.push([t, ...vals.map(num), qoq].join("\t"));
    });
    return lines.join("\n");
  };

  return (<div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
    <div style={{ padding: "16px 22px", borderBottom: "1px solid #1e2028" }}>
      <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#f1f5f9" }}>
        <Landmark size={18} style={{ verticalAlign: "middle", marginRight: 8 }} />
        BMA EBS Discount Rates (Quarterly)
      </h3>
      <DataFresh date={data.as_of_date} source={data.source} url={data.url} />
      {data.note && <div style={{ fontSize: 11, color: "#f59e0b", marginTop: 5, lineHeight: 1.5 }}>{data.note}</div>}
      {data.pdf_url && <div style={{ marginTop: 5 }}><a href={data.pdf_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "#60a5fa", textDecoration: "none" }}>Download latest workbook <ExternalLink size={11} style={{ verticalAlign: "middle" }} /></a></div>}
    </div>

    {data.stale && (
      <div style={{ padding: "8px 22px", background: "#1a1206", borderBottom: "1px solid #854d0e", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#fbbf24" }}>
        <AlertTriangle size={13} style={{ flexShrink: 0 }} />
        <span>
          Newer quarter expected ({data.expected_as_of}) — showing {data.as_of_date_iso || data.as_of_date}. BMA blocks automated clients;
          paste the new workbook URL into <code style={{ color: "#fde68a" }}>data/bma_rates_manual.json</code> → <code style={{ color: "#fde68a" }}>known_files</code>.
        </span>
      </div>
    )}

    {/* Currency selector + copy actions */}
    <div style={{ padding: "12px 22px", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", borderBottom: "1px solid #1e2028" }}>
      {ccys.map(ccy => (
        <button key={ccy} onClick={() => setSelectedCcy(ccy)} style={{
          background: selectedCcy === ccy ? "#3b82f6" : "transparent",
          border: `1px solid ${selectedCcy === ccy ? "#3b82f6" : "#2a2d35"}`,
          borderRadius: 6, padding: "6px 16px", fontSize: 13, fontWeight: 700,
          color: selectedCcy === ccy ? "#fff" : "#94a3b8", cursor: "pointer",
          letterSpacing: "0.03em"
        }}>{ccy}</button>
      ))}
      <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
        {hasRates && <CopyTableButton label={`Copy ${selectedCcy} table`} id="ccy" buildText={buildCcyTsv} copied={copied} setCopied={setCopied} />}
        {ccys.length > 1 && <CopyTableButton label="Copy all currencies" id="all" buildText={buildAllTsv} copied={copied} setCopied={setCopied} />}
      </div>
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
              {has1mBma && <th style={{ textAlign: "right", padding: "8px 12px", color: "#818cf8", fontWeight: 700, fontSize: 12 }}>Prior 1M</th>}
              {has1mBma && <th style={{ textAlign: "right", padding: "8px 12px", color: "#818cf8", fontWeight: 700, fontSize: 12 }}>Chg 1M (bp)</th>}
              {hasQtrBma && <th style={{ textAlign: "right", padding: "8px 12px", color: "#34d399", fontWeight: 700, fontSize: 12 }}>Prior Qtr</th>}
              {hasQtrBma && <th style={{ textAlign: "right", padding: "8px 12px", color: "#34d399", fontWeight: 700, fontSize: 12 }}>Chg Qtr (bp)</th>}
            </tr>
          </thead>
          <tbody>
            {tenors.map((t, i) => {
              const curr = ccyData?.rates?.[i];
              const p1m = ccyData?.prior_1m_rates?.[i];
              const prev = ccyData?.prior_rates?.[i];
              const ch1m = curr != null && p1m != null ? ((curr - p1m) * 100).toFixed(1) : null;
              const chQtr = curr != null && prev != null ? ((curr - prev) * 100).toFixed(1) : null;
              const ch1mNum = parseFloat(ch1m);
              const chQtrNum = parseFloat(chQtr);
              return (<tr key={i} style={{ borderBottom: "1px solid #151820" }}>
                <td style={{ padding: "7px 12px", color: "#f1f5f9", fontWeight: 700, fontFamily: "monospace" }}>{t}</td>
                <td style={{ padding: "7px 12px", color: "#f1f5f9", textAlign: "right", fontFamily: "monospace", fontWeight: 600, fontSize: 14 }}>{curr != null ? curr.toFixed(2) + "%" : "—"}</td>
                {has1mBma && <td style={{ padding: "7px 12px", color: "#a5b4fc", textAlign: "right", fontFamily: "monospace" }}>{p1m != null ? p1m.toFixed(2) + "%" : "—"}</td>}
                {has1mBma && <td style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: chgCol(ch1mNum), fontWeight: 600 }}>{ch1m != null ? (ch1mNum > 0 ? "+" : "") + ch1m : "—"}</td>}
                {hasQtrBma && <td style={{ padding: "7px 12px", color: "#6ee7b7", textAlign: "right", fontFamily: "monospace" }}>{prev != null ? prev.toFixed(2) + "%" : "—"}</td>}
                {hasQtrBma && <td style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: chgCol(chQtrNum), fontWeight: 600 }}>{chQtr != null ? (chQtrNum > 0 ? "+" : "") + chQtr : "—"}</td>}
              </tr>);
            })}
          </tbody>
        </table>
      )}
    </div>

    {/* Last 4 quarters history */}
    {qCols.length > 1 && (
      <div style={{ padding: "4px 22px 18px", borderTop: "1px solid #1e2028" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "12px 0 10px" }}>
          <div style={{ fontSize: 12, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Last {qCols.length} Quarters — {selectedCcy}
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {[["standard_spot_rates", "Standard Spot"], ["risk_free_rates", "Risk-Free"]].map(([key, label]) => (
              <button key={key} onClick={() => setRateType(key)} style={{
                background: rateType === key ? "#1e2028" : "transparent",
                border: `1px solid ${rateType === key ? "#475569" : "#2a2d35"}`,
                borderRadius: 5, padding: "3px 10px", fontSize: 11, fontWeight: 600,
                color: rateType === key ? "#f1f5f9" : "#64748b", cursor: "pointer"
              }}>{label}</button>
            ))}
          </div>
          <div style={{ marginLeft: "auto" }}>
            <CopyTableButton label="Copy quarters" id="quarters" buildText={buildQuartersTsv} copied={copied} setCopied={setCopied} />
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #1e2028" }}>
                <th style={{ textAlign: "left", padding: "8px 12px", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Tenor</th>
                {qCols.map((q, qi) => (
                  <th key={q.asOf} style={{ textAlign: "right", padding: "8px 12px", color: qi === 0 ? "#f1f5f9" : "#94a3b8", fontWeight: 700, fontSize: 12 }}>
                    {q.label}<div style={{ fontSize: 10, fontWeight: 500, color: "#475569" }}>{q.asOf}</div>
                  </th>
                ))}
                <th style={{ textAlign: "right", padding: "8px 12px", color: "#34d399", fontWeight: 700, fontSize: 12 }}>QoQ (bp)</th>
              </tr>
            </thead>
            <tbody>
              {tenors.map(t => {
                const vals = qCols.map(q => q.map[t]);
                const qoq = vals[0] != null && vals[1] != null ? ((vals[0] - vals[1]) * 100).toFixed(1) : null;
                const qoqNum = parseFloat(qoq);
                return (
                  <tr key={t} style={{ borderBottom: "1px solid #151820" }}>
                    <td style={{ padding: "7px 12px", color: "#f1f5f9", fontWeight: 700, fontFamily: "monospace" }}>{t}</td>
                    {vals.map((v, vi) => (
                      <td key={vi} style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: vi === 0 ? "#f1f5f9" : "#94a3b8", fontWeight: vi === 0 ? 600 : 400, fontSize: vi === 0 ? 14 : 13 }}>
                        {v != null ? v.toFixed(2) + "%" : "—"}
                      </td>
                    ))}
                    <td style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: chgCol(qoqNum), fontWeight: 600 }}>
                      {qoq != null ? (qoqNum > 0 ? "+" : "") + qoq : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 10, color: "#475569", marginTop: 8 }}>
          {rateType === "standard_spot_rates" ? "Standard approach spot discount rates" : "Risk-free spot rates"} per BMA quarterly EBS workbooks. QoQ compares the two most recent quarters.
        </div>
      </div>
    )}
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
  const termRates = data.term_rates || {};
  const sofrDaily = rates.SOFR || {};
  const yaRate = ya.rate;
  const sofrCurrent = sofrDaily.rate;

  // Safe YoY calc
  const yoyBp = sofrCurrent != null && yaRate != null ? ((sofrCurrent - yaRate) * 100).toFixed(1) : null;

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
        if (!r) return null;
        const chg = r.rate != null && r.prior != null ? ((r.rate - r.prior) * 100).toFixed(1) : null;
        const chgNum = parseFloat(chg);
        return (<div key={key} style={{ background: "#12141a", border: "1px solid #1e2028", borderRadius: 10, padding: "16px 20px" }}>
          <div style={{ fontSize: 12, color: "#94a3b8", fontWeight: 600, marginBottom: 4 }}>{r.name || key}</div>
          <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8 }}>{r.desc || ""}</div>
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
      {yaRate != null && (<div style={{ background: "#12141a", border: "1px solid #1e2028", borderRadius: 10, padding: "16px 20px" }}>
        <div style={{ fontSize: 12, color: "#f59e0b", fontWeight: 600, marginBottom: 4 }}>1 Year Ago</div>
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8 }}>{ya.date || ""}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontSize: 26, fontWeight: 700, color: "#d4a057", fontFamily: "'JetBrains Mono', monospace" }}>
            {yaRate.toFixed(2)}%
          </span>
          {yoyBp != null && (
            <span style={{ fontSize: 13, color: chgCol(parseFloat(yoyBp)), fontWeight: 600, fontFamily: "monospace" }}>
              {parseFloat(yoyBp) > 0 ? "+" : ""}{yoyBp}bp YoY
            </span>
          )}
        </div>
      </div>)}
    </div>

    {/* SOFR average cards (NY Fed compounded averages via FRED) */}
    {Object.keys(termRates).length > 0 && (
      <div style={{ padding: "0 22px 16px" }}>
        <div style={{ fontSize: 11, color: "#64748b", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
          SOFR Averages — Backward-Looking Compounded (NY Fed)
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 12 }}>
          {["1M", "3M", "6M", "1Y"].filter(k => termRates[k]).map(key => {
            const r = termRates[key];
            const chg = r.rate != null && r.prior != null ? ((r.rate - r.prior) * 100).toFixed(1) : null;
            const chgNum = parseFloat(chg);
            return (
              <div key={key} style={{ background: "#12141a", border: "1px solid #2a2d35", borderRadius: 10, padding: "14px 18px" }}>
                <div style={{ fontSize: 12, color: "#818cf8", fontWeight: 600, marginBottom: 2 }}>{r.name}</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6 }}>
                  <span style={{ fontSize: 24, fontWeight: 700, color: "#f1f5f9", fontFamily: "monospace" }}>
                    {r.rate != null ? r.rate.toFixed(2) + "%" : "—"}
                  </span>
                  {chg != null && !isNaN(chgNum) && (
                    <span style={{ fontSize: 12, color: chgCol(chgNum), fontWeight: 600, fontFamily: "monospace" }}>
                      <ChgIcon v={chg} />{Math.abs(chgNum).toFixed(1)}bp
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>
                  Prior: {r.prior != null ? r.prior.toFixed(2) + "%" : "—"} • {r.date || "—"}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    )}

    {/* SOFR + UST history chart — last 12 months */}
    {history.length > 5 && (<div style={{ padding: "8px 14px 16px" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#94a3b8", marginBottom: 8, marginLeft: 8 }}>SOFR &amp; UST — LAST 12 MONTHS</div>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={history}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e2028" />
          <XAxis dataKey="date" tick={{ fill: "#94a3b8", fontSize: 10 }} axisLine={{ stroke: "#1e2028" }} tickLine={false}
            interval="preserveStartEnd"
            tickFormatter={d => {
              const p = (d || "").split("-");
              if (p.length < 3) return d;
              const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
              return mo[parseInt(p[1], 10) - 1] + " '" + p[0].slice(2);
            }} />
          <YAxis tick={{ fill: "#94a3b8", fontSize: 12 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} domain={["auto", "auto"]}
            tickFormatter={v => typeof v === "number" ? v.toFixed(2) + "%" : ""} />
          <Tooltip content={<CTooltip />} />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
          <Line type="monotone" dataKey="rate"   stroke="#60a5fa" strokeWidth={2}   name="SOFR"   dot={false} connectNulls />
          <Line type="monotone" dataKey="ust_3m" stroke="#34d399" strokeWidth={1.5} name="UST 3M" dot={false} connectNulls />
          <Line type="monotone" dataKey="ust_1y" stroke="#f59e0b" strokeWidth={1.5} name="UST 1Y" dot={false} connectNulls />
        </LineChart>
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
            if (!r) return null;
            const ch = r.rate != null && r.prior != null ? ((r.rate - r.prior) * 100).toFixed(1) : null;
            const chNum = parseFloat(ch);
            return (<tr key={key} style={{ borderBottom: "1px solid #151820" }}>
              <td style={{ padding: "7px 12px", color: "#f1f5f9", fontWeight: 600 }}>{r.name || key}</td>
              <td style={{ padding: "7px 12px", color: "#f1f5f9", textAlign: "right", fontFamily: "monospace", fontWeight: 700, fontSize: 14 }}>{r.rate != null ? r.rate.toFixed(4) + "%" : "—"}</td>
              <td style={{ padding: "7px 12px", color: "#94a3b8", textAlign: "right", fontFamily: "monospace" }}>{r.prior != null ? r.prior.toFixed(4) + "%" : "—"}</td>
              <td style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: ch != null ? chgCol(chNum) : "#94a3b8", fontWeight: 600 }}>{ch != null ? (chNum > 0 ? "+" : "") + ch : "—"}</td>
              <td style={{ padding: "7px 12px", color: "#64748b", textAlign: "right", fontSize: 12 }}>{r.date || "—"}</td>
            </tr>);
          })}
          {yaRate != null && (<tr style={{ borderBottom: "1px solid #151820", background: "#111318" }}>
            <td style={{ padding: "7px 12px", color: "#f59e0b", fontWeight: 600 }}>1 Year Ago</td>
            <td style={{ padding: "7px 12px", color: "#d4a057", textAlign: "right", fontFamily: "monospace", fontWeight: 700, fontSize: 14 }}>{yaRate.toFixed(4)}%</td>
            <td colSpan={2} style={{ padding: "7px 12px", textAlign: "right", fontFamily: "monospace", color: yoyBp != null ? chgCol(parseFloat(yoyBp)) : "#94a3b8", fontWeight: 600 }}>
              {yoyBp != null ? (parseFloat(yoyBp) > 0 ? "+" : "") + yoyBp + "bp YoY" : "—"}
            </td>
            <td style={{ padding: "7px 12px", color: "#64748b", textAlign: "right", fontSize: 12 }}>{ya.date || ""}</td>
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
  { id: 5, title: "Global reinsurer completes $1.5B structured credit deal", source: "Ins. Insider", date: "2026-03-19T16:45:00Z", topic: "Structured Credit", summary: "CLO/ABS to Class E insurer." },
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
// COMMODITIES SECTION
// ═══════════════════════════════════════════
const COMMODITY_CONFIGS = {
  gold:   { label: "Gold",       color: "#f59e0b", unit: "USD/troy oz", symbol: "Au" },
  wti:    { label: "WTI Crude",  color: "#64748b", unit: "USD/barrel",  symbol: "WTI" },
  brent:  { label: "Brent Crude",color: "#0ea5e9", unit: "USD/barrel",  symbol: "Brent" },
  usdinr: { label: "USD/INR",    color: "#a78bfa", unit: "INR per USD", symbol: "₹",  isFX: true },
};

const fmtUSD = (v, decimals = 2) => v != null ? `$${v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}` : "—";
const fmtPct = v => v != null ? (v >= 0 ? "+" : "") + v.toFixed(2) + "%" : "—";
const chgUSD = (cur, prior) => cur != null && prior != null ? round2(cur - prior) : null;
const chgPctComm = (cur, prior) => cur != null && prior != null ? round2(((cur - prior) / prior) * 100) : null;
const round2 = v => Math.round(v * 100) / 100;
const commChgCol = v => v == null ? "#64748b" : v > 0 ? "#f87171" : v < 0 ? "#4ade80" : "#64748b";
const futChgCol = v => v == null ? "#64748b" : v > 0 ? "#f87171" : v < 0 ? "#4ade80" : "#64748b";

const COMM_TENOR_ORDER = ["3M", "6M", "12M", "24M"];

const CommoditiesSection = ({ data, loading, error }) => {
  const [sel, setSel] = useState("gold");
  if (loading) return <div style={{ color: "#94a3b8", padding: 40, textAlign: "center" }}>Loading commodities…</div>;
  if (error) return <div style={{ color: "#f87171", padding: 24 }}>Error: {error}</div>;
  if (!data) return <div style={{ color: "#64748b", padding: 24 }}>No commodities data available.</div>;

  const cfg = COMMODITY_CONFIGS[sel];
  const cd = data[sel] || {};
  const { spot, spot_date, unit, prior_1d, prior_1d_date, prior_1m, prior_1m_date, prior_3m, prior_3m_date, prior_1y, prior_1y_date, futures } = cd;

  // FX rates (USD/INR) use 4dp number formatting; commodities use USD currency formatting
  const fmtSpotVal = v => cfg.isFX ? (v != null ? v.toFixed(4) : "—") : fmtUSD(v);
  const fmtChgVal = v => cfg.isFX
    ? (v != null ? (v >= 0 ? "+" : "") + v.toFixed(4) : "—")
    : (v != null ? (v >= 0 ? "+" : "") + fmtUSD(v) : "—");
  const fmtFutVal = v => cfg.isFX ? (v != null ? v.toFixed(4) : "—") : fmtUSD(v);
  const fmtFutChgVal = v => cfg.isFX ? (v != null ? (v >= 0 ? "+" : "") + v.toFixed(4) : "—") : (v != null ? (v >= 0 ? "+" : "") + fmtUSD(v) : "—");

  const chg1d  = chgUSD(spot, prior_1d);
  const chg1m = chgUSD(spot, prior_1m);
  const chg3m = chgUSD(spot, prior_3m);
  const chg1y = chgUSD(spot, prior_1y);
  const pct1d  = chgPctComm(spot, prior_1d);
  const pct1m = chgPctComm(spot, prior_1m);
  const pct3m = chgPctComm(spot, prior_3m);
  const pct1y = chgPctComm(spot, prior_1y);

  // Fixed-order futures rows with prior prices
  const futureRows = COMM_TENOR_ORDER
    .filter(t => futures?.[t])
    .map(t => {
      const f = futures[t];
      return {
        tenor: t,
        price: f.price,
        expiry: f.expiry,
        contract: f.contract,
        prior_1m: f.prior_1m,
        prior_1m_date: f.prior_1m_date,
        prior_3m: f.prior_3m,
        prior_3m_date: f.prior_3m_date,
        vsSpot: spot != null && f.price != null ? round2(f.price - spot) : null,
        vsSpotPct: spot != null && f.price != null ? round2(((f.price - spot) / spot) * 100) : null,
        chg1m: chgUSD(f.price, f.prior_1m),
        chg3m: chgUSD(f.price, f.prior_3m),
      };
    });

  // Forward premium chart: % above/below spot at each tenor — shows market expectation
  // Spot is always 0% (the reference); lines show how much market is pricing in vs spot
  const prem = (fwd, ref) => fwd != null && ref != null && ref !== 0 ? round2(((fwd - ref) / ref) * 100) : null;
  const premData = [
    { tenor: "Spot", curr: 0, m1: prior_1m != null ? 0 : null, m3: prior_3m != null ? 0 : null },
    ...COMM_TENOR_ORDER.map(t => {
      const f = futures?.[t] || {};
      return {
        tenor: t,
        curr: prem(f.price,    spot),
        m1:   prem(f.prior_1m, prior_1m),
        m3:   prem(f.prior_3m, prior_3m),
      };
    }),
  ];
  const hasCurrPrem = premData.some(d => d.curr != null && d.tenor !== "Spot");
  const has1mPrem   = premData.some(d => d.m1   != null && d.tenor !== "Spot");
  const has3mPrem   = premData.some(d => d.m3   != null && d.tenor !== "Spot");
  const hasPremChart = hasCurrPrem || has1mPrem || has3mPrem;
  const has1mFut = futureRows.some(r => r.prior_1m != null);
  const has3mFut = futureRows.some(r => r.prior_3m != null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Commodity selector */}
      <div style={{ display: "flex", gap: 8 }}>
        {Object.entries(COMMODITY_CONFIGS).map(([key, c]) => (
          <button key={key} onClick={() => setSel(key)} style={{
            padding: "8px 20px", borderRadius: 8, border: `1px solid ${sel === key ? c.color : "#334155"}`,
            background: sel === key ? c.color + "22" : "transparent",
            color: sel === key ? c.color : "#94a3b8", fontWeight: sel === key ? 700 : 500,
            fontSize: 13, cursor: "pointer"
          }}>{c.label}</button>
        ))}
      </div>

      {/* Spot price card */}
      <div style={{ background: "#0d0f14", border: `1px solid ${cfg.color}44`, borderRadius: 10, padding: "20px 24px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 12, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
              {cfg.label} Spot — {unit}
            </div>
            <div style={{ fontSize: 36, fontWeight: 800, color: cfg.color, fontFamily: "monospace", letterSpacing: "-0.02em" }}>
              {fmtSpotVal(spot)}
            </div>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>{spot_date || "—"}</div>
          </div>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginLeft: "auto" }}>
            {[
              { label: "vs 1D ago", chg: chg1d,  pct: pct1d,  date: prior_1d_date },
              { label: "vs 1M ago", chg: chg1m, pct: pct1m, date: prior_1m_date },
              { label: "vs 3M ago", chg: chg3m, pct: pct3m, date: prior_3m_date },
              { label: "vs 1Y ago", chg: chg1y, pct: pct1y, date: prior_1y_date },
            ].map(({ label, chg, pct, date }) => (
              <div key={label} style={{ textAlign: "center", minWidth: 90 }}>
                <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4, fontWeight: 600 }}>{label}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: commChgCol(chg), fontFamily: "monospace" }}>
                  {fmtChgVal(chg)}
                </div>
                <div style={{ fontSize: 12, color: commChgCol(pct), fontFamily: "monospace" }}>{fmtPct(pct)}</div>
                {date && <div style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>{date}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Forward Premium Chart: % above/below spot at each tenor */}
      {hasPremChart && <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: "16px 16px 8px" }}>
        <h3 style={{ margin: "0 0 4px 8px", fontSize: 14, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Forward Premium — % vs Spot
        </h3>
        <div style={{ marginLeft: 8, marginBottom: 10, fontSize: 11, color: "#64748b" }}>
          Each line anchors at 0% (spot) and shows the market's priced-in premium / discount at each tenor. Positive = contango; negative = backwardation.
        </div>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={premData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e2028" />
            <XAxis dataKey="tenor" tick={{ fill: "#94a3b8", fontSize: 12 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} />
            <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={{ stroke: "#1e2028" }} tickLine={false}
              domain={["auto", "auto"]}
              tickFormatter={v => typeof v === "number" ? (v >= 0 ? "+" : "") + v.toFixed(2) + "%" : ""}
              width={72} />
            <Tooltip
              formatter={(v, name) => [v != null ? (v >= 0 ? "+" : "") + v.toFixed(2) + "%" : "—", name]}
              contentStyle={{ background: "#1e2028", border: "1px solid #334155", borderRadius: 6, fontSize: 12 }}
              labelStyle={{ color: "#f1f5f9", fontWeight: 700 }} />
            <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
            {hasCurrPrem && <Line type="monotone" dataKey="curr" stroke={cfg.color} strokeWidth={2.5} name="Current" dot={{ r: 4, fill: cfg.color }} connectNulls />}
            {has1mPrem   && <Line type="monotone" dataKey="m1"   stroke="#818cf8" strokeWidth={1.5} strokeDasharray="5 3" name="1M Ago" dot={{ r: 3 }} connectNulls />}
            {has3mPrem   && <Line type="monotone" dataKey="m3"   stroke="#34d399" strokeWidth={1.5} strokeDasharray="5 3" name="3M Ago" dot={{ r: 3 }} connectNulls />}
          </LineChart>
        </ResponsiveContainer>
      </div>}

      {/* Futures strip table */}
      <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "12px 20px", borderBottom: "1px solid #1e2028" }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.08em" }}>Futures Strip</h3>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #1e2028" }}>
                <th style={{ padding: "10px 14px", textAlign: "left", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Tenor</th>
                <th style={{ padding: "10px 14px", textAlign: "left", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Contract</th>
                <th style={{ padding: "10px 14px", textAlign: "left", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Expiry</th>
                <th style={{ padding: "10px 14px", textAlign: "right", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>Price</th>
                <th style={{ padding: "10px 14px", textAlign: "right", color: "#94a3b8", fontWeight: 700, fontSize: 12 }}>vs Spot</th>
                {has1mFut && <th style={{ padding: "10px 14px", textAlign: "right", color: "#818cf8", fontWeight: 700, fontSize: 12 }}>Prior 1M</th>}
                {has1mFut && <th style={{ padding: "10px 14px", textAlign: "right", color: "#818cf8", fontWeight: 700, fontSize: 12 }}>1M Chg</th>}
                {has3mFut && <th style={{ padding: "10px 14px", textAlign: "right", color: "#34d399", fontWeight: 700, fontSize: 12 }}>Prior 3M</th>}
                {has3mFut && <th style={{ padding: "10px 14px", textAlign: "right", color: "#34d399", fontWeight: 700, fontSize: 12 }}>3M Chg</th>}
              </tr>
            </thead>
            <tbody>
              {futureRows.length === 0 ? (
                <tr><td colSpan={9} style={{ padding: "20px 14px", textAlign: "center", color: "#64748b" }}>No futures data available</td></tr>
              ) : futureRows.map((row, i) => (
                <tr key={row.tenor} style={{ borderBottom: "1px solid #151820", background: i % 2 === 0 ? "transparent" : "#0a0c10" }}>
                  <td style={{ padding: "9px 14px", fontWeight: 700, color: cfg.color, fontFamily: "monospace" }}>{row.tenor}</td>
                  <td style={{ padding: "9px 14px", color: "#94a3b8", fontFamily: "monospace", fontSize: 12 }}>{row.contract || "—"}</td>
                  <td style={{ padding: "9px 14px", color: "#cbd5e1", fontSize: 12 }}>{row.expiry || "—"}</td>
                  <td style={{ padding: "9px 14px", textAlign: "right", fontFamily: "monospace", fontWeight: 600, color: "#f1f5f9" }}>{fmtFutVal(row.price)}</td>
                  <td style={{ padding: "9px 14px", textAlign: "right", fontFamily: "monospace", color: futChgCol(row.vsSpot) }}>
                    {fmtFutChgVal(row.vsSpot)}
                  </td>
                  {has1mFut && <td style={{ padding: "9px 14px", textAlign: "right", fontFamily: "monospace", color: "#94a3b8" }}>{fmtFutVal(row.prior_1m)}</td>}
                  {has1mFut && <td style={{ padding: "9px 14px", textAlign: "right", fontFamily: "monospace", color: commChgCol(row.chg1m) }}>
                    {fmtFutChgVal(row.chg1m)}
                  </td>}
                  {has3mFut && <td style={{ padding: "9px 14px", textAlign: "right", fontFamily: "monospace", color: "#94a3b8" }}>{fmtFutVal(row.prior_3m)}</td>}
                  {has3mFut && <td style={{ padding: "9px 14px", textAlign: "right", fontFamily: "monospace", color: commChgCol(row.chg3m) }}>
                    {fmtFutChgVal(row.chg3m)}
                  </td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "10px 20px", fontSize: 11, color: "#475569", borderTop: "1px solid #151820" }}>
          FRED (spot) / Yahoo Finance (futures) • Contango = futures &gt; spot (red) • Backwardation = futures &lt; spot (green) • 1M/3M prior = same contract price at that date
        </div>
      </div>

      <div style={{ fontSize: 11, color: "#475569" }}>
        Source: {data.source || "FRED / Yahoo Finance"} • {data.date || "—"}
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════
const PAGES = [
  { id: "home", label: "Overview", icon: Activity }, { id: "ust", label: "US Treasuries", icon: DollarSign },
  { id: "jgb", label: "Japan JGB", icon: CurrencySymbolIcon("¥") }, { id: "gilt", label: "UK Gilts", icon: CurrencySymbolIcon("£") },
  { id: "eiopa", label: "EIOPA EUR", icon: CurrencySymbolIcon("€") }, { id: "india", label: "India Govt", icon: CurrencySymbolIcon("₹") },
  { id: "bma_rates", label: "BMA Rates", icon: Landmark },
  { id: "commodities", label: "Commodities", icon: Gem },
  { id: "sofr", label: "SOFR", icon: TrendingUp },
  { id: "credit", label: "Credit Spreads", icon: Percent },
  { id: "cds", label: "CDS Spreads", icon: BarChart3 },
  { id: "news", label: "News", icon: Newspaper }, { id: "bma", label: "BMA Updates", icon: Shield },
];
const FILES = { ust: "ust.json", jgb: "jgb.json", gilt: "gilt.json", eiopa: "eur.json", india: "india.json", credit: "credit.json", cds: "cds.json", sofr: "sofr.json", bma_rates: "bma_rates.json", commodities: "commodities.json", debt_maturity: "debt_maturity.json" };

// ── Source health (data/source_health.json written by the pipeline) ──
const HEALTH_COLORS = { active: "#4ade80", fallback: "#fbbf24", stagnant: "#f87171" };
const HEALTH_LABELS = { active: "live", fallback: "fallback", stagnant: "stagnant" };

const SourceHealthIndicator = ({ health }) => {
  const [open, setOpen] = useState(false);
  if (!health?.sources?.length) return null;
  const s = health.summary || {};
  const total = (s.active || 0) + (s.fallback || 0) + (s.stagnant || 0);
  const color = (s.stagnant || 0) > 0 ? "#f87171" : (s.fallback || 0) > 0 ? "#fbbf24" : "#4ade80";
  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen(!open)} title="Data source health"
        style={{ background: "transparent", border: `1px solid ${color}55`, borderRadius: 7, padding: "5px 10px", color, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, display: "inline-block" }} />
        {s.active || 0}/{total} sources live
      </button>
      {open && (
        <div style={{ position: "absolute", right: 0, top: "130%", zIndex: 50, background: "#12141a", border: "1px solid #2a2d35", borderRadius: 8, padding: "10px 0", width: 380, maxHeight: 400, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
          <div style={{ padding: "0 14px 8px", borderBottom: "1px solid #1e2028", fontSize: 11, color: "#94a3b8" }}>
            Upstream data sources — last pipeline run{health.updated ? ` ${new Date(health.updated).toLocaleString()}` : ""}
          </div>
          {health.sources.map(src => (
            <div key={src.source} style={{ padding: "8px 14px", borderBottom: "1px solid #151820" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: HEALTH_COLORS[src.status] || "#64748b", flexShrink: 0 }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: "#f1f5f9" }}>{src.source}</span>
                <Badge color={HEALTH_COLORS[src.status] || "#64748b"}>{HEALTH_LABELS[src.status] || src.status}</Badge>
                {src.fallback && <span style={{ fontSize: 10, color: "#fbbf24" }}>→ {src.fallback}</span>}
              </div>
              <div style={{ fontSize: 11, color: "#64748b", marginTop: 3, marginLeft: 15 }}>{src.feeds}</div>
              {src.last_success && (
                <div style={{ fontSize: 10, color: "#475569", marginTop: 2, marginLeft: 15 }}>last success: {src.last_success.slice(0, 16).replace("T", " ")} UTC</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

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
  const [health, setHealth] = useState(null);

  useEffect(() => { const t = setInterval(() => setClock(new Date().toLocaleTimeString("en-US", { hour12: false })), 1000); setClock(new Date().toLocaleTimeString("en-US", { hour12: false })); return () => clearInterval(t); }, []);

  const loadData = useCallback(async () => {
    setGLoad(true); const newLs = {}, newErrs = {}, newData = {};
    Object.keys(FILES).forEach(k => newLs[k] = true); setLs(newLs); setErrs({});
    try { setManifest(await loadJson("manifest.json")); } catch {}
    try { setHealth(await loadJson("source_health.json")); } catch {}
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
      case "ust": return <SovSection data={data.ust} title="US Treasury Par Yield Curve" accentColor="#3b82f6" loading={ls.ust} error={errs.ust} wamData={data.debt_maturity?.countries?.usa} />;
      case "jgb": return <SovSection data={data.jgb} title="Japan Government Bond Yields" accentColor="#ef4444" loading={ls.jgb} error={errs.jgb} wamData={data.debt_maturity?.countries?.japan} />;
      case "gilt": return <SovSection data={data.gilt} title="UK Gilt Nominal Par Yields" accentColor="#22c55e" loading={ls.gilt} error={errs.gilt} wamData={data.debt_maturity?.countries?.uk} />;
      case "eiopa": return <SovSection data={data.eiopa} title="EUR Govt Yield Curve (EIOPA proxy)" accentColor="#f59e0b" loading={ls.eiopa} error={errs.eiopa} wamData={data.debt_maturity?.countries?.eur} />;
      case "india": return <SovSection data={data.india} title="India Government Bond Yields" accentColor="#ec4899" loading={ls.india} error={errs.india} wamData={data.debt_maturity?.countries?.india} />;
      case "bma_rates": return <BmaRatesSection data={data.bma_rates} loading={ls.bma_rates} error={errs.bma_rates} />;
      case "commodities": return <CommoditiesSection data={data.commodities} loading={ls.commodities} error={errs.commodities} />;
      case "sofr": return <SofrSection data={data.sofr} loading={ls.sofr} error={errs.sofr} />;
      case "credit": return <CreditSection data={data.credit} loading={ls.credit} error={errs.credit} />;
      case "cds": return <CDSSection data={data.cds} loading={ls.cds} error={errs.cds} />;
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
            <MetricCard label="Gold (spot)" value={data.commodities?.gold?.spot != null ? fmtUSD(data.commodities.gold.spot) : "—"} change={data.commodities?.gold?.spot != null && data.commodities?.gold?.prior_1m != null ? (chgUSD(data.commodities.gold.spot, data.commodities.gold.prior_1m) >= 0 ? "+" : "") + fmtUSD(chgUSD(data.commodities.gold.spot, data.commodities.gold.prior_1m)) + " 1M" : null} loading={ls.commodities} />
            <MetricCard label="WTI (spot)" value={data.commodities?.wti?.spot != null ? fmtUSD(data.commodities.wti.spot) : "—"} change={data.commodities?.wti?.spot != null && data.commodities?.wti?.prior_1m != null ? (chgUSD(data.commodities.wti.spot, data.commodities.wti.prior_1m) >= 0 ? "+" : "") + fmtUSD(chgUSD(data.commodities.wti.spot, data.commodities.wti.prior_1m)) + " 1M" : null} loading={ls.commodities} />
            <MetricCard label="USD/INR (spot)" value={data.commodities?.usdinr?.spot != null ? data.commodities.usdinr.spot.toFixed(4) : "—"} change={data.commodities?.usdinr?.spot != null && data.commodities?.usdinr?.prior_1m != null ? (chgUSD(data.commodities.usdinr.spot, data.commodities.usdinr.prior_1m) >= 0 ? "+" : "") + chgUSD(data.commodities.usdinr.spot, data.commodities.usdinr.prior_1m).toFixed(4) + " 1M" : null} loading={ls.commodities} />
          </div>
        </div>

        {/* Global Curve */}
        {hasCurve && <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: "16px 16px 8px" }}>
          <h3 style={{ margin: "0 0 12px 8px", fontSize: 14, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em" }}>Global Yield Curve Comparison</h3>
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={mc}><CartesianGrid strokeDasharray="3 3" stroke="#1e2028" /><XAxis dataKey="tenor" tick={{ fill: "#94a3b8", fontSize: 12 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} /><YAxis tick={{ fill: "#94a3b8", fontSize: 12 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} domain={[0, "auto"]} tickFormatter={v => typeof v === "number" ? v.toFixed(1) + "%" : ""} /><Tooltip content={<CTooltip />} />
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

        {/* Govt Debt WAM */}
        <WamComparisonSection data={data.debt_maturity} loading={ls.debt_maturity} error={errs.debt_maturity} />

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
        {sidebarOpen && <div><div style={{ fontSize: 14, fontWeight: 800, color: "#f1f5f9", letterSpacing: "-0.02em", lineHeight: 1.1 }}>{PLATFORM_NAME.toUpperCase()}</div><div style={{ fontSize: 10, fontWeight: 700, color: "#22d3ee", letterSpacing: "0.18em", textTransform: "uppercase", textShadow: "0 0 10px rgba(34,211,238,0.35)" }}>{TOOL_NAME}</div></div>}
      </div>
      <div style={{ flex: 1, padding: "8px 7px", overflowY: "auto" }}>{PAGES.map(p => { const Icon = p.icon; const a = page === p.id; return <button key={p.id} onClick={() => setPage(p.id)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 11, padding: sidebarOpen ? "9px 12px" : "9px", marginBottom: 2, borderRadius: 7, border: "none", background: a ? "#1e2028" : "transparent", color: a ? "#f1f5f9" : "#94a3b8", cursor: "pointer", fontSize: 13, fontWeight: a ? 600 : 500, textAlign: "left", justifyContent: sidebarOpen ? "flex-start" : "center" }} onMouseEnter={e => { if (!a) e.currentTarget.style.background = "#12141a" }} onMouseLeave={e => { if (!a) e.currentTarget.style.background = "transparent" }}><Icon size={16} style={{ flexShrink: 0 }} />{sidebarOpen && <span>{p.label}</span>}</button>; })}</div>
      {sidebarOpen && <div style={{ padding: "12px 16px", borderTop: "1px solid #1a1d23", fontSize: 11, color: "#475569" }}>Data via GitHub Actions</div>}
    </div>

    {/* Main */}
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ height: 46, padding: "0 22px", borderBottom: "1px solid #1a1d23", background: "#0a0c12", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#f1f5f9" }}>{PAGES.find(p => p.id === page)?.label || "Overview"}</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12 }}>
          <SourceHealthIndicator health={health} />
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
        <div style={{ display: "flex", gap: 16 }}>{ust10y != null && <span>UST 10Y: {fmtY(ust10y)}</span>}{jgb10y != null && <span>JGB 10Y: {fmtY(jgb10y)}</span>}{gilt10y != null && <span>Gilt 10Y: {fmtY(gilt10y)}</span>}{india10y != null && <span>India 10Y: {fmtY(india10y)}</span>}{sofrRate != null && <span>SOFR: {sofrRate.toFixed(2)}%</span>}{igS != null && <span>IG: {igS}bp</span>}{hyS != null && <span>HY: {hyS}bp</span>}{data.cds?.sovereign?.us_5y?.spread != null && <span>US CDS: {data.cds.sovereign.us_5y.spread}bp</span>}{data.commodities?.usdinr?.spot != null && <span>USD/INR: {data.commodities.usdinr.spot.toFixed(4)}</span>}</div>
        <span>{PLATFORM_NAME} • {TOOL_NAME} • v9</span>
      </div>
    </div>
  </div>);
}

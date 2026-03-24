import { useState, useEffect, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, AreaChart, Area, Legend
} from "recharts";
import {
  Globe, Shield, Newspaper, BarChart3, ChevronRight, ExternalLink,
  Clock, RefreshCw, Activity, DollarSign, Percent, ArrowUpRight,
  ArrowDownRight, Minus, AlertTriangle, Loader, Settings, Key, CheckCircle
} from "lucide-react";

/* ═══════════════════════════════════════════════════════════════════
   BERMUDA MARKET INTELLIGENCE TERMINAL v7
   
   Reads data/*.json committed by GitHub Actions.
   Refresh button: triggers GitHub Actions workflow → waits → reloads.
   Settings: GitHub PAT for triggering workflows.
   ═══════════════════════════════════════════════════════════════════ */

const DATA_BASE = import.meta.env.BASE_URL + "data/";

async function loadJson(file) {
  const res = await fetch(`${DATA_BASE}${file}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return res.json();
}

// Detect repo from GitHub Pages URL: https://user.github.io/repo-name/
function detectRepo() {
  try {
    const host = window.location.hostname;
    const path = window.location.pathname.split("/").filter(Boolean);
    if (host.endsWith(".github.io")) {
      const owner = host.replace(".github.io", "");
      const repo = path[0] || "";
      if (owner && repo) return { owner, repo };
    }
  } catch {}
  return null;
}

// Trigger GitHub Actions workflow via API
async function triggerWorkflow(token) {
  const repoInfo = detectRepo();
  if (!repoInfo) throw new Error("Cannot detect repo from URL. Are you on GitHub Pages?");
  const { owner, repo } = repoInfo;
  // List workflows to find ours
  const wfRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows`, {
    headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" },
  });
  if (!wfRes.ok) throw new Error(`GitHub API: ${wfRes.status} — check your PAT`);
  const wfData = await wfRes.json();
  // Find our workflow
  const wf = wfData.workflows?.find(w => w.name.includes("Refresh") || w.name.includes("Deploy") || w.path?.includes("deploy"));
  if (!wf) throw new Error("No matching workflow found. Name must contain 'Refresh' or 'Deploy'.");
  // Dispatch it
  const dispRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${wf.id}/dispatches`, {
    method: "POST",
    headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main" }),
  });
  if (!dispRes.ok) {
    const body = await dispRes.text().catch(() => "");
    throw new Error(`Dispatch failed: ${dispRes.status} ${body.slice(0, 100)}`);
  }
  return { owner, repo, workflow: wf.name };
}

// ── Utilities ──
const fmtY = v => v != null ? v.toFixed(2) + "%" : "—";
const chgBp = (c, p) => c != null && p != null ? ((c - p) * 100).toFixed(1) : null;
const chgCol = v => v > 0 ? "#ef4444" : v < 0 ? "#22c55e" : "#64748b";
const ChgIcon = ({ v }) => { const n = parseFloat(v); return n > 0 ? <ArrowUpRight size={14} /> : n < 0 ? <ArrowDownRight size={14} /> : <Minus size={14} />; };
const timeAgo = ds => { const h = Math.floor((Date.now() - new Date(ds)) / 36e5); if (h < 1) return "Now"; if (h < 24) return h + "h ago"; const d = Math.floor(h / 24); return d < 7 ? d + "d" : new Date(ds).toLocaleDateString("en-US", { month: "short", day: "numeric" }); };

// ── Shared Components ──

const Badge = ({ children, color = "#3b82f6" }) => (
  <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", padding: "2px 8px", borderRadius: 4, background: color + "18", color, whiteSpace: "nowrap" }}>{children}</span>
);

const DataFresh = ({ date, source, url }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#64748b", flexWrap: "wrap", marginTop: 4 }}>
    <Clock size={12} /><span>As of {date || "—"}</span>
    {source && <><span style={{ color: "#334155" }}>|</span>
      <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "#3b82f6", textDecoration: "none", display: "flex", alignItems: "center", gap: 3 }}>{source} <ExternalLink size={10} /></a></>}
  </div>
);

const CTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (<div style={{ background: "#1a1d23", border: "1px solid #2a2d35", borderRadius: 6, padding: "10px 14px", fontSize: 12 }}>
    <div style={{ color: "#94a3b8", marginBottom: 4, fontWeight: 600 }}>{label}</div>
    {payload.filter(p => p.value != null).map((p, i) => (
      <div key={i} style={{ color: p.color, display: "flex", gap: 8, alignItems: "center", marginBottom: 2 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: p.color, display: "inline-block" }} />
        <span>{p.name}: {p.value?.toFixed(2)}%</span>
      </div>
    ))}
  </div>);
};

const MetricCard = ({ label, value, change, loading: ld }) => {
  const n = parseFloat(change);
  return (<div style={{ background: "#12141a", border: "1px solid #1e2028", borderRadius: 8, padding: "14px 18px", minWidth: 160 }}>
    <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>{label}</div>
    {ld ? <Loader size={16} style={{ color: "#3b82f6", animation: "spin 1s linear infinite" }} /> :
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace" }}>{value}</span>
        {change != null && !isNaN(n) && <span style={{ fontSize: 12, color: chgCol(n), display: "flex", alignItems: "center", gap: 2, fontWeight: 600, fontFamily: "monospace" }}><ChgIcon v={change} />{Math.abs(n).toFixed(1)}bp</span>}
      </div>}
  </div>);
};

// ── Sovereign Section ──
const SovSection = ({ data, title, accentColor, loading: ld, error }) => {
  if (ld) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 40, textAlign: "center", color: "#64748b" }}><Loader size={24} style={{ animation: "spin 1s linear infinite", margin: "0 auto 10px", display: "block", color: "#3b82f6" }} />Loading {title}…</div>;
  if (error) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 20 }}><h3 style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>{title}</h3><div style={{ color: "#ef4444", fontSize: 12 }}><AlertTriangle size={14} style={{ verticalAlign: "middle", marginRight: 6 }} />{error}</div></div>;
  if (!data) return null;
  const cd = data.tenors.map((t, i) => ({ tenor: t, current: data.yields[i], prior: data.prior_yields?.[i],
    change: data.yields[i] != null && data.prior_yields?.[i] != null ? ((data.yields[i] - data.prior_yields[i]) * 100).toFixed(1) : null }));
  const hasPrior = data.prior_yields?.some(v => v != null);
  return (<div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
    <div style={{ padding: "14px 20px", borderBottom: "1px solid #1e2028" }}>
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>{title}</h3>
      <DataFresh date={data.date} source={data.source} url={data.url} />
      {data.note && <div style={{ fontSize: 10, color: "#f59e0b", marginTop: 4 }}>{data.note}</div>}
    </div>
    <div style={{ padding: "12px 12px 4px" }}>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={cd}>
          <defs><linearGradient id={`g${accentColor.slice(1)}`} x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={accentColor} stopOpacity={0.25} /><stop offset="95%" stopColor={accentColor} stopOpacity={0} /></linearGradient></defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1a1d23" /><XAxis dataKey="tenor" tick={{ fill: "#64748b", fontSize: 11 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} />
          <YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} domain={["auto", "auto"]} tickFormatter={v => v?.toFixed(1)} />
          <Tooltip content={<CTooltip />} /><Area type="monotone" dataKey="current" stroke={accentColor} strokeWidth={2.5} fill={`url(#g${accentColor.slice(1)})`} name="Current" dot={{ r: 3, fill: accentColor }} connectNulls />
          {hasPrior && <Line type="monotone" dataKey="prior" stroke="#475569" strokeWidth={1.5} strokeDasharray="5 5" name="Prior" dot={false} connectNulls />}
        </AreaChart>
      </ResponsiveContainer>
    </div>
    <div style={{ padding: "0 20px 14px", overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead><tr style={{ borderBottom: "1px solid #1e2028" }}>{["Tenor", "Yield", "Prior", "Chg (bp)"].map(h => <th key={h} style={{ textAlign: h === "Tenor" ? "left" : "right", padding: "6px 10px", color: "#64748b", fontWeight: 600, fontSize: 11 }}>{h}</th>)}</tr></thead>
        <tbody>{cd.map((r, i) => { const ch = parseFloat(r.change); return (<tr key={i} style={{ borderBottom: "1px solid #13151b" }}>
          <td style={{ padding: "5px 10px", color: "#e2e8f0", fontWeight: 600, fontFamily: "monospace" }}>{r.tenor}</td>
          <td style={{ padding: "5px 10px", color: "#e2e8f0", textAlign: "right", fontFamily: "monospace" }}>{fmtY(r.current)}</td>
          <td style={{ padding: "5px 10px", color: "#94a3b8", textAlign: "right", fontFamily: "monospace" }}>{fmtY(r.prior)}</td>
          <td style={{ padding: "5px 10px", textAlign: "right", fontFamily: "monospace", color: chgCol(ch), fontWeight: 600 }}>{r.change != null ? (ch > 0 ? "+" : "") + r.change : "—"}</td>
        </tr>); })}</tbody>
      </table>
    </div>
  </div>);
};

// ── Credit Section ──
const CreditSection = ({ data, loading: ld, error }) => {
  if (ld) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 40, textAlign: "center", color: "#64748b" }}><Loader size={24} style={{ animation: "spin 1s linear infinite", margin: "0 auto 10px", display: "block", color: "#3b82f6" }} />Loading…</div>;
  if (error) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 20 }}><h3 style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>Credit Spreads</h3><div style={{ color: "#ef4444", fontSize: 12 }}><AlertTriangle size={14} style={{ verticalAlign: "middle", marginRight: 6 }} />{error}</div></div>;
  if (!data) return null;
  const entries = Object.values(data.spreads || {}).filter(e => e.spread != null);
  return (<div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
    <div style={{ padding: "14px 20px", borderBottom: "1px solid #1e2028" }}>
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>US Corporate Credit Spreads (OAS)</h3>
      <DataFresh date={data.date} source={data.source} url={data.url} />
    </div>
    <div style={{ padding: "8px 20px", overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead><tr style={{ borderBottom: "1px solid #1e2028" }}>{["Index", "OAS (bp)", "Prior", "Chg"].map(h => <th key={h} style={{ textAlign: h === "Index" ? "left" : "right", padding: "6px 10px", color: "#64748b", fontWeight: 600, fontSize: 11 }}>{h}</th>)}</tr></thead>
        <tbody>{entries.map((r, i) => { const c = (r.spread || 0) - (r.prior || 0); return (<tr key={i} style={{ borderBottom: "1px solid #13151b" }}>
          <td style={{ padding: "6px 10px", color: "#e2e8f0", fontWeight: 600 }}>{r.name} <Badge color={["HY", "BB", "B", "CCC"].includes(r.bucket) ? "#ef4444" : "#22c55e"}>{r.bucket}</Badge></td>
          <td style={{ padding: "6px 10px", color: "#e2e8f0", textAlign: "right", fontFamily: "monospace", fontWeight: 700 }}>{r.spread}</td>
          <td style={{ padding: "6px 10px", color: "#94a3b8", textAlign: "right", fontFamily: "monospace" }}>{r.prior || "—"}</td>
          <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "monospace", color: chgCol(c * -1), fontWeight: 600 }}>{r.prior ? (c > 0 ? "+" : "") + c : "—"}</td>
        </tr>); })}</tbody>
      </table>
    </div>
  </div>);
};

// ── News + BMA (curated) ──
const NEWS = [
  { id: 1, title: "UK gilt 10Y hits 5% for first time since 2008", source: "CNBC", date: "2026-03-20T09:30:00Z", topic: "Rates & Macro", summary: "Energy surge + hawkish BOE." },
  { id: 2, title: "BOJ holds; Takata dissents, calls for 25bp hike", source: "Reuters", date: "2026-03-19T08:00:00Z", topic: "Rates & Macro", summary: "Ueda signals possible rate hike." },
  { id: 3, title: "Apollo raises $8.2B for insurance private credit", source: "Reuters", date: "2026-03-20T14:30:00Z", topic: "Private Credit", summary: "IG private placements for insurance." },
  { id: 4, title: "BOE holds at 3.75%; inflation warning from conflict", source: "FT", date: "2026-03-20T10:00:00Z", topic: "Rates & Macro", summary: "Markets price in rate hikes." },
  { id: 5, title: "Bermuda reinsurer completes $1.5B structured credit deal", source: "Ins. Insider", date: "2026-03-19T16:45:00Z", topic: "Structured Credit", summary: "CLO/ABS to Class E insurer." },
  { id: 6, title: "NAIC proposes enhanced private credit reporting", source: "AM Best", date: "2026-03-19T14:20:00Z", topic: "Insurance AM", summary: "More transparency on illiquid assets." },
];
const BMA_D = [
  { id: 1, title: "Notice – Pre-Approval for New Insurance Registrations", date: "2026-03-19", cat: "Licensing", summary: "Updated Class D/E requirements.", isNew: true },
  { id: 2, title: "Notice – Regulatory Burden Reduction", date: "2026-02-19", cat: "Governance", summary: "Streamlined reporting.", isNew: true },
  { id: 3, title: "Notice – 2025 Year-End BSCR Model Republication", date: "2026-02-18", cat: "Capital/Solvency", summary: "Republished BSCR with validation.", isNew: true },
  { id: 4, title: "DP – AI Governance Framework", date: "2026-02-09", cat: "Governance", summary: "Final proposal Q3 2026.", isNew: true },
  { id: 5, title: "CP – Prudent Person Principle", date: "2025-12-15", cat: "Investment", summary: "PPP guidance for NPTA.", isNew: false },
  { id: 6, title: "Class C,D,E Solvency Amendment Rules 2025", date: "2025-12-01", cat: "Capital/Solvency", summary: "New A&L disclosure.", isNew: false },
];
const TC = { "Private Credit": "#8b5cf6", "Rates & Macro": "#22c55e", "Structured Credit": "#f59e0b", "Insurance AM": "#ec4899" };
const CC = { "Capital/Solvency": "#ef4444", Investment: "#f59e0b", Governance: "#8b5cf6", Licensing: "#22c55e" };

const NewsSection = () => { const topics = [...new Set(NEWS.map(n => n.topic))]; const [sel, setSel] = useState("All"); const filtered = sel === "All" ? NEWS : NEWS.filter(n => n.topic === sel); return (<div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}><div style={{ padding: "14px 20px", borderBottom: "1px solid #1e2028" }}><h3 style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}><Newspaper size={16} style={{ verticalAlign: "middle", marginRight: 8 }} /> News</h3><div style={{ fontSize: 11, color: "#f59e0b", marginBottom: 8 }}><AlertTriangle size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />Curated — live RSS via GitHub Actions (Phase 2).</div><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{["All", ...topics].map(t => <button key={t} onClick={() => setSel(t)} style={{ background: sel === t ? (TC[t] || "#3b82f6") : "transparent", border: `1px solid ${sel === t ? (TC[t] || "#3b82f6") : "#2a2d35"}`, borderRadius: 20, padding: "4px 14px", fontSize: 11, color: sel === t ? "#fff" : "#94a3b8", cursor: "pointer", fontWeight: 600 }}>{t}</button>)}</div></div><div style={{ maxHeight: 500, overflowY: "auto" }}>{filtered.map(item => (<div key={item.id} style={{ padding: "12px 20px", borderBottom: "1px solid #13151b" }} onMouseEnter={e => e.currentTarget.style.background = "#12141a"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}><div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}><Badge color={TC[item.topic] || "#3b82f6"}>{item.topic}</Badge><span style={{ fontSize: 11, color: "#475569" }}>{item.source} • {timeAgo(item.date)}</span></div><h4 style={{ margin: "0 0 3px", fontSize: 13, fontWeight: 600, color: "#e2e8f0", lineHeight: 1.4 }}>{item.title}</h4><p style={{ margin: 0, fontSize: 12, color: "#64748b" }}>{item.summary}</p></div>))}</div></div>); };
const BMASection = () => { const cats = [...new Set(BMA_D.map(u => u.cat))]; const [cf, setCf] = useState("All"); const filtered = cf === "All" ? BMA_D : BMA_D.filter(u => u.cat === cf); return (<div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}><div style={{ padding: "14px 20px", borderBottom: "1px solid #1e2028" }}><h3 style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}><Shield size={16} style={{ verticalAlign: "middle", marginRight: 8 }} /> BMA Updates</h3><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{["All", ...cats].map(c => <button key={c} onClick={() => setCf(c)} style={{ background: cf === c ? (CC[c] || "#3b82f6") : "transparent", border: `1px solid ${cf === c ? (CC[c] || "#3b82f6") : "#2a2d35"}`, borderRadius: 20, padding: "4px 14px", fontSize: 11, color: cf === c ? "#fff" : "#94a3b8", cursor: "pointer", fontWeight: 500 }}>{c}</button>)}</div></div><div>{filtered.map(item => (<div key={item.id} style={{ padding: "12px 20px", borderBottom: "1px solid #13151b" }} onMouseEnter={e => e.currentTarget.style.background = "#12141a"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}><div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}><Badge color={CC[item.cat] || "#3b82f6"}>{item.cat}</Badge>{item.isNew && <Badge color="#22c55e">NEW</Badge>}<span style={{ fontSize: 11, color: "#475569" }}>{item.date}</span></div><h4 style={{ margin: "0 0 3px", fontSize: 13, fontWeight: 600, color: "#e2e8f0", lineHeight: 1.4 }}>{item.title}</h4><p style={{ margin: 0, fontSize: 12, color: "#64748b" }}>{item.summary}</p></div>))}</div></div>); };

// ── Navigation ──
const PAGES = [
  { id: "home", label: "Overview", icon: Activity }, { id: "ust", label: "US Treasuries", icon: DollarSign },
  { id: "jgb", label: "Japan JGB", icon: Globe }, { id: "gilt", label: "UK Gilts", icon: Globe },
  { id: "eiopa", label: "EIOPA EUR", icon: Globe }, { id: "india", label: "India Govt", icon: Globe },
  { id: "credit", label: "Credit Spreads", icon: Percent }, { id: "news", label: "News", icon: Newspaper },
  { id: "bma", label: "BMA Updates", icon: Shield },
];
const FILES = { ust: "ust.json", jgb: "jgb.json", gilt: "gilt.json", eiopa: "eur.json", india: "india.json", credit: "credit.json" };

// ── MAIN APP ──
export default function App() {
  const [page, setPage] = useState("home");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [clock, setClock] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [ghToken, setGhToken] = useState("");
  const [tokenInput, setTokenInput] = useState("");

  const [data, setData] = useState({});
  const [ls, setLs] = useState({});
  const [errs, setErrs] = useState({});
  const [gLoad, setGLoad] = useState(false);
  const [lastRef, setLastRef] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [dispatchMsg, setDispatchMsg] = useState("");

  useEffect(() => {
    const t = setInterval(() => setClock(new Date().toLocaleTimeString("en-US", { hour12: false })), 1000);
    setClock(new Date().toLocaleTimeString("en-US", { hour12: false }));
    return () => clearInterval(t);
  }, []);

  useEffect(() => { try { const s = localStorage.getItem("gh_pat"); if (s) { setGhToken(s); setTokenInput(s); } } catch {} }, []);

  const saveToken = useCallback(() => {
    const k = tokenInput.trim();
    if (k.length >= 10) { setGhToken(k); try { localStorage.setItem("gh_pat", k); } catch {} setShowSettings(false); }
  }, [tokenInput]);

  // Load JSON files from the deployed build
  const loadData = useCallback(async () => {
    setGLoad(true);
    const newLs = {}; const newErrs = {}; const newData = {};
    Object.keys(FILES).forEach(k => newLs[k] = true);
    setLs(newLs); setErrs({});
    try { setManifest(await loadJson("manifest.json")); } catch {}
    await Promise.all(Object.entries(FILES).map(async ([key, file]) => {
      try { newData[key] = await loadJson(file); }
      catch (e) { newErrs[key] = e.message; }
      finally { setLs(p => ({ ...p, [key]: false })); }
    }));
    setData(prev => ({ ...prev, ...newData }));
    setErrs(newErrs); setLastRef(new Date()); setGLoad(false);
  }, []);

  // Trigger workflow + reload data
  const handleRefresh = useCallback(async () => {
    setDispatchMsg("");
    if (ghToken) {
      try {
        setDispatchMsg("Triggering pipeline…");
        const info = await triggerWorkflow(ghToken);
        setDispatchMsg(`Pipeline triggered (${info.workflow}). Data will update in ~60s. Reloading current data…`);
      } catch (e) {
        setDispatchMsg(`Dispatch failed: ${e.message}. Loading cached data…`);
      }
    }
    await loadData();
    // If we dispatched, schedule a second reload after the pipeline completes
    if (ghToken) {
      setTimeout(async () => {
        setDispatchMsg("Reloading after pipeline…");
        await loadData();
        setDispatchMsg("Done — data should be updated if pipeline completed.");
      }, 75000); // 75 seconds for pipeline to run
    }
  }, [ghToken, loadData]);

  useEffect(() => { loadData(); }, []);

  // Helpers
  const gv = (key, tenor) => { const d = data[key]; if (!d) return null; const i = d.tenors?.indexOf(tenor); return i >= 0 ? d.yields?.[i] : null; };
  const gp = (key, tenor) => { const d = data[key]; if (!d) return null; const i = d.tenors?.indexOf(tenor); return i >= 0 ? d.prior_yields?.[i] : null; };

  const ust10y = gv("ust", "10Y"), ust10yP = gp("ust", "10Y"), ust2y = gv("ust", "2Y"), ust2yP = gp("ust", "2Y");
  const jgb10y = gv("jgb", "10Y"), jgb10yP = gp("jgb", "10Y"), gilt10y = gv("gilt", "10Y"), gilt10yP = gp("gilt", "10Y");
  const india10y = gv("india", "10Y"), india10yP = gp("india", "10Y");
  const igS = data.credit?.spreads?.ig?.spread, igP = data.credit?.spreads?.ig?.prior;
  const hyS = data.credit?.spreads?.hy?.spread, hyP = data.credit?.spreads?.hy?.prior;

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
      case "credit": return <CreditSection data={data.credit} loading={ls.credit} error={errs.credit} />;
      case "news": return <NewsSection />; case "bma": return <BMASection />;
      default: return (<div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {dispatchMsg && <div style={{ background: "#0a1a2a", border: "1px solid #1e3a5f", borderRadius: 10, padding: "10px 20px", fontSize: 12, color: "#60a5fa" }}><RefreshCw size={12} style={{ verticalAlign: "middle", marginRight: 6 }} />{dispatchMsg}</div>}
        {noData && <div style={{ background: "#1a1206", border: "1px solid #854d0e", borderRadius: 10, padding: "16px 20px" }}>
          <div style={{ color: "#fbbf24", fontWeight: 700, fontSize: 14, marginBottom: 4 }}>No data files found</div>
          <div style={{ color: "#a3a3a3", fontSize: 12, lineHeight: 1.6 }}>
            1. Go to Actions tab → "Refresh Data and Deploy" → Run workflow<br />
            2. Or set a GitHub PAT via <Settings size={12} style={{ verticalAlign: "middle" }} /> and click Refresh to trigger it from here
          </div>
        </div>}
        {Object.keys(errs).length > 0 && !noData && <div style={{ background: "#1a0a0a", border: "1px solid #7f1d1d", borderRadius: 10, padding: "12px 20px" }}>
          <div style={{ color: "#ef4444", fontWeight: 700, fontSize: 12, marginBottom: 4 }}><AlertTriangle size={14} style={{ verticalAlign: "middle", marginRight: 4 }} />Errors:</div>
          {Object.entries(errs).map(([k, v]) => <div key={k} style={{ color: "#a3a3a3", fontSize: 11 }}>• <strong>{k}</strong>: {v}</div>)}
        </div>}
        {manifest && <div style={{ fontSize: 11, color: "#475569" }}>Pipeline: {manifest.run ? new Date(manifest.run).toLocaleString() : "—"}</div>}

        <div>
          <h3 style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.1em" }}>Key Rates {data.ust ? `(${data.ust.date})` : ""}</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(165px, 1fr))", gap: 10 }}>
            <MetricCard label="UST 10Y" value={fmtY(ust10y)} change={chgBp(ust10y, ust10yP)} loading={ls.ust} />
            <MetricCard label="UST 2Y" value={fmtY(ust2y)} change={chgBp(ust2y, ust2yP)} loading={ls.ust} />
            <MetricCard label="UST 2s10s" value={ust10y != null && ust2y != null ? ((ust10y - ust2y) * 100).toFixed(0) + "bp" : "—"} change={ust10yP != null ? chgBp(ust10y - ust2y, ust10yP - ust2yP) : null} loading={ls.ust} />
            <MetricCard label="JGB 10Y" value={fmtY(jgb10y)} change={chgBp(jgb10y, jgb10yP)} loading={ls.jgb} />
            <MetricCard label="UK Gilt 10Y" value={fmtY(gilt10y)} change={chgBp(gilt10y, gilt10yP)} loading={ls.gilt} />
            <MetricCard label="India 10Y" value={fmtY(india10y)} change={chgBp(india10y, india10yP)} loading={ls.india} />
            <MetricCard label="US IG OAS" value={igS != null ? igS + "bp" : "—"} change={igP != null ? (igS - igP).toFixed(0) : null} loading={ls.credit} />
            <MetricCard label="US HY OAS" value={hyS != null ? hyS + "bp" : "—"} change={hyP != null ? (hyS - hyP).toFixed(0) : null} loading={ls.credit} />
          </div>
        </div>

        {hasCurve && <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: "14px 14px 6px" }}>
          <h3 style={{ margin: "0 0 10px 6px", fontSize: 13, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.1em" }}>Global Yield Curve Comparison</h3>
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={mc}><CartesianGrid strokeDasharray="3 3" stroke="#1a1d23" /><XAxis dataKey="tenor" tick={{ fill: "#64748b", fontSize: 11 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} /><YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={{ stroke: "#1e2028" }} tickLine={false} domain={[0, "auto"]} tickFormatter={v => v.toFixed(1) + "%"} /><Tooltip content={<CTooltip />} />
              <Line type="monotone" dataKey="India" stroke="#ec4899" strokeWidth={2} name="India" dot={{ r: 3 }} connectNulls />
              <Line type="monotone" dataKey="Gilt" stroke="#22c55e" strokeWidth={2} name="UK Gilt" dot={{ r: 3 }} connectNulls />
              <Line type="monotone" dataKey="UST" stroke="#3b82f6" strokeWidth={2.5} name="US Treasury" dot={{ r: 4 }} connectNulls />
              <Line type="monotone" dataKey="EUR" stroke="#f59e0b" strokeWidth={2} name="EUR" dot={{ r: 3 }} connectNulls />
              <Line type="monotone" dataKey="JGB" stroke="#ef4444" strokeWidth={2} name="Japan JGB" dot={{ r: 3 }} connectNulls />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} /></LineChart>
          </ResponsiveContainer>
          <div style={{ overflowX: "auto", padding: "4px 6px 10px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead><tr style={{ borderBottom: "1px solid #1e2028" }}><th style={{ textAlign: "left", padding: "5px 8px", color: "#64748b" }}>Tenor</th><th style={{ textAlign: "right", padding: "5px 8px", color: "#3b82f6" }}>UST</th><th style={{ textAlign: "right", padding: "5px 8px", color: "#ef4444" }}>JGB</th><th style={{ textAlign: "right", padding: "5px 8px", color: "#22c55e" }}>Gilt</th><th style={{ textAlign: "right", padding: "5px 8px", color: "#f59e0b" }}>EUR</th><th style={{ textAlign: "right", padding: "5px 8px", color: "#ec4899" }}>India</th></tr></thead>
              <tbody>{mc.map((r, i) => (<tr key={i} style={{ borderBottom: "1px solid #13151b" }}><td style={{ padding: "4px 8px", color: "#e2e8f0", fontWeight: 600, fontFamily: "monospace" }}>{r.tenor}</td>{["UST", "JGB", "Gilt", "EUR", "India"].map(k => <td key={k} style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", color: r[k] != null ? "#e2e8f0" : "#334155" }}>{r[k] != null ? r[k].toFixed(2) + "%" : "—"}</td>)}</tr>))}</tbody>
            </table>
          </div>
          <div style={{ padding: "4px 8px 10px", display: "flex", gap: 16, flexWrap: "wrap", fontSize: 10, color: "#475569" }}>
            {data.ust && <span>UST: {data.ust.date}</span>}{data.jgb && <span>JGB: {data.jgb.date}</span>}{data.gilt && <span>Gilt: {data.gilt.date}</span>}{data.eiopa && <span>EUR: {data.eiopa.date}</span>}{data.india && <span>India: {data.india.date}</span>}
          </div>
        </div>}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "12px 20px", borderBottom: "1px solid #1e2028", display: "flex", justifyContent: "space-between", alignItems: "center" }}><h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}><Newspaper size={14} style={{ verticalAlign: "middle", marginRight: 6 }} /> News</h3><button onClick={() => setPage("news")} style={{ background: "transparent", border: "none", color: "#3b82f6", fontSize: 11, cursor: "pointer", fontWeight: 600 }}>All <ChevronRight size={12} style={{ verticalAlign: "middle" }} /></button></div>
            {NEWS.slice(0, 4).map(item => <div key={item.id} style={{ padding: "8px 20px", borderBottom: "1px solid #13151b" }}><div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 2 }}><Badge>{item.topic}</Badge><span style={{ fontSize: 10, color: "#475569" }}>{timeAgo(item.date)}</span></div><div style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0", lineHeight: 1.4 }}>{item.title}</div></div>)}
          </div>
          <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "12px 20px", borderBottom: "1px solid #1e2028", display: "flex", justifyContent: "space-between", alignItems: "center" }}><h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}><Shield size={14} style={{ verticalAlign: "middle", marginRight: 6 }} /> BMA</h3><button onClick={() => setPage("bma")} style={{ background: "transparent", border: "none", color: "#3b82f6", fontSize: 11, cursor: "pointer", fontWeight: 600 }}>All <ChevronRight size={12} style={{ verticalAlign: "middle" }} /></button></div>
            {BMA_D.filter(u => u.isNew).slice(0, 4).map(item => <div key={item.id} style={{ padding: "8px 20px", borderBottom: "1px solid #13151b" }}><div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 2 }}><Badge color="#22c55e">NEW</Badge><Badge>{item.cat}</Badge><span style={{ fontSize: 10, color: "#475569" }}>{item.date}</span></div><div style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0", lineHeight: 1.4 }}>{item.title}</div></div>)}
          </div>
        </div>
      </div>);
    }
  };

  return (<div style={{ display: "flex", height: "100vh", background: "#080a0f", color: "#e2e8f0", fontFamily: "'JetBrains Mono', 'IBM Plex Sans', -apple-system, sans-serif", fontSize: 13, overflow: "hidden" }}>
    <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>

    {/* Settings Modal */}
    {showSettings && <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setShowSettings(false)}>
      <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 12, padding: 24, width: 480, maxWidth: "90vw" }} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700 }}><Key size={18} style={{ verticalAlign: "middle", marginRight: 8, color: "#f59e0b" }} />GitHub Personal Access Token</h3>
        <p style={{ color: "#94a3b8", fontSize: 12, marginBottom: 12, lineHeight: 1.6 }}>
          Optional — enables the Refresh button to trigger the data pipeline directly.<br />
          Create a <strong>fine-grained PAT</strong> at <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener noreferrer" style={{ color: "#3b82f6" }}>github.com/settings/tokens</a> with <strong>Actions: Read & Write</strong> permission on your repo.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={tokenInput} onChange={e => setTokenInput(e.target.value)} placeholder="github_pat_..." style={{ flex: 1, background: "#12141a", border: "1px solid #2a2d35", borderRadius: 6, padding: "10px 14px", color: "#e2e8f0", fontSize: 12, fontFamily: "monospace", outline: "none" }} onKeyDown={e => e.key === "Enter" && saveToken()} />
          <button onClick={saveToken} style={{ background: "#3b82f6", border: "none", borderRadius: 6, padding: "10px 20px", color: "#fff", fontWeight: 700, cursor: "pointer" }}>Save</button>
        </div>
        {ghToken && <div style={{ marginTop: 10, fontSize: 11, color: "#22c55e", display: "flex", alignItems: "center", gap: 4 }}><CheckCircle size={12} /> Saved: {ghToken.slice(0, 12)}…</div>}
        <p style={{ color: "#475569", fontSize: 11, marginTop: 12 }}>Without a PAT, Refresh just reloads the current data files. With a PAT, it also triggers a fresh scrape.</p>
      </div>
    </div>}

    {/* Sidebar */}
    <div style={{ width: sidebarOpen ? 210 : 52, transition: "width 0.2s", background: "#0a0c12", borderRight: "1px solid #1a1d23", display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden" }}>
      <div style={{ padding: sidebarOpen ? "14px 16px" : "14px 10px", borderBottom: "1px solid #1a1d23", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", minHeight: 52 }} onClick={() => setSidebarOpen(!sidebarOpen)}>
        <div style={{ width: 28, height: 28, borderRadius: 6, background: "linear-gradient(135deg, #3b82f6, #8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><BarChart3 size={16} color="#fff" /></div>
        {sidebarOpen && <div><div style={{ fontSize: 13, fontWeight: 800, color: "#e2e8f0", letterSpacing: "-0.02em", lineHeight: 1.1 }}>BERMUDA</div><div style={{ fontSize: 9, fontWeight: 600, color: "#3b82f6", letterSpacing: "0.15em", textTransform: "uppercase" }}>MARKET INTEL</div></div>}
      </div>
      <div style={{ flex: 1, padding: "6px", overflowY: "auto" }}>{PAGES.map(p => { const Icon = p.icon; const a = page === p.id; return <button key={p.id} onClick={() => setPage(p.id)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: sidebarOpen ? "8px 10px" : "8px", marginBottom: 1, borderRadius: 6, border: "none", background: a ? "#1e2028" : "transparent", color: a ? "#e2e8f0" : "#64748b", cursor: "pointer", fontSize: 12, fontWeight: a ? 600 : 500, textAlign: "left", justifyContent: sidebarOpen ? "flex-start" : "center" }} onMouseEnter={e => { if (!a) e.currentTarget.style.background = "#12141a" }} onMouseLeave={e => { if (!a) e.currentTarget.style.background = "transparent" }}><Icon size={15} style={{ flexShrink: 0 }} />{sidebarOpen && <span>{p.label}</span>}</button>; })}</div>
      {sidebarOpen && <div style={{ padding: "10px 14px", borderTop: "1px solid #1a1d23", fontSize: 10, color: "#334155" }}>Data via GitHub Actions</div>}
    </div>

    {/* Main */}
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ height: 42, padding: "0 20px", borderBottom: "1px solid #1a1d23", background: "#0a0c12", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{PAGES.find(p => p.id === page)?.label || "Overview"}</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11 }}>
          {lastRef && <span style={{ color: "#475569", fontSize: 10 }}>Loaded: {lastRef.toLocaleTimeString()}</span>}
          {gLoad && <Loader size={14} style={{ color: "#3b82f6", animation: "spin 1s linear infinite" }} />}
          <button onClick={handleRefresh} disabled={gLoad} style={{ background: gLoad ? "#1e2028" : "#3b82f6", border: "none", borderRadius: 6, padding: "5px 14px", color: gLoad ? "#64748b" : "#fff", cursor: gLoad ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 5, fontWeight: 700, fontSize: 12 }}>
            <RefreshCw size={13} style={{ animation: gLoad ? "spin 1s linear infinite" : "none" }} />{gLoad ? "Loading…" : "Refresh"}
          </button>
          <button onClick={() => setShowSettings(true)} style={{ background: "transparent", border: "1px solid #2a2d35", borderRadius: 6, padding: "5px 8px", cursor: "pointer", display: "flex", alignItems: "center" }}>
            <Settings size={14} style={{ color: ghToken ? "#22c55e" : "#f59e0b" }} />
          </button>
          <span style={{ color: "#3b82f6", fontFamily: "monospace", fontWeight: 700, fontSize: 13 }}>{clock}</span>
        </div>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 18 }}>{renderPage()}</div>
      <div style={{ height: 26, padding: "0 20px", borderTop: "1px solid #1a1d23", background: "#0a0c12", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 10, color: "#334155", flexShrink: 0 }}>
        <div style={{ display: "flex", gap: 14 }}>{ust10y != null && <span>UST 10Y: {fmtY(ust10y)}</span>}{jgb10y != null && <span>JGB 10Y: {fmtY(jgb10y)}</span>}{gilt10y != null && <span>Gilt 10Y: {fmtY(gilt10y)}</span>}{india10y != null && <span>India 10Y: {fmtY(india10y)}</span>}{igS != null && <span>IG: {igS}bp</span>}{hyS != null && <span>HY: {hyS}bp</span>}</div>
        <span>Bermuda Market Intel v7</span>
      </div>
    </div>
  </div>);
}

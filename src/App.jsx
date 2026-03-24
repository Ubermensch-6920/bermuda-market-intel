import { useState, useEffect, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, AreaChart, Area, Legend
} from "recharts";
import {
  Globe, Shield, Newspaper, BarChart3, ChevronRight, ExternalLink, Clock,
  RefreshCw, Activity, DollarSign, Percent, ArrowUpRight, ArrowDownRight,
  Minus, Settings, Key, CheckCircle, AlertTriangle, Loader
} from "lucide-react";

/* ═══════════════════════════════════════════════════════════════════
   BERMUDA MARKET INTELLIGENCE TERMINAL v4.0
   All data live — robust parsers, multiple proxy fallbacks
   ═══════════════════════════════════════════════════════════════════ */

// ─── CORS PROXY HELPERS ───
// Try multiple proxies in sequence for reliability
const PROXIES = [
  u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
];

async function proxyFetch(url) {
  for (const mkUrl of PROXIES) {
    try {
      const res = await fetch(mkUrl(url), { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const text = await res.text();
        if (text && text.length > 50) return text;
      }
    } catch { /* try next proxy */ }
  }
  throw new Error("All CORS proxies failed for " + url.slice(0, 60));
}

// ═══════════════════════════════════════════
// 1. US TREASURY — FRED API (native CORS)
// ═══════════════════════════════════════════

const UST_SERIES = {"1M":"DGS1MO","3M":"DGS3MO","6M":"DGS6MO","1Y":"DGS1","2Y":"DGS2","3Y":"DGS3","5Y":"DGS5","7Y":"DGS7","10Y":"DGS10","20Y":"DGS20","30Y":"DGS30"};
const UST_TENORS = Object.keys(UST_SERIES);

async function fredFetch(seriesId, apiKey, limit = 10) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`FRED ${seriesId}: HTTP ${res.status} — ${body.slice(0, 100)}`);
  }
  const data = await res.json();
  if (data.error_message) throw new Error(`FRED ${seriesId}: ${data.error_message}`);
  return (data.observations || []).filter(o => o.value !== ".").map(o => ({ date: o.date, value: parseFloat(o.value) }));
}

async function fetchUST(apiKey) {
  const results = await Promise.allSettled(
    UST_TENORS.map(t => fredFetch(UST_SERIES[t], apiKey, 10).then(obs => ({ tenor: t, obs })))
  );
  const good = results.filter(r => r.status === "fulfilled").map(r => r.value);
  if (good.length === 0) throw new Error("No UST series returned data. Check your FRED API key.");
  const allDates = [...new Set(good.flatMap(r => r.obs.map(o => o.date)))].sort().reverse();
  const [d0, d1] = [allDates[0] || "", allDates[1] || ""];
  const gv = (t, d) => good.find(x => x.tenor === t)?.obs.find(o => o.date === d)?.value ?? null;
  return {
    date: d0, prior_date: d1,
    source: "FRED / US Treasury CMT", url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates",
    tenors: UST_TENORS, yields: UST_TENORS.map(t => gv(t, d0)), prior_yields: UST_TENORS.map(t => gv(t, d1)),
    history: allDates.slice(0, 6).map(d => ({ date: d, yields: UST_TENORS.map(t => gv(t, d)) })),
  };
}

// ═══════════════════════════════════════════
// 2. JAPAN JGB — MOF CSV via CORS proxy
// ═══════════════════════════════════════════
// CSV format (from search results):
//   Line 0: "Interest Rate (March 2026),,,,,,,,,,,,,,,(Unit : %)"
//   Line 1: "Date,1Y,2Y,3Y,4Y,5Y,6Y,7Y,8Y,9Y,10Y,15Y,20Y,25Y,30Y,40Y"
//   Line 2+: "2026/3/19,0.82,0.98,..."

const JGB_TENORS = ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","25Y","30Y","40Y"];

async function fetchJGB() {
  const raw = await proxyFetch("https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv");
  const lines = raw.split(/\r?\n/);

  // Find the header line containing "Date"
  let headerIdx = -1;
  let headers = [];
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    if (lines[i].toLowerCase().includes("date")) {
      headerIdx = i;
      headers = lines[i].split(",").map(s => s.trim().replace(/"/g, ""));
      break;
    }
  }
  if (headerIdx < 0) throw new Error("JGB CSV: Could not find header row");

  // Map header names to column indices
  const colMap = {};
  headers.forEach((h, i) => {
    const cleaned = h.replace(/\s+/g, "");
    if (JGB_TENORS.includes(cleaned)) colMap[cleaned] = i;
  });

  // Parse data rows
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const parts = lines[i].split(",").map(s => s.trim().replace(/"/g, ""));
    if (parts.length < 10) continue;

    // Parse date: "2026/3/19" or "2026/03/19"
    const dm = parts[0].match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
    if (!dm) continue;
    const date = `${dm[1]}-${dm[2].padStart(2, "0")}-${dm[3].padStart(2, "0")}`;

    const yields = {};
    for (const t of JGB_TENORS) {
      if (colMap[t] !== undefined) {
        const v = parseFloat(parts[colMap[t]]);
        yields[t] = isNaN(v) ? null : v;
      } else {
        yields[t] = null;
      }
    }
    rows.push({ date, yields });
  }

  rows.sort((a, b) => b.date.localeCompare(a.date));
  if (rows.length < 2) throw new Error(`JGB: Only ${rows.length} rows parsed from CSV (${lines.length} lines total)`);

  return {
    date: rows[0].date, prior_date: rows[1].date,
    source: "Ministry of Finance Japan", url: "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/",
    tenors: JGB_TENORS,
    yields: JGB_TENORS.map(t => rows[0].yields[t]),
    prior_yields: JGB_TENORS.map(t => rows[1].yields[t]),
    history: rows.slice(0, 6).map(r => ({ date: r.date, yields: JGB_TENORS.map(t => r.yields[t]) })),
  };
}

// ═══════════════════════════════════════════
// 3. UK GILTS — Bank of England CSV API via proxy
// ═══════════════════════════════════════════
// BoE returns CSV with header like: DATE,IUMALNPY,IUMALNP2,...
// Date format: "20 Mar 2026"

const GILT_CODES = {"1Y":"IUMALNPY","2Y":"IUMALNP2","3Y":"IUMALNP3","5Y":"IUMALNP5","7Y":"IUMALNP7","10Y":"IUMALNP10","15Y":"IUMALNP15","20Y":"IUMALNP20","25Y":"IUMALNP25","30Y":"IUMALNP30"};
const GILT_TENORS = Object.keys(GILT_CODES);
const MON = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};

async function fetchGilt() {
  const codes = Object.values(GILT_CODES).join(",");
  const end = new Date();
  const start = new Date(end); start.setDate(start.getDate() - 30);
  const fmt = d => {
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${d.getDate()}/${months[d.getMonth()]}/${d.getFullYear()}`;
  };
  const url = `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&SeriesCodes=${codes}&CSVF=TN&Datefrom=${fmt(start)}&Dateto=${fmt(end)}`;

  const raw = await proxyFetch(url);
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error("Gilt: BoE returned empty CSV");

  const header = lines[0].split(",").map(s => s.trim().replace(/"/g, ""));
  const datesByRow = {};

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(s => s.trim().replace(/"/g, ""));
    const raw_date = cols[0];
    if (!raw_date) continue;

    // Parse "20 Mar 2026" or "2 Mar 2026"
    const m = raw_date.match(/(\d{1,2})\s+(\w{3})\s+(\d{4})/);
    if (!m) continue;
    const monIdx = MON[m[2].toLowerCase()];
    if (monIdx === undefined) continue;
    const dk = `${m[3]}-${String(monIdx + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;

    const yields = {};
    for (const [tenor, code] of Object.entries(GILT_CODES)) {
      const ci = header.indexOf(code);
      if (ci >= 0 && cols[ci]) {
        const v = parseFloat(cols[ci]);
        yields[tenor] = isNaN(v) ? null : v;
      } else {
        yields[tenor] = null;
      }
    }
    datesByRow[dk] = yields;
  }

  const dates = Object.keys(datesByRow).sort().reverse();
  if (dates.length < 1) throw new Error(`Gilt: 0 valid dates parsed from ${lines.length} CSV lines`);

  return {
    date: dates[0], prior_date: dates[1] || "",
    source: "Bank of England", url: "https://www.bankofengland.co.uk/statistics/yield-curves",
    tenors: GILT_TENORS,
    yields: GILT_TENORS.map(t => datesByRow[dates[0]]?.[t] ?? null),
    prior_yields: dates[1] ? GILT_TENORS.map(t => datesByRow[dates[1]]?.[t] ?? null) : GILT_TENORS.map(() => null),
    history: dates.slice(0, 6).map(d => ({ date: d, yields: GILT_TENORS.map(t => datesByRow[d]?.[t] ?? null) })),
  };
}

// ═══════════════════════════════════════════
// 4. INDIA — Investing.com bond page (static HTML) via proxy
//    Fallback: FRED monthly 10Y
// ═══════════════════════════════════════════

const INDIA_TENORS = ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","30Y"];

async function fetchIndia(apiKey) {
  // Try investing.com rates page (has static HTML table)
  try {
    const html = await proxyFetch("https://www.investing.com/rates-bonds/india-government-bonds");
    // investing.com has a table with rows containing tenor names and yield values
    // Pattern: title="India X-Year" ... <td>6.XXX</td>
    const yields = {};

    // Match patterns like: india-1-year-bond-yield ... >5.729</td>  or title="India 10-Year" ... >6.820%
    const bondRegex = /india[- ](\d+)[- ](year|month)[^>]*bond[- ]yield[^>]*>[\s\S]*?<td[^>]*>([\d.]+)%?<\/td>/gi;
    let bm;
    while ((bm = bondRegex.exec(html)) !== null) {
      const num = parseInt(bm[1]);
      const unit = bm[2].toLowerCase();
      const val = parseFloat(bm[3]);
      if (!isNaN(val)) {
        const key = unit === "year" ? num + "Y" : (num === 6 ? "6M" : null);
        if (key && INDIA_TENORS.includes(key)) yields[key] = val;
      }
    }

    // Alternative pattern: rows with "1 Year" ... percentage in nearby td
    if (Object.keys(yields).length < 3) {
      const rowRe = /<tr[^>]*>[\s\S]*?(\d+)[- ](Year|Month)[\s\S]*?<\/tr>/gi;
      let rm;
      while ((rm = rowRe.exec(html)) !== null) {
        const num = parseInt(rm[1]);
        const unit = rm[2].toLowerCase();
        const key = unit === "year" ? num + "Y" : null;
        if (!key || !INDIA_TENORS.includes(key)) continue;
        // Find all numbers that look like yields in this row
        const yieldMatches = rm[0].match(/>\s*([\d]+\.[\d]{2,3})\s*%?\s*</g);
        if (yieldMatches && yieldMatches.length > 0) {
          const val = parseFloat(yieldMatches[0].replace(/[><%\s]/g, ""));
          if (!isNaN(val) && val > 0 && val < 20) yields[key] = val;
        }
      }
    }

    if (Object.keys(yields).length >= 3) {
      return {
        date: new Date().toISOString().slice(0, 10), prior_date: "",
        source: "Investing.com (India Govt Bonds)", url: "https://www.investing.com/rates-bonds/india-government-bonds",
        tenors: INDIA_TENORS, yields: INDIA_TENORS.map(t => yields[t] ?? null),
        prior_yields: INDIA_TENORS.map(() => null), history: [],
        note: "Day-over-day change not available from this source.",
      };
    }
  } catch (e) {
    console.warn("India investing.com failed:", e.message);
  }

  // Fallback: FRED 10Y only (monthly)
  if (apiKey) {
    try {
      const obs = await fredFetch("INDIRLTLT01STM", apiKey, 3);
      if (obs.length > 0) {
        const yields = INDIA_TENORS.map(t => t === "10Y" ? obs[0].value : null);
        const prior = INDIA_TENORS.map(t => t === "10Y" && obs[1] ? obs[1].value : null);
        return {
          date: obs[0].date, prior_date: obs[1]?.date || "",
          source: "FRED (India 10Y only — monthly)", url: "https://fred.stlouisfed.org/series/INDIRLTLT01STM",
          tenors: INDIA_TENORS, yields, prior_yields: prior, history: [],
          note: "Only 10Y available via FRED (monthly). Full curve requires server-side scraping.",
        };
      }
    } catch {}
  }

  throw new Error("India: No data source succeeded. Investing.com may be blocking the proxy.");
}

// ═══════════════════════════════════════════
// 5. EUR YIELD CURVE — ECB SDW (native CORS)
// ═══════════════════════════════════════════

const ECB_MAP = {"1Y":"SR_1Y","2Y":"SR_2Y","3Y":"SR_3Y","5Y":"SR_5Y","7Y":"SR_7Y","10Y":"SR_10Y","15Y":"SR_15Y","20Y":"SR_20Y","30Y":"SR_30Y"};
const EUR_TENORS = Object.keys(ECB_MAP);

async function fetchEUR() {
  const results = {};
  await Promise.allSettled(EUR_TENORS.map(async tenor => {
    const sk = `B.U2.EUR.4F.G_N_A.SV_C_YM.${ECB_MAP[tenor]}`;
    const url = `https://data-api.ecb.europa.eu/service/data/YC/${sk}?lastNObservations=5&format=csvdata`;
    const res = await fetch(url, { headers: { Accept: "text/csv" } });
    if (!res.ok) return;
    const text = await res.text();
    const lines = text.trim().split("\n");
    if (lines.length < 2) return;
    const header = lines[0].split(",");
    const oi = header.findIndex(h => h.includes("OBS_VALUE"));
    const ti = header.findIndex(h => h.includes("TIME_PERIOD"));
    if (oi < 0) return;
    const obs = lines.slice(1).map(l => { const p = l.split(","); return { date: (p[ti]||"").replace(/"/g,""), value: parseFloat(p[oi]) }; }).filter(o => !isNaN(o.value));
    obs.sort((a, b) => b.date.localeCompare(a.date));
    if (obs.length > 0) results[tenor] = { value: obs[0].value, prior: obs[1]?.value ?? null, date: obs[0].date };
  }));
  if (Object.keys(results).length === 0) throw new Error("ECB: No tenors returned");
  const latestDate = Object.values(results).map(r => r.date).sort().reverse()[0] || "";
  return {
    date: latestDate, prior_date: "",
    source: "ECB SDW (EUR AAA Govt — EIOPA proxy)", url: "https://data.ecb.europa.eu/",
    tenors: EUR_TENORS,
    yields: EUR_TENORS.map(t => results[t]?.value ?? null),
    prior_yields: EUR_TENORS.map(t => results[t]?.prior ?? null),
    history: [], note: "EUR AAA govt curve. Actual EIOPA RFR includes UFR extrapolation.",
  };
}

// ═══════════════════════════════════════════
// 6. CREDIT SPREADS — FRED (native CORS)
// ═══════════════════════════════════════════

const CR = {
  ig:{id:"BAMLC0A0CM",name:"US IG (Master)",bucket:"IG"}, aaa:{id:"BAMLC0A1CAAA",name:"US AAA",bucket:"AAA"},
  aa:{id:"BAMLC0A2CAA",name:"US AA",bucket:"AA"}, a:{id:"BAMLC0A3CA",name:"US A",bucket:"A"},
  bbb:{id:"BAMLC0A4CBBB",name:"US BBB",bucket:"BBB"}, hy:{id:"BAMLH0A0HYM2",name:"US HY",bucket:"HY"},
  bb:{id:"BAMLH0A1HYBB",name:"US BB",bucket:"BB"}, b:{id:"BAMLH0A2HYB",name:"US B",bucket:"B"},
  ccc:{id:"BAMLH0A3HYC",name:"US CCC+",bucket:"CCC"},
};

async function fetchCredit(apiKey) {
  const results = await Promise.allSettled(
    Object.entries(CR).map(([key, info]) => fredFetch(info.id, apiKey, 60).then(obs => ({ key, info, obs })))
  );
  const good = results.filter(r => r.status === "fulfilled").map(r => r.value);
  if (good.length === 0) throw new Error("Credit: No series returned. Check FRED API key.");

  const us = {}; let latestDate = "";
  for (const { key, info, obs } of good) {
    if (!obs.length) continue;
    const [latest, prior] = [obs[0], obs[1] || obs[0]];
    if (latest.date > latestDate) latestDate = latest.date;
    const spread = Math.round(latest.value * 100);
    const priorSpread = Math.round(prior.value * 100);
    const yr = new Date().getFullYear();
    const ytd = obs.filter(o => o.date >= `${yr}-01-01`);
    us[key] = { name: info.name, spread, prior: priorSpread,
      ytd_avg: ytd.length ? Math.round(ytd.reduce((s, o) => s + o.value, 0) / ytd.length * 100) : spread,
      bucket: info.bucket };
  }

  // Monthly history for chart
  const months = {};
  for (const r of good) {
    if (!["ig","hy","bbb","aaa"].includes(r.key)) continue;
    for (const o of r.obs) {
      const m = o.date.slice(0, 7);
      if (!months[m]) months[m] = {};
      if (!months[m][r.key]) months[m][r.key] = [];
      months[m][r.key].push(o.value * 100);
    }
  }
  const history = Object.entries(months).sort(([a],[b])=>a.localeCompare(b)).slice(-6).map(([date,vals])=>({
    date, ig:vals.ig?Math.round(vals.ig.reduce((a,b)=>a+b,0)/vals.ig.length):null,
    hy:vals.hy?Math.round(vals.hy.reduce((a,b)=>a+b,0)/vals.hy.length):null,
    bbb:vals.bbb?Math.round(vals.bbb.reduce((a,b)=>a+b,0)/vals.bbb.length):null,
    aaa:vals.aaa?Math.round(vals.aaa.reduce((a,b)=>a+b,0)/vals.aaa.length):null,
  }));

  return { date: latestDate, source: "FRED / ICE BofA Indices", url: "https://fred.stlouisfed.org/release?rid=209", us,
    eu:{ig:{name:"EUR IG",spread:null,prior:null,ytd_avg:null,bucket:"IG"},hy:{name:"EUR HY",spread:null,prior:null,ytd_avg:null,bucket:"HY"}}, history };
}

// ═══════════════════════════════════════════
// UI UTILITIES & COMPONENTS
// ═══════════════════════════════════════════

const fmtY=v=>v!=null?v.toFixed(2)+"%":"—";
const chgBp=(c,p)=>c!=null&&p!=null?((c-p)*100).toFixed(1):null;
const chgCol=v=>v>0?"#ef4444":v<0?"#22c55e":"#64748b";
const ChgI=({v})=>{const n=parseFloat(v);return n>0?<ArrowUpRight size={14}/>:n<0?<ArrowDownRight size={14}/>:<Minus size={14}/>;};
const timeAgo=ds=>{const h=Math.floor((Date.now()-new Date(ds))/36e5);if(h<1)return"Now";if(h<24)return h+"h";const d=Math.floor(h/24);return d<7?d+"d":new Date(ds).toLocaleDateString("en-US",{month:"short",day:"numeric"});};

const Badge=({children,color="#3b82f6"})=><span style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",padding:"2px 8px",borderRadius:4,background:color+"18",color,whiteSpace:"nowrap"}}>{children}</span>;
const Fresh=({date,source,url})=><div style={{display:"flex",alignItems:"center",gap:8,fontSize:11,color:"#64748b",flexWrap:"wrap"}}><Clock size={12}/><span>As of {date||"—"}</span><span style={{color:"#334155"}}>|</span><a href={url} target="_blank" rel="noopener noreferrer" style={{color:"#3b82f6",textDecoration:"none",display:"flex",alignItems:"center",gap:3}}>{source}<ExternalLink size={10}/></a></div>;

const CTooltip=({active,payload,label})=>{if(!active||!payload?.length)return null;return<div style={{background:"#1a1d23",border:"1px solid #2a2d35",borderRadius:6,padding:"10px 14px",fontSize:12}}><div style={{color:"#94a3b8",marginBottom:4,fontWeight:600}}>{label}</div>{payload.filter(p=>p.value!=null).map((p,i)=><div key={i} style={{color:p.color,display:"flex",gap:8,alignItems:"center"}}><span style={{width:8,height:8,borderRadius:"50%",background:p.color,display:"inline-block"}}/><span>{p.name}: {p.value?.toFixed(2)}%</span></div>)}</div>;};
const STooltip=({active,payload,label})=>{if(!active||!payload?.length)return null;return<div style={{background:"#1a1d23",border:"1px solid #2a2d35",borderRadius:6,padding:"10px 14px",fontSize:12}}><div style={{color:"#94a3b8",marginBottom:4,fontWeight:600}}>{label}</div>{payload.filter(p=>p.value!=null).map((p,i)=><div key={i} style={{color:p.color,display:"flex",gap:8,alignItems:"center"}}><span style={{width:8,height:8,borderRadius:"50%",background:p.color,display:"inline-block"}}/><span>{p.name}: {p.value}bp</span></div>)}</div>;};

const MetricCard=({label,value,change,loading:ld})=>{const n=parseFloat(change);return<div style={{background:"#12141a",border:"1px solid #1e2028",borderRadius:8,padding:"14px 18px",minWidth:160}}><div style={{fontSize:11,color:"#64748b",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>{label}</div>{ld?<Loader size={16} style={{color:"#3b82f6",animation:"spin 1s linear infinite"}}/>:<div style={{display:"flex",alignItems:"baseline",gap:8}}><span style={{fontSize:22,fontWeight:700,color:"#e2e8f0",fontFamily:"'JetBrains Mono',monospace"}}>{value}</span>{change!=null&&!isNaN(n)&&<span style={{fontSize:12,color:chgCol(n),display:"flex",alignItems:"center",gap:2,fontWeight:600,fontFamily:"monospace"}}><ChgI v={change}/>{Math.abs(n).toFixed(1)}bp</span>}</div>}</div>;};

// ── Sovereign Section ──
const SovSection=({data,title,accentColor,loading:ld,error})=>{
  if(ld)return<div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:10,padding:40,textAlign:"center",color:"#64748b"}}><Loader size={24} style={{animation:"spin 1s linear infinite",margin:"0 auto 10px",display:"block",color:"#3b82f6"}}/>Loading {title}…</div>;
  if(error)return<div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:10,padding:"20px"}}><h3 style={{margin:"0 0 8px",fontSize:15,fontWeight:700,color:"#e2e8f0"}}>{title}</h3><div style={{color:"#ef4444",fontSize:12,lineHeight:1.6}}><AlertTriangle size={14} style={{verticalAlign:"middle",marginRight:6}}/>{error}</div></div>;
  if(!data)return null;
  const cd=data.tenors.map((t,i)=>({tenor:t,current:data.yields[i],prior:data.prior_yields[i],change:data.yields[i]!=null&&data.prior_yields[i]!=null?((data.yields[i]-data.prior_yields[i])*100).toFixed(1):null}));
  return<div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:10,overflow:"hidden"}}>
    <div style={{padding:"14px 20px",borderBottom:"1px solid #1e2028"}}><h3 style={{margin:0,fontSize:15,fontWeight:700,color:"#e2e8f0"}}>{title}</h3><Fresh date={data.date} source={data.source} url={data.url}/>{data.note&&<div style={{fontSize:10,color:"#f59e0b",marginTop:4}}>{data.note}</div>}</div>
    <div style={{padding:"12px 12px 4px"}}><ResponsiveContainer width="100%" height={220}><AreaChart data={cd}><defs><linearGradient id={`g${accentColor.slice(1)}`} x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={accentColor} stopOpacity={0.25}/><stop offset="95%" stopColor={accentColor} stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke="#1a1d23"/><XAxis dataKey="tenor" tick={{fill:"#64748b",fontSize:11}} axisLine={{stroke:"#1e2028"}} tickLine={false}/><YAxis tick={{fill:"#64748b",fontSize:11}} axisLine={{stroke:"#1e2028"}} tickLine={false} domain={["auto","auto"]} tickFormatter={v=>v?.toFixed(1)}/><Tooltip content={<CTooltip/>}/><Area type="monotone" dataKey="current" stroke={accentColor} strokeWidth={2.5} fill={`url(#g${accentColor.slice(1)})`} name="Current" dot={{r:3,fill:accentColor}} connectNulls/><Line type="monotone" dataKey="prior" stroke="#475569" strokeWidth={1.5} strokeDasharray="5 5" name="Prior" dot={false} connectNulls/></AreaChart></ResponsiveContainer></div>
    <div style={{padding:"0 20px 14px",overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}><thead><tr style={{borderBottom:"1px solid #1e2028"}}>{["Tenor","Yield","Prior","Chg (bp)"].map(h=><th key={h} style={{textAlign:h==="Tenor"?"left":"right",padding:"6px 10px",color:"#64748b",fontWeight:600,fontSize:11}}>{h}</th>)}</tr></thead><tbody>{cd.map((r,i)=>{const ch=parseFloat(r.change);return<tr key={i} style={{borderBottom:"1px solid #13151b"}}><td style={{padding:"5px 10px",color:"#e2e8f0",fontWeight:600,fontFamily:"monospace"}}>{r.tenor}</td><td style={{padding:"5px 10px",color:"#e2e8f0",textAlign:"right",fontFamily:"monospace"}}>{fmtY(r.current)}</td><td style={{padding:"5px 10px",color:"#94a3b8",textAlign:"right",fontFamily:"monospace"}}>{fmtY(r.prior)}</td><td style={{padding:"5px 10px",textAlign:"right",fontFamily:"monospace",color:chgCol(ch),fontWeight:600}}>{r.change!=null?(ch>0?"+":"")+r.change:"—"}</td></tr>;})}</tbody></table></div>
  </div>;
};

// ── Credit Section ──
const CreditSection=({data,loading:ld})=>{const[mkt,setMkt]=useState("us");if(ld)return<div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:10,padding:40,textAlign:"center",color:"#64748b"}}><Loader size={24} style={{animation:"spin 1s linear infinite",margin:"0 auto 10px",display:"block",color:"#3b82f6"}}/>Loading…</div>;if(!data)return null;const entries=Object.values(mkt==="us"?data.us:data.eu).filter(e=>e.spread!=null);return<div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:10,overflow:"hidden"}}><div style={{padding:"14px 20px",borderBottom:"1px solid #1e2028",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}><div><h3 style={{margin:0,fontSize:15,fontWeight:700,color:"#e2e8f0"}}>Corporate Credit Spreads (OAS)</h3><Fresh date={data.date} source={data.source} url={data.url}/></div><div style={{display:"flex",gap:4}}>{["us","eu"].map(m=><button key={m} onClick={()=>setMkt(m)} style={{background:mkt===m?"#3b82f6":"transparent",border:"1px solid #2a2d35",borderRadius:6,padding:"5px 14px",fontSize:11,color:mkt===m?"#fff":"#94a3b8",cursor:"pointer",fontWeight:600,textTransform:"uppercase"}}>{m==="us"?"US":"EUR"}</button>)}</div></div><div style={{padding:"8px 20px",overflowX:"auto"}}>{entries.length===0?<div style={{padding:20,color:"#475569",textAlign:"center"}}>EUR credit spreads require iBoxx (paid).</div>:<table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}><thead><tr style={{borderBottom:"1px solid #1e2028"}}>{["Index","OAS (bp)","Prior","Chg","YTD Avg"].map(h=><th key={h} style={{textAlign:h==="Index"?"left":"right",padding:"6px 10px",color:"#64748b",fontWeight:600,fontSize:11}}>{h}</th>)}</tr></thead><tbody>{entries.map((r,i)=>{const c=r.spread-r.prior;return<tr key={i} style={{borderBottom:"1px solid #13151b"}}><td style={{padding:"6px 10px",color:"#e2e8f0",fontWeight:600}}>{r.name} <Badge color={["HY","BB","B","CCC"].includes(r.bucket)?"#ef4444":"#22c55e"}>{r.bucket}</Badge></td><td style={{padding:"6px 10px",color:"#e2e8f0",textAlign:"right",fontFamily:"monospace",fontWeight:700}}>{r.spread}</td><td style={{padding:"6px 10px",color:"#94a3b8",textAlign:"right",fontFamily:"monospace"}}>{r.prior}</td><td style={{padding:"6px 10px",textAlign:"right",fontFamily:"monospace",color:chgCol(c*-1),fontWeight:600}}>{c>0?"+":""}{c}</td><td style={{padding:"6px 10px",color:"#94a3b8",textAlign:"right",fontFamily:"monospace"}}>{r.ytd_avg}</td></tr>;})}</tbody></table>}</div>{data.history?.length>0&&<div style={{padding:"12px 12px 8px"}}><ResponsiveContainer width="100%" height={190}><BarChart data={data.history}><CartesianGrid strokeDasharray="3 3" stroke="#1a1d23"/><XAxis dataKey="date" tick={{fill:"#64748b",fontSize:11}} axisLine={{stroke:"#1e2028"}} tickLine={false}/><YAxis tick={{fill:"#64748b",fontSize:11}} axisLine={{stroke:"#1e2028"}} tickLine={false}/><Tooltip content={<STooltip/>}/><Bar dataKey="ig" fill="#3b82f6" name="IG" radius={[3,3,0,0]}/><Bar dataKey="bbb" fill="#f59e0b" name="BBB" radius={[3,3,0,0]}/><Bar dataKey="hy" fill="#ef4444" name="HY" radius={[3,3,0,0]}/><Legend wrapperStyle={{fontSize:11}}/></BarChart></ResponsiveContainer></div>}</div>;};

// ── News & BMA (curated) ──
const NEWS=[{id:1,title:"UK gilt 10Y hits 5% for first time since 2008",source:"CNBC",date:"2026-03-20T09:30:00Z",topic:"Rates & Macro",url:"https://www.cnbc.com/2026/03/20/uk-gilt-market-interest-rates-boe-inflation-reeves.html",summary:"Energy price surge and hawkish BOE."},{id:2,title:"BOJ holds; Takata dissents, calls for 25bp hike to 1%",source:"Reuters",date:"2026-03-19T08:00:00Z",topic:"Rates & Macro",url:"#",summary:"Ueda signals possible rate hike."},{id:3,title:"Apollo raises $8.2B for insurance private credit fund",source:"Reuters",date:"2026-03-20T14:30:00Z",topic:"Private Credit",url:"#",summary:"IG private placements for insurance."},{id:4,title:"BOE holds at 3.75% unanimously; inflation warning",source:"FT",date:"2026-03-20T10:00:00Z",topic:"Rates & Macro",url:"#",summary:"Markets price in rate hikes."},{id:5,title:"Bermuda reinsurer completes $1.5B structured credit acquisition",source:"Ins Insider",date:"2026-03-19T16:45:00Z",topic:"Structured Credit",url:"#",summary:"CLO/ABS to Class E insurer."},{id:6,title:"NAIC proposes enhanced insurer private credit reporting",source:"AM Best",date:"2026-03-19T14:20:00Z",topic:"Insurance AM",url:"#",summary:"More transparency on illiquid assets."}];
const BMA_DATA=[{id:1,title:"Notice – Pre-Approval for New Insurance Registrations",date:"2026-03-19",category:"Licensing",url:"https://www.bma.bm",summary:"Updated Class D/E requirements.",isNew:true},{id:2,title:"Notice – Regulatory Burden Reduction",date:"2026-02-19",category:"Governance",url:"https://www.bma.bm",summary:"Streamlined reporting.",isNew:true},{id:3,title:"Notice – 2025 Year-End BSCR Model Republication",date:"2026-02-18",category:"Capital/Solvency",url:"https://www.bma.bm",summary:"Republished BSCR with validation.",isNew:true},{id:4,title:"DP – AI Governance Framework",date:"2026-02-09",category:"Governance",url:"https://www.bma.bm",summary:"Final proposal Q3 2026.",isNew:true},{id:5,title:"CP – Prudent Person Principle",date:"2025-12-15",category:"Investment",url:"https://www.bma.bm",summary:"PPP guidance for NPTA.",isNew:false},{id:6,title:"Class C,D,E Solvency Amendment Rules 2025",date:"2025-12-01",category:"Capital/Solvency",url:"https://www.bma.bm",summary:"New A&L Statement disclosure.",isNew:false}];
const tc={"Private Credit":"#8b5cf6","Credit Markets":"#3b82f6","Rates & Macro":"#22c55e","Structured Credit":"#f59e0b","Insurance AM":"#ec4899","Pension/Insurance":"#14b8a6"};
const cc={"Capital/Solvency":"#ef4444",Investment:"#f59e0b",Governance:"#8b5cf6",Licensing:"#22c55e"};

const NewsSection=()=>{const topics=[...new Set(NEWS.map(n=>n.topic))];const[sel,setSel]=useState("All");const filtered=sel==="All"?NEWS:NEWS.filter(n=>n.topic===sel);return<div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:10,overflow:"hidden"}}><div style={{padding:"14px 20px",borderBottom:"1px solid #1e2028"}}><h3 style={{margin:"0 0 10px",fontSize:15,fontWeight:700,color:"#e2e8f0"}}><Newspaper size={16} style={{verticalAlign:"middle",marginRight:8}}/>News</h3><div style={{fontSize:11,color:"#f59e0b",marginBottom:8}}><AlertTriangle size={12} style={{verticalAlign:"middle",marginRight:4}}/>Curated — live RSS requires GitHub Actions pipeline.</div><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{["All",...topics].map(t=><button key={t} onClick={()=>setSel(t)} style={{background:sel===t?(tc[t]||"#3b82f6"):"transparent",border:`1px solid ${sel===t?(tc[t]||"#3b82f6"):"#2a2d35"}`,borderRadius:20,padding:"4px 14px",fontSize:11,color:sel===t?"#fff":"#94a3b8",cursor:"pointer",fontWeight:600}}>{t}</button>)}</div></div><div style={{maxHeight:500,overflowY:"auto"}}>{filtered.map(item=><div key={item.id} style={{padding:"12px 20px",borderBottom:"1px solid #13151b"}} onMouseEnter={e=>e.currentTarget.style.background="#12141a"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}><div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}><Badge color={tc[item.topic]||"#3b82f6"}>{item.topic}</Badge><span style={{fontSize:11,color:"#475569"}}>{item.source} • {timeAgo(item.date)}</span></div><h4 style={{margin:"0 0 3px",fontSize:13,fontWeight:600,color:"#e2e8f0",lineHeight:1.4}}>{item.title}</h4><p style={{margin:0,fontSize:12,color:"#64748b"}}>{item.summary}</p></div>)}</div></div>;};
const BMASection=()=>{const cats=[...new Set(BMA_DATA.map(u=>u.category))];const[cf,setCf]=useState("All");const filtered=cf==="All"?BMA_DATA:BMA_DATA.filter(u=>u.category===cf);return<div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:10,overflow:"hidden"}}><div style={{padding:"14px 20px",borderBottom:"1px solid #1e2028"}}><h3 style={{margin:"0 0 10px",fontSize:15,fontWeight:700,color:"#e2e8f0"}}><Shield size={16} style={{verticalAlign:"middle",marginRight:8}}/>BMA Updates</h3><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{["All",...cats].map(c=><button key={c} onClick={()=>setCf(c)} style={{background:cf===c?(cc[c]||"#3b82f6"):"transparent",border:`1px solid ${cf===c?(cc[c]||"#3b82f6"):"#2a2d35"}`,borderRadius:20,padding:"4px 14px",fontSize:11,color:cf===c?"#fff":"#94a3b8",cursor:"pointer",fontWeight:500}}>{c}</button>)}</div></div><div>{filtered.map(item=><div key={item.id} style={{padding:"12px 20px",borderBottom:"1px solid #13151b"}} onMouseEnter={e=>e.currentTarget.style.background="#12141a"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}><div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}><Badge color={cc[item.category]||"#3b82f6"}>{item.category}</Badge>{item.isNew&&<Badge color="#22c55e">NEW</Badge>}<span style={{fontSize:11,color:"#475569"}}>{item.date}</span></div><h4 style={{margin:"0 0 3px",fontSize:13,fontWeight:600,color:"#e2e8f0",lineHeight:1.4}}>{item.title}</h4><p style={{margin:0,fontSize:12,color:"#64748b"}}>{item.summary}</p></div>)}</div></div>;};

// ═══════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════

const PAGES=[{id:"home",label:"Overview",icon:Activity},{id:"ust",label:"US Treasuries",icon:DollarSign},{id:"jgb",label:"Japan JGB",icon:Globe},{id:"gilt",label:"UK Gilts",icon:Globe},{id:"eiopa",label:"EIOPA EUR",icon:Globe},{id:"india",label:"India Govt",icon:Globe},{id:"credit",label:"Credit Spreads",icon:Percent},{id:"news",label:"News",icon:Newspaper},{id:"bma",label:"BMA Updates",icon:Shield}];

export default function App(){
  const[page,setPage]=useState("home");
  const[sidebarOpen,setSidebarOpen]=useState(true);
  const[clock,setClock]=useState("");
  const[apiKey,setApiKey]=useState("");const[keyInput,setKeyInput]=useState("");const[showSettings,setShowSettings]=useState(false);
  const[ust,setUst]=useState(null);const[jgb,setJgb]=useState(null);const[gilt,setGilt]=useState(null);const[eiopa,setEiopa]=useState(null);const[india,setIndia]=useState(null);const[credit,setCredit]=useState(null);
  const[ls,setLs]=useState({});const[errs,setErrs]=useState({});const[gLoad,setGLoad]=useState(false);const[lastRef,setLastRef]=useState(null);

  useEffect(()=>{const t=setInterval(()=>setClock(new Date().toLocaleTimeString("en-US",{hour12:false})),1000);setClock(new Date().toLocaleTimeString("en-US",{hour12:false}));return()=>clearInterval(t);},[]);
  useEffect(()=>{try{const s=window.localStorage?.getItem("fred_api_key");if(s){setApiKey(s);setKeyInput(s);}}catch{}},[]);
  const saveKey=useCallback(()=>{const k=keyInput.trim();if(k.length>=20){setApiKey(k);try{window.localStorage?.setItem("fred_api_key",k);}catch{}setShowSettings(false);}},[keyInput]);

  const refreshAll=useCallback(async()=>{
    if(!apiKey){setShowSettings(true);return;}
    setGLoad(true);setLs({ust:true,jgb:true,gilt:true,eiopa:true,india:true,credit:true});setErrs({});
    const es={};
    const run=async(key,fn,setter)=>{try{setter(await fn());}catch(e){es[key]=e.message;}finally{setLs(p=>({...p,[key]:false}));}};
    await Promise.all([
      run("ust",()=>fetchUST(apiKey),setUst),
      run("jgb",fetchJGB,setJgb),
      run("gilt",fetchGilt,setGilt),
      run("eiopa",fetchEUR,setEiopa),
      run("india",()=>fetchIndia(apiKey),setIndia),
      run("credit",()=>fetchCredit(apiKey),setCredit),
    ]);
    setErrs(es);setLastRef(new Date());setGLoad(false);
  },[apiKey]);

  useEffect(()=>{if(apiKey)refreshAll();},[apiKey]);

  const gv=(d,t)=>{if(!d)return null;const i=d.tenors.indexOf(t);return i>=0?d.yields[i]:null;};
  const gp=(d,t)=>{if(!d)return null;const i=d.tenors.indexOf(t);return i>=0?d.prior_yields[i]:null;};
  const ust10y=gv(ust,"10Y"),ust10yP=gp(ust,"10Y"),ust2y=gv(ust,"2Y"),ust2yP=gp(ust,"2Y");
  const jgb10y=gv(jgb,"10Y"),jgb10yP=gp(jgb,"10Y"),gilt10y=gv(gilt,"10Y"),gilt10yP=gp(gilt,"10Y"),india10y=gv(india,"10Y"),india10yP=gp(india,"10Y");

  const compT=["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","30Y"];
  const mc=compT.map(t=>({tenor:t,UST:gv(ust,t),JGB:gv(jgb,t),Gilt:gv(gilt,t),EUR:gv(eiopa,t),India:gv(india,t)}));
  const hasCurve=ust||jgb||gilt||eiopa||india;const noKey=!apiKey;

  const renderPage=()=>{switch(page){
    case"ust":return<SovSection data={ust} title="US Treasury Par Yield Curve (CMT)" accentColor="#3b82f6" loading={ls.ust} error={errs.ust}/>;
    case"jgb":return<SovSection data={jgb} title="Japan Government Bond Yields (JGB)" accentColor="#ef4444" loading={ls.jgb} error={errs.jgb}/>;
    case"gilt":return<SovSection data={gilt} title="UK Gilt Nominal Par Yields" accentColor="#22c55e" loading={ls.gilt} error={errs.gilt}/>;
    case"eiopa":return<SovSection data={eiopa} title="EUR AAA Govt Yield Curve (ECB — EIOPA proxy)" accentColor="#f59e0b" loading={ls.eiopa} error={errs.eiopa}/>;
    case"india":return<SovSection data={india} title="India Government Bond Yields" accentColor="#ec4899" loading={ls.india} error={errs.india}/>;
    case"credit":return<CreditSection data={credit} loading={ls.credit}/>;
    case"news":return<NewsSection/>;case"bma":return<BMASection/>;
    default:return<div style={{display:"flex",flexDirection:"column",gap:18}}>
      {noKey&&<div style={{background:"#1a1206",border:"1px solid #854d0e",borderRadius:10,padding:"16px 20px",display:"flex",alignItems:"center",gap:12}}><Key size={20} style={{color:"#f59e0b",flexShrink:0}}/><div style={{flex:1}}><div style={{color:"#fbbf24",fontWeight:700,fontSize:14,marginBottom:4}}>FRED API Key Required</div><div style={{color:"#a3a3a3",fontSize:12}}>Free at <a href="https://fred.stlouisfed.org/docs/api/api_key.html" target="_blank" rel="noopener noreferrer" style={{color:"#3b82f6"}}>fred.stlouisfed.org</a>. Click <Settings size={12} style={{verticalAlign:"middle"}}/> above to enter it.</div></div></div>}
      {Object.keys(errs).length>0&&<div style={{background:"#1a0a0a",border:"1px solid #7f1d1d",borderRadius:10,padding:"12px 20px"}}><div style={{color:"#ef4444",fontWeight:700,fontSize:12,marginBottom:4}}><AlertTriangle size={14} style={{verticalAlign:"middle",marginRight:4}}/>Errors:</div>{Object.entries(errs).map(([k,v])=><div key={k} style={{color:"#a3a3a3",fontSize:11}}>• <strong>{k}</strong>: {v}</div>)}</div>}
      <div><h3 style={{margin:"0 0 10px",fontSize:13,fontWeight:700,color:"#64748b",textTransform:"uppercase",letterSpacing:"0.1em"}}>Key Rates {ust?`(${ust.date})`:""}</h3><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(165px,1fr))",gap:10}}>
        <MetricCard label="UST 10Y" value={fmtY(ust10y)} change={chgBp(ust10y,ust10yP)} loading={ls.ust}/>
        <MetricCard label="UST 2Y" value={fmtY(ust2y)} change={chgBp(ust2y,ust2yP)} loading={ls.ust}/>
        <MetricCard label="UST 2s10s" value={ust10y!=null&&ust2y!=null?((ust10y-ust2y)*100).toFixed(0)+"bp":"—"} change={ust10yP!=null?chgBp(ust10y-ust2y,ust10yP-ust2yP):null} loading={ls.ust}/>
        <MetricCard label="JGB 10Y" value={fmtY(jgb10y)} change={chgBp(jgb10y,jgb10yP)} loading={ls.jgb}/>
        <MetricCard label="UK Gilt 10Y" value={fmtY(gilt10y)} change={chgBp(gilt10y,gilt10yP)} loading={ls.gilt}/>
        <MetricCard label="India 10Y" value={fmtY(india10y)} change={chgBp(india10y,india10yP)} loading={ls.india}/>
        <MetricCard label="US IG OAS" value={credit?.us?.ig?.spread!=null?credit.us.ig.spread+"bp":"—"} change={credit?.us?.ig?(credit.us.ig.spread-credit.us.ig.prior).toFixed(0):null} loading={ls.credit}/>
        <MetricCard label="US HY OAS" value={credit?.us?.hy?.spread!=null?credit.us.hy.spread+"bp":"—"} change={credit?.us?.hy?(credit.us.hy.spread-credit.us.hy.prior).toFixed(0):null} loading={ls.credit}/>
      </div></div>
      {hasCurve&&<div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:10,padding:"14px 14px 6px"}}>
        <h3 style={{margin:"0 0 10px 6px",fontSize:13,fontWeight:700,color:"#64748b",textTransform:"uppercase",letterSpacing:"0.1em"}}>Global Yield Curve Comparison</h3>
        <ResponsiveContainer width="100%" height={320}><LineChart data={mc}><CartesianGrid strokeDasharray="3 3" stroke="#1a1d23"/><XAxis dataKey="tenor" tick={{fill:"#64748b",fontSize:11}} axisLine={{stroke:"#1e2028"}} tickLine={false}/><YAxis tick={{fill:"#64748b",fontSize:11}} axisLine={{stroke:"#1e2028"}} tickLine={false} domain={[0,"auto"]} tickFormatter={v=>v.toFixed(1)+"%"}/><Tooltip content={<CTooltip/>}/><Line type="monotone" dataKey="India" stroke="#ec4899" strokeWidth={2} name="India" dot={{r:3}} connectNulls/><Line type="monotone" dataKey="Gilt" stroke="#22c55e" strokeWidth={2} name="UK Gilt" dot={{r:3}} connectNulls/><Line type="monotone" dataKey="UST" stroke="#3b82f6" strokeWidth={2.5} name="US Treasury" dot={{r:4}} connectNulls/><Line type="monotone" dataKey="EUR" stroke="#f59e0b" strokeWidth={2} name="EUR (ECB)" dot={{r:3}} connectNulls/><Line type="monotone" dataKey="JGB" stroke="#ef4444" strokeWidth={2} name="Japan JGB" dot={{r:3}} connectNulls/><Legend wrapperStyle={{fontSize:11,paddingTop:8}}/></LineChart></ResponsiveContainer>
        <div style={{overflowX:"auto",padding:"4px 6px 10px"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}><thead><tr style={{borderBottom:"1px solid #1e2028"}}><th style={{textAlign:"left",padding:"5px 8px",color:"#64748b",fontWeight:600}}>Tenor</th><th style={{textAlign:"right",padding:"5px 8px",color:"#3b82f6",fontWeight:600}}>UST</th><th style={{textAlign:"right",padding:"5px 8px",color:"#ef4444",fontWeight:600}}>JGB</th><th style={{textAlign:"right",padding:"5px 8px",color:"#22c55e",fontWeight:600}}>Gilt</th><th style={{textAlign:"right",padding:"5px 8px",color:"#f59e0b",fontWeight:600}}>EUR</th><th style={{textAlign:"right",padding:"5px 8px",color:"#ec4899",fontWeight:600}}>India</th></tr></thead><tbody>{mc.map((r,i)=><tr key={i} style={{borderBottom:"1px solid #13151b"}}><td style={{padding:"4px 8px",color:"#e2e8f0",fontWeight:600,fontFamily:"monospace"}}>{r.tenor}</td>{["UST","JGB","Gilt","EUR","India"].map(k=><td key={k} style={{padding:"4px 8px",textAlign:"right",fontFamily:"monospace",color:r[k]!=null?"#e2e8f0":"#334155"}}>{r[k]!=null?r[k].toFixed(2)+"%":"—"}</td>)}</tr>)}</tbody></table></div>
        <div style={{padding:"4px 8px 10px",display:"flex",gap:16,flexWrap:"wrap",fontSize:10,color:"#475569"}}>{ust&&<span>UST: {ust.date}</span>}{jgb&&<span>JGB: {jgb.date}</span>}{gilt&&<span>Gilt: {gilt.date}</span>}{eiopa&&<span>EUR: {eiopa.date}</span>}{india&&<span>India: {india.date}</span>}</div>
      </div>}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
        <div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:10,overflow:"hidden"}}><div style={{padding:"12px 20px",borderBottom:"1px solid #1e2028",display:"flex",justifyContent:"space-between",alignItems:"center"}}><h3 style={{margin:0,fontSize:13,fontWeight:700,color:"#e2e8f0"}}><Newspaper size={14} style={{verticalAlign:"middle",marginRight:6}}/>Latest News</h3><button onClick={()=>setPage("news")} style={{background:"transparent",border:"none",color:"#3b82f6",fontSize:11,cursor:"pointer",fontWeight:600}}>All<ChevronRight size={12} style={{verticalAlign:"middle"}}/></button></div>{NEWS.slice(0,4).map(item=><div key={item.id} style={{padding:"8px 20px",borderBottom:"1px solid #13151b"}}><div style={{display:"flex",gap:6,alignItems:"center",marginBottom:2}}><Badge>{item.topic}</Badge><span style={{fontSize:10,color:"#475569"}}>{timeAgo(item.date)}</span></div><div style={{fontSize:12,fontWeight:600,color:"#e2e8f0",lineHeight:1.4}}>{item.title}</div></div>)}</div>
        <div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:10,overflow:"hidden"}}><div style={{padding:"12px 20px",borderBottom:"1px solid #1e2028",display:"flex",justifyContent:"space-between",alignItems:"center"}}><h3 style={{margin:0,fontSize:13,fontWeight:700,color:"#e2e8f0"}}><Shield size={14} style={{verticalAlign:"middle",marginRight:6}}/>BMA Updates</h3><button onClick={()=>setPage("bma")} style={{background:"transparent",border:"none",color:"#3b82f6",fontSize:11,cursor:"pointer",fontWeight:600}}>All<ChevronRight size={12} style={{verticalAlign:"middle"}}/></button></div>{BMA_DATA.filter(u=>u.isNew).slice(0,4).map(item=><div key={item.id} style={{padding:"8px 20px",borderBottom:"1px solid #13151b"}}><div style={{display:"flex",gap:6,alignItems:"center",marginBottom:2}}><Badge color="#22c55e">NEW</Badge><Badge>{item.category}</Badge><span style={{fontSize:10,color:"#475569"}}>{item.date}</span></div><div style={{fontSize:12,fontWeight:600,color:"#e2e8f0",lineHeight:1.4}}>{item.title}</div></div>)}</div>
      </div>
    </div>;}};

  return<div style={{display:"flex",height:"100vh",background:"#080a0f",color:"#e2e8f0",fontFamily:"'JetBrains Mono','IBM Plex Sans',-apple-system,sans-serif",fontSize:13,overflow:"hidden"}}>
    <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    {showSettings&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setShowSettings(false)}><div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:12,padding:24,width:440,maxWidth:"90vw"}} onClick={e=>e.stopPropagation()}><h3 style={{margin:"0 0 8px",fontSize:16,fontWeight:700}}><Key size={18} style={{verticalAlign:"middle",marginRight:8,color:"#f59e0b"}}/>FRED API Key</h3><p style={{color:"#94a3b8",fontSize:12,marginBottom:16,lineHeight:1.5}}>Free at <a href="https://fred.stlouisfed.org/docs/api/api_key.html" target="_blank" rel="noopener noreferrer" style={{color:"#3b82f6"}}>fred.stlouisfed.org</a>. Required for UST + credit spreads. JGB/Gilt/EUR work without it.</p><div style={{display:"flex",gap:8}}><input value={keyInput} onChange={e=>setKeyInput(e.target.value)} placeholder="Paste FRED API key" style={{flex:1,background:"#12141a",border:"1px solid #2a2d35",borderRadius:6,padding:"10px 14px",color:"#e2e8f0",fontSize:13,fontFamily:"monospace",outline:"none"}} onKeyDown={e=>e.key==="Enter"&&saveKey()}/><button onClick={saveKey} style={{background:"#3b82f6",border:"none",borderRadius:6,padding:"10px 20px",color:"#fff",fontWeight:700,cursor:"pointer"}}>Save</button></div>{apiKey&&<div style={{marginTop:10,fontSize:11,color:"#22c55e",display:"flex",alignItems:"center",gap:4}}><CheckCircle size={12}/>Saved: {apiKey.slice(0,8)}…</div>}</div></div>}
    <div style={{width:sidebarOpen?210:52,transition:"width 0.2s",background:"#0a0c12",borderRight:"1px solid #1a1d23",display:"flex",flexDirection:"column",flexShrink:0,overflow:"hidden"}}>
      <div style={{padding:sidebarOpen?"14px 16px":"14px 10px",borderBottom:"1px solid #1a1d23",display:"flex",alignItems:"center",gap:10,cursor:"pointer",minHeight:52}} onClick={()=>setSidebarOpen(!sidebarOpen)}><div style={{width:28,height:28,borderRadius:6,background:"linear-gradient(135deg,#3b82f6,#8b5cf6)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><BarChart3 size={16} color="#fff"/></div>{sidebarOpen&&<div><div style={{fontSize:13,fontWeight:800,color:"#e2e8f0",letterSpacing:"-0.02em",lineHeight:1.1}}>BERMUDA</div><div style={{fontSize:9,fontWeight:600,color:"#3b82f6",letterSpacing:"0.15em",textTransform:"uppercase"}}>MARKET INTEL</div></div>}</div>
      <div style={{flex:1,padding:"6px",overflowY:"auto"}}>{PAGES.map(p=>{const Icon=p.icon;const a=page===p.id;return<button key={p.id} onClick={()=>setPage(p.id)} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:sidebarOpen?"8px 10px":"8px",marginBottom:1,borderRadius:6,border:"none",background:a?"#1e2028":"transparent",color:a?"#e2e8f0":"#64748b",cursor:"pointer",fontSize:12,fontWeight:a?600:500,textAlign:"left",justifyContent:sidebarOpen?"flex-start":"center"}} onMouseEnter={e=>{if(!a)e.currentTarget.style.background="#12141a"}} onMouseLeave={e=>{if(!a)e.currentTarget.style.background="transparent"}}><Icon size={15} style={{flexShrink:0}}/>{sidebarOpen&&<span>{p.label}</span>}</button>;})}</div>
      {sidebarOpen&&<div style={{padding:"10px 14px",borderTop:"1px solid #1a1d23",fontSize:10,color:"#334155"}}>Live: FRED + ECB + MOF JP + BoE</div>}
    </div>
    <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
      <div style={{height:42,padding:"0 20px",borderBottom:"1px solid #1a1d23",background:"#0a0c12",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
        <h2 style={{margin:0,fontSize:14,fontWeight:700}}>{PAGES.find(p=>p.id===page)?.label||"Overview"}</h2>
        <div style={{display:"flex",alignItems:"center",gap:10,fontSize:11}}>
          {lastRef&&<span style={{color:"#475569",fontSize:10}}>Last: {lastRef.toLocaleTimeString()}</span>}
          {gLoad&&<Loader size={14} style={{color:"#3b82f6",animation:"spin 1s linear infinite"}}/>}
          <button onClick={refreshAll} disabled={gLoad||noKey} style={{background:gLoad?"#1e2028":"#3b82f6",border:"none",borderRadius:6,padding:"5px 14px",color:gLoad?"#64748b":"#fff",cursor:gLoad||noKey?"not-allowed":"pointer",display:"flex",alignItems:"center",gap:5,fontWeight:700,fontSize:12,opacity:noKey?0.4:1}}><RefreshCw size={13} style={{animation:gLoad?"spin 1s linear infinite":"none"}}/>{gLoad?"Fetching…":"Refresh"}</button>
          <button onClick={()=>setShowSettings(true)} style={{background:"transparent",border:"1px solid #2a2d35",borderRadius:6,padding:"5px 8px",cursor:"pointer",display:"flex",alignItems:"center"}}><Settings size={14} style={{color:apiKey?"#22c55e":"#f59e0b"}}/></button>
          <span style={{color:"#3b82f6",fontFamily:"monospace",fontWeight:700,fontSize:13}}>{clock}</span>
        </div>
      </div>
      <div style={{flex:1,overflow:"auto",padding:18}}>{renderPage()}</div>
      <div style={{height:26,padding:"0 20px",borderTop:"1px solid #1a1d23",background:"#0a0c12",display:"flex",alignItems:"center",justifyContent:"space-between",fontSize:10,color:"#334155",flexShrink:0}}>
        <div style={{display:"flex",gap:14}}>{ust10y!=null&&<span>UST 10Y:{fmtY(ust10y)}</span>}{jgb10y!=null&&<span>JGB 10Y:{fmtY(jgb10y)}</span>}{gilt10y!=null&&<span>Gilt 10Y:{fmtY(gilt10y)}</span>}{india10y!=null&&<span>India 10Y:{fmtY(india10y)}</span>}{credit?.us?.ig?.spread!=null&&<span>IG:{credit.us.ig.spread}bp</span>}{credit?.us?.hy?.spread!=null&&<span>HY:{credit.us.hy.spread}bp</span>}</div>
        <span>Bermuda Market Intel v4.0 — Live</span>
      </div>
    </div>
  </div>;
}

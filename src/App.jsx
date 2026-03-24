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
   BERMUDA MARKET INTELLIGENCE TERMINAL v3.0
   ALL DATA LIVE — FRED, ECB, MOF Japan, BoE, WGB (via CORS proxy)
   ═══════════════════════════════════════════════════════════════════ */

const PROXY = "https://api.allorigins.win/get?url=";
const proxyFetch = async (url) => {
  const res = await fetch(PROXY + encodeURIComponent(url));
  if (!res.ok) throw new Error(`Proxy ${res.status}`);
  const json = await res.json();
  return json.contents;
};

// ═══════════════════════════════════════════
// DATA FETCHERS
// ═══════════════════════════════════════════

// ── 1. US TREASURY (FRED — native CORS) ──

const UST_SERIES = { "1M":"DGS1MO","3M":"DGS3MO","6M":"DGS6MO","1Y":"DGS1","2Y":"DGS2","3Y":"DGS3","5Y":"DGS5","7Y":"DGS7","10Y":"DGS10","20Y":"DGS20","30Y":"DGS30" };
const UST_TENORS = Object.keys(UST_SERIES);

async function fredFetch(seriesId, apiKey, limit = 10) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId}: ${res.status}`);
  const data = await res.json();
  return (data.observations || []).filter(o => o.value !== ".").map(o => ({ date: o.date, value: parseFloat(o.value) }));
}

async function fetchUSTCurve(apiKey) {
  const results = await Promise.all(UST_TENORS.map(async t => {
    try { return { tenor: t, obs: await fredFetch(UST_SERIES[t], apiKey, 10) }; }
    catch { return { tenor: t, obs: [] }; }
  }));
  const allDates = [...new Set(results.flatMap(r => r.obs.map(o => o.date)))].sort().reverse();
  const [latestDate, priorDate] = [allDates[0] || "", allDates[1] || ""];
  const getVal = (t, d) => results.find(x => x.tenor === t)?.obs.find(o => o.date === d)?.value ?? null;
  return {
    date: latestDate, prior_date: priorDate,
    source: "FRED / US Treasury CMT", url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates",
    tenors: UST_TENORS,
    yields: UST_TENORS.map(t => getVal(t, latestDate)),
    prior_yields: UST_TENORS.map(t => getVal(t, priorDate)),
    history: allDates.slice(0, 6).map(d => ({ date: d, yields: UST_TENORS.map(t => getVal(t, d)) })),
  };
}

// ── 2. JAPAN JGB (MOF CSV via proxy) ──

const JGB_TENORS = ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","25Y","30Y","40Y"];
const JGB_COL_MAP = { 1:"1Y",2:"2Y",3:"3Y",5:"5Y",7:"7Y",10:"10Y",11:"15Y",12:"20Y",13:"25Y",14:"30Y",15:"40Y" };

async function fetchJGBCurve() {
  const csvUrl = "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv";
  const raw = await proxyFetch(csvUrl);
  const lines = raw.split("\n");
  const rows = [];
  for (const line of lines) {
    const parts = line.split(",").map(s => s.trim().replace(/"/g, ""));
    if (parts.length < 10) continue;
    let date = null;
    for (const fmt of [/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, /^(\d{4})-(\d{1,2})-(\d{1,2})$/]) {
      const m = parts[0].match(fmt);
      if (m) { date = `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`; break; }
    }
    if (!date) continue;
    const yields = {};
    for (const [col, tenor] of Object.entries(JGB_COL_MAP)) {
      const v = parseFloat(parts[+col]);
      yields[tenor] = isNaN(v) ? null : v;
    }
    rows.push({ date, yields });
  }
  rows.sort((a, b) => b.date.localeCompare(a.date));
  if (rows.length < 2) throw new Error("JGB: <2 rows parsed");
  const [latest, prior] = [rows[0], rows[1]];
  return {
    date: latest.date, prior_date: prior.date,
    source: "Ministry of Finance Japan", url: "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/",
    tenors: JGB_TENORS,
    yields: JGB_TENORS.map(t => latest.yields[t]),
    prior_yields: JGB_TENORS.map(t => prior.yields[t]),
    history: rows.slice(0, 6).map(r => ({ date: r.date, yields: JGB_TENORS.map(t => r.yields[t]) })),
  };
}

// ── 3. UK GILTS (Bank of England CSV API via proxy) ──

const GILT_SERIES = { "1Y":"IUMALNPY","2Y":"IUMALNP2","3Y":"IUMALNP3","5Y":"IUMALNP5","7Y":"IUMALNP7","10Y":"IUMALNP10","15Y":"IUMALNP15","20Y":"IUMALNP20","25Y":"IUMALNP25","30Y":"IUMALNP30" };
const GILT_TENORS = Object.keys(GILT_SERIES);

async function fetchGiltCurve() {
  const seriesList = Object.values(GILT_SERIES).join(",");
  const end = new Date(); const start = new Date(end); start.setDate(start.getDate() - 21);
  const fmt = d => `${d.getDate()}/${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()]}/${d.getFullYear()}`;
  const boeUrl = `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&SeriesCodes=${seriesList}&CSVF=TN&Datefrom=${fmt(start)}&Dateto=${fmt(end)}`;
  const raw = await proxyFetch(boeUrl);
  const lines = raw.split("\n");
  const header = lines[0]?.split(",").map(s => s.trim().replace(/"/g, "")) || [];
  const datesByRow = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(s => s.trim().replace(/"/g, ""));
    const dateStr = cols[0];
    if (!dateStr) continue;
    let date;
    try {
      const parts = dateStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
      if (!parts) continue;
      const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
      date = new Date(+parts[3], months[parts[2]], +parts[1]);
    } catch { continue; }
    const dk = date.toISOString().slice(0, 10);
    const yields = {};
    for (const [tenor, series] of Object.entries(GILT_SERIES)) {
      const ci = header.indexOf(series);
      if (ci >= 0 && cols[ci]) { const v = parseFloat(cols[ci]); yields[tenor] = isNaN(v) ? null : v; }
      else yields[tenor] = null;
    }
    datesByRow[dk] = yields;
  }
  const dates = Object.keys(datesByRow).sort().reverse();
  if (dates.length < 2) throw new Error("Gilt: <2 dates parsed");
  return {
    date: dates[0], prior_date: dates[1],
    source: "Bank of England", url: "https://www.bankofengland.co.uk/statistics/yield-curves",
    tenors: GILT_TENORS,
    yields: GILT_TENORS.map(t => datesByRow[dates[0]][t]),
    prior_yields: GILT_TENORS.map(t => datesByRow[dates[1]][t]),
    history: dates.slice(0, 6).map(d => ({ date: d, yields: GILT_TENORS.map(t => datesByRow[d][t]) })),
  };
}

// ── 4. INDIA (worldgovernmentbonds.com via proxy) ──

const INDIA_TENORS = ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","30Y"];

async function fetchIndiaCurve() {
  const html = await proxyFetch("http://www.worldgovernmentbonds.com/country/india/");
  // Parse yield curve table — look for tenor/yield pairs in HTML
  const yields = {};
  // WGB uses a table with class "w3-table" containing rows with tenors and yields
  // Pattern: <td ...>10Y</td> ... <td ...>6.820%</td>
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const rowHtml = match[1];
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, "").trim());
    }
    // Look for tenor patterns like "1 Year", "10 Years", "6 Months"
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const tenorMatch = cell.match(/^(\d+)\s*(Year|Month)/i);
      if (tenorMatch) {
        const num = parseInt(tenorMatch[1]);
        const unit = tenorMatch[2].toLowerCase();
        let tenorKey = null;
        if (unit.startsWith("year")) tenorKey = num + "Y";
        else if (unit.startsWith("month") && num === 6) tenorKey = "6M";
        else if (unit.startsWith("month") && num === 3) tenorKey = "3M";
        if (tenorKey && INDIA_TENORS.includes(tenorKey)) {
          // Find the yield value in subsequent cells
          for (let j = i + 1; j < cells.length; j++) {
            const yieldMatch = cells[j].match(/([\d.]+)\s*%/);
            if (yieldMatch) {
              yields[tenorKey] = parseFloat(yieldMatch[1]);
              break;
            }
          }
        }
      }
    }
  }
  if (Object.keys(yields).length < 3) throw new Error("India: <3 tenors parsed");
  const today = new Date().toISOString().slice(0, 10);
  return {
    date: today, prior_date: "",
    source: "World Government Bonds", url: "http://www.worldgovernmentbonds.com/country/india/",
    tenors: INDIA_TENORS,
    yields: INDIA_TENORS.map(t => yields[t] ?? null),
    prior_yields: INDIA_TENORS.map(() => null),
    history: [],
    note: "Prior-day change not available from this source.",
  };
}

// ── 5. EIOPA / EUR (ECB SDW — native CORS) ──

const ECB_TENORS_MAP = { "1Y":"SR_1Y","2Y":"SR_2Y","3Y":"SR_3Y","5Y":"SR_5Y","7Y":"SR_7Y","10Y":"SR_10Y","15Y":"SR_15Y","20Y":"SR_20Y","30Y":"SR_30Y" };
const EIOPA_TENORS = Object.keys(ECB_TENORS_MAP);

async function fetchEIOPACurve() {
  const results = {};
  await Promise.all(EIOPA_TENORS.map(async tenor => {
    const sk = `B.U2.EUR.4F.G_N_A.SV_C_YM.${ECB_TENORS_MAP[tenor]}`;
    const url = `https://data-api.ecb.europa.eu/service/data/YC/${sk}?lastNObservations=5&format=csvdata`;
    try {
      const res = await fetch(url, { headers: { Accept: "text/csv" } });
      if (!res.ok) return;
      const text = await res.text();
      const lines = text.trim().split("\n");
      if (lines.length < 2) return;
      const header = lines[0].split(",");
      const obsIdx = header.findIndex(h => h.includes("OBS_VALUE"));
      const timeIdx = header.findIndex(h => h.includes("TIME_PERIOD"));
      if (obsIdx < 0) return;
      // Get last two observations
      const dataLines = lines.slice(1);
      const obs = dataLines.map(l => { const p = l.split(","); return { date: p[timeIdx]||"", value: parseFloat(p[obsIdx]) }; }).filter(o => !isNaN(o.value));
      obs.sort((a, b) => b.date.localeCompare(a.date));
      if (obs.length > 0) results[tenor] = { value: obs[0].value, prior: obs[1]?.value ?? null, date: obs[0].date };
    } catch {}
  }));
  const latestDate = Object.values(results).map(r => r.date).sort().reverse()[0] || "";
  return {
    date: latestDate, prior_date: "",
    source: "ECB SDW (EUR AAA Govt — EIOPA proxy)", url: "https://data.ecb.europa.eu/",
    tenors: EIOPA_TENORS,
    yields: EIOPA_TENORS.map(t => results[t]?.value ?? null),
    prior_yields: EIOPA_TENORS.map(t => results[t]?.prior ?? null),
    history: [],
    note: "EUR AAA govt yield curve. Actual EIOPA RFR includes UFR extrapolation.",
  };
}

// ── 6. CREDIT SPREADS (FRED — native CORS) ──

const CREDIT_SERIES = {
  ig:{id:"BAMLC0A0CM",name:"US IG (Master)",bucket:"IG"}, aaa:{id:"BAMLC0A1CAAA",name:"US AAA",bucket:"AAA"},
  aa:{id:"BAMLC0A2CAA",name:"US AA",bucket:"AA"}, a:{id:"BAMLC0A3CA",name:"US A",bucket:"A"},
  bbb:{id:"BAMLC0A4CBBB",name:"US BBB",bucket:"BBB"}, hy:{id:"BAMLH0A0HYM2",name:"US HY",bucket:"HY"},
  bb:{id:"BAMLH0A1HYBB",name:"US BB",bucket:"BB"}, b:{id:"BAMLH0A2HYB",name:"US B",bucket:"B"},
  ccc:{id:"BAMLH0A3HYC",name:"US CCC+",bucket:"CCC"},
};

async function fetchCreditSpreads(apiKey) {
  const entries = Object.entries(CREDIT_SERIES);
  const results = await Promise.all(entries.map(async ([key, info]) => {
    try { return { key, info, obs: await fredFetch(info.id, apiKey, 60) }; }
    catch { return { key, info, obs: [] }; }
  }));
  const us = {}; let latestDate = "";
  for (const { key, info, obs } of results) {
    if (!obs.length) continue;
    const [latest, prior] = [obs[0], obs[1] || obs[0]];
    if (latest.date > latestDate) latestDate = latest.date;
    const spread = Math.round(latest.value * 100);
    const priorSpread = Math.round(prior.value * 100);
    const yr = new Date().getFullYear();
    const ytdObs = obs.filter(o => o.date >= `${yr}-01-01`);
    const ytdAvg = ytdObs.length ? Math.round(ytdObs.reduce((s, o) => s + o.value, 0) / ytdObs.length * 100) : spread;
    us[key] = { name: info.name, spread, prior: priorSpread, ytd_avg: ytdAvg, bucket: info.bucket };
  }
  // Monthly history
  const months = {};
  for (const r of results) {
    if (!["ig","hy","bbb","aaa"].includes(r.key)) continue;
    for (const o of r.obs) {
      const m = o.date.slice(0, 7);
      if (!months[m]) months[m] = {};
      if (!months[m][r.key]) months[m][r.key] = [];
      months[m][r.key].push(o.value * 100);
    }
  }
  const history = Object.entries(months).sort(([a],[b]) => a.localeCompare(b)).slice(-6).map(([date, vals]) => ({
    date, ig: vals.ig ? Math.round(vals.ig.reduce((a,b)=>a+b,0)/vals.ig.length) : null,
    hy: vals.hy ? Math.round(vals.hy.reduce((a,b)=>a+b,0)/vals.hy.length) : null,
    bbb: vals.bbb ? Math.round(vals.bbb.reduce((a,b)=>a+b,0)/vals.bbb.length) : null,
    aaa: vals.aaa ? Math.round(vals.aaa.reduce((a,b)=>a+b,0)/vals.aaa.length) : null,
  }));
  return { date: latestDate, source: "FRED / ICE BofA Indices", url: "https://fred.stlouisfed.org/release?rid=209", us,
    eu: { ig:{name:"EUR IG",spread:null,prior:null,ytd_avg:null,bucket:"IG"}, hy:{name:"EUR HY",spread:null,prior:null,ytd_avg:null,bucket:"HY"} }, history };
}

// ═══════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════

const fmtY = v => v != null ? v.toFixed(2)+"%" : "—";
const chgBp = (c,p) => c!=null&&p!=null ? ((c-p)*100).toFixed(1) : null;
const chgCol = v => v>0?"#ef4444":v<0?"#22c55e":"#64748b";
const ChgIcon = ({v}) => { const n=parseFloat(v); if(n>0)return<ArrowUpRight size={14}/>; if(n<0)return<ArrowDownRight size={14}/>; return<Minus size={14}/>; };
const timeAgo = ds => { const h=Math.floor((Date.now()-new Date(ds))/36e5); if(h<1)return"Just now"; if(h<24)return h+"h ago"; const d=Math.floor(h/24); return d<7?d+"d ago":new Date(ds).toLocaleDateString("en-US",{month:"short",day:"numeric"}); };

// ═══════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════

const Badge = ({children,color="#3b82f6"}) => <span style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",padding:"2px 8px",borderRadius:4,background:color+"18",color,whiteSpace:"nowrap"}}>{children}</span>;

const Freshness = ({date,source,url,loading:ld}) => (
  <div style={{display:"flex",alignItems:"center",gap:8,fontSize:11,color:"#64748b",flexWrap:"wrap"}}>
    {ld ? <Loader size={12} style={{animation:"spin 1s linear infinite",color:"#3b82f6"}}/> : <Clock size={12}/>}
    <span>{ld?"Fetching…":"As of "+(date||"—")}</span>
    <span style={{color:"#334155"}}>|</span>
    <a href={url} target="_blank" rel="noopener noreferrer" style={{color:"#3b82f6",textDecoration:"none",display:"flex",alignItems:"center",gap:3}}>{source}<ExternalLink size={10}/></a>
  </div>
);

const CTooltip = ({active,payload,label}) => {
  if(!active||!payload?.length) return null;
  return <div style={{background:"#1a1d23",border:"1px solid #2a2d35",borderRadius:6,padding:"10px 14px",fontSize:12}}>
    <div style={{color:"#94a3b8",marginBottom:4,fontWeight:600}}>{label}</div>
    {payload.filter(p=>p.value!=null).map((p,i)=><div key={i} style={{color:p.color,display:"flex",gap:8,alignItems:"center"}}>
      <span style={{width:8,height:8,borderRadius:"50%",background:p.color,display:"inline-block"}}/><span>{p.name}: {p.value?.toFixed(2)}%</span>
    </div>)}
  </div>;
};

const STooltip = ({active,payload,label}) => {
  if(!active||!payload?.length) return null;
  return <div style={{background:"#1a1d23",border:"1px solid #2a2d35",borderRadius:6,padding:"10px 14px",fontSize:12}}>
    <div style={{color:"#94a3b8",marginBottom:4,fontWeight:600}}>{label}</div>
    {payload.filter(p=>p.value!=null).map((p,i)=><div key={i} style={{color:p.color,display:"flex",gap:8,alignItems:"center"}}>
      <span style={{width:8,height:8,borderRadius:"50%",background:p.color,display:"inline-block"}}/><span>{p.name}: {p.value}bp</span>
    </div>)}
  </div>;
};

const MetricCard = ({label,value,change,loading:ld}) => {
  const n=parseFloat(change); const col=chgCol(n);
  return <div style={{background:"#12141a",border:"1px solid #1e2028",borderRadius:8,padding:"14px 18px",minWidth:160}}>
    <div style={{fontSize:11,color:"#64748b",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>{label}</div>
    {ld ? <Loader size={16} style={{color:"#3b82f6",animation:"spin 1s linear infinite"}}/> :
      <div style={{display:"flex",alignItems:"baseline",gap:8}}>
        <span style={{fontSize:22,fontWeight:700,color:"#e2e8f0",fontFamily:"'JetBrains Mono',monospace"}}>{value}</span>
        {change!=null&&!isNaN(n)&&<span style={{fontSize:12,color:col,display:"flex",alignItems:"center",gap:2,fontWeight:600,fontFamily:"'JetBrains Mono',monospace"}}><ChgIcon v={change}/>{Math.abs(n).toFixed(1)}bp</span>}
      </div>}
  </div>;
};

// ── Sovereign Yield Section (chart + table) ──

const SovereignSection = ({data,title,accentColor,loading:ld,error}) => {
  if(ld) return <div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:10,padding:40,textAlign:"center",color:"#64748b"}}><Loader size={24} style={{animation:"spin 1s linear infinite",margin:"0 auto 10px",display:"block",color:"#3b82f6"}}/>Loading {title}…</div>;
  if(error) return <div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:10,padding:"20px 20px"}}><h3 style={{margin:"0 0 8px",fontSize:15,fontWeight:700,color:"#e2e8f0"}}>{title}</h3><div style={{color:"#ef4444",fontSize:12}}><AlertTriangle size={14} style={{verticalAlign:"middle",marginRight:6}}/>{error}</div></div>;
  if(!data) return null;
  const cd = data.tenors.map((t,i) => ({ tenor:t, current:data.yields[i], prior:data.prior_yields[i],
    change: data.yields[i]!=null&&data.prior_yields[i]!=null ? ((data.yields[i]-data.prior_yields[i])*100).toFixed(1) : null }));
  return (
    <div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:10,overflow:"hidden"}}>
      <div style={{padding:"14px 20px",borderBottom:"1px solid #1e2028"}}>
        <h3 style={{margin:0,fontSize:15,fontWeight:700,color:"#e2e8f0"}}>{title}</h3>
        <Freshness date={data.date} source={data.source} url={data.url}/>
        {data.note && <div style={{fontSize:10,color:"#f59e0b",marginTop:4}}>{data.note}</div>}
      </div>
      <div style={{padding:"12px 12px 4px"}}>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={cd}>
            <defs><linearGradient id={`g${accentColor.slice(1)}`} x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={accentColor} stopOpacity={0.25}/><stop offset="95%" stopColor={accentColor} stopOpacity={0}/></linearGradient></defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1a1d23"/>
            <XAxis dataKey="tenor" tick={{fill:"#64748b",fontSize:11}} axisLine={{stroke:"#1e2028"}} tickLine={false}/>
            <YAxis tick={{fill:"#64748b",fontSize:11}} axisLine={{stroke:"#1e2028"}} tickLine={false} domain={["auto","auto"]} tickFormatter={v=>v?.toFixed(1)}/>
            <Tooltip content={<CTooltip/>}/>
            <Area type="monotone" dataKey="current" stroke={accentColor} strokeWidth={2.5} fill={`url(#g${accentColor.slice(1)})`} name="Current" dot={{r:3,fill:accentColor}} connectNulls/>
            <Line type="monotone" dataKey="prior" stroke="#475569" strokeWidth={1.5} strokeDasharray="5 5" name="Prior" dot={false} connectNulls/>
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div style={{padding:"0 20px 14px",overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          <thead><tr style={{borderBottom:"1px solid #1e2028"}}>{["Tenor","Yield","Prior","Chg (bp)"].map(h=><th key={h} style={{textAlign:h==="Tenor"?"left":"right",padding:"6px 10px",color:"#64748b",fontWeight:600,fontSize:11}}>{h}</th>)}</tr></thead>
          <tbody>{cd.map((r,i)=>{ const ch=parseFloat(r.change); return <tr key={i} style={{borderBottom:"1px solid #13151b"}}>
            <td style={{padding:"5px 10px",color:"#e2e8f0",fontWeight:600,fontFamily:"monospace"}}>{r.tenor}</td>
            <td style={{padding:"5px 10px",color:"#e2e8f0",textAlign:"right",fontFamily:"monospace"}}>{fmtY(r.current)}</td>
            <td style={{padding:"5px 10px",color:"#94a3b8",textAlign:"right",fontFamily:"monospace"}}>{fmtY(r.prior)}</td>
            <td style={{padding:"5px 10px",textAlign:"right",fontFamily:"monospace",color:chgCol(ch),fontWeight:600}}>{r.change!=null?(ch>0?"+":"")+r.change:"—"}</td>
          </tr>; })}</tbody>
        </table>
      </div>
    </div>
  );
};

// ── Credit Spread Section ──

const CreditSection = ({data,loading:ld}) => {
  const [mkt,setMkt]=useState("us");
  if(ld) return <div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:10,padding:40,textAlign:"center",color:"#64748b"}}><Loader size={24} style={{animation:"spin 1s linear infinite",margin:"0 auto 10px",display:"block",color:"#3b82f6"}}/>Loading credit spreads…</div>;
  if(!data) return null;
  const entries = Object.values(mkt==="us"?data.us:data.eu).filter(e=>e.spread!=null);
  return (
    <div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:10,overflow:"hidden"}}>
      <div style={{padding:"14px 20px",borderBottom:"1px solid #1e2028",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
        <div><h3 style={{margin:0,fontSize:15,fontWeight:700,color:"#e2e8f0"}}>Corporate Credit Spreads (OAS)</h3><Freshness date={data.date} source={data.source} url={data.url}/></div>
        <div style={{display:"flex",gap:4}}>{["us","eu"].map(m=><button key={m} onClick={()=>setMkt(m)} style={{background:mkt===m?"#3b82f6":"transparent",border:"1px solid #2a2d35",borderRadius:6,padding:"5px 14px",fontSize:11,color:mkt===m?"#fff":"#94a3b8",cursor:"pointer",fontWeight:600,textTransform:"uppercase"}}>{m==="us"?"US":"EUR"}</button>)}</div>
      </div>
      <div style={{padding:"8px 20px",overflowX:"auto"}}>
        {entries.length===0 ? <div style={{padding:20,color:"#475569",textAlign:"center"}}>EUR credit spreads require iBoxx (paid). Not available via FRED.</div> :
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead><tr style={{borderBottom:"1px solid #1e2028"}}>{["Index","OAS (bp)","Prior","Chg","YTD Avg"].map(h=><th key={h} style={{textAlign:h==="Index"?"left":"right",padding:"6px 10px",color:"#64748b",fontWeight:600,fontSize:11}}>{h}</th>)}</tr></thead>
            <tbody>{entries.map((r,i)=>{ const c=r.spread-r.prior; return <tr key={i} style={{borderBottom:"1px solid #13151b"}}>
              <td style={{padding:"6px 10px",color:"#e2e8f0",fontWeight:600}}>{r.name} <Badge color={["HY","BB","B","CCC"].includes(r.bucket)?"#ef4444":"#22c55e"}>{r.bucket}</Badge></td>
              <td style={{padding:"6px 10px",color:"#e2e8f0",textAlign:"right",fontFamily:"monospace",fontWeight:700}}>{r.spread}</td>
              <td style={{padding:"6px 10px",color:"#94a3b8",textAlign:"right",fontFamily:"monospace"}}>{r.prior}</td>
              <td style={{padding:"6px 10px",textAlign:"right",fontFamily:"monospace",color:chgCol(c*-1),fontWeight:600}}>{c>0?"+":""}{c}</td>
              <td style={{padding:"6px 10px",color:"#94a3b8",textAlign:"right",fontFamily:"monospace"}}>{r.ytd_avg}</td>
            </tr>; })}</tbody>
          </table>}
      </div>
      {data.history?.length>0 && <div style={{padding:"12px 12px 8px"}}>
        <ResponsiveContainer width="100%" height={190}>
          <BarChart data={data.history}><CartesianGrid strokeDasharray="3 3" stroke="#1a1d23"/><XAxis dataKey="date" tick={{fill:"#64748b",fontSize:11}} axisLine={{stroke:"#1e2028"}} tickLine={false}/><YAxis tick={{fill:"#64748b",fontSize:11}} axisLine={{stroke:"#1e2028"}} tickLine={false}/><Tooltip content={<STooltip/>}/><Bar dataKey="ig" fill="#3b82f6" name="IG" radius={[3,3,0,0]}/><Bar dataKey="bbb" fill="#f59e0b" name="BBB" radius={[3,3,0,0]}/><Bar dataKey="hy" fill="#ef4444" name="HY" radius={[3,3,0,0]}/><Legend wrapperStyle={{fontSize:11,color:"#64748b"}}/></BarChart>
        </ResponsiveContainer>
      </div>}
    </div>
  );
};

// ── News & BMA (curated — RSS needs server) ──

const NEWS = [
  {id:1,title:"UK gilt 10Y yield hits 5% for first time since 2008 on energy price surge",source:"CNBC",date:"2026-03-20T09:30:00Z",topic:"Rates & Macro",url:"https://www.cnbc.com/2026/03/20/uk-gilt-market-interest-rates-boe-inflation-reeves.html",summary:"Gilt sell-off driven by soaring energy prices and hawkish BOE."},
  {id:2,title:"BOJ holds rates steady; Takata dissents again calling for 25bp hike to 1%",source:"Reuters",date:"2026-03-19T08:00:00Z",topic:"Rates & Macro",url:"#",summary:"Governor Ueda signaled rate increase possible if slowdown proves temporary."},
  {id:3,title:"Apollo Global raises $8.2B for private credit fund targeting insurance mandates",source:"Reuters",date:"2026-03-20T14:30:00Z",topic:"Private Credit",url:"#",summary:"IG private placements and asset-backed finance for insurance balance sheets."},
  {id:4,title:"BOE holds rates at 3.75% unanimously; warns of inflation risk from conflict",source:"FT",date:"2026-03-20T10:00:00Z",topic:"Rates & Macro",url:"#",summary:"Markets now price in multiple rate hikes rather than cuts in 2026."},
  {id:5,title:"Bermuda reinsurer completes $1.5B structured credit portfolio acquisition",source:"Insurance Insider",date:"2026-03-19T16:45:00Z",topic:"Structured Credit",url:"#",summary:"CLO and ABS portfolio transfer from European bank to Class E insurer."},
  {id:6,title:"NAIC proposes enhanced reporting for insurer private credit allocations",source:"AM Best",date:"2026-03-19T14:20:00Z",topic:"Insurance AM",url:"#",summary:"New disclosure requirements for illiquid asset holdings."},
  {id:7,title:"US CLO new issuance hits record $45B in Q1 2026",source:"S&P LCD",date:"2026-03-17T16:00:00Z",topic:"Structured Credit",url:"#",summary:"Strong demand from insurance portfolios and Asian investors."},
  {id:8,title:"Pension risk transfer market expected to exceed $60B in 2026",source:"P&I",date:"2026-03-17T10:30:00Z",topic:"Pension/Insurance",url:"#",summary:"UK and US PRT pipelines remain robust."},
];

const BMA = [
  {id:1,title:"Notice – Pre-Approval Process for New Bermuda Insurance Registrations",date:"2026-03-19",category:"Licensing",url:"https://www.bma.bm",summary:"Updated requirements for Class D and E.",isNew:true},
  {id:2,title:"Notice – Regulatory Burden Reduction for Better Supervision",date:"2026-02-19",category:"Governance",url:"https://www.bma.bm",summary:"Streamlined reporting for commercial insurers.",isNew:true},
  {id:3,title:"Notice – 2025 Year-End BSCR Model Republication",date:"2026-02-18",category:"Capital/Solvency",url:"https://www.bma.bm",summary:"Republished BSCR models with optional data validation.",isNew:true},
  {id:4,title:"Discussion Paper – AI Governance Framework",date:"2026-02-09",category:"Governance",url:"https://www.bma.bm",summary:"AI risk management framework. Final proposal Q3 2026.",isNew:true},
  {id:5,title:"CP – Prudent Person Principle Instructions",date:"2025-12-15",category:"Investment",url:"https://www.bma.bm",summary:"PPP guidance for NPTA allocations.",isNew:false},
  {id:6,title:"Class C,D,E Solvency Amendment Rules 2025",date:"2025-12-01",category:"Capital/Solvency",url:"https://www.bma.bm",summary:"New Asset & Liability Statement disclosure. Effective Jan 1 2026.",isNew:false},
];

const NewsSection = () => {
  const topics=[...new Set(NEWS.map(n=>n.topic))]; const [sel,setSel]=useState("All");
  const filtered=sel==="All"?NEWS:NEWS.filter(n=>n.topic===sel);
  const tc={"Private Credit":"#8b5cf6","Credit Markets":"#3b82f6","Rates & Macro":"#22c55e","Structured Credit":"#f59e0b","Insurance AM":"#ec4899","Pension/Insurance":"#14b8a6"};
  return <div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:10,overflow:"hidden"}}>
    <div style={{padding:"14px 20px",borderBottom:"1px solid #1e2028"}}>
      <h3 style={{margin:"0 0 10px",fontSize:15,fontWeight:700,color:"#e2e8f0"}}><Newspaper size={16} style={{verticalAlign:"middle",marginRight:8}}/> Financial Markets News</h3>
      <div style={{fontSize:11,color:"#f59e0b",marginBottom:8}}><AlertTriangle size={12} style={{verticalAlign:"middle",marginRight:4}}/>Curated headlines — live RSS requires the GitHub Actions pipeline.</div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{["All",...topics].map(t=><button key={t} onClick={()=>setSel(t)} style={{background:sel===t?(tc[t]||"#3b82f6"):"transparent",border:`1px solid ${sel===t?(tc[t]||"#3b82f6"):"#2a2d35"}`,borderRadius:20,padding:"4px 14px",fontSize:11,color:sel===t?"#fff":"#94a3b8",cursor:"pointer",fontWeight:600}}>{t}</button>)}</div>
    </div>
    <div style={{maxHeight:500,overflowY:"auto"}}>{filtered.map(item=><div key={item.id} style={{padding:"12px 20px",borderBottom:"1px solid #13151b"}} onMouseEnter={e=>e.currentTarget.style.background="#12141a"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
      <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}><Badge color={tc[item.topic]||"#3b82f6"}>{item.topic}</Badge><span style={{fontSize:11,color:"#475569"}}>{item.source} • {timeAgo(item.date)}</span></div>
      <h4 style={{margin:"0 0 3px",fontSize:13,fontWeight:600,color:"#e2e8f0",lineHeight:1.4}}>{item.title}</h4>
      <p style={{margin:0,fontSize:12,color:"#64748b",lineHeight:1.5}}>{item.summary}</p>
    </div>)}</div>
  </div>;
};

const BMASection = () => {
  const cats=[...new Set(BMA.map(u=>u.category))]; const [cf,setCf]=useState("All");
  const filtered=cf==="All"?BMA:BMA.filter(u=>u.category===cf);
  const cc={"Capital/Solvency":"#ef4444",Investment:"#f59e0b",Governance:"#8b5cf6",Licensing:"#22c55e"};
  return <div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:10,overflow:"hidden"}}>
    <div style={{padding:"14px 20px",borderBottom:"1px solid #1e2028"}}>
      <h3 style={{margin:"0 0 10px",fontSize:15,fontWeight:700,color:"#e2e8f0"}}><Shield size={16} style={{verticalAlign:"middle",marginRight:8}}/> BMA Regulatory Updates</h3>
      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{["All",...cats].map(c=><button key={c} onClick={()=>setCf(c)} style={{background:cf===c?(cc[c]||"#3b82f6"):"transparent",border:`1px solid ${cf===c?(cc[c]||"#3b82f6"):"#2a2d35"}`,borderRadius:20,padding:"4px 14px",fontSize:11,color:cf===c?"#fff":"#94a3b8",cursor:"pointer",fontWeight:500}}>{c}</button>)}</div>
    </div>
    <div>{filtered.map(item=><div key={item.id} style={{padding:"12px 20px",borderBottom:"1px solid #13151b"}} onMouseEnter={e=>e.currentTarget.style.background="#12141a"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
      <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}><Badge color={cc[item.category]||"#3b82f6"}>{item.category}</Badge>{item.isNew&&<Badge color="#22c55e">NEW</Badge>}<span style={{fontSize:11,color:"#475569"}}>{item.date}</span></div>
      <h4 style={{margin:"0 0 3px",fontSize:13,fontWeight:600,color:"#e2e8f0",lineHeight:1.4}}>{item.title}</h4>
      <p style={{margin:0,fontSize:12,color:"#64748b",lineHeight:1.5}}>{item.summary}</p>
    </div>)}</div>
  </div>;
};

// ═══════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════

const PAGES = [
  {id:"home",label:"Overview",icon:Activity}, {id:"ust",label:"US Treasuries",icon:DollarSign},
  {id:"jgb",label:"Japan JGB",icon:Globe}, {id:"gilt",label:"UK Gilts",icon:Globe},
  {id:"eiopa",label:"EIOPA EUR",icon:Globe}, {id:"india",label:"India Govt",icon:Globe},
  {id:"credit",label:"Credit Spreads",icon:Percent}, {id:"news",label:"News",icon:Newspaper},
  {id:"bma",label:"BMA Updates",icon:Shield},
];

export default function App() {
  const [page,setPage]=useState("home");
  const [sidebarOpen,setSidebarOpen]=useState(true);
  const [clock,setClock]=useState("");
  const [apiKey,setApiKey]=useState("");
  const [keyInput,setKeyInput]=useState("");
  const [showSettings,setShowSettings]=useState(false);

  // Data stores
  const [ust,setUst]=useState(null);
  const [jgb,setJgb]=useState(null);
  const [gilt,setGilt]=useState(null);
  const [eiopa,setEiopa]=useState(null);
  const [india,setIndia]=useState(null);
  const [credit,setCredit]=useState(null);

  // Loading / error per source
  const [loadState,setLoadState]=useState({});
  const [errors,setErrors]=useState({});
  const [globalLoading,setGlobalLoading]=useState(false);
  const [lastRefresh,setLastRefresh]=useState(null);

  useEffect(()=>{ const t=setInterval(()=>setClock(new Date().toLocaleTimeString("en-US",{hour12:false})),1000); setClock(new Date().toLocaleTimeString("en-US",{hour12:false})); return()=>clearInterval(t); },[]);
  useEffect(()=>{ try{ const s=window.localStorage?.getItem("fred_api_key"); if(s){setApiKey(s);setKeyInput(s);} }catch{} },[]);

  const saveKey = useCallback(()=>{ const k=keyInput.trim(); if(k.length>=20){setApiKey(k); try{window.localStorage?.setItem("fred_api_key",k);}catch{} setShowSettings(false);} },[keyInput]);

  const refreshAll = useCallback(async()=>{
    if(!apiKey){setShowSettings(true);return;}
    setGlobalLoading(true);
    setLoadState({ust:true,jgb:true,gilt:true,eiopa:true,india:true,credit:true});
    setErrors({});
    const errs={};
    const run = async(key,fn,setter)=>{ try{ const d=await fn(); setter(d); }catch(e){ errs[key]=e.message; } finally{ setLoadState(p=>({...p,[key]:false})); } };
    await Promise.all([
      run("ust",()=>fetchUSTCurve(apiKey),setUst),
      run("jgb",fetchJGBCurve,setJgb),
      run("gilt",fetchGiltCurve,setGilt),
      run("eiopa",fetchEIOPACurve,setEiopa),
      run("india",fetchIndiaCurve,setIndia),
      run("credit",()=>fetchCreditSpreads(apiKey),setCredit),
    ]);
    setErrors(errs);
    setLastRefresh(new Date());
    setGlobalLoading(false);
  },[apiKey]);

  useEffect(()=>{ if(apiKey) refreshAll(); },[apiKey]);

  // Derived
  const getV=(d,t)=>{ if(!d)return null; const i=d.tenors.indexOf(t); return i>=0?d.yields[i]:null; };
  const getP=(d,t)=>{ if(!d)return null; const i=d.tenors.indexOf(t); return i>=0?d.prior_yields[i]:null; };
  const ust10y=getV(ust,"10Y"),ust10yP=getP(ust,"10Y"),ust2y=getV(ust,"2Y"),ust2yP=getP(ust,"2Y");
  const jgb10y=getV(jgb,"10Y"),jgb10yP=getP(jgb,"10Y");
  const gilt10y=getV(gilt,"10Y"),gilt10yP=getP(gilt,"10Y");
  const india10y=getV(india,"10Y"),india10yP=getP(india,"10Y");

  // Multi-curve comparison
  const compTenors=["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","30Y"];
  const multiCurve=compTenors.map(t=>({ tenor:t, UST:getV(ust,t), JGB:getV(jgb,t), Gilt:getV(gilt,t), EUR:getV(eiopa,t), India:getV(india,t) }));
  const hasAnyCurve = ust||jgb||gilt||eiopa||india;

  const noKey=!apiKey;

  const renderPage=()=>{
    switch(page){
      case "ust": return <SovereignSection data={ust} title="US Treasury Par Yield Curve (CMT)" accentColor="#3b82f6" loading={loadState.ust} error={errors.ust}/>;
      case "jgb": return <SovereignSection data={jgb} title="Japan Government Bond Yields (JGB)" accentColor="#ef4444" loading={loadState.jgb} error={errors.jgb}/>;
      case "gilt": return <SovereignSection data={gilt} title="UK Gilt Nominal Par Yields" accentColor="#22c55e" loading={loadState.gilt} error={errors.gilt}/>;
      case "eiopa": return <SovereignSection data={eiopa} title="EUR AAA Govt Yield Curve (ECB — EIOPA proxy)" accentColor="#f59e0b" loading={loadState.eiopa} error={errors.eiopa}/>;
      case "india": return <SovereignSection data={india} title="India Government Bond Yields" accentColor="#ec4899" loading={loadState.india} error={errors.india}/>;
      case "credit": return <CreditSection data={credit} loading={loadState.credit}/>;
      case "news": return <NewsSection/>;
      case "bma": return <BMASection/>;
      default: return (
        <div style={{display:"flex",flexDirection:"column",gap:18}}>
          {noKey&&<div style={{background:"#1a1206",border:"1px solid #854d0e",borderRadius:10,padding:"16px 20px",display:"flex",alignItems:"center",gap:12}}>
            <Key size={20} style={{color:"#f59e0b",flexShrink:0}}/>
            <div style={{flex:1}}><div style={{color:"#fbbf24",fontWeight:700,fontSize:14,marginBottom:4}}>FRED API Key Required</div>
              <div style={{color:"#a3a3a3",fontSize:12}}>Free at <a href="https://fred.stlouisfed.org/docs/api/api_key.html" target="_blank" rel="noopener noreferrer" style={{color:"#3b82f6"}}>fred.stlouisfed.org</a> — click <Settings size={12} style={{verticalAlign:"middle"}}/> above.</div></div>
          </div>}
          {Object.keys(errors).length>0&&<div style={{background:"#1a0a0a",border:"1px solid #7f1d1d",borderRadius:10,padding:"12px 20px"}}>
            <div style={{color:"#ef4444",fontWeight:700,fontSize:12,marginBottom:4}}><AlertTriangle size={14} style={{verticalAlign:"middle",marginRight:4}}/>Some sources had errors:</div>
            {Object.entries(errors).map(([k,v])=><div key={k} style={{color:"#a3a3a3",fontSize:11}}>• <strong>{k}</strong>: {v}</div>)}
          </div>}

          {/* Key Rates */}
          <div>
            <h3 style={{margin:"0 0 10px",fontSize:13,fontWeight:700,color:"#64748b",textTransform:"uppercase",letterSpacing:"0.1em"}}>Key Rates {ust?`(${ust.date})`:""}</h3>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(165px, 1fr))",gap:10}}>
              <MetricCard label="UST 10Y" value={fmtY(ust10y)} change={chgBp(ust10y,ust10yP)} loading={loadState.ust}/>
              <MetricCard label="UST 2Y" value={fmtY(ust2y)} change={chgBp(ust2y,ust2yP)} loading={loadState.ust}/>
              <MetricCard label="UST 2s10s" value={ust10y!=null&&ust2y!=null?((ust10y-ust2y)*100).toFixed(0)+"bp":"—"} change={ust10yP!=null?chgBp(ust10y-ust2y,ust10yP-ust2yP):null} loading={loadState.ust}/>
              <MetricCard label="JGB 10Y" value={fmtY(jgb10y)} change={chgBp(jgb10y,jgb10yP)} loading={loadState.jgb}/>
              <MetricCard label="UK Gilt 10Y" value={fmtY(gilt10y)} change={chgBp(gilt10y,gilt10yP)} loading={loadState.gilt}/>
              <MetricCard label="India 10Y" value={fmtY(india10y)} change={chgBp(india10y,india10yP)} loading={loadState.india}/>
              <MetricCard label="US IG OAS" value={credit?.us?.ig?.spread!=null?credit.us.ig.spread+"bp":"—"} change={credit?.us?.ig?(credit.us.ig.spread-credit.us.ig.prior).toFixed(0):null} loading={loadState.credit}/>
              <MetricCard label="US HY OAS" value={credit?.us?.hy?.spread!=null?credit.us.hy.spread+"bp":"—"} change={credit?.us?.hy?(credit.us.hy.spread-credit.us.hy.prior).toFixed(0):null} loading={loadState.credit}/>
            </div>
          </div>

          {/* Global Curve Comparison */}
          {hasAnyCurve&&<div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:10,padding:"14px 14px 6px"}}>
            <h3 style={{margin:"0 0 10px 6px",fontSize:13,fontWeight:700,color:"#64748b",textTransform:"uppercase",letterSpacing:"0.1em"}}>Global Yield Curve Comparison (1Y–30Y)</h3>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={multiCurve}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1a1d23"/>
                <XAxis dataKey="tenor" tick={{fill:"#64748b",fontSize:11}} axisLine={{stroke:"#1e2028"}} tickLine={false}/>
                <YAxis tick={{fill:"#64748b",fontSize:11}} axisLine={{stroke:"#1e2028"}} tickLine={false} domain={[0,"auto"]} tickFormatter={v=>v.toFixed(1)+"%"}/>
                <Tooltip content={<CTooltip/>}/>
                <Line type="monotone" dataKey="India" stroke="#ec4899" strokeWidth={2} name="India" dot={{r:3}} connectNulls/>
                <Line type="monotone" dataKey="Gilt" stroke="#22c55e" strokeWidth={2} name="UK Gilt" dot={{r:3}} connectNulls/>
                <Line type="monotone" dataKey="UST" stroke="#3b82f6" strokeWidth={2.5} name="US Treasury" dot={{r:4}} connectNulls/>
                <Line type="monotone" dataKey="EUR" stroke="#f59e0b" strokeWidth={2} name="EUR (ECB)" dot={{r:3}} connectNulls/>
                <Line type="monotone" dataKey="JGB" stroke="#ef4444" strokeWidth={2} name="Japan JGB" dot={{r:3}} connectNulls/>
                <Legend wrapperStyle={{fontSize:11,color:"#64748b",paddingTop:8}}/>
              </LineChart>
            </ResponsiveContainer>
            <div style={{overflowX:"auto",padding:"4px 6px 10px"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                <thead><tr style={{borderBottom:"1px solid #1e2028"}}>
                  <th style={{textAlign:"left",padding:"5px 8px",color:"#64748b",fontWeight:600}}>Tenor</th>
                  <th style={{textAlign:"right",padding:"5px 8px",color:"#3b82f6",fontWeight:600}}>UST</th>
                  <th style={{textAlign:"right",padding:"5px 8px",color:"#ef4444",fontWeight:600}}>JGB</th>
                  <th style={{textAlign:"right",padding:"5px 8px",color:"#22c55e",fontWeight:600}}>Gilt</th>
                  <th style={{textAlign:"right",padding:"5px 8px",color:"#f59e0b",fontWeight:600}}>EUR</th>
                  <th style={{textAlign:"right",padding:"5px 8px",color:"#ec4899",fontWeight:600}}>India</th>
                </tr></thead>
                <tbody>{multiCurve.map((r,i)=><tr key={i} style={{borderBottom:"1px solid #13151b"}}>
                  <td style={{padding:"4px 8px",color:"#e2e8f0",fontWeight:600,fontFamily:"monospace"}}>{r.tenor}</td>
                  {["UST","JGB","Gilt","EUR","India"].map(k=><td key={k} style={{padding:"4px 8px",textAlign:"right",fontFamily:"monospace",color:r[k]!=null?"#e2e8f0":"#334155"}}>{r[k]!=null?r[k].toFixed(2)+"%":"—"}</td>)}
                </tr>)}</tbody>
              </table>
            </div>
            {/* Source dates */}
            <div style={{padding:"4px 8px 10px",display:"flex",gap:16,flexWrap:"wrap",fontSize:10,color:"#475569"}}>
              {ust&&<span>UST: {ust.date}</span>}
              {jgb&&<span>JGB: {jgb.date}</span>}
              {gilt&&<span>Gilt: {gilt.date}</span>}
              {eiopa&&<span>EUR: {eiopa.date}</span>}
              {india&&<span>India: {india.date}</span>}
            </div>
          </div>}

          {/* News + BMA */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
            <div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:10,overflow:"hidden"}}>
              <div style={{padding:"12px 20px",borderBottom:"1px solid #1e2028",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <h3 style={{margin:0,fontSize:13,fontWeight:700,color:"#e2e8f0"}}><Newspaper size={14} style={{verticalAlign:"middle",marginRight:6}}/> Latest News</h3>
                <button onClick={()=>setPage("news")} style={{background:"transparent",border:"none",color:"#3b82f6",fontSize:11,cursor:"pointer",fontWeight:600}}>View All <ChevronRight size={12} style={{verticalAlign:"middle"}}/></button>
              </div>
              {NEWS.slice(0,5).map(item=><div key={item.id} style={{padding:"8px 20px",borderBottom:"1px solid #13151b"}}><div style={{display:"flex",gap:6,alignItems:"center",marginBottom:2}}><Badge>{item.topic}</Badge><span style={{fontSize:10,color:"#475569"}}>{timeAgo(item.date)}</span></div><div style={{fontSize:12,fontWeight:600,color:"#e2e8f0",lineHeight:1.4}}>{item.title}</div></div>)}
            </div>
            <div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:10,overflow:"hidden"}}>
              <div style={{padding:"12px 20px",borderBottom:"1px solid #1e2028",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <h3 style={{margin:0,fontSize:13,fontWeight:700,color:"#e2e8f0"}}><Shield size={14} style={{verticalAlign:"middle",marginRight:6}}/> BMA Updates</h3>
                <button onClick={()=>setPage("bma")} style={{background:"transparent",border:"none",color:"#3b82f6",fontSize:11,cursor:"pointer",fontWeight:600}}>View All <ChevronRight size={12} style={{verticalAlign:"middle"}}/></button>
              </div>
              {BMA.filter(u=>u.isNew).slice(0,4).map(item=><div key={item.id} style={{padding:"8px 20px",borderBottom:"1px solid #13151b"}}><div style={{display:"flex",gap:6,alignItems:"center",marginBottom:2}}><Badge color="#22c55e">NEW</Badge><Badge>{item.category}</Badge><span style={{fontSize:10,color:"#475569"}}>{item.date}</span></div><div style={{fontSize:12,fontWeight:600,color:"#e2e8f0",lineHeight:1.4}}>{item.title}</div></div>)}
            </div>
          </div>
        </div>
      );
    }
  };

  return (
    <div style={{display:"flex",height:"100vh",background:"#080a0f",color:"#e2e8f0",fontFamily:"'JetBrains Mono','IBM Plex Sans',-apple-system,sans-serif",fontSize:13,overflow:"hidden"}}>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>

      {/* Settings Modal */}
      {showSettings&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setShowSettings(false)}>
        <div style={{background:"#0d0f14",border:"1px solid #1e2028",borderRadius:12,padding:24,width:440,maxWidth:"90vw"}} onClick={e=>e.stopPropagation()}>
          <h3 style={{margin:"0 0 8px",fontSize:16,fontWeight:700}}><Key size={18} style={{verticalAlign:"middle",marginRight:8,color:"#f59e0b"}}/>FRED API Key</h3>
          <p style={{color:"#94a3b8",fontSize:12,marginBottom:16,lineHeight:1.5}}>Free key from <a href="https://fred.stlouisfed.org/docs/api/api_key.html" target="_blank" rel="noopener noreferrer" style={{color:"#3b82f6"}}>fred.stlouisfed.org</a>. JGB, Gilt, India, and EUR curves don't need this key.</p>
          <div style={{display:"flex",gap:8}}>
            <input value={keyInput} onChange={e=>setKeyInput(e.target.value)} placeholder="Paste your FRED API key" style={{flex:1,background:"#12141a",border:"1px solid #2a2d35",borderRadius:6,padding:"10px 14px",color:"#e2e8f0",fontSize:13,fontFamily:"monospace",outline:"none"}} onKeyDown={e=>e.key==="Enter"&&saveKey()}/>
            <button onClick={saveKey} style={{background:"#3b82f6",border:"none",borderRadius:6,padding:"10px 20px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:13}}>Save</button>
          </div>
          {apiKey&&<div style={{marginTop:10,fontSize:11,color:"#22c55e",display:"flex",alignItems:"center",gap:4}}><CheckCircle size={12}/> Key saved: {apiKey.slice(0,8)}…</div>}
        </div>
      </div>}

      {/* Sidebar */}
      <div style={{width:sidebarOpen?210:52,transition:"width 0.2s ease",background:"#0a0c12",borderRight:"1px solid #1a1d23",display:"flex",flexDirection:"column",flexShrink:0,overflow:"hidden"}}>
        <div style={{padding:sidebarOpen?"14px 16px":"14px 10px",borderBottom:"1px solid #1a1d23",display:"flex",alignItems:"center",gap:10,cursor:"pointer",minHeight:52}} onClick={()=>setSidebarOpen(!sidebarOpen)}>
          <div style={{width:28,height:28,borderRadius:6,background:"linear-gradient(135deg,#3b82f6,#8b5cf6)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><BarChart3 size={16} color="#fff"/></div>
          {sidebarOpen&&<div><div style={{fontSize:13,fontWeight:800,color:"#e2e8f0",letterSpacing:"-0.02em",lineHeight:1.1}}>BERMUDA</div><div style={{fontSize:9,fontWeight:600,color:"#3b82f6",letterSpacing:"0.15em",textTransform:"uppercase"}}>MARKET INTEL</div></div>}
        </div>
        <div style={{flex:1,padding:"6px",overflowY:"auto"}}>
          {PAGES.map(p=>{const Icon=p.icon;const a=page===p.id;return<button key={p.id} onClick={()=>setPage(p.id)} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:sidebarOpen?"8px 10px":"8px",marginBottom:1,borderRadius:6,border:"none",background:a?"#1e2028":"transparent",color:a?"#e2e8f0":"#64748b",cursor:"pointer",fontSize:12,fontWeight:a?600:500,textAlign:"left",justifyContent:sidebarOpen?"flex-start":"center"}} onMouseEnter={e=>{if(!a)e.currentTarget.style.background="#12141a"}} onMouseLeave={e=>{if(!a)e.currentTarget.style.background="transparent"}}><Icon size={15} style={{flexShrink:0}}/>{sidebarOpen&&<span>{p.label}</span>}</button>;})}
        </div>
        {sidebarOpen&&<div style={{padding:"10px 14px",borderTop:"1px solid #1a1d23",fontSize:10,color:"#334155"}}>Live: FRED + ECB + MOF JP + BoE + WGB</div>}
      </div>

      {/* Main */}
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        <div style={{height:42,padding:"0 20px",borderBottom:"1px solid #1a1d23",background:"#0a0c12",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
          <h2 style={{margin:0,fontSize:14,fontWeight:700}}>{PAGES.find(p=>p.id===page)?.label||"Overview"}</h2>
          <div style={{display:"flex",alignItems:"center",gap:10,fontSize:11}}>
            {lastRefresh&&<span style={{color:"#475569",fontSize:10}}>Last: {lastRefresh.toLocaleTimeString()}</span>}
            {globalLoading&&<Loader size={14} style={{color:"#3b82f6",animation:"spin 1s linear infinite"}}/>}
            <button onClick={refreshAll} disabled={globalLoading||noKey} title={noKey?"Set FRED API key first":"Refresh all data"} style={{background:globalLoading?"#1e2028":"#3b82f6",border:"none",borderRadius:6,padding:"5px 14px",color:globalLoading?"#64748b":"#fff",cursor:globalLoading||noKey?"not-allowed":"pointer",display:"flex",alignItems:"center",gap:5,fontWeight:700,fontSize:12,opacity:noKey?0.4:1}}>
              <RefreshCw size={13} style={{animation:globalLoading?"spin 1s linear infinite":"none"}}/>{globalLoading?"Fetching…":"Refresh"}
            </button>
            <button onClick={()=>setShowSettings(true)} style={{background:"transparent",border:"1px solid #2a2d35",borderRadius:6,padding:"5px 8px",cursor:"pointer",display:"flex",alignItems:"center"}}><Settings size={14} style={{color:apiKey?"#22c55e":"#f59e0b"}}/></button>
            <span style={{color:"#3b82f6",fontFamily:"monospace",fontWeight:700,fontSize:13}}>{clock}</span>
          </div>
        </div>
        <div style={{flex:1,overflow:"auto",padding:18}}>{renderPage()}</div>
        <div style={{height:26,padding:"0 20px",borderTop:"1px solid #1a1d23",background:"#0a0c12",display:"flex",alignItems:"center",justifyContent:"space-between",fontSize:10,color:"#334155",flexShrink:0}}>
          <div style={{display:"flex",gap:14}}>
            {ust10y!=null&&<span>UST 10Y: {fmtY(ust10y)}</span>}
            {jgb10y!=null&&<span>JGB 10Y: {fmtY(jgb10y)}</span>}
            {gilt10y!=null&&<span>Gilt 10Y: {fmtY(gilt10y)}</span>}
            {india10y!=null&&<span>India 10Y: {fmtY(india10y)}</span>}
            {credit?.us?.ig?.spread!=null&&<span>IG: {credit.us.ig.spread}bp</span>}
            {credit?.us?.hy?.spread!=null&&<span>HY: {credit.us.hy.spread}bp</span>}
          </div>
          <span>Bermuda Market Intelligence Terminal v3.0 — All Live</span>
        </div>
      </div>
    </div>
  );
}

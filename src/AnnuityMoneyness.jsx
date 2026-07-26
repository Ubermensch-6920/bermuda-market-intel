import { useState, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, ReferenceLine, ReferenceDot,
} from "recharts";
import {
  Gauge, AlertTriangle, Loader, ExternalLink, Clock, Info,
  ShieldCheck, TrendingDown, Calculator, SlidersHorizontal,
} from "lucide-react";
import {
  BENCHMARKS, BENCHMARK_ORDER, TAX_MODES, DYNAMIC_LAPSE_DEFAULTS,
  benchmarkRate, analyseMoneyness, dynamicLapse, moneynessGrid,
  interpolateCurve,
} from "./annuityMoneyness.js";

/* ═══════════════════════════════════════════════════════════════════
   ANNUITY IN-THE-MONEY METER
   Hold-vs-lapse decision surface for guaranteed deferred annuities,
   driven off the live UST curve + ICE BofA IG OAS already in the
   pipeline. All maths lives in ./annuityMoneyness.js.
   ═══════════════════════════════════════════════════════════════════ */

// ── Diverging ramp: cyan (in the money) ↔ slate (at the money) ↔ amber (out) ──
// Cool/warm poles rather than green/red: ΔE 18 under protan/tritan, and every
// cell carries its number besides, so identity is never colour-alone.
const ITM_RAMP = ["#0f3f49", "#15616f", "#1a8497", "#20aac2", "#22d3ee"];
const OTM_RAMP = ["#443210", "#664a14", "#94681c", "#c28a22", "#f59e0b"];
const NEUTRAL = "#2a2d35";
const ITM_INK = "#22d3ee";
const OTM_INK = "#f59e0b";

const FULL_SCALE_BP = 300; // meter/heatmap saturate here

function divergingFill(bp) {
  if (bp == null || !isFinite(bp)) return "#12141a";
  const mag = Math.min(1, Math.abs(bp) / FULL_SCALE_BP);
  if (mag < 0.08) return NEUTRAL;
  const ramp = bp > 0 ? ITM_RAMP : OTM_RAMP;
  return ramp[Math.min(ramp.length - 1, Math.floor(mag * ramp.length))];
}
// The top two steps of each arm are bright enough to need dark ink on them.
function inkFor(bp) {
  if (bp == null || !isFinite(bp)) return "#475569";
  const mag = Math.min(1, Math.abs(bp) / FULL_SCALE_BP);
  return mag >= 0.6 ? "#08111a" : "#e2e8f0";
}

const VERDICT_INK = {
  deep_itm: ITM_INK, itm: ITM_INK, atm: "#94a3b8", otm: OTM_INK, deep_otm: OTM_INK,
};

// ── Formatters ──
const pct = (v, d = 2) => (v != null && isFinite(v) ? v.toFixed(d) + "%" : "—");
const bp = v => (v != null && isFinite(v) ? (v > 0 ? "+" : "") + v.toFixed(0) + "bp" : "—");
const usd = v =>
  v != null && isFinite(v)
    ? "$" + Math.round(v).toLocaleString("en-US")
    : "—";
const yrs = v => (v != null && isFinite(v) ? v.toFixed(1) + "y" : "—");

// ── Small controls ──

const Field = ({ label, hint, children }) => (
  <label style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
    <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, letterSpacing: "0.03em" }}>
      {label}
      {hint && <span title={hint} style={{ color: "#475569", marginLeft: 4, cursor: "help" }}>ⓘ</span>}
    </span>
    {children}
  </label>
);

const inputStyle = {
  background: "#0a0c12", border: "1px solid #2a2d35", borderRadius: 6,
  padding: "7px 10px", fontSize: 13, color: "#f1f5f9",
  fontFamily: "'JetBrains Mono', monospace", width: "100%", boxSizing: "border-box",
};

const Num = ({ value, onChange, step = 0.25, min, max, suffix }) => (
  <div style={{ position: "relative" }}>
    <input
      type="number" value={value} step={step} min={min} max={max}
      onChange={e => {
        const v = e.target.value;
        if (v === "") return onChange("");
        const n = parseFloat(v);
        if (!isNaN(n)) onChange(n);
      }}
      style={{ ...inputStyle, paddingRight: suffix ? 28 : 10 }}
    />
    {suffix && (
      <span style={{ position: "absolute", right: 9, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: "#475569", pointerEvents: "none" }}>{suffix}</span>
    )}
  </div>
);

const Select = ({ value, onChange, options }) => (
  <select value={value} onChange={e => onChange(e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
    {options.map(o => <option key={o.value} value={o.value} style={{ background: "#12141a" }}>{o.label}</option>)}
  </select>
);

const Toggle = ({ checked, onChange, label }) => (
  <button
    onClick={() => onChange(!checked)}
    style={{
      display: "flex", alignItems: "center", gap: 8, background: "transparent",
      border: `1px solid ${checked ? "#22d3ee55" : "#2a2d35"}`, borderRadius: 6,
      padding: "7px 11px", cursor: "pointer", fontSize: 12, fontWeight: 600,
      color: checked ? "#22d3ee" : "#64748b", width: "100%", textAlign: "left",
    }}>
    <span style={{
      width: 13, height: 13, borderRadius: 3, flexShrink: 0,
      border: `1px solid ${checked ? "#22d3ee" : "#475569"}`,
      background: checked ? "#22d3ee" : "transparent",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      {checked && <span style={{ color: "#08111a", fontSize: 10, fontWeight: 900, lineHeight: 1 }}>✓</span>}
    </span>
    {label}
  </button>
);

const Stat = ({ label, value, sub, ink = "#f1f5f9", hint, big }) => (
  <div style={{ background: "#12141a", border: "1px solid #1e2028", borderRadius: 10, padding: "13px 16px", minWidth: 0 }}>
    <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, marginBottom: 6, letterSpacing: "0.03em" }}>
      {label}
      {hint && <span title={hint} style={{ color: "#475569", marginLeft: 4, cursor: "help" }}>ⓘ</span>}
    </div>
    <div style={{ fontSize: big ? 26 : 21, fontWeight: 700, color: ink, fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.1, wordBreak: "break-word" }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: "#64748b", marginTop: 5, lineHeight: 1.4 }}>{sub}</div>}
  </div>
);

const Panel = ({ title, icon: Icon, note, children, right }) => (
  <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
    <div style={{ padding: "14px 20px", borderBottom: "1px solid #1e2028", display: "flex", alignItems: "flex-start", gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          {Icon && <Icon size={15} style={{ verticalAlign: "middle", marginRight: 7 }} />}{title}
        </h3>
        {note && <div style={{ fontSize: 11, color: "#64748b", marginTop: 5, lineHeight: 1.55 }}>{note}</div>}
      </div>
      {right}
    </div>
    {children}
  </div>
);

// ── The meter ────────────────────────────────────────────────────
// A linear diverging track, not a radial gauge: the value is one ratio
// against a baseline, and a straight track reads its sign and magnitude
// far faster than a dial arc does.

const METER_BANDS = [
  { from: -FULL_SCALE_BP, to: -150, label: "Deep OTM", ink: OTM_RAMP[4] },
  { from: -150, to: -25, label: "OTM", ink: OTM_RAMP[2] },
  { from: -25, to: 50, label: "ATM", ink: "#64748b" },
  { from: 50, to: 150, label: "ITM", ink: ITM_RAMP[2] },
  { from: 150, to: FULL_SCALE_BP, label: "Deep ITM", ink: ITM_RAMP[4] },
];

const Meter = ({ netBp, grossBp, verdict }) => {
  const toPct = v => ((Math.max(-FULL_SCALE_BP, Math.min(FULL_SCALE_BP, v)) + FULL_SCALE_BP) / (2 * FULL_SCALE_BP)) * 100;
  const clamped = netBp != null && Math.abs(netBp) > FULL_SCALE_BP;
  const ink = verdict ? VERDICT_INK[verdict.key] : "#94a3b8";

  return (
    <div style={{ padding: "20px 22px 18px" }}>
      {/* Verdict — icon + words, never colour alone */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap", marginBottom: 4 }}>
        {verdict ? (
          <>
            {netBp > 25 ? <ShieldCheck size={26} style={{ color: ink, alignSelf: "center", flexShrink: 0 }} />
              : netBp < -25 ? <TrendingDown size={26} style={{ color: ink, alignSelf: "center", flexShrink: 0 }} />
              : <Gauge size={26} style={{ color: ink, alignSelf: "center", flexShrink: 0 }} />}
            <div style={{ fontSize: 30, fontWeight: 800, color: ink, letterSpacing: "-0.02em", lineHeight: 1.1 }}>
              {verdict.label}
            </div>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#f1f5f9", fontFamily: "'JetBrains Mono', monospace" }}>
              {clamped ? `${netBp > 0 ? "> +" : "< −"}${FULL_SCALE_BP}bp` : bp(netBp)}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 20, fontWeight: 700, color: "#64748b" }}>Awaiting curve data</div>
        )}
      </div>
      {verdict && <div style={{ fontSize: 13, color: "#cbd5e1", lineHeight: 1.6, marginBottom: 18, maxWidth: 760 }}>{verdict.action}</div>}

      {/* Track */}
      <div style={{ position: "relative", marginTop: 8 }}>
        <div style={{ display: "flex", height: 26, borderRadius: 4, overflow: "hidden", gap: 2 }}>
          {METER_BANDS.map(b => (
            <div key={b.label} style={{ flex: b.to - b.from, background: b.ink, opacity: 0.42 }} />
          ))}
        </div>

        {/* Zero baseline */}
        <div style={{ position: "absolute", left: "50%", top: -5, bottom: -5, width: 2, background: "#e2e8f0", opacity: 0.55, transform: "translateX(-1px)" }} />

        {/* Gross-gap ghost marker: where the naive rate difference alone would sit */}
        {grossBp != null && (
          <div title={`Gross rate gap ${bp(grossBp)} — before surrender charge, MVA and tax`}
            style={{ position: "absolute", left: `${toPct(grossBp)}%`, top: -3, bottom: -3, width: 2, background: "#94a3b8", transform: "translateX(-1px)", opacity: 0.9 }} />
        )}

        {/* Needle */}
        {netBp != null && (
          <div style={{ position: "absolute", left: `${toPct(netBp)}%`, top: -9, bottom: -9, width: 4, background: "#f8fafc", borderRadius: 2, transform: "translateX(-2px)", boxShadow: "0 0 0 2px #0d0f14" }} />
        )}
      </div>

      {/* Scale + legend */}
      <div style={{ display: "flex", marginTop: 7 }}>
        {METER_BANDS.map(b => (
          <div key={b.label} style={{ flex: b.to - b.from, textAlign: "center", fontSize: 10, color: "#64748b", fontWeight: 700, letterSpacing: "0.05em" }}>{b.label}</div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#475569", fontFamily: "monospace", marginTop: 3 }}>
        <span>−{FULL_SCALE_BP}bp</span><span>lapse & reinvest ← 0 → keep the contract</span><span>+{FULL_SCALE_BP}bp</span>
      </div>
      <div style={{ display: "flex", gap: 18, marginTop: 12, flexWrap: "wrap", fontSize: 11, color: "#94a3b8" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 4, height: 12, background: "#f8fafc", borderRadius: 2 }} /> Net of all frictions {bp(netBp)}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 2, height: 12, background: "#94a3b8" }} /> Gross rate gap {bp(grossBp)}
        </span>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════

const GRID_RATES = [2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5];
const GRID_TERMS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/* The illustrative contract. Single source of truth so the Overview tile and
   the full calculator cannot drift into showing different verdicts for what
   reads as the same policy. A mid-schedule MYGA: written when money was
   cheaper, four years still to run. */
const DEFAULTS = {
  av: 100000, basis: 80000, g: 3.25, n: 4, sc: 5, free: 10,
  mvaIssue: 2.5, mvaMargin: 10, taxMode: "nq_1035", taxRate: 24, age: 65,
  bench: "myga_arated",
};

export default function AnnuityMoneynessSection({ ust, credit, loading, error }) {
  // ── Contract ──
  const [av, setAv] = useState(DEFAULTS.av);
  const [basis, setBasis] = useState(DEFAULTS.basis);
  const [g, setG] = useState(DEFAULTS.g);
  const [n, setN] = useState(DEFAULTS.n);
  const [sc, setSc] = useState(DEFAULTS.sc);
  const [free, setFree] = useState(DEFAULTS.free);
  const [freeOnFull, setFreeOnFull] = useState(true);

  // ── MVA ──
  const [mvaOn, setMvaOn] = useState(true);
  const [mvaIssue, setMvaIssue] = useState(DEFAULTS.mvaIssue);
  const [mvaMargin, setMvaMargin] = useState(DEFAULTS.mvaMargin);
  const [mgsvOn, setMgsvOn] = useState(true);

  // ── Tax ──
  const [taxMode, setTaxMode] = useState(DEFAULTS.taxMode);
  const [taxRate, setTaxRate] = useState(DEFAULTS.taxRate);
  const [age, setAge] = useState(DEFAULTS.age);

  // ── Benchmark ──
  const [benchKey, setBenchKey] = useState(DEFAULTS.bench);
  const [spreadOverride, setSpreadOverride] = useState(null);

  // ── Dynamic lapse ──
  const [dl, setDl] = useState(DYNAMIC_LAPSE_DEFAULTS);
  const [hoverCell, setHoverCell] = useState(null);
  // Grid MVA is off by default and deliberately separate from the contract
  // toggle. See the panel note: a matched-period MVA is built to neutralise
  // rate movement, so switching it on flattens the surface to near-zero
  // everywhere. That flattening is itself the finding, not a bug.
  const [gridMva, setGridMva] = useState(false);

  const ustTenors = ust?.tenors;
  const ustYields = ust?.yields;
  const igOasBp = credit?.spreads?.ig?.spread ?? null;

  const bench = BENCHMARKS[benchKey];
  const effSpread = spreadOverride != null ? spreadOverride : bench?.spreadBp;

  // MVA reference index today. Deliberately the matched-maturity Treasury and
  // NOT the benchmark reinvestment rate: the "index at issue" input is a
  // Treasury-basis number, and both legs of the MVA ratio have to sit on the
  // same basis. Using a MYGA or IG rate here would book that instrument's
  // credit spread as rate movement and overstate the MVA charge by it.
  const mvaIndexNow = useMemo(
    () => interpolateCurve(ustTenors, ustYields, n || 1),
    [ustTenors, ustYields, n]
  );

  const { rate: marketRate, detail: rateDetail } = useMemo(
    () => benchmarkRate(benchKey, n || 1, { ustTenors, ustYields, igOasBp, spreadOverrideBp: spreadOverride }),
    [benchKey, n, ustTenors, ustYields, igOasBp, spreadOverride]
  );

  // Minimum guaranteed surrender value: 87.5% of premium accumulated at the
  // nonforfeiture rate. Premium is approximated by cost basis, which is exact
  // for a single-premium contract with no withdrawals.
  const mgsv = useMemo(() => {
    if (!mgsvOn || basis == null) return null;
    const yearsHeld = 0; // conservative: no accumulation credited to the floor
    return 0.875 * basis * Math.pow(1.01, yearsHeld);
  }, [mgsvOn, basis]);

  const contract = useMemo(() => ({
    accountValue: av, basis, freeWithdrawalPct: free,
    freeAppliesOnFullSurrender: freeOnFull,
    mvaEnabled: mvaOn, mvaIndexAtIssue: mvaIssue, mvaMarginBp: mvaMargin,
    mgsv, taxMode, taxRate, currentAge: age,
  }), [av, basis, free, freeOnFull, mvaOn, mvaIssue, mvaMargin, mgsv, taxMode, taxRate, age]);

  const result = useMemo(() => analyseMoneyness({
    ...contract,
    guaranteedRate: g,
    reinvestRate: marketRate,
    yearsRemaining: n,
    surrenderChargePct: sc,
    mvaIndexNow,
  }), [contract, g, marketRate, n, sc, mvaIndexNow]);

  // Wealth paths — the crossover is the whole story, so plot it rather than
  // asking the reader to trust a single break-even number.
  const pathData = useMemo(() => {
    if (marketRate == null || !n) return [];
    const horizon = Math.max(n, result?.breakEvenYears ? Math.ceil(result.breakEvenYears) + 1 : 0);
    const steps = Math.min(60, Math.max(12, Math.ceil(horizon * 4)));
    const out = [];
    for (let i = 0; i <= steps; i++) {
      // The first point runs through the same after-tax lens as every other
      // one (T→0 rather than a hardcoded pre-tax account value), otherwise the
      // series opens with a phantom step down where the tax charge first lands.
      const T = Math.max(1e-3, (horizon * i) / steps);
      const r = analyseMoneyness({ ...contract, guaranteedRate: g, reinvestRate: marketRate, yearsRemaining: T, surrenderChargePct: sc, mvaIndexNow });
      if (r) out.push({ t: T, hold: r.hold.net, sw: r.sw.net });
    }
    return out;
  }, [contract, g, marketRate, n, sc, av, result, mvaIndexNow]);

  const grid = useMemo(() => {
    if (!ustTenors || !ustYields) return null;
    return moneynessGrid({
      guaranteedRates: GRID_RATES, terms: GRID_TERMS, benchKey,
      ustTenors, ustYields, igOasBp, spreadOverrideBp: spreadOverride,
      accountValue: av, basis, freeWithdrawalPct: free,
      freeAppliesOnFullSurrender: freeOnFull, mvaEnabled: gridMva,
      mvaMarginBp: mvaMargin, taxMode, taxRate, currentAge: age,
    });
  }, [ustTenors, ustYields, benchKey, igOasBp, spreadOverride, av, basis, free, freeOnFull, gridMva, mvaMargin, taxMode, taxRate, age]);

  // Dynamic lapse response curve, evaluated across the plausible gap range.
  const lapseCurve = useMemo(() => {
    const out = [];
    for (let gap = -2; gap <= 5.01; gap += 0.25) {
      const d = dynamicLapse({ competitorRate: g + gap, creditedRate: g, surrenderChargePct: sc, ...dl });
      out.push({ gap: +gap.toFixed(2), total: d.total, base: d.base });
    }
    return out;
  }, [g, sc, dl]);

  const currentGap = marketRate != null ? marketRate - g : null;
  const currentLapse = useMemo(
    () => (marketRate != null ? dynamicLapse({ competitorRate: marketRate, creditedRate: g, surrenderChargePct: sc, ...dl }) : null),
    [marketRate, g, sc, dl]
  );

  if (loading) return <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: 40, textAlign: "center", color: "#94a3b8" }}><Loader size={24} style={{ animation: "spin 1s linear infinite", margin: "0 auto 10px", display: "block", color: "#22d3ee" }} />Loading curve data…</div>;

  const noCurve = !ustTenors || !ustYields;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* ── Header ── */}
      <div style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "16px 22px", borderBottom: "1px solid #1e2028" }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#f1f5f9" }}>
            <Gauge size={18} style={{ verticalAlign: "middle", marginRight: 8 }} />
            Guaranteed Annuity — In-the-Money Meter
          </h3>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#94a3b8", flexWrap: "wrap", marginTop: 5 }}>
            <Clock size={13} /><span>Curve as of {ust?.date || "—"}</span>
            <span style={{ color: "#475569" }}>|</span>
            <a href={ust?.url} target="_blank" rel="noopener noreferrer" style={{ color: "#60a5fa", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 3 }}>
              {ust?.source || "US Treasury"} <ExternalLink size={11} />
            </a>
            {igOasBp != null && <><span style={{ color: "#475569" }}>|</span><span>IG OAS {igOasBp}bp ({credit?.date})</span></>}
          </div>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 8, lineHeight: 1.65, maxWidth: 940 }}>
            Compares after-tax terminal wealth from <strong style={{ color: "#cbd5e1" }}>keeping</strong> a guaranteed deferred annuity to
            its remaining guarantee date against <strong style={{ color: "#cbd5e1" }}>surrendering today and reinvesting</strong> the proceeds.
            The rate gap alone is not the answer — the surrender charge, the market value adjustment and the tax treatment of the exit
            routinely reverse it. The meter reads the net of all three.
          </div>
        </div>

        {noCurve && (
          <div style={{ padding: "10px 22px", background: "#1a1206", borderBottom: "1px solid #854d0e", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#fbbf24" }}>
            <AlertTriangle size={13} />
            No Treasury curve loaded{error ? ` (${error})` : ""} — the benchmark reinvestment rate cannot be derived. Run the data pipeline.
          </div>
        )}

        {/* ── Reinvestment benchmark ── */}
        <div style={{ padding: "14px 22px", borderBottom: "1px solid #1e2028" }}>
          <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
            Reinvest into
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {BENCHMARK_ORDER.map(k => {
              const b = BENCHMARKS[k];
              const on = benchKey === k;
              return (
                <button key={k} onClick={() => { setBenchKey(k); setSpreadOverride(null); }} title={b.desc}
                  style={{
                    background: on ? "#22d3ee1f" : "transparent",
                    border: `1px solid ${on ? "#22d3ee" : "#2a2d35"}`, borderRadius: 6,
                    padding: "7px 15px", fontSize: 12.5, fontWeight: 700,
                    color: on ? "#22d3ee" : "#94a3b8", cursor: "pointer",
                  }}>{b.label}</button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 20, alignItems: "flex-end", flexWrap: "wrap", marginTop: 12 }}>
            <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.6, flex: "1 1 380px", minWidth: 260 }}>
              {bench?.desc}
              <div style={{ marginTop: 5, color: "#475569", fontFamily: "monospace", fontSize: 11 }}>{rateDetail}</div>
            </div>
            {bench?.kind === "ust_spread" && (
              <div style={{ width: 150 }}>
                <Field label="Spread over UST" hint="Calibrated to the July 2026 new-money MYGA market. Override to match a quote you actually have.">
                  <Num value={effSpread ?? 0} onChange={setSpreadOverride} step={5} suffix="bp" />
                </Field>
              </div>
            )}
            <Stat label="Reinvestment rate" value={pct(marketRate)} ink="#22d3ee"
              sub={`matched to ${n || 0}y remaining term`} />
          </div>
        </div>

        {/* ── The meter ── */}
        <Meter netBp={result?.netAdvantageBp} grossBp={result?.grossGapBp} verdict={result?.verdict} />
      </div>

      {/* ── Contract inputs ── */}
      <Panel title="Contract" icon={SlidersHorizontal}
        note="Everything below is an input — nothing is inferred from a policy file. Defaults describe a mid-schedule MYGA.">
        <div style={{ padding: "16px 20px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 14 }}>
          <Field label="Account value"><Num value={av} onChange={setAv} step={1000} min={0} suffix="$" /></Field>
          <Field label="Cost basis" hint="Premiums paid less untaxed withdrawals. Drives the taxable gain on exit; irrelevant for qualified money.">
            <Num value={basis} onChange={setBasis} step={1000} min={0} suffix="$" />
          </Field>
          <Field label="Guaranteed rate" hint="The rate the contract credits for the rest of the guarantee period.">
            <Num value={g} onChange={setG} step={0.25} suffix="%" />
          </Field>
          <Field label="Years remaining" hint="Remaining guarantee period. Also the horizon both paths are measured to.">
            <Num value={n} onChange={setN} step={1} min={0.25} suffix="y" />
          </Field>
          <Field label="Surrender charge" hint="Current-year charge. A 9%-declining 7-year schedule sits at roughly the number of years still to run.">
            <Num value={sc} onChange={setSc} step={0.5} min={0} suffix="%" />
          </Field>
          <Field label="Free withdrawal" hint="Annual penalty-free corridor, commonly 10% of account value.">
            <Num value={free} onChange={setFree} step={1} min={0} max={100} suffix="%" />
          </Field>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <Toggle checked={freeOnFull} onChange={setFreeOnFull} label="Corridor applies on full surrender" />
          </div>
        </div>

        <div style={{ padding: "0 20px 16px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 14, borderTop: "1px solid #151820", paddingTop: 16 }}>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <Toggle checked={mvaOn} onChange={setMvaOn} label="Market value adjustment" />
          </div>
          <Field label="MVA index at issue" hint="Treasury-basis reference rate when the contract was written — the same basis the current index is read on. Rates have risen since ⇒ the MVA is negative and works against leaving.">
            <Num value={mvaIssue} onChange={setMvaIssue} step={0.25} suffix="%" />
          </Field>
          <Field label="MVA index now" hint="Matched-maturity Treasury, read live off the curve. Not editable — it is the market, not an assumption.">
            <div style={{ ...inputStyle, color: "#22d3ee", display: "flex", alignItems: "center" }}>{pct(mvaIndexNow)}</div>
          </Field>
          <Field label="MVA carrier margin" hint="Added to the current index in the denominator. Commonly 10–25bp.">
            <Num value={mvaMargin} onChange={setMvaMargin} step={5} min={0} suffix="bp" />
          </Field>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <Toggle checked={mgsvOn} onChange={setMgsvOn} label="Nonforfeiture floor (87.5%)" />
          </div>
          <Field label="Tax treatment"><Select value={taxMode} onChange={setTaxMode} options={Object.values(TAX_MODES).map(t => ({ value: t.key, label: t.label }))} /></Field>
          <Field label="Marginal rate" hint="Ordinary income rate — annuity gains never receive capital-gains treatment.">
            <Num value={taxRate} onChange={setTaxRate} step={1} min={0} max={60} suffix="%" />
          </Field>
          <Field label="Current age" hint="Under 59½ a cash-out adds the 10% penalty under IRC §72(q)/(t).">
            <Num value={age} onChange={setAge} step={1} min={0} max={110} />
          </Field>
        </div>
        <div style={{ padding: "0 20px 16px", fontSize: 11.5, color: "#64748b", lineHeight: 1.6 }}>
          {TAX_MODES[taxMode]?.desc}
          {taxMode === "nq_cash" && age < 59.5 && (
            <span style={{ color: "#f59e0b" }}> — 10% penalty applies at age {age}.</span>
          )}
        </div>
      </Panel>

      {/* ── The numbers ── */}
      {result && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12 }}>
          <Stat label="Break-even reinvestment rate" big
            value={pct(result.breakEvenRate)}
            ink={marketRate != null && marketRate > result.breakEvenRate ? OTM_INK : ITM_INK}
            hint="The rate a replacement contract must beat for surrendering to leave you better off. This is the single number to shop against."
            sub={marketRate != null
              ? marketRate > result.breakEvenRate
                ? `market ${pct(marketRate)} clears it by ${bp((marketRate - result.breakEvenRate) * 100)}`
                : `market ${pct(marketRate)} falls ${bp((result.breakEvenRate - marketRate) * 100)} short`
              : null} />
          <Stat label="Gross rate gap" value={bp(result.grossGapBp)}
            ink={result.grossGapBp >= 0 ? ITM_INK : OTM_INK}
            hint="Guaranteed rate less the reinvestment rate, before any friction. The number most comparison sites stop at."
            sub={`${pct(g)} guaranteed vs ${pct(marketRate)} market`} />
          <Stat label="Net advantage of holding" value={bp(result.netAdvantageBp)}
            ink={result.netAdvantageBp >= 0 ? ITM_INK : OTM_INK}
            hint="Annualised, after surrender charge, MVA and tax. This is what the meter reads."
            sub={`${usd(result.netAdvantage)} over ${yrs(n)} · ${result.netAdvantagePctAv >= 0 ? "+" : ""}${result.netAdvantagePctAv.toFixed(2)}% of AV`} />
          <Stat label="Cost of leaving today" value={pct(result.exitCostPct)}
            ink={result.exitCostPct > 0 ? OTM_INK : "#f1f5f9"}
            hint="Account value less cash surrender value, as a % of AV — the surrender charge and MVA combined."
            sub={`SC ${usd(result.surrenderCharge)} · MVA ${usd(result.mvaAmount)}${result.flooredByMgsv ? " · floored" : ""}`} />
          <Stat label="Cash surrender value" value={usd(result.csv)}
            hint="What actually leaves the contract today and gets reinvested."
            sub={`from ${usd(av)} account value${result.flooredByMgsv ? " — nonforfeiture floor binding" : ""}`} />
          <Stat label="Break-even horizon" value={result.breakEvenYears != null ? yrs(result.breakEvenYears) : "never"}
            ink={result.breakEvenYears != null && result.breakEvenYears < n ? OTM_INK : ITM_INK}
            hint="How long you must stay invested for switching to overtake holding. Beyond the remaining guarantee period, the switch does not pay for itself in time."
            sub={result.breakEvenYears == null
              ? "the guarantee wins at every horizon"
              : result.breakEvenYears < n ? `inside the ${yrs(n)} remaining — switching pays off in time` : `beyond the ${yrs(n)} remaining`} />
          <Stat label="Guarantee value (PV)" value={`${result.guaranteeValuePctAv >= 0 ? "+" : ""}${result.guaranteeValuePctAv.toFixed(2)}%`}
            ink={result.guaranteeValuePctAv >= 0 ? ITM_INK : OTM_INK}
            hint="PV of the rate guarantee's excess over the market alternative, as a % of account value, ignoring exit frictions. The option view rather than the decision view."
            sub={`${usd((result.guaranteeValuePctAv / 100) * av)} on ${usd(av)}`} />
          <Stat label="Terminal wealth" value={usd(result.hold.net)}
            hint="After-tax value at the end of the remaining guarantee period if you hold."
            sub={`vs ${usd(result.sw.net)} if you switch — a ${result.netAdvantage >= 0 ? "gain" : "shortfall"} of ${usd(Math.abs(result.netAdvantage))}`} />
        </div>
      )}

      {/* ── Wealth paths ── */}
      {pathData.length > 1 && (
        <Panel title="After-tax wealth — hold vs surrender & reinvest" icon={Calculator}
          note={`Both paths start from the same contract today: holding compounds ${pct(g)} on the full ${usd(av)}; switching compounds ${pct(marketRate)} on the ${usd(result?.csv)} that survives the exit. Where they cross is the break-even horizon.`}>
          <div style={{ padding: "14px 14px 6px" }}>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={pathData} margin={{ top: 6, right: 18, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2028" />
                <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]}
                  tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={{ stroke: "#1e2028" }} tickLine={false}
                  tickFormatter={v => v.toFixed(0) + "y"}
                  label={{ value: "Years from today", position: "insideBottom", offset: -2, fill: "#475569", fontSize: 11 }} />
                <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={{ stroke: "#1e2028" }} tickLine={false}
                  domain={["auto", "auto"]} width={78}
                  tickFormatter={v => "$" + Math.round(v / 1000) + "k"} />
                <Tooltip
                  contentStyle={{ background: "#1e2028", border: "1px solid #334155", borderRadius: 6, fontSize: 12 }}
                  labelStyle={{ color: "#f1f5f9", fontWeight: 700 }}
                  labelFormatter={v => `Year ${(+v).toFixed(1)}`}
                  formatter={(v, name) => [usd(v), name]} />
                <Legend wrapperStyle={{ fontSize: 12, paddingTop: 14 }} />
                <Line type="monotone" dataKey="hold" stroke={ITM_INK} strokeWidth={2} name="Hold the annuity" dot={false} />
                <Line type="monotone" dataKey="sw" stroke={OTM_INK} strokeWidth={2} name="Surrender & reinvest" dot={false} />
                <ReferenceLine x={n} stroke="#94a3b8" strokeDasharray="4 3" strokeWidth={1.5}
                  label={{ value: "guarantee ends", position: "insideTopLeft", fill: "#94a3b8", fontSize: 10, fontWeight: 700 }} />
                {result?.breakEvenYears != null && (
                  <ReferenceLine x={result.breakEvenYears} stroke="#f8fafc" strokeDasharray="2 3" strokeWidth={1.5}
                    label={{ value: `break-even ${yrs(result.breakEvenYears)}`, position: "insideTopRight", fill: "#f8fafc", fontSize: 10, fontWeight: 700 }} />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      )}

      {/* ── Block moneyness surface ── */}
      {grid && (
        <Panel title="Block moneyness surface" icon={Gauge}
          right={<div style={{ width: 210, flexShrink: 0 }}><Toggle checked={gridMva} onChange={setGridMva} label="Apply MVA across the grid" /></div>}
          note={<>Net annualised advantage of holding (bp), by guaranteed rate and remaining term, against <strong style={{ color: "#cbd5e1" }}>{bench?.label}</strong> at each term. Surrender charge declines with the remaining term (min(9%, years left)). Cyan = policyholder in the money, so the block persists; amber = out of the money, so it is exposed to disintermediation.
            <div style={{ marginTop: 7, color: gridMva ? "#f59e0b" : "#475569" }}>
              {gridMva
                ? "MVA on: the surface collapses toward zero almost everywhere. That is the MVA working as designed — over a matched period it neutralises rate movement, so a contract carrying a full MVA is largely hedged against this decision. The residual is the surrender charge and tax."
                : "MVA off — the exposure view. Applies to contracts written without an MVA, and to any contract whose MVA period has run off ahead of its guarantee. Switch it on to see how much of the exposure an MVA removes."}
            </div>
          </>}>
          <div style={{ padding: "14px 20px 6px", overflowX: "auto" }}>
            <table style={{ borderCollapse: "separate", borderSpacing: 2, fontSize: 11.5, minWidth: 640 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "right", padding: "4px 8px", color: "#94a3b8", fontWeight: 700, fontSize: 11, whiteSpace: "nowrap" }}>Guar. rate ↓ / term →</th>
                  {GRID_TERMS.map(t => (
                    <th key={t} style={{ textAlign: "center", padding: "4px 6px", color: "#94a3b8", fontWeight: 700, fontSize: 11, minWidth: 46 }}>{t}y</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.map((row, ri) => (
                  <tr key={GRID_RATES[ri]}>
                    <td style={{ textAlign: "right", padding: "4px 8px", color: "#f1f5f9", fontWeight: 700, fontFamily: "monospace", whiteSpace: "nowrap" }}>{GRID_RATES[ri].toFixed(2)}%</td>
                    {row.map(cell => {
                      const active = hoverCell && hoverCell.g === cell.g && hoverCell.n === cell.n;
                      return (
                        <td key={cell.n}
                          onMouseEnter={() => setHoverCell(cell)}
                          onMouseLeave={() => setHoverCell(null)}
                          title={`${cell.g.toFixed(2)}% guaranteed, ${cell.n}y left → ${bp(cell.netAdvantageBp)}`}
                          style={{
                            background: divergingFill(cell.netAdvantageBp),
                            color: inkFor(cell.netAdvantageBp),
                            textAlign: "center", padding: "6px 4px", borderRadius: 3,
                            fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, cursor: "crosshair",
                            outline: active ? "2px solid #f8fafc" : "none", outlineOffset: -2,
                          }}>
                          {cell.netAdvantageBp != null ? cell.netAdvantageBp.toFixed(0) : "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Hover readout — the cell detail, without a floating layer over a dense grid */}
          <div style={{ padding: "8px 20px 14px", fontSize: 12, color: hoverCell ? "#cbd5e1" : "#475569", fontFamily: "monospace", minHeight: 20 }}>
            {hoverCell ? (
              <>
                <strong style={{ color: "#f1f5f9" }}>{hoverCell.g.toFixed(2)}% guaranteed · {hoverCell.n}y remaining</strong>
                {"  ·  "}reinvest at {pct(hoverCell.rate)}
                {"  ·  "}assumed SC {hoverCell.scPct?.toFixed(1)}%{gridMva ? " + MVA" : ""}
                {"  ·  "}gross gap <span style={{ color: hoverCell.grossGapBp >= 0 ? ITM_INK : OTM_INK }}>{bp(hoverCell.grossGapBp)}</span>
                {"  ·  "}net <span style={{ color: hoverCell.netAdvantageBp >= 0 ? ITM_INK : OTM_INK }}>{bp(hoverCell.netAdvantageBp)}</span>
              </>
            ) : "Hover a cell for its reinvestment rate, assumed surrender charge and gross-vs-net gap."}
          </div>

          {/* Legend */}
          <div style={{ padding: "0 20px 16px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 11, color: "#94a3b8" }}>
            <span>Out of the money</span>
            {[...OTM_RAMP].reverse().map(c => <span key={c} style={{ width: 22, height: 12, background: c, borderRadius: 2 }} />)}
            <span style={{ width: 22, height: 12, background: NEUTRAL, borderRadius: 2 }} />
            {ITM_RAMP.map(c => <span key={c} style={{ width: 22, height: 12, background: c, borderRadius: 2 }} />)}
            <span>In the money</span>
            <span style={{ color: "#475569", marginLeft: 6 }}>−{FULL_SCALE_BP}bp … 0 … +{FULL_SCALE_BP}bp (saturating)</span>
          </div>
        </Panel>
      )}

      {/* ── Dynamic lapse ── */}
      <Panel title="Dynamic lapse response" icon={TrendingDown}
        note={<>The block-level consequence. Form follows market practice as described in Milliman&rsquo;s FIA/MYGA lapse survey: an <strong style={{ color: "#cbd5e1" }}>additive</strong> adjustment to the base lapse, <strong style={{ color: "#cbd5e1" }}>one-sided</strong> (no credit for being in the money), damped by the surrender charge and <strong style={{ color: "#cbd5e1" }}>capped</strong>. Parameters are a sensitivity starting point, not a substitute for a company&rsquo;s own experience study.</>}>
        <div style={{ padding: "14px 20px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 14 }}>
          <Field label="Base lapse"><Num value={dl.baseLapsePct} onChange={v => setDl(d => ({ ...d, baseLapsePct: v }))} step={0.5} min={0} suffix="%" /></Field>
          <Field label="Sensitivity" hint="Percentage points of excess lapse per 1pp of rate disadvantage.">
            <Num value={dl.sensitivity} onChange={v => setDl(d => ({ ...d, sensitivity: v }))} step={0.5} min={0} />
          </Field>
          <Field label="Threshold" hint="Dead zone before policyholders react at all.">
            <Num value={dl.thresholdPp} onChange={v => setDl(d => ({ ...d, thresholdPp: v }))} step={0.25} min={0} suffix="pp" />
          </Field>
          <Field label="Cap" hint="Ceiling on the dynamic add-on. Every surveyed writer applies one.">
            <Num value={dl.capPp} onChange={v => setDl(d => ({ ...d, capPp: v }))} step={5} min={0} suffix="pp" />
          </Field>
          <Field label="SC full-damp level" hint="Surrender charge at which the dynamic response is fully suppressed.">
            <Num value={dl.scDampPp} onChange={v => setDl(d => ({ ...d, scDampPp: v }))} step={1} min={0} suffix="%" />
          </Field>
        </div>
        <div style={{ padding: "0 14px 6px" }}>
          <ResponsiveContainer width="100%" height={230}>
            <LineChart data={lapseCurve} margin={{ top: 6, right: 18, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e2028" />
              <XAxis dataKey="gap" type="number" domain={[-2, 5]}
                tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={{ stroke: "#1e2028" }} tickLine={false}
                tickFormatter={v => (v > 0 ? "+" : "") + v + "pp"}
                label={{ value: "Competitor rate − credited rate", position: "insideBottom", offset: -2, fill: "#475569", fontSize: 11 }} />
              <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={{ stroke: "#1e2028" }} tickLine={false}
                width={52} tickFormatter={v => v + "%"} />
              <Tooltip
                contentStyle={{ background: "#1e2028", border: "1px solid #334155", borderRadius: 6, fontSize: 12 }}
                labelStyle={{ color: "#f1f5f9", fontWeight: 700 }}
                labelFormatter={v => `Gap ${(+v) > 0 ? "+" : ""}${v}pp`}
                formatter={(v, name) => [v.toFixed(1) + "%", name]} />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 14 }} />
              <Line type="monotone" dataKey="base" stroke="#64748b" strokeWidth={1.5} strokeDasharray="5 4" name="Base lapse" dot={false} />
              <Line type="monotone" dataKey="total" stroke={OTM_INK} strokeWidth={2} name="Total lapse (base + dynamic)" dot={false} />
              <ReferenceLine x={0} stroke="#475569" strokeWidth={1} />
              {currentGap != null && currentGap >= -2 && currentGap <= 5 && currentLapse && (
                <>
                  <ReferenceLine x={+currentGap.toFixed(2)} stroke="#f8fafc" strokeDasharray="2 3" strokeWidth={1.5}
                    label={{ value: "today", position: "insideTopLeft", fill: "#f8fafc", fontSize: 10, fontWeight: 700 }} />
                  <ReferenceDot x={+currentGap.toFixed(2)} y={currentLapse.total} r={5} fill="#f8fafc" stroke="#0d0f14" strokeWidth={2} />
                </>
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
        {currentLapse && (
          <div style={{ padding: "6px 20px 16px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
            <Stat label="Rate gap today" value={bp(currentGap * 100)} ink={currentGap > 0 ? OTM_INK : ITM_INK}
              sub={`competitor ${pct(marketRate)} vs credited ${pct(g)}`} />
            <Stat label="Excess lapse" value={currentLapse.excess.toFixed(1) + "pp"} ink={currentLapse.excess > 0 ? OTM_INK : "#94a3b8"}
              sub={currentLapse.excess === 0 ? "contract is in the money — no dynamic add-on" : `damped by the ${sc}% surrender charge`} />
            <Stat label="Projected total lapse" value={currentLapse.total.toFixed(1) + "%"} ink="#f1f5f9"
              sub={`${dl.baseLapsePct}% base + ${currentLapse.excess.toFixed(1)}pp dynamic`} />
          </div>
        )}
      </Panel>

      {/* ── Methodology ── */}
      <Panel title="Method & assumptions" icon={Info}>
        <div style={{ padding: "14px 20px 18px", fontSize: 12, color: "#94a3b8", lineHeight: 1.75, maxWidth: 980 }}>
          <p style={{ margin: "0 0 12px" }}>
            <strong style={{ color: "#cbd5e1" }}>The comparison.</strong> After-tax terminal wealth at the end of the remaining
            guarantee period, under two paths. <em>Hold</em>: the full account value compounds at the guaranteed rate. <em>Switch</em>:
            the cash surrender value — account value less the surrender charge and the market value adjustment, floored at the
            nonforfeiture minimum — compounds at the benchmark reinvestment rate. The meter shows the geometric annualised
            difference, which is why it reads slightly inside the arithmetic rate gap.
          </p>
          <p style={{ margin: "0 0 12px" }}>
            <strong style={{ color: "#cbd5e1" }}>Market value adjustment.</strong> MVA = [(1 + i₀) / (1 + i₁ + k)]<sup>m</sup> − 1,
            where i₀ is the reference index at issue, i₁ the current index, k the carrier margin and m the years remaining. Carriers
            use proprietary variants, but this is the common shape. Note the direction: rates up ⇒ MVA negative ⇒ exit value cut. The
            MVA is the carrier&rsquo;s disintermediation defence and it bites hardest in exactly the scenario that makes leaving look
            attractive — which is the single most under-appreciated part of this decision.
          </p>
          <p style={{ margin: "0 0 12px" }}>
            <strong style={{ color: "#cbd5e1" }}>Tax.</strong> Annuity gains are ordinary income under LIFO — never capital gains. A
            §1035 exchange moves the contract without tax and carries the basis over, so it preserves deferral while still incurring
            the surrender charge; that is usually the realistic switch route. A full cash-out crystallises the gain today, adds the
            10% penalty under IRC §72(q)/(t) below age 59½, and drops the proceeds into annual taxation thereafter — so the
            alternative then compounds at r × (1 − t), not r. The penalty is charged only on acting today: reaching the end of a
            guarantee period does not force a distribution, and no one liquidates into a penalty they can avoid by waiting.
          </p>
          <p style={{ margin: "0 0 12px" }}>
            <strong style={{ color: "#cbd5e1" }}>What this does not model.</strong> Carrier credit quality and state guaranty
            association limits (typically $250k–$300k per contract) — a rate pickup earned by moving down the ratings scale is not
            free. Also excluded: GLWB/GMWB rider benefit bases, which have their own moneyness and can dominate the account-value
            comparison entirely; bonus recapture on exit; renewal-rate behaviour after the guarantee period, where a carrier&rsquo;s
            renewal rate rather than a new-money rate is the relevant comparison; and any advice dimension beyond the arithmetic.
            Payout annuities are irrevocable and out of scope by construction.
          </p>
          <p style={{ margin: "0 0 12px", color: "#64748b" }}>
            <strong style={{ color: "#94a3b8" }}>Calibration.</strong> MYGA spreads over Treasuries are set from the July 2026
            new-money market (best-available 5-year ≈ 6.3%, competitive A-rated ≈ 5.0–5.75%, against a 5-year Treasury of
            ≈ 4.4%) and are editable. The modelled competitor rate uses the Treasury-blend convention — 105% × (50% × 5Y + 50% × 7Y)
            — reported as common practice for fixed-account dynamic lapse. Sources:{" "}
            <a href="https://www.annuity.org/annuities/rates/" target="_blank" rel="noopener noreferrer" style={{ color: "#60a5fa" }}>Annuity.org rate survey</a>,{" "}
            <a href="https://myannuitystore.com/annuities/myga/" target="_blank" rel="noopener noreferrer" style={{ color: "#60a5fa" }}>My Annuity Store MYGA rates</a>,{" "}
            <a href="https://www.milliman.com/en/insight/fixed-indexed-annuity-multi-year-guaranteed-annuity-lapse-experience-study" target="_blank" rel="noopener noreferrer" style={{ color: "#60a5fa" }}>Milliman FIA/MYGA lapse study</a>,{" "}
            <a href="https://www.actuary.org/sites/default/files/2023-12/life-paper-dynamic-lapses.pdf" target="_blank" rel="noopener noreferrer" style={{ color: "#60a5fa" }}>Academy of Actuaries, dynamic lapses</a>.
          </p>
          <div style={{ background: "#12141a", border: "1px solid #2a2d35", borderRadius: 8, padding: "12px 15px", fontSize: 11.5, color: "#94a3b8", lineHeight: 1.65 }}>
            <AlertTriangle size={13} style={{ verticalAlign: "middle", marginRight: 6, color: "#f59e0b" }} />
            An analytical tool, not advice. Contract terms — surrender schedule, the carrier&rsquo;s actual MVA formula, bonus
            recapture, rider guarantees — vary enough that the policy documents govern. Verify against the contract before anyone
            acts on a number here.
          </div>
        </div>
      </Panel>
    </div>
  );
}

/* ── Compact tile for the Overview page ── */
export function AnnuityMoneynessTile({ ust, credit, onOpen }) {
  const ustTenors = ust?.tenors, ustYields = ust?.yields;
  const igOasBp = credit?.spreads?.ig?.spread ?? null;

  // Exactly the contract the calculator opens on, so the tile and the page
  // never disagree.
  const { g, n } = DEFAULTS;
  const { rate } = benchmarkRate(DEFAULTS.bench, n, { ustTenors, ustYields, igOasBp });
  const res = rate == null ? null : analyseMoneyness({
    accountValue: DEFAULTS.av, basis: DEFAULTS.basis, guaranteedRate: g, reinvestRate: rate,
    yearsRemaining: n, surrenderChargePct: DEFAULTS.sc, freeWithdrawalPct: DEFAULTS.free,
    mvaEnabled: true, mvaIndexAtIssue: DEFAULTS.mvaIssue,
    mvaIndexNow: interpolateCurve(ustTenors, ustYields, n),
    mvaMarginBp: DEFAULTS.mvaMargin, mgsv: 0.875 * DEFAULTS.basis,
    taxMode: DEFAULTS.taxMode, taxRate: DEFAULTS.taxRate, currentAge: DEFAULTS.age,
  });
  const ink = res?.verdict ? VERDICT_INK[res.verdict.key] : "#94a3b8";

  return (
    <div onClick={onOpen} style={{ background: "#0d0f14", border: "1px solid #1e2028", borderRadius: 10, padding: "16px 20px", cursor: "pointer" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Gauge size={15} style={{ color: "#22d3ee" }} />
        <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>Annuity moneyness</span>
      </div>
      {res ? (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 24, fontWeight: 800, color: ink, fontFamily: "'JetBrains Mono', monospace" }}>{bp(res.netAdvantageBp)}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: ink }}>{res.verdict?.label}</span>
          </div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 7, lineHeight: 1.5 }}>
            {g.toFixed(2)}% guaranteed, {n}y left vs {pct(rate)} A-rated MYGA · break-even {pct(res.breakEvenRate)}
          </div>
        </>
      ) : (
        <div style={{ fontSize: 13, color: "#64748b" }}>Curve data unavailable</div>
      )}
    </div>
  );
}

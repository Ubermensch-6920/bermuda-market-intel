/* ═══════════════════════════════════════════════════════════════════
   ANNUITY IN-THE-MONEY ENGINE
   ───────────────────────────────────────────────────────────────────
   Pure functions — no React, no I/O — so the maths can be unit tested
   (see scripts/test_annuity_moneyness.mjs).

   Question this answers, from the policyholder's side:
     "My deferred annuity guarantees me g% for another n years. Market
      rates have moved. Am I in the money — and if not, is it worth
      eating the surrender charge to lapse and reinvest?"

   The honest answer is never just (g − market). Three frictions sit
   between the rate gap and the decision, and all three are modelled:

     1. Surrender charge  — declining %, applied to the non-free portion
     2. Market value adj. — the carrier's disintermediation defence; it
                             moves AGAINST you exactly when the rate gap
                             tempts you to leave
     3. Tax               — a full surrender to cash crystallises the
                             gain as ordinary income (+10% IRC §72(q)/(t)
                             penalty pre-59½) and drops you into annual
                             taxation thereafter. A §1035 exchange into a
                             new annuity avoids all of that but keeps the
                             surrender charge.

   So the engine compares AFTER-TAX TERMINAL WEALTH at the end of the
   remaining guarantee period under two paths, and reports the break-even
   reinvestment rate — the rate you'd have to find to justify leaving.
   ═══════════════════════════════════════════════════════════════════ */

// ── Curve handling ────────────────────────────────────────────────

/** "6M" → 0.5, "10Y" → 10. Returns null for anything unparseable. */
export function tenorToYears(t) {
  if (typeof t !== "string") return null;
  const m = t.trim().match(/^([\d.]+)\s*([MY])$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  return m[2].toUpperCase() === "M" ? n / 12 : n;
}

/**
 * Linear interpolation across a par/spot curve, flat extrapolation past
 * either end. Nulls in `yields` are skipped rather than treated as zero —
 * BMA curves in particular carry a null 0.5Y for several currencies.
 */
export function interpolateCurve(tenors, yields, targetYears) {
  if (!Array.isArray(tenors) || !Array.isArray(yields) || targetYears == null) return null;
  const pts = [];
  tenors.forEach((t, i) => {
    const y = tenorToYears(t);
    const v = yields[i];
    if (y != null && v != null && isFinite(v)) pts.push([y, v]);
  });
  if (!pts.length) return null;
  pts.sort((a, b) => a[0] - b[0]);
  if (targetYears <= pts[0][0]) return pts[0][1];
  if (targetYears >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    if (targetYears <= x1) return y0 + ((y1 - y0) * (targetYears - x0)) / (x1 - x0);
  }
  return pts[pts.length - 1][1];
}

// ── Reinvestment benchmarks ───────────────────────────────────────
/*
   What exactly is the policyholder reinvesting INTO? That choice drives
   the whole answer, so it is explicit rather than buried in a constant.

   Spreads over Treasuries are calibrated to the July 2026 new-money MYGA
   market (5Y UST ~4.4%; best-available 5Y MYGA ~6.3%; A-rated competitive
   5Y MYGA ~5.0–5.75%). They are inputs, not truths — the UI exposes them.

   `competitor` is the modelling convention rather than a shoppable rate:
   Milliman's FIA/MYGA lapse survey reports competitor rates for fixed
   accounts commonly set as a Treasury blend such as
   105% × (50% × 5Y + 50% × 7Y). It is what a pricing/ALM model would use
   to drive dynamic lapse, so it is the right benchmark for the block view.
*/
export const BENCHMARKS = {
  myga_best: {
    key: "myga_best",
    label: "Best-available MYGA",
    short: "MYGA (best)",
    desc: "Top-of-market new-money MYGA. Usually a smaller or non-rated carrier — highest rate, weakest covenant.",
    kind: "ust_spread",
    spreadBp: 185,
    creditRisk: "carrier",
  },
  myga_arated: {
    key: "myga_arated",
    label: "A-rated MYGA",
    short: "MYGA (A-rated)",
    desc: "Competitive new-money MYGA from an A-rated carrier. The realistic like-for-like §1035 target.",
    kind: "ust_spread",
    spreadBp: 90,
    creditRisk: "carrier",
  },
  competitor: {
    key: "competitor",
    label: "Modelled competitor rate",
    short: "Competitor",
    desc: "105% × (50% × 5Y + 50% × 7Y UST) — the Treasury-blend convention used to drive dynamic lapse in pricing and ALM models.",
    kind: "ust_blend",
    creditRisk: "carrier",
  },
  ig_corp: {
    key: "ig_corp",
    label: "IG corporate bond",
    short: "IG corp",
    desc: "UST + live ICE BofA US IG OAS. Direct credit exposure, no tax deferral, no guaranty-association backstop.",
    kind: "ust_plus_oas",
    creditRisk: "market",
  },
  myga_live: {
    key: "myga_live",
    label: "Observed MYGA",
    short: "MYGA (observed)",
    desc: "Live quote-board spreads over Treasuries, bucketed by AM Best rating. Lets the rating you are willing to accept price itself instead of being a calibration guess.",
    kind: "observed",
    creditRisk: "carrier",
  },
  treasury: {
    key: "treasury",
    label: "US Treasury",
    short: "UST",
    desc: "Matched-maturity Treasury. Credit-risk-free, so the most conservative bar the guarantee has to clear.",
    kind: "ust_spread",
    spreadBp: 0,
    creditRisk: "none",
  },
};

export const BENCHMARK_ORDER = ["myga_live", "myga_arated", "myga_best", "competitor", "ig_corp", "treasury"];

/* Rating buckets, richest covenant first. Mirrors the buckets written by
   scripts/fetch_myga.py — the two lists have to agree or the lookup misses. */
export const RATING_BUCKETS = [
  { key: "aplus", label: "A++ / A+" },
  { key: "a", label: "A" },
  { key: "aminus", label: "A-" },
  { key: "bplus", label: "B++ / B+" },
];
export const SPREAD_STATS = [
  { key: "median_bp", label: "Median", desc: "The typical carrier in the bucket — the honest default." },
  { key: "top_quartile_bp", label: "Top quartile", desc: "What an engaged shopper realistically reaches." },
  { key: "best_bp", label: "Best", desc: "The single best quote on the board. Optimistic: it may not be available in every state or at every premium size." },
];

/**
 * Observed spread (bp) for a rating bucket at an arbitrary term, interpolated
 * across whatever terms the quote board returned. Returns null rather than a
 * guess when the bucket is empty — an absent observation must not silently
 * fall back to a calibration constant, or the UI would claim to be showing
 * live data while showing an assumption.
 */
export function observedSpreadBp(data, bucketKey, years, stat = "median_bp") {
  const terms = bucketKey === "__all__"
    ? data?.overall
    : data?.buckets?.[bucketKey]?.terms;
  if (!terms) return null;
  const pts = Object.entries(terms)
    .map(([t, v]) => [parseFloat(t), v?.[stat], v?.n])
    .filter(([t, v]) => isFinite(t) && v != null && isFinite(v))
    .sort((a, b) => a[0] - b[0]);
  if (!pts.length) return null;
  if (pts.length === 1 || years <= pts[0][0]) return pts[0][1];
  if (years >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    if (years <= x1) return y0 + ((y1 - y0) * (years - x0)) / (x1 - x0);
  }
  return pts[pts.length - 1][1];
}

/** Total quotes behind a bucket, for showing sample size next to the rate. */
export function observedSampleSize(data, bucketKey) {
  const terms = bucketKey === "__all__" ? data?.overall : data?.buckets?.[bucketKey]?.terms;
  if (!terms) return 0;
  return Object.values(terms).reduce((a, v) => a + (v?.n || 0), 0);
}

/**
 * Resolve a benchmark to a reinvestment rate (in %) for a given horizon.
 * Returns { rate, detail } or { rate: null } when the curve is unavailable.
 */
export function benchmarkRate(benchKey, years, { ustTenors, ustYields, igOasBp, spreadOverrideBp, mygaSpreads, mygaBucket = "aplus", mygaStat = "median_bp" } = {}) {
  const b = BENCHMARKS[benchKey];
  if (!b) return { rate: null, detail: "unknown benchmark" };

  if (b.kind === "observed") {
    const base = interpolateCurve(ustTenors, ustYields, years);
    if (base == null) return { rate: null, detail: "UST curve unavailable" };
    const sp = observedSpreadBp(mygaSpreads, mygaBucket, years, mygaStat);
    if (sp == null) {
      return { rate: null, detail: "no observed quotes for this rating and term yet" };
    }
    return {
      rate: base + sp / 100,
      detail: `${years.toFixed(1)}Y UST ${base.toFixed(2)}% + ${sp.toFixed(0)}bp observed`,
    };
  }

  if (b.kind === "ust_blend") {
    const u5 = interpolateCurve(ustTenors, ustYields, 5);
    const u7 = interpolateCurve(ustTenors, ustYields, 7);
    if (u5 == null || u7 == null) return { rate: null, detail: "UST curve unavailable" };
    const blend = 0.5 * u5 + 0.5 * u7;
    return { rate: 1.05 * blend, detail: `105% × (50%×${u5.toFixed(2)} + 50%×${u7.toFixed(2)})` };
  }

  const base = interpolateCurve(ustTenors, ustYields, years);
  if (base == null) return { rate: null, detail: "UST curve unavailable" };

  if (b.kind === "ust_plus_oas") {
    if (igOasBp == null) return { rate: null, detail: "IG OAS unavailable" };
    return { rate: base + igOasBp / 100, detail: `${years.toFixed(1)}Y UST ${base.toFixed(2)}% + IG OAS ${igOasBp}bp` };
  }

  const sp = spreadOverrideBp != null ? spreadOverrideBp : b.spreadBp;
  return {
    rate: base + sp / 100,
    detail: sp === 0 ? `${years.toFixed(1)}Y UST ${base.toFixed(2)}%` : `${years.toFixed(1)}Y UST ${base.toFixed(2)}% + ${sp}bp`,
  };
}

// ── Exit value: surrender charge, MVA, nonforfeiture floor ────────

/**
 * Industry-standard MVA factor.
 *
 *   MVA = [ (1 + i0) / (1 + i1 + k) ] ^ m  −  1
 *
 * i0 = reference index at issue, i1 = reference index now, k = carrier
 * margin (commonly 10–25bp), m = years remaining in the MVA period.
 * Rates up ⇒ i1 > i0 ⇒ factor negative ⇒ exit value reduced. That is the
 * point: the MVA is the carrier's disintermediation defence and it bites
 * hardest in exactly the scenario that makes lapsing look attractive.
 *
 * Rates are passed as percentages (4.5 means 4.5%).
 */
export function mvaFactor({ indexAtIssue, indexNow, marginBp = 10, yearsRemaining }) {
  if (indexAtIssue == null || indexNow == null || yearsRemaining == null) return 0;
  if (yearsRemaining <= 0) return 0;
  const i0 = indexAtIssue / 100;
  const i1 = indexNow / 100 + marginBp / 10000;
  return Math.pow((1 + i0) / (1 + i1), yearsRemaining) - 1;
}

/**
 * Cash surrender value today.
 *
 * Surrender charge and MVA both apply only to the amount above the annual
 * free-withdrawal corridor (the common contract wording, though carriers
 * differ on whether the corridor applies to a FULL surrender — hence the
 * `freeAppliesOnFullSurrender` switch).
 *
 * `mgsv` is the minimum guaranteed surrender value under the Standard
 * Nonforfeiture Law for Individual Deferred Annuities — typically 87.5%
 * of premium accumulated at the nonforfeiture rate. Where supplied it
 * floors the result, which is what stops a large negative MVA from
 * confiscating the contract.
 */
export function cashSurrenderValue({
  accountValue,
  surrenderChargePct = 0,
  freeWithdrawalPct = 0,
  freeAppliesOnFullSurrender = true,
  mvaPct = 0,
  mgsv = null,
}) {
  const av = accountValue;
  const freeFrac = freeAppliesOnFullSurrender ? Math.min(1, Math.max(0, freeWithdrawalPct / 100)) : 0;
  const chargeable = av * (1 - freeFrac);
  const sc = chargeable * (surrenderChargePct / 100);
  const mva = chargeable * (mvaPct / 100);
  let csv = av - sc + mva;
  if (mgsv != null && isFinite(mgsv)) csv = Math.max(csv, mgsv);
  return {
    csv: Math.max(0, csv),
    surrenderCharge: sc,
    mvaAmount: mva,
    freeAmount: av * freeFrac,
    flooredByMgsv: mgsv != null && csv <= mgsv,
  };
}

// ── Tax treatment ─────────────────────────────────────────────────
/*
   qualified  — IRA/qualified money. A transfer is not a taxable event and
                everything is ordinary income on distribution, so the tax
                rate scales both paths identically and cancels out of the
                comparison. Reported after-tax anyway, for honest dollars.

   nq_1035    — Non-qualified, §1035 exchange into a new annuity. No tax
                today, basis carries over, deferral survives. Surrender
                charge still applies. This is the realistic switch route
                and usually the one worth modelling.

   nq_cash    — Non-qualified, full surrender to cash. Gain is ordinary
                income now under LIFO, +10% penalty pre-59½, and the
                reinvestment is then taxed annually — so the reinvestment
                compounds at r × (1 − t), not r. This is the expensive exit
                and the one that keeps deeply OTM contracts persisting.
*/
export const TAX_MODES = {
  qualified: { key: "qualified", label: "Qualified (IRA)", desc: "No tax on transfer; all ordinary income at distribution." },
  nq_1035: { key: "nq_1035", label: "Non-qualified — §1035", desc: "Tax-free exchange into a new annuity. Basis carries over, deferral survives." },
  nq_cash: { key: "nq_cash", label: "Non-qualified — cash out", desc: "Gain taxed now (LIFO) + 10% penalty pre-59½; reinvestment taxed annually." },
};

const PENALTY_RATE = 0.10;
const PENALTY_AGE = 59.5;

/*
   On the 10% penalty (IRC §72(q) non-qualified / §72(t) qualified):

   It is charged ONCE, on a surrender taken TODAY while under 59½ — never at
   the terminal horizon. Reaching the end of a guarantee period does not force
   a distribution: the contract renews or rolls into a new guarantee period,
   and no policyholder voluntarily liquidates into a 10% penalty when waiting
   avoids it. Charging it at the horizon on both paths would penalise holding
   harder than switching (the held contract carries the larger accrued gain),
   which inverts the real economics.

   So the penalty is asymmetric by construction, and that asymmetry IS the
   result: being under 59½ is a lock-in that discourages switching.
*/

/** After-tax terminal wealth of holding to the end of the guarantee. */
function holdTerminal({ accountValue, guaranteedRate, years, basis, taxMode, taxRate }) {
  const pre = accountValue * Math.pow(1 + guaranteedRate / 100, years);
  const t = taxRate / 100;
  if (taxMode === "qualified") return { pre, tax: pre * t, net: pre * (1 - t) };
  const tax = Math.max(0, pre - basis) * t;
  return { pre, tax, net: pre - tax };
}

/** After-tax terminal wealth of surrendering today and reinvesting at `reinvestRate`. */
function switchTerminal({ csv, reinvestRate, years, basis, taxMode, taxRate, currentAge }) {
  const t = taxRate / 100;

  if (taxMode === "qualified") {
    const pre = csv * Math.pow(1 + reinvestRate / 100, years);
    return { pre, taxNow: 0, tax: pre * t, net: pre * (1 - t) };
  }

  if (taxMode === "nq_1035") {
    // No tax today; basis and the deferral both carry over to the new contract.
    const pre = csv * Math.pow(1 + reinvestRate / 100, years);
    const tax = Math.max(0, pre - basis) * t;
    return { pre, taxNow: 0, tax, net: pre - tax };
  }

  // nq_cash: crystallise now, then compound at the after-tax rate.
  const gainNow = Math.max(0, csv - basis);
  const pen = currentAge != null && currentAge < PENALTY_AGE ? PENALTY_RATE : 0;
  const taxNow = gainNow * (t + pen);
  const netNow = csv - taxNow;
  const afterTaxRate = (reinvestRate / 100) * (1 - t);
  const pre = netNow * Math.pow(1 + afterTaxRate, years);
  return { pre, taxNow, tax: taxNow, net: pre };
}

// ── The decision ──────────────────────────────────────────────────

/**
 * Full hold-vs-lapse analysis.
 *
 * Returns nulls-free numbers when inputs are valid; `null` fields where a
 * quantity is undefined (e.g. no break-even horizon exists because holding
 * wins at every horizon).
 */
export function analyseMoneyness(input) {
  const {
    accountValue = 100000,
    basis = 100000,
    guaranteedRate,
    reinvestRate,
    yearsRemaining,
    surrenderChargePct = 0,
    freeWithdrawalPct = 10,
    freeAppliesOnFullSurrender = true,
    mvaEnabled = true,
    mvaIndexAtIssue = null,
    mvaIndexNow = null,
    mvaMarginBp = 10,
    mgsv = null,
    taxMode = "nq_1035",
    taxRate = 24,
    currentAge = 65,
    // The MVA runs over the remaining MVA period, which is NOT always the
    // remaining guarantee period — a contract can reach the end of its
    // surrender/MVA period with years of guarantee still to run. Defaults to
    // the guarantee horizon, which is right for the vanilla MYGA where they
    // coincide.
    mvaYearsOverride = null,
  } = input || {};

  if (guaranteedRate == null || reinvestRate == null || yearsRemaining == null || yearsRemaining <= 0) {
    return null;
  }

  const mvaYears = mvaYearsOverride != null ? Math.min(mvaYearsOverride, yearsRemaining) : yearsRemaining;
  const mvaPct = mvaEnabled
    ? mvaFactor({
        indexAtIssue: mvaIndexAtIssue,
        indexNow: mvaIndexNow,
        marginBp: mvaMarginBp,
        yearsRemaining: mvaYears,
      }) * 100
    : 0;

  const exit = cashSurrenderValue({
    accountValue,
    surrenderChargePct,
    freeWithdrawalPct,
    freeAppliesOnFullSurrender,
    mvaPct,
    mgsv,
  });

  const common = { basis, taxMode, taxRate, currentAge, years: yearsRemaining };
  const hold = holdTerminal({ accountValue, guaranteedRate, ...common });
  const sw = switchTerminal({ csv: exit.csv, reinvestRate, ...common });

  // Headline gap, before any friction.
  const grossGapBp = (guaranteedRate - reinvestRate) * 100;

  // Cost of leaving, as a % of account value.
  const exitCostPct = ((accountValue - exit.csv) / accountValue) * 100;

  // Net advantage of HOLDING, in dollars and annualised basis points.
  const netAdvantage = hold.net - sw.net;
  const netAdvantagePctAv = (netAdvantage / accountValue) * 100;
  const netAdvantageBp =
    hold.net > 0 && sw.net > 0
      ? (Math.pow(hold.net / sw.net, 1 / yearsRemaining) - 1) * 10000
      : null;

  // Break-even reinvestment rate: solve for r where switching ties holding.
  // Solved numerically so it stays correct under every tax mode (the closed
  // form breaks once nq_cash introduces annual taxation of the alternative).
  const breakEvenRate = solve(
    r => switchTerminal({ csv: exit.csv, reinvestRate: r, ...common }).net - hold.net,
    -5,
    60
  );

  // Break-even horizon: how long you must stay invested for switching to
  // overtake holding. Only meaningful when switching is behind today but
  // compounding at a higher rate.
  const breakEvenYears = solve(
    T => {
      if (T <= 0) return -1;
      const h = holdTerminal({ accountValue, guaranteedRate, ...common, years: T });
      const s = switchTerminal({ csv: exit.csv, reinvestRate, ...common, years: T });
      return s.net - h.net;
    },
    0.01,
    60
  );

  // PV of the guarantee's excess over the market alternative, as % of AV.
  // ((1+g)/(1+r))^n − 1 — what the rate guarantee alone is worth, ignoring
  // exit frictions. This is the "option" view rather than the decision view.
  const guaranteeValuePctAv =
    (Math.pow((1 + guaranteedRate / 100) / (1 + reinvestRate / 100), yearsRemaining) - 1) * 100;

  return {
    grossGapBp,
    netAdvantageBp,
    netAdvantage,
    netAdvantagePctAv,
    breakEvenRate,
    breakEvenYears: breakEvenYears != null && breakEvenYears < yearsRemaining * 5 ? breakEvenYears : null,
    guaranteeValuePctAv,
    exitCostPct,
    csv: exit.csv,
    surrenderCharge: exit.surrenderCharge,
    mvaAmount: exit.mvaAmount,
    mvaPct,
    flooredByMgsv: exit.flooredByMgsv,
    hold,
    sw,
    verdict: verdictFor(netAdvantageBp),
  };
}

/**
 * Bisection on a monotone-enough function. Returns null when no sign change
 * exists in [lo, hi] — which is a real answer ("never breaks even"), not a
 * failure, so callers should treat null as "no crossing".
 */
function solve(f, lo, hi, iters = 80) {
  let flo = f(lo), fhi = f(hi);
  if (!isFinite(flo) || !isFinite(fhi)) return null;
  if (flo === 0) return lo;
  if (fhi === 0) return hi;
  if (flo > 0 === fhi > 0) return null;
  let a = lo, b = hi;
  for (let i = 0; i < iters; i++) {
    const m = (a + b) / 2;
    const fm = f(m);
    if (!isFinite(fm)) return null;
    if (fm > 0 === flo > 0) { a = m; flo = fm; } else { b = m; }
  }
  return (a + b) / 2;
}

// ── Verdict bands ─────────────────────────────────────────────────
/*
   Bands are on the NET annualised advantage of holding, not the raw rate
   gap — a contract can show a +100bp rate gap and still be a switch once a
   9% surrender charge is amortised over two remaining years, and the bands
   have to reflect that or they mislead.

   The ±25bp "at the money" dead zone is deliberate: inside it the answer is
   inside the noise of the assumptions (spread calibration, tax rate, the
   carrier's actual MVA formula), and pretending otherwise is false precision.
*/
export const VERDICT_BANDS = [
  { key: "deep_itm", min: 150, label: "Deep in the money", action: "Hold — the guarantee is well above anything you can replace it with." },
  { key: "itm", min: 50, label: "In the money", action: "Hold. Switching costs more than the rate pickup is worth." },
  { key: "atm", min: -25, label: "At the money", action: "Roughly indifferent. Decide on carrier strength, liquidity and term, not rate." },
  { key: "otm", min: -150, label: "Out of the money", action: "Switching is ahead — check the break-even horizon before acting." },
  { key: "deep_otm", min: -Infinity, label: "Deep out of the money", action: "Strong switch candidate. Model a §1035 exchange to keep deferral intact." },
];

export function verdictFor(netAdvantageBp) {
  if (netAdvantageBp == null || !isFinite(netAdvantageBp)) return null;
  return VERDICT_BANDS.find(b => netAdvantageBp >= b.min) || VERDICT_BANDS[VERDICT_BANDS.length - 1];
}

// ── Surrender charge schedules & optimal exit timing ──────────────
/*
   Everything above answers "hold to the guarantee date, or surrender today?".
   That is only two of the available exit dates, and it is provably enough ONLY
   for the vanilla case. With the surrender period equal to the guarantee period
   and a roughly linear decline, terminal wealth in exit year k is

       const + k·[ln(1+g) − ln(1+r)] + ln(1 − SC(k))

   — linear-decreasing plus convex-increasing, so the objective is convex in k
   and its maximum always sits at an endpoint.

   It stops being enough as soon as the schedules stop lining up:
     · surrender period SHORTER than the guarantee period (charge hits zero
       while the below-market rate still has years to run), or
     · a premium bonus whose vesting runs LONGER than the surrender period,
       which public product disclosures show is common.

   In those structures an interior exit year strictly beats BOTH endpoints, so
   the schedule has to be carried explicitly rather than collapsed to a single
   current-year rate.

   Preset schedules below are calibrated to public product documentation:
   surrender charges typically open at 7–10% and decline about 1pp a year over
   6–10 years; MYGAs commonly run 3–7 years and index products 7–10. Under the
   Interstate Insurance Compact's amended uniform standards the separate
   7%/7-year limit for non-MYGA MVA products was removed, leaving roughly 10%
   grading down over 10 years as the effective ceiling.

   schedule[k] = surrender charge % applying to an exit at year k, so a 7-year
   contract carries 8 entries and the last one is 0.
*/
export const SC_SCHEDULE_PRESETS = {
  myga3: { key: "myga3", label: "MYGA 3-year", schedule: [8, 7, 6, 0] },
  myga5: { key: "myga5", label: "MYGA 5-year", schedule: [8, 7, 6, 5, 4, 0] },
  myga7: { key: "myga7", label: "MYGA 7-year", schedule: [8, 7, 6, 5, 4, 3, 2, 0] },
  myga10: { key: "myga10", label: "MYGA 10-year", schedule: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0] },
  fia10: { key: "fia10", label: "FIA 10-year", schedule: [10, 10, 9, 8, 7, 6, 5, 4, 3, 2, 0] },
  none: { key: "none", label: "No surrender charge", schedule: [0] },
};

/** "8,7,6,5,4,3,2,0" → [8,7,6,5,4,3,2,0]. Junk entries are dropped. */
export function parseSchedule(str) {
  if (Array.isArray(str)) return str.filter(v => v != null && isFinite(v));
  if (typeof str !== "string") return [];
  return str.split(/[,\s]+/).map(s => parseFloat(s)).filter(v => isFinite(v));
}

/**
 * Charge applying to an exit at `year`. Surrender charges step by contract
 * year rather than accruing continuously, so a part-year exit carries the
 * charge for the year it falls in — hence the floor rather than interpolation.
 * Past the end of the schedule the charge is zero, not the last entry.
 */
export function scheduleAt(schedule, year) {
  if (!schedule?.length) return 0;
  const k = Math.floor(Math.max(0, year));
  return k >= schedule.length ? 0 : schedule[k];
}

/**
 * The year the surrender charge actually expires — the first zero entry, not
 * the array length, since schedules are commonly zero-padded out to the
 * guarantee date. This is also the natural MVA period: the adjustment runs
 * with the charge and dies with it.
 */
export function surrenderPeriodYears(schedule) {
  if (!schedule?.length) return 0;
  const i = schedule.findIndex(v => !v);
  return i === -1 ? schedule.length : i;
}

/**
 * Premium-bonus vesting. Public disclosures describe bonuses vesting on their
 * own schedule — commonly ~10% a year from year two to 100% by year ten — and
 * that schedule may run LONGER than the surrender period, so the unvested
 * portion is clawed back on exit independently of the surrender charge.
 * Returns the fraction of the bonus RECAPTURED (1 = fully forfeited).
 */
export function bonusRecapturedFraction(vestingSchedule, year) {
  if (!vestingSchedule?.length) return 0;
  const k = Math.floor(Math.max(0, year));
  const vested = k >= vestingSchedule.length ? 100 : vestingSchedule[k];
  return Math.max(0, Math.min(1, 1 - vested / 100));
}

/** Standard 10-year bonus vesting: nothing until year 2, then 10pp a year. */
export const DEFAULT_VESTING = [0, 0, 10, 20, 30, 40, 50, 60, 70, 80, 100];

/**
 * After-tax terminal wealth at the guarantee date, for an exit taken at each
 * whole year from today through the guarantee date.
 *
 * IMPORTANT — this holds TODAY'S curve constant. Reinvestment and MVA at a
 * future exit are read off the current curve at the term then remaining, i.e.
 * a "rates unchanged" scenario, not a forward-implied or stochastic one. That
 * is the right default for a decision-support view (it isolates the effect of
 * the charge schedule from a rate view), but it is an assumption, and a real
 * rate path would move the answer.
 */
export function exitYearAnalysis({
  accountValue = 100000,
  basis = 100000,
  guaranteedRate,
  yearsRemaining,
  schedule = [],
  freeWithdrawalPct = 10,
  freeAppliesOnFullSurrender = true,
  mvaEnabled = true,
  mvaIndexAtIssue = null,
  mvaMarginBp = 10,
  mgsv = null,
  taxMode = "nq_1035",
  taxRate = 24,
  currentAge = 65,
  bonusPct = 0,
  vestingSchedule = null,
  // Length of the MVA period, in years from today. In real contracts the MVA
  // runs with the surrender-charge period and dies with it — once the charge
  // expires there is nothing left to adjust — so it defaults to the schedule's
  // length rather than to the remaining guarantee. Getting this wrong keeps a
  // large negative MVA alive to the guarantee date and silently suppresses any
  // interior exit optimum.
  mvaPeriodYears = null,
  rateAtTerm,
  ustAtTerm,
}) {
  if (guaranteedRate == null || yearsRemaining == null || yearsRemaining <= 0) return null;
  if (typeof rateAtTerm !== "function") return null;

  const t = taxRate / 100;
  const rows = [];
  const lastK = Math.floor(yearsRemaining + 1e-9);
  const mvaPeriod = mvaPeriodYears != null ? mvaPeriodYears : surrenderPeriodYears(schedule);

  for (let k = 0; k <= lastK; k++) {
    const m = yearsRemaining - k;            // years still to run after exiting
    if (m < -1e-9) break;

    const avK = accountValue * Math.pow(1 + guaranteedRate / 100, k);
    const scPct = scheduleAt(schedule, k);

    // Unvested premium bonus is clawed back on exit, on its own schedule.
    const recapFrac = bonusPct > 0 ? bonusRecapturedFraction(vestingSchedule, k) : 0;
    const recaptureAmt = avK * (bonusPct / 100) * recapFrac;

    // The MVA bites over whatever is left of the MVA period, capped by the
    // time still to run — never beyond the point the adjustment expires.
    const mvaYears = Math.max(0, Math.min(m, mvaPeriod - k));
    const idxNow = typeof ustAtTerm === "function" ? ustAtTerm(Math.max(0.25, mvaYears || m)) : null;
    const mvaPct = mvaEnabled && mvaYears > 0
      ? mvaFactor({ indexAtIssue: mvaIndexAtIssue, indexNow: idxNow, marginBp: mvaMarginBp, yearsRemaining: mvaYears }) * 100
      : 0;

    const exit = cashSurrenderValue({
      accountValue: avK - recaptureAmt,
      surrenderChargePct: scPct,
      freeWithdrawalPct,
      freeAppliesOnFullSurrender,
      mvaPct,
      mgsv,
    });

    const r = m > 0 ? rateAtTerm(m) : 0;
    let pre, net, taxNow = 0;

    if (m <= 0) {
      // Reached the guarantee date: nothing left to reinvest. This row IS the
      // hold-to-maturity path, so the two comparisons share one code path.
      pre = exit.csv;
      net = taxMode === "qualified" ? pre * (1 - t) : pre - Math.max(0, pre - basis) * t;
    } else if (taxMode === "qualified") {
      pre = exit.csv * Math.pow(1 + r / 100, m);
      net = pre * (1 - t);
    } else if (taxMode === "nq_1035") {
      pre = exit.csv * Math.pow(1 + r / 100, m);
      net = pre - Math.max(0, pre - basis) * t;
    } else {
      const pen = currentAge != null && currentAge + k < PENALTY_AGE ? PENALTY_RATE : 0;
      taxNow = Math.max(0, exit.csv - basis) * (t + pen);
      pre = (exit.csv - taxNow) * Math.pow(1 + (r / 100) * (1 - t), m);
      net = pre;
    }

    rows.push({
      year: k, yearsToRun: m, avAtExit: avK, scPct, mvaYears,
      recapturePct: bonusPct * recapFrac, recaptureAmt,
      mvaPct, csv: exit.csv, reinvestRate: m > 0 ? r : null,
      taxNow, terminal: net,
    });
  }

  if (!rows.length) return null;
  const best = rows.reduce((a, b) => (b.terminal > a.terminal ? b : a));
  const now = rows[0], hold = rows[rows.length - 1];
  const interior = best.year > now.year && best.year < hold.year;

  return {
    rows,
    best,
    surrenderNow: now,
    holdToMaturity: hold,
    // The finding that motivates carrying the schedule at all: waiting beats
    // both acting today and holding to the guarantee date.
    interiorOptimum: interior,
    gainOverBestEndpoint: best.terminal - Math.max(now.terminal, hold.terminal),
  };
}

// ── Dynamic lapse ─────────────────────────────────────────────────
/*
   The block-level consequence of all of the above.

   Form follows the Milliman FIA/MYGA lapse survey's description of market
   practice: an ADDITIVE adjustment to the base lapse rate, ONE-SIDED
   (excess lapse when the competitor rate exceeds the credited rate; no
   negative adjustment when the contract is in the money), dampened by the
   surrender charge, and CAPPED — every surveyed participant applies limits.

     excess = min( cap , max(0, sens × (rComp − g − threshold)) × (1 − scPct/scDamp) )

   sens is percentage points of extra lapse per 1pp of rate disadvantage.
   Defaults sit mid-range of what the survey describes rather than any one
   company's calibration — they are a starting point for a sensitivity, not
   a substitute for a company's own experience study.
*/
export const DYNAMIC_LAPSE_DEFAULTS = {
  baseLapsePct: 5,
  sensitivity: 8,     // pp of excess lapse per 1pp of (competitor − credited)
  thresholdPp: 0.25,  // dead zone before policyholders react at all
  capPp: 35,          // ceiling on the dynamic add-on
  scDampPp: 10,       // SC level at which the dynamic response is fully suppressed
};

export function dynamicLapse({
  competitorRate,
  creditedRate,
  surrenderChargePct = 0,
  baseLapsePct = DYNAMIC_LAPSE_DEFAULTS.baseLapsePct,
  sensitivity = DYNAMIC_LAPSE_DEFAULTS.sensitivity,
  thresholdPp = DYNAMIC_LAPSE_DEFAULTS.thresholdPp,
  capPp = DYNAMIC_LAPSE_DEFAULTS.capPp,
  scDampPp = DYNAMIC_LAPSE_DEFAULTS.scDampPp,
}) {
  if (competitorRate == null || creditedRate == null) return null;
  const gap = competitorRate - creditedRate;
  const raw = Math.max(0, sensitivity * (gap - thresholdPp));
  const damp = scDampPp > 0 ? Math.max(0, 1 - surrenderChargePct / scDampPp) : 1;
  const excess = Math.min(capPp, raw * damp);
  return { gap, excess, total: baseLapsePct + excess, base: baseLapsePct };
}

// ── Block view: moneyness across a grid of vintages ───────────────

/**
 * Surrender charge assumed at a given remaining term, for the grid only.
 * A MYGA written on a 9%-declining schedule sits at roughly `n`% with `n`
 * years left to run, so SC% = min(scStart, n) is the right shape. Contract
 * specifics belong in the calculator, not the grid.
 */
export function gridSurrenderCharge(yearsRemaining, scStartPct = 9) {
  return Math.min(scStartPct, Math.max(0, yearsRemaining));
}

/**
 * Net advantage (annualised bp of holding) over a grid of guaranteed rates
 * × remaining terms — the block-exposure view. Every cell reuses the same
 * contract assumptions so the surface is comparable across it.
 */
export function moneynessGrid({
  guaranteedRates,
  terms,
  benchKey,
  ustTenors,
  ustYields,
  igOasBp,
  spreadOverrideBp,
  scStartPct = 9,
  ...contract
}) {
  return guaranteedRates.map(g =>
    terms.map(n => {
      const { rate } = benchmarkRate(benchKey, n, { ustTenors, ustYields, igOasBp, spreadOverrideBp });
      if (rate == null) return { g, n, rate: null, netAdvantageBp: null };
      const scPct = gridSurrenderCharge(n, scStartPct);
      // Each cell is a different vintage, so it needs its own MVA reference
      // point. The guaranteed rate is the best available proxy for the rate
      // environment the contract was written into — a 3% guarantee was sold
      // when money was cheap — which keeps the surface internally consistent
      // instead of pinning every vintage to one contract's issue index.
      //
      // The CURRENT index is the matched-maturity Treasury, not the benchmark
      // reinvestment rate: both legs of the MVA ratio must sit on the same
      // basis, or the benchmark's credit spread gets counted as rate movement
      // and the MVA hit is overstated by that spread.
      const res = analyseMoneyness({
        ...contract,
        guaranteedRate: g,
        reinvestRate: rate,
        yearsRemaining: n,
        surrenderChargePct: scPct,
        mvaIndexAtIssue: g,
        mvaIndexNow: interpolateCurve(ustTenors, ustYields, n),
      });
      return {
        g,
        n,
        rate,
        scPct,
        netAdvantageBp: res?.netAdvantageBp ?? null,
        grossGapBp: res?.grossGapBp ?? null,
      };
    })
  );
}

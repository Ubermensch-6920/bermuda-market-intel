/* Sanity checks for the annuity in-the-money engine.
   Run: node scripts/test_annuity_moneyness.mjs                       */

import {
  interpolateCurve, tenorToYears, mvaFactor, cashSurrenderValue,
  analyseMoneyness, dynamicLapse, benchmarkRate, verdictFor,
} from "../src/annuityMoneyness.js";

let pass = 0, fail = 0;
const near = (a, b, tol = 1e-6) => a != null && b != null && Math.abs(a - b) <= tol;
function check(name, cond, got, want) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         got  ${got}\n         want ${want}`); }
}

const UST_T = ["1M", "3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"];
const UST_Y = [3.80, 3.96, 4.08, 4.14, 4.33, 4.36, 4.43, 4.55, 4.69, 4.935, 5.18, 5.16];

console.log("\ntenor parsing & interpolation");
check("6M → 0.5", near(tenorToYears("6M"), 0.5), tenorToYears("6M"), 0.5);
check("10Y → 10", near(tenorToYears("10Y"), 10), tenorToYears("10Y"), 10);
check("junk → null", tenorToYears("abc") === null, tenorToYears("abc"), null);
check("exact node 5Y", near(interpolateCurve(UST_T, UST_Y, 5), 4.43), interpolateCurve(UST_T, UST_Y, 5), 4.43);
check("midpoint 6Y = 4.49", near(interpolateCurve(UST_T, UST_Y, 6), 4.49, 1e-9), interpolateCurve(UST_T, UST_Y, 6), 4.49);
check("flat extrapolation past 30Y", near(interpolateCurve(UST_T, UST_Y, 40), 5.16), interpolateCurve(UST_T, UST_Y, 40), 5.16);
check(
  "nulls skipped, not zeroed",
  near(interpolateCurve(["1Y", "2Y", "3Y"], [null, 4.0, 5.0], 2), 4.0),
  interpolateCurve(["1Y", "2Y", "3Y"], [null, 4.0, 5.0], 2), 4.0
);

console.log("\nbenchmarks");
{
  const t = benchmarkRate("treasury", 5, { ustTenors: UST_T, ustYields: UST_Y });
  check("treasury 5Y = UST 5Y", near(t.rate, 4.43), t.rate, 4.43);
  const a = benchmarkRate("myga_arated", 5, { ustTenors: UST_T, ustYields: UST_Y });
  check("A-rated MYGA 5Y = UST + 90bp", near(a.rate, 5.33, 1e-9), a.rate, 5.33);
  const c = benchmarkRate("competitor", 5, { ustTenors: UST_T, ustYields: UST_Y });
  // 105% × (50%×4.43 + 50%×4.55) = 1.05 × 4.49 = 4.7145
  check("competitor blend", near(c.rate, 4.7145, 1e-9), c.rate, 4.7145);
  const ig = benchmarkRate("ig_corp", 5, { ustTenors: UST_T, ustYields: UST_Y, igOasBp: 79 });
  check("IG corp = UST + OAS", near(ig.rate, 5.22, 1e-9), ig.rate, 5.22);
  const bad = benchmarkRate("ig_corp", 5, { ustTenors: UST_T, ustYields: UST_Y, igOasBp: null });
  check("IG corp null OAS → null rate", bad.rate === null, bad.rate, null);
}

console.log("\nMVA");
{
  const up = mvaFactor({ indexAtIssue: 2.0, indexNow: 4.5, marginBp: 10, yearsRemaining: 5 });
  check("rates up ⇒ negative MVA", up < 0, up, "< 0");
  const dn = mvaFactor({ indexAtIssue: 4.5, indexNow: 2.0, marginBp: 10, yearsRemaining: 5 });
  check("rates down ⇒ positive MVA", dn > 0, dn, "> 0");
  // (1.02/1.046)^5 − 1
  const want = Math.pow(1.02 / 1.046, 5) - 1;
  check("closed form matches", near(up, want, 1e-12), up, want);
  check("zero years ⇒ no MVA", mvaFactor({ indexAtIssue: 2, indexNow: 9, yearsRemaining: 0 }) === 0, "—", 0);
}

console.log("\ncash surrender value");
{
  // 9% SC on the 90% that sits outside the free corridor ⇒ 8.1% cost.
  const r = cashSurrenderValue({ accountValue: 100000, surrenderChargePct: 9, freeWithdrawalPct: 10 });
  check("SC applies only above the free corridor", near(r.csv, 91900, 1e-6), r.csv, 91900);
  const noFree = cashSurrenderValue({ accountValue: 100000, surrenderChargePct: 9, freeWithdrawalPct: 10, freeAppliesOnFullSurrender: false });
  check("corridor switched off ⇒ full 9%", near(noFree.csv, 91000, 1e-6), noFree.csv, 91000);
  const floored = cashSurrenderValue({ accountValue: 100000, surrenderChargePct: 9, freeWithdrawalPct: 10, mvaPct: -20, mgsv: 88000 });
  check("nonforfeiture floor binds", near(floored.csv, 88000) && floored.flooredByMgsv, floored.csv, 88000);
}

console.log("\nhold vs switch");
{
  const base = {
    accountValue: 100000, basis: 100000, yearsRemaining: 5,
    surrenderChargePct: 9, freeWithdrawalPct: 10, mvaEnabled: false,
    taxMode: "qualified", taxRate: 24, currentAge: 65,
  };

  // Break-even: CSV = 91,900. Need (1.03^5 × 100000 / 91900)^(1/5) − 1.
  const r = analyseMoneyness({ ...base, guaranteedRate: 3, reinvestRate: 4 });
  const wantBE = (Math.pow((Math.pow(1.03, 5) * 100000) / 91900, 1 / 5) - 1) * 100;
  check("break-even reinvestment rate", near(r.breakEvenRate, wantBE, 1e-6), r.breakEvenRate, wantBE);
  check("break-even ≈ 4.755%", near(r.breakEvenRate, 4.7548, 1e-3), r.breakEvenRate, "≈4.7548");
  check(
    "market 4% < break-even 4.77% ⇒ holding wins despite negative rate gap",
    r.grossGapBp < 0 && r.netAdvantageBp > 0,
    `gap ${r.grossGapBp.toFixed(0)}bp, net ${r.netAdvantageBp.toFixed(0)}bp`,
    "gap < 0, net > 0"
  );

  // Tie exactly at the break-even rate.
  const tie = analyseMoneyness({ ...base, guaranteedRate: 3, reinvestRate: wantBE });
  check("at break-even, net advantage ≈ 0", Math.abs(tie.netAdvantageBp) < 1e-3, tie.netAdvantageBp, 0);

  // Clear the charge by enough and switching wins.
  const win = analyseMoneyness({ ...base, guaranteedRate: 3, reinvestRate: 6.5 });
  check("big enough pickup ⇒ switching wins", win.netAdvantageBp < 0, win.netAdvantageBp, "< 0");
  check("verdict is OTM", win.verdict.key === "otm" || win.verdict.key === "deep_otm", win.verdict.key, "otm|deep_otm");

  // No frictions at all ⇒ the decision collapses to the raw rate gap.
  const clean = analyseMoneyness({
    ...base, surrenderChargePct: 0, freeWithdrawalPct: 0,
    guaranteedRate: 5, reinvestRate: 4,
  });
  // With no frictions the two measures differ only by compounding: grossGapBp is
  // the ARITHMETIC rate difference (g − r), netAdvantageBp is the GEOMETRIC
  // annualised excess of terminal wealth, (1+g)/(1+r) − 1. At g=5, r=4 that is
  // 100bp vs 96.15bp. Both are right; the geometric one is what the bands use,
  // because it is the measure that actually compares terminal wealth.
  const wantNet = ((1.05 / 1.04) - 1) * 10000;
  check("frictionless: net advantage = geometric gap", near(clean.netAdvantageBp, wantNet, 1e-6), clean.netAdvantageBp, wantNet);
  check("frictionless: gross gap is the arithmetic difference", near(clean.grossGapBp, 100, 1e-9), clean.grossGapBp, 100);
  check("geometric gap sits just inside the arithmetic one", clean.netAdvantageBp < clean.grossGapBp && clean.netAdvantageBp > clean.grossGapBp - 10, clean.netAdvantageBp, "just below 100");
  check("frictionless: break-even = guaranteed rate", near(clean.breakEvenRate, 5, 1e-6), clean.breakEvenRate, 5);
  check("frictionless: exit cost = 0", near(clean.exitCostPct, 0, 1e-9), clean.exitCostPct, 0);

  // Guarantee value: ((1.05/1.04)^5 − 1) × 100
  const wantGV = (Math.pow(1.05 / 1.04, 5) - 1) * 100;
  check("guarantee PV as % of AV", near(clean.guaranteeValuePctAv, wantGV, 1e-9), clean.guaranteeValuePctAv, wantGV);

  // Break-even horizon: switching behind today, ahead eventually.
  const bh = analyseMoneyness({ ...base, guaranteedRate: 3, reinvestRate: 5.5, yearsRemaining: 20 });
  check("break-even horizon exists and is positive", bh.breakEvenYears > 0, bh.breakEvenYears, "> 0");
  const never = analyseMoneyness({ ...base, guaranteedRate: 6, reinvestRate: 3 });
  check("guarantee above market at every horizon ⇒ no crossing", never.breakEvenYears === null, never.breakEvenYears, null);
}

console.log("\ntax modes");
{
  const base = {
    accountValue: 100000, basis: 60000, guaranteedRate: 3, reinvestRate: 6,
    yearsRemaining: 5, surrenderChargePct: 5, freeWithdrawalPct: 10,
    mvaEnabled: false, taxRate: 32,
  };
  const q = analyseMoneyness({ ...base, taxMode: "qualified", currentAge: 65 });
  const x = analyseMoneyness({ ...base, taxMode: "nq_1035", currentAge: 65 });
  const c = analyseMoneyness({ ...base, taxMode: "nq_cash", currentAge: 65 });
  check(
    "cash-out is the worst switch route (tax drag + annual taxation)",
    c.netAdvantageBp > x.netAdvantageBp,
    `cash ${c.netAdvantageBp.toFixed(0)} vs 1035 ${x.netAdvantageBp.toFixed(0)}`,
    "cash-out favours holding more"
  );
  check("qualified tax scales both paths ⇒ same decision as pre-tax", near(q.netAdvantageBp, x.netAdvantageBp, 60), q.netAdvantageBp, x.netAdvantageBp);

  const young = analyseMoneyness({ ...base, taxMode: "nq_cash", currentAge: 50 });
  const old = analyseMoneyness({ ...base, taxMode: "nq_cash", currentAge: 65 });
  check("10% penalty pre-59½ pushes further toward holding", young.netAdvantageBp > old.netAdvantageBp, `${young.netAdvantageBp.toFixed(0)} vs ${old.netAdvantageBp.toFixed(0)}`, "young > old");
}

console.log("\nMVA in the decision");
{
  const base = {
    accountValue: 100000, basis: 100000, guaranteedRate: 3, reinvestRate: 6,
    yearsRemaining: 5, surrenderChargePct: 5, freeWithdrawalPct: 10,
    taxMode: "qualified", taxRate: 24, currentAge: 65,
    mvaIndexAtIssue: 2.0, mvaIndexNow: 6.0, mvaMarginBp: 10,
  };
  const off = analyseMoneyness({ ...base, mvaEnabled: false });
  const on = analyseMoneyness({ ...base, mvaEnabled: true });
  check("MVA is negative when rates have risen", on.mvaPct < 0, on.mvaPct, "< 0");
  check("negative MVA raises the bar for switching", on.breakEvenRate > off.breakEvenRate, `${on.breakEvenRate.toFixed(2)} vs ${off.breakEvenRate.toFixed(2)}`, "on > off");
  check("negative MVA cuts the exit value", on.csv < off.csv, on.csv, "< " + off.csv);
}

console.log("\nverdict bands");
{
  check("+300bp ⇒ deep ITM", verdictFor(300).key === "deep_itm", verdictFor(300).key, "deep_itm");
  check("+80bp ⇒ ITM", verdictFor(80).key === "itm", verdictFor(80).key, "itm");
  check("0bp ⇒ ATM", verdictFor(0).key === "atm", verdictFor(0).key, "atm");
  check("−80bp ⇒ OTM", verdictFor(-80).key === "otm", verdictFor(-80).key, "otm");
  check("−400bp ⇒ deep OTM", verdictFor(-400).key === "deep_otm", verdictFor(-400).key, "deep_otm");
  check("null in ⇒ null out", verdictFor(null) === null, verdictFor(null), null);
}

console.log("\ndynamic lapse");
{
  const itm = dynamicLapse({ competitorRate: 3.0, creditedRate: 5.0, surrenderChargePct: 0 });
  check("one-sided: no negative adjustment when ITM", itm.excess === 0, itm.excess, 0);
  const otm = dynamicLapse({ competitorRate: 6.0, creditedRate: 3.0, surrenderChargePct: 0 });
  // 8 × (3 − 0.25) = 22 pp, under the 35pp cap
  check("excess lapse = sens × (gap − threshold)", near(otm.excess, 22, 1e-9), otm.excess, 22);
  check("total = base + excess", near(otm.total, 27, 1e-9), otm.total, 27);
  const capped = dynamicLapse({ competitorRate: 12, creditedRate: 3, surrenderChargePct: 0 });
  check("cap binds", near(capped.excess, 35), capped.excess, 35);
  const damped = dynamicLapse({ competitorRate: 6.0, creditedRate: 3.0, surrenderChargePct: 5 });
  check("surrender charge damps the response", damped.excess < otm.excess && damped.excess > 0, damped.excess, "between 0 and " + otm.excess);
  const fully = dynamicLapse({ competitorRate: 6.0, creditedRate: 3.0, surrenderChargePct: 10 });
  check("full SC fully suppresses the dynamic add-on", fully.excess === 0, fully.excess, 0);
  const dead = dynamicLapse({ competitorRate: 3.1, creditedRate: 3.0, surrenderChargePct: 0 });
  check("threshold dead zone holds", dead.excess === 0, dead.excess, 0);
}

console.log("\nguards");
{
  check("zero remaining term ⇒ null", analyseMoneyness({ guaranteedRate: 3, reinvestRate: 4, yearsRemaining: 0 }) === null, "—", null);
  check("missing rate ⇒ null", analyseMoneyness({ guaranteedRate: null, reinvestRate: 4, yearsRemaining: 5 }) === null, "—", null);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

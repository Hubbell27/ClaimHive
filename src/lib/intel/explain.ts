/**
 * Plain-English explanations for rules, always with the evidence behind them:
 * "BlueHarbor Dental denies D2740 (Ceramic crown) 73% of the time without an X-ray
 *  (n=41 procedures, 11 practices), vs 0% with one."
 */
import { CARC, CDT_BY_CODE, RARC, type Attachment } from "../reference/codes";
import type { Rule, GroupStats } from "./engine";

const ATT: Record<Attachment, { a: string; one: string }> = {
  xray: { a: "an X-ray", one: "an X-ray" },
  narrative: { a: "a narrative", one: "a narrative" },
  perio_chart: { a: "a periodontal chart", one: "a periodontal chart" },
  photo: { a: "a photo", one: "a photo" },
};
const PLAN: Record<string, string> = { PPO: "PPO", DHMO: "DHMO", INDEMNITY: "indemnity", MEDICAID: "Medicaid", MEDICARE_ADVANTAGE: "Medicare Advantage" };

export const pct = (x: number) => `${Math.round(x * 100)}%`;
export const range = (g: { lo: number; hi: number }) => `${Math.round(g.lo * 100)}–${Math.round(g.hi * 100)}%`;
const n = (g: GroupStats) => `n=${g.n.toLocaleString("en-US")} procedures, ${g.practices} practices`;

export function procedureName(cdt: string): string {
  const label = CDT_BY_CODE.get(cdt)?.label;
  return label ? `${cdt} (${label.charAt(0).toLowerCase()}${label.slice(1)})` : cdt;
}

export interface RuleText {
  title: string;       // short: "Ceramic crowns need an X-ray"
  headline: string;    // the finding with numbers
  evidence: string;    // sample sizes and ranges
  why?: string;        // usual denial reason
  fix: string;         // what to do before sending
  appeal?: string;     // what wins on appeal (only when there's enough data)
}

export function explainRule(r: Rule): RuleText {
  const s = r.stats;
  const who = `${r.payer}${r.planType ? ` (${PLAN[r.planType] ?? r.planType} plans)` : ""}`;
  const proc = procedureName(r.cdt);
  const label = CDT_BY_CODE.get(r.cdt)?.label ?? r.cdt;
  const reasonCode = s.topCarc?.split("-")[1];
  const why = reasonCode
    ? `Usual reason: ${reasonCode} (${CARC.find((c) => c.code === reasonCode)?.label.toLowerCase() ?? "see code"})${s.topRarc ? `, remark ${s.topRarc}${RARC.find((x) => x.code === s.topRarc) ? ` (${RARC.find((x) => x.code === s.topRarc)!.label.toLowerCase()})` : ""}` : ""}.`
    : undefined;
  const ev = (label2: string, g: GroupStats) => `${label2}: ${pct(g.rate)} denied (95% range ${range(g)}; ${n(g)})`;
  let t: RuleText;
  switch (r.kind) {
    case "missing_attachment": {
      const a = ATT[s.condition.attachment!];
      t = {
        title: `${label}: send ${a.a}`,
        headline: `${who} denies ${proc} ${pct(s.cond.rate)} of the time without ${a.a}, vs ${pct(s.base!.rate)} with ${a.one}.`,
        evidence: `${ev(`Without ${a.a}`, s.cond)}. ${ev(`With ${a.one}`, s.base!)}.`,
        fix: `Attach ${a.a} before sending.`,
      };
      break;
    }
    case "billed_with": {
      const w = procedureName(s.condition.withCdt!);
      t = {
        title: `${label} billed with ${s.condition.withCdt}`,
        headline: `${who} denies ${proc} ${pct(s.cond.rate)} of the time when it's billed with ${w}, vs ${pct(s.base!.rate)} otherwise.`,
        evidence: `${ev(`Billed together`, s.cond)}. ${ev("Billed without it", s.base!)}.`,
        fix: `Check whether ${r.cdt} is bundled into ${s.condition.withCdt} for this plan. If it's a separate service, send a narrative that documents why.`,
      };
      break;
    }
    case "frequency": {
      const nth = s.condition.freqAtLeast === 3 ? "the third (or later) time in 12 months" : "the second time in 12 months";
      t = {
        title: `${label}: frequency limit`,
        headline: `${who} denies ${proc} ${pct(s.cond.rate)} of the time when it's ${nth} for the same patient, vs ${pct(s.base!.rate)} otherwise.`,
        evidence: `${ev(s.condition.freqAtLeast === 3 ? "3rd or later" : "2nd", s.cond)}. ${ev("Earlier ones", s.base!)}.`,
        fix: `Check the patient's history and benefits before sending. Consider a different code, a medical-necessity narrative, or asking the patient to pay.`,
      };
      break;
    }
    case "usually_denied":
      t = {
        title: `${label}: usually denied`,
        headline: `${who} denies ${proc} ${pct(s.cond.rate)} of the time.`,
        evidence: `${ev("All claims", s.cond)}.`,
        fix: `Verify coverage before treatment and discuss cost with the patient.`,
      };
      break;
  }
  t.why = why;
  const ap = s.appeal;
  if (ap.withFix && ap.withoutFix) {
    t.appeal = `Appeals that ${ap.fix} won ${pct(ap.withFix.rate)} (${ap.withFix.n} appeals, ${ap.withFix.practices} practices) vs ${pct(ap.withoutFix.rate)} without (${ap.withoutFix.n} appeals).`;
  } else if (ap.withFix) {
    t.appeal = `Appeals that ${ap.fix} won ${pct(ap.withFix.rate)} (${ap.withFix.n} appeals, ${ap.withFix.practices} practices).`;
  } else if (ap.withoutFix) {
    t.appeal = `Appeals without that fix won ${pct(ap.withoutFix.rate)} (${ap.withoutFix.n} appeals, ${ap.withoutFix.practices} practices).`;
  }
  return t;
}

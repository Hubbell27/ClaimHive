/**
 * Basic pre-submission checks: no pool data needed, so every practice gets them.
 * Probabilities here are deliberately rough and labelled as such in the text;
 * pooled rules (for practices that share) carry measured rates instead.
 */
import { CDT_BY_CODE } from "../reference/codes";

/** Typical plan frequency limits (varies by plan: the text always says "check the patient's benefits"). */
export const TYPICAL_LIMITS: Record<string, { max: number; months: number }> = {
  D0120: { max: 2, months: 12 },
  D0150: { max: 1, months: 36 },
  D0210: { max: 1, months: 36 },
  D0274: { max: 1, months: 12 },
  D0330: { max: 1, months: 36 },
  D1110: { max: 2, months: 12 },
  D1120: { max: 2, months: 12 },
  D1206: { max: 2, months: 12 },
  D4910: { max: 4, months: 12 },
};

/** Many plans deny claims filed more than 12 months after the date of service (CARC 29). */
export const FILING_LIMIT_DAYS = 365;
export const FILING_WARN_DAYS = 300;

export interface BasicLine { id: string; cdtCode: string; tooth: string | null; surfaces: string | null; feeCents: number }
export interface HistoryItem { claimId: string; serviceDate: Date; cdtCode: string; tooth: string | null; status: string }

export interface BasicFinding {
  lineId: string;
  kind: "missing_tooth" | "missing_surface" | "duplicate" | "timely_filing" | "frequency";
  fixType: "data" | "verify" | "code";
  probability: number;
  title: string;
  detail: string;
  fix: string;
}

const DAY = 86_400_000;
const label = (cdt: string) => CDT_BY_CODE.get(cdt)?.label ?? cdt;

export function basicChecks(
  claim: { id: string; serviceDate: Date; lines: BasicLine[] },
  history: HistoryItem[], // this patient's other claims (any status except draft), any date
  now = new Date(),
): BasicFinding[] {
  const out: BasicFinding[] = [];
  const ageDays = Math.floor((now.getTime() - claim.serviceDate.getTime()) / DAY);
  for (const l of claim.lines) {
    const ref = CDT_BY_CODE.get(l.cdtCode);
    if (ref?.tooth && !l.tooth) {
      out.push({ lineId: l.id, kind: "missing_tooth", fixType: "data", probability: 0.9,
        title: `${l.cdtCode} needs a tooth number`, detail: `${label(l.cdtCode)} is billed per tooth; claims without one are usually rejected.`,
        fix: "Add the tooth number." });
    }
    if (ref?.surfaces && !l.surfaces) {
      out.push({ lineId: l.id, kind: "missing_surface", fixType: "data", probability: 0.9,
        title: `${l.cdtCode} needs the surfaces`, detail: `${label(l.cdtCode)} is billed by surface; claims without them are usually rejected.`,
        fix: "Add the surfaces (M, O, D, B, L...)." });
    }
    const dup = history.find((h) => h.claimId !== claim.id && h.cdtCode === l.cdtCode
      && h.serviceDate.getTime() === claim.serviceDate.getTime() && (!h.tooth || !l.tooth || h.tooth === l.tooth));
    if (dup) {
      out.push({ lineId: l.id, kind: "duplicate", fixType: "verify", probability: 0.9,
        title: `${l.cdtCode} was already billed for this date`,
        detail: `The same procedure${l.tooth ? ` on tooth ${l.tooth}` : ""} for this patient and date of service is on another claim (${dup.status}). Duplicates are denied (reason 18).`,
        fix: "Don't send it twice. If it's a correction, send it as a corrected claim instead." });
    }
    const limit = TYPICAL_LIMITS[l.cdtCode];
    if (limit) {
      const since = claim.serviceDate.getTime() - limit.months * 30.44 * DAY;
      const prior = history.filter((h) => h.claimId !== claim.id && h.cdtCode === l.cdtCode
        && h.serviceDate.getTime() >= since && h.serviceDate.getTime() < claim.serviceDate.getTime() && h.status !== "denied").length;
      if (prior >= limit.max) {
        out.push({ lineId: l.id, kind: "frequency", fixType: "verify", probability: 0.6,
          title: `${label(l.cdtCode)}: may be over the frequency limit`,
          detail: `This would be number ${prior + 1} in ${limit.months} months for this patient. Many plans allow ${limit.max} (a typical limit, not this plan's).`,
          fix: "Check the patient's benefits before sending; if over the limit, discuss cost with the patient." });
      }
    }
  }
  if (ageDays > FILING_LIMIT_DAYS) {
    out.push({ lineId: claim.lines[0].id, kind: "timely_filing", fixType: "verify", probability: 0.9,
      title: "Past the usual filing deadline", detail: `The date of service was ${ageDays} days ago. Many plans deny claims filed after 12 months (reason 29).`,
      fix: "Check this insurer's filing limit; if it has passed, a late-filing appeal needs proof of an earlier submission." });
  } else if (ageDays > FILING_WARN_DAYS) {
    out.push({ lineId: claim.lines[0].id, kind: "timely_filing", fixType: "verify", probability: 0.3,
      title: "Close to the usual filing deadline", detail: `The date of service was ${ageDays} days ago; many plans allow 12 months.`,
      fix: "Send it now." });
  }
  return out;
}

/** P(at least one of several independent problems causes a denial). */
export function combine(ps: number[]): number {
  return 1 - ps.reduce((acc, p) => acc * (1 - Math.min(Math.max(p, 0), 1)), 1);
}

/**
 * The 12-month "money left on the table" report (Phase 8), built from a
 * practice's own imported claims:
 *
 *   - Still recoverable: denied money still inside a typical appeal window,
 *     ranked by expected value (denied $ × chance an appeal wins).
 *   - Preventable: denials a check before sending would likely have avoided,
 *     grouped by cause, with the fix. Practices that share get ClaimHive's
 *     pooled rules (measured); everyone gets basic causes from the denial codes.
 *
 * Every probability says where it came from: "pool" (measured across practices)
 * or "typical" (a rough rate for that kind of denial).
 */
import { prisma, withPractice } from "../db";
import { matchClaims } from "../intel/match";
import { CARC, CDT_BY_CODE } from "../reference/codes";

/** Most dental plans allow 90-180 days to appeal; ClaimHive uses 180 and says "check each insurer". */
export const APPEAL_WINDOW_DAYS = 180;
const DAY = 86_400_000;
const carcLabel = new Map(CARC.map((c) => [c.code, c.label]));

/** Rough appeal success by denial reason when there's no pooled evidence. Labelled "typical". */
const TYPICAL_WIN: [string[], number, string][] = [
  [["16", "252", "197"], 0.55, "Send the missing information or documentation with the appeal."],
  [["97", "4"], 0.35, "Explain why the service was separate, or correct the code, and appeal."],
  [["50"], 0.35, "Appeal with a narrative and X-rays showing why the treatment was necessary."],
  [["151", "119"], 0.2, "Check the patient's benefits; appeal only if the limit was applied in error."],
  [["27", "204", "96"], 0.1, "Verify eligibility and coverage; bill the patient or another plan if it isn't covered."],
  [["29"], 0.1, "Appeal only with proof the claim was filed on time."],
  [["18"], 0.05, "Check whether the original claim was paid; don't send duplicates."],
];
const typicalFor = (carc: string) => TYPICAL_WIN.find(([codes]) => codes.includes(carc)) ?? [[], 0.3, "Review the denial reason and appeal with supporting documentation."] as const;

/** Denials a check before sending would usually have caught (basic causes, from the reason code). */
const BASIC_CAUSES: { key: string; carcs: string[]; title: string; fix: string; avoidable: number }[] = [
  { key: "missing_info", carcs: ["16", "252"], title: "Missing information or attachments", fix: "Check tooth numbers, surfaces and required attachments before sending (Check a claim).", avoidable: 0.6 },
  { key: "eligibility", carcs: ["27", "204"], title: "Coverage had ended or didn't apply", fix: "Verify eligibility and benefits before the appointment.", avoidable: 0.7 },
  { key: "frequency", carcs: ["151", "119"], title: "Over a frequency or benefit limit", fix: "Check the patient's history and plan limits before treatment.", avoidable: 0.5 },
  { key: "timely_filing", carcs: ["29"], title: "Filed too late", fix: "Send claims within days of the appointment; ClaimHive flags claims close to the deadline.", avoidable: 0.9 },
  { key: "duplicate", carcs: ["18"], title: "Duplicate claims", fix: "Check before resending; send a corrected claim instead of a duplicate.", avoidable: 0.9 },
  { key: "prior_auth", carcs: ["197"], title: "No prior authorization", fix: "Get pre-authorization for procedures the plan requires it for.", avoidable: 0.8 },
];

export interface RecoverableItem {
  claimId: string; claimRef: string; payer: string; serviceDate: string; deniedAt: string; daysLeft: number;
  deniedCents: number; cdtCodes: string[]; reason: string; group: string; carc: string; rarc: string | null; likelihood: number; source: "pool" | "typical"; expectedCents: number; fix: string;
}
export interface PreventableGroup {
  key: string; title: string; fix: string; source: "pool" | "basic"; payer?: string; claims: number; deniedCents: number; avoidableCents: number; evidence?: string;
}
export interface OpportunityReport {
  from: string; to: string; pooled: boolean; anySynthetic: boolean;
  deniedCents: number; deniedClaims: number; underAppealCents: number;
  recoverable: { items: RecoverableItem[]; deniedCents: number; expectedCents: number };
  tooLateCents: number;
  preventable: { groups: PreventableGroup[]; deniedCents: number; avoidableCents: number };
}

export async function opportunityReport(practiceId: string, now = new Date()): Promise<OpportunityReport> {
  const from = new Date(now.getTime() - 365 * DAY);
  const practice = await prisma().practice.findUniqueOrThrow({ where: { id: practiceId }, select: { poolOptIn: true, isSynthetic: true } });
  const claims = await withPractice(practiceId, (tx) => tx.claim.findMany({
    where: { status: { not: "draft" }, denials: { some: { deniedAt: { gte: from } } } },
    include: { payer: { select: { name: true } }, lines: { select: { id: true, cdtCode: true } }, denials: { orderBy: { deniedAt: "asc" } } },
  }));
  const matches = practice.poolOptIn ? await matchClaims(practiceId, claims) : new Map();
  const r: OpportunityReport = {
    from: from.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10), pooled: practice.poolOptIn, anySynthetic: practice.isSynthetic,
    deniedCents: 0, deniedClaims: 0, underAppealCents: 0,
    recoverable: { items: [], deniedCents: 0, expectedCents: 0 }, tooLateCents: 0,
    preventable: { groups: [], deniedCents: 0, avoidableCents: 0 },
  };
  const groups = new Map<string, PreventableGroup>();
  const add = (g: Omit<PreventableGroup, "claims" | "deniedCents" | "avoidableCents">, denied: number, avoidable: number) => {
    const x = groups.get(g.key) ?? { ...g, claims: 0, deniedCents: 0, avoidableCents: 0 };
    x.claims++; x.deniedCents += denied; x.avoidableCents += avoidable;
    groups.set(g.key, x);
  };

  for (const c of claims) {
    const denied = Math.max(0, c.denials.reduce((s, d) => s + d.amountCents, 0) - c.recoveredCents);
    if (!denied || c.appealStatus === "won") continue;
    r.deniedCents += denied; r.deniedClaims++;
    const first = c.denials[0];
    const m = (matches.get(c.id) ?? [])[0];

    // Preventable: a pooled rule if one matches, else a basic cause from the reason code.
    if (m) {
      const s = m.rule.stats;
      const avoid = s.base && s.cond.rate > 0 ? Math.max(0, 1 - s.base.rate / s.cond.rate) : 0.5;
      add({ key: m.rule.key, title: m.text.title, fix: m.text.fix, source: "pool", payer: m.rule.payer, evidence: m.text.headline }, denied, Math.round(denied * avoid));
    } else {
      const cause = BASIC_CAUSES.find((b) => c.denials.some((d) => b.carcs.includes(d.carc)));
      if (cause) add({ key: `basic:${cause.key}`, title: cause.title, fix: cause.fix, source: "basic" }, denied, Math.round(denied * cause.avoidable));
    }

    // Recoverable: not already appealed, and still inside the appeal window.
    if (c.appealStatus === "sent") { r.underAppealCents += denied; continue; }
    if (c.appealStatus === "lost") continue;
    const deadline = first.deniedAt.getTime() + APPEAL_WINDOW_DAYS * DAY;
    if (deadline < now.getTime()) { r.tooLateCents += denied; continue; }
    const t = typicalFor(first.carc);
    const pooled = m?.rule.stats.appeal?.withFix;
    const likelihood = pooled ? pooled.rate : t[1];
    r.recoverable.items.push({
      claimId: c.id, claimRef: c.id.slice(0, 8).toUpperCase(), payer: c.payer.name, serviceDate: c.serviceDate.toISOString().slice(0, 10),
      deniedAt: first.deniedAt.toISOString().slice(0, 10), // (a denial dated after today counts from today)
      daysLeft: Math.min(APPEAL_WINDOW_DAYS, Math.ceil((deadline - now.getTime()) / DAY)), deniedCents: denied,
      cdtCodes: [...new Set(c.lines.filter((l) => c.denials.some((d) => d.claimLineId === l.id)).map((l) => l.cdtCode))],
      group: first.groupCode, carc: first.carc, rarc: first.rarc,
      reason: `${first.groupCode}-${first.carc}${carcLabel.get(first.carc) ? ` ${carcLabel.get(first.carc)}` : ""}`,
      likelihood, source: pooled ? "pool" : "typical", expectedCents: Math.round(denied * likelihood),
      fix: m ? `${m.text.fix}${m.text.appeal ? ` ${m.text.appeal}` : ""}` : t[2],
    });
  }
  r.recoverable.items.sort((a, b) => b.expectedCents - a.expectedCents || a.daysLeft - b.daysLeft);
  r.recoverable.deniedCents = r.recoverable.items.reduce((s, i) => s + i.deniedCents, 0);
  r.recoverable.expectedCents = r.recoverable.items.reduce((s, i) => s + i.expectedCents, 0);
  r.preventable.groups = [...groups.values()].sort((a, b) => b.avoidableCents - a.avoidableCents);
  r.preventable.deniedCents = r.preventable.groups.reduce((s, g) => s + g.deniedCents, 0);
  r.preventable.avoidableCents = r.preventable.groups.reduce((s, g) => s + g.avoidableCents, 0);
  return r;
}

export const procLabel = (cdt: string) => CDT_BY_CODE.get(cdt)?.label ?? cdt;

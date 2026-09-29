/**
 * Matching a practice's own claims against pool rules: "this denial fits a known
 * pattern, and here's what wins on appeal". Runs inside the practice (its claims
 * never leave it); only contributing practices get pooled rules (owner decision).
 */
import { prisma, withPractice } from "../db";
import { frequencyOf } from "../pool/sync";
import { listRules, type Rule } from "./engine";
import { explainRule, type RuleText } from "./explain";

export interface ClaimForMatch {
  id: string;
  patientId: string;
  serviceDate: Date;
  planType: string;
  attachments: string[];
  payer: { name: string };
  lines: { id: string; cdtCode: string }[];
}

export interface Match { rule: Rule; text: RuleText }

export function ruleApplies(rule: Rule, c: ClaimForMatch, freq: Map<string, number>): boolean {
  if (rule.payer !== c.payer.name) return false;
  if (rule.planType && rule.planType !== c.planType) return false;
  const lines = c.lines.filter((l) => l.cdtCode === rule.cdt);
  if (!lines.length) return false;
  const cond = rule.stats.condition;
  switch (rule.kind) {
    case "missing_attachment": return !c.attachments.includes(cond.attachment!);
    case "billed_with": return c.lines.some((l) => l.cdtCode === cond.withCdt);
    case "frequency": return lines.some((l) => {
      const f = freq.get(l.id) ?? 1;
      return cond.freqAtLeast === 3 ? f >= 3 : f === 2;
    });
    case "usually_denied": return true;
  }
}

/** Rules matching each claim. Empty for practices that don't share with the pool. */
export async function matchClaims(practiceId: string, claims: ClaimForMatch[]): Promise<Map<string, Match[]>> {
  const out = new Map<string, Match[]>();
  if (!claims.length) return out;
  const p = await prisma().practice.findUniqueOrThrow({ where: { id: practiceId }, select: { poolOptIn: true, isSynthetic: true } });
  if (!p.poolOptIn) return out;
  const payers = [...new Set(claims.map((c) => c.payer.name))];
  const rules = await listRules({ synthetic: p.isSynthetic, payers });
  if (!rules.length) return out;
  const freq = await withPractice(practiceId, (tx) => frequencyOf(tx, claims));
  for (const c of claims) {
    const m = rules.filter((r) => ruleApplies(r, c, freq)).map((rule) => ({ rule, text: explainRule(rule) }));
    if (m.length) out.set(c.id, m);
  }
  return out;
}

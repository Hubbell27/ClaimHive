/**
 * What a practice may see from the pool. Pooled patterns are shown only to
 * practices that contribute (the owner's decision); everyone always sees their
 * own data. Every row already meets the 5-practice minimum (see store.ts).
 */
import { prisma, withPractice } from "../db";
import { CDT } from "../reference/codes";
import { denialRatesByPayerCode, MIN_PRACTICES, patternOptions, type DenialRateRow, type PatternSort } from "./store";

export interface InsightFilter {
  payer?: string;
  cdt?: string;
  category?: string;
  planType?: string;
  mine?: boolean;      // only insurers this practice bills
  minLines?: number;
  sort?: PatternSort;
  limit?: number;
}

export type PoolInsights =
  | { allowed: false; reason: "not_contributing" }
  | { allowed: true; minPractices: number; denialRates: DenialRateRow[];
      options: { payers: string[]; cdts: string[]; planTypes: string[]; myPayers: string[] } };

export async function poolInsights(practiceId: string, f: InsightFilter = {}): Promise<PoolInsights> {
  const p = await prisma().practice.findUniqueOrThrow({ where: { id: practiceId }, select: { poolOptIn: true, isSynthetic: true } });
  if (!p.poolOptIn) return { allowed: false, reason: "not_contributing" };
  // The practice's own insurers come from its own claims (tenant data, under RLS).
  const own = await withPractice(practiceId, (tx) => tx.claim.findMany({ distinct: ["payerId"], select: { payer: { select: { name: true } } } }));
  const myPayers = own.map((c) => c.payer.name).sort();
  const cdts = f.category ? CDT.filter((c) => c.category === f.category).map((c) => c.code) : undefined;
  const payers = f.payer ? [f.payer] : f.mine ? myPayers : undefined;
  // Synthetic practices only ever see the synthetic pool, and live practices only the live one.
  const [denialRates, options] = await Promise.all([
    f.mine && !myPayers.length ? Promise.resolve([]) : denialRatesByPayerCode({
      synthetic: p.isSynthetic, payers, cdt: f.cdt, cdts, planType: f.planType, minLines: f.minLines, sort: f.sort, limit: f.limit,
    }),
    patternOptions(p.isSynthetic),
  ]);
  return { allowed: true, minPractices: MIN_PRACTICES, denialRates, options: { ...options, myPayers } };
}

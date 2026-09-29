/**
 * What a practice may see from the pool. Pooled patterns are shown only to
 * practices that contribute (the owner's decision); everyone always sees their
 * own data. Every row already meets the 5-practice minimum (see store.ts).
 */
import { prisma } from "../db";
import { denialRatesByPayerCode, MIN_PRACTICES, type DenialRateRow } from "./store";

export type PoolInsights =
  | { allowed: false; reason: "not_contributing" }
  | { allowed: true; minPractices: number; denialRates: DenialRateRow[] };

export async function poolInsights(practiceId: string, opts: { payer?: string; limit?: number } = {}): Promise<PoolInsights> {
  const p = await prisma().practice.findUniqueOrThrow({ where: { id: practiceId }, select: { poolOptIn: true, isSynthetic: true } });
  if (!p.poolOptIn) return { allowed: false, reason: "not_contributing" };
  // Synthetic practices only ever see the synthetic pool, and live practices only the live one.
  const denialRates = await denialRatesByPayerCode({ synthetic: p.isSynthetic, payer: opts.payer, limit: opts.limit });
  return { allowed: true, minPractices: MIN_PRACTICES, denialRates };
}

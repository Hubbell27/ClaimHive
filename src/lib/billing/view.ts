import { prisma, withPractice } from "../db";
import { ratesFor, rateOn } from "./statements";

/** The rate in force today for each practice, and whether it's the practice's own. */
export async function currentRates(practiceIds: string[]) {
  const out = new Map<string, { bps: number | null; own: boolean }>();
  for (const id of practiceIds) {
    const rows = await withPractice(id, (tx) => ratesFor(tx));
    const today = new Date();
    out.set(id, { bps: rateOn(rows, today), own: rows.some((r) => r.practiceId && r.effectiveFrom <= today) });
  }
  return out;
}

export const defaultRates = () => prisma().billingRate.findMany({ where: { practiceId: null }, orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }], take: 20 });

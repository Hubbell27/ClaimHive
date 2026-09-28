/**
 * Money summary for a practice (Phase 1 definitions; refined with attribution in Phase 7).
 *   denied     = amount on denied claim lines, last 12 months
 *   recovered  = amount won back on appeal
 *   at risk    = denied, not yet won or lost, and still inside a typical 180-day appeal window
 *   lost       = appeal lost, or denied and never appealed past the window
 */
import { withPractice } from "./db";

export const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const DAY = 86_400_000;

export async function moneySummary(practiceId: string, now = new Date()) {
  const since = new Date(now.getTime() - 365 * DAY);
  const windowStart = new Date(now.getTime() - 180 * DAY);
  return withPractice(practiceId, async (tx) => {
    const claims = await tx.claim.findMany({
      where: { serviceDate: { gte: since } },
      select: { status: true, billedCents: true, paidCents: true, appealStatus: true, recoveredCents: true,
        adjudicatedAt: true, payer: { select: { name: true } }, denials: { select: { amountCents: true, carc: true } } },
    });
    let denied = 0, recovered = 0, atRisk = 0, lost = 0, billed = 0, paid = 0;
    const causes = new Map<string, { payer: string; carc: string; cents: number; count: number }>();
    for (const c of claims) {
      billed += c.billedCents;
      paid += c.paidCents;
      const d = c.denials.reduce((s, x) => s + x.amountCents, 0);
      if (!d) continue;
      denied += d;
      recovered += c.recoveredCents;
      const open = c.appealStatus === "none" || c.appealStatus === "sent" || c.appealStatus === "drafted";
      if (c.appealStatus === "lost" || (open && c.adjudicatedAt && c.adjudicatedAt < windowStart)) lost += d;
      else if (open) atRisk += d;
      for (const x of c.denials) {
        const k = `${c.payer.name}|${x.carc}`;
        const cur = causes.get(k) ?? { payer: c.payer.name, carc: x.carc, cents: 0, count: 0 };
        cur.cents += x.amountCents;
        cur.count += 1;
        causes.set(k, cur);
      }
    }
    const topCauses = [...causes.values()].sort((a, b) => b.cents - a.cents).slice(0, 8);
    return { claims: claims.length, billed, paid, denied, recovered, atRisk, lost, topCauses };
  });
}

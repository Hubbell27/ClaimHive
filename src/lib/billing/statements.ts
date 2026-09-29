/**
 * Contingency billing (Phase 7).
 *
 * What's billed: attributed "recovered" ledger events (money won back through
 * ClaimHive and received by the practice), at the rate in force on the day the
 * money was recovered. Never protected money, never recoveries the office made
 * on its own. When an insurer later takes billed money back, the fee on it is
 * credited on the next statement. Every ledger event is billed at most once
 * (unique result_event_id on statement lines).
 *
 * Monthly flow: a draft per practice is built on the 1st for the previous month
 * (ClaimHive staff only) -> staff review and issue it -> issued statements are
 * locked by the database and visible to the practice.
 */
import { audit } from "../audit";
import { prisma, withPractice, type TenantTx } from "../db";
import { log } from "../logger";
import type { Evidence } from "../results/ledger";

export class BillingError extends Error {}

export const PAYMENT_TERMS_DAYS = 30;
export const pctOf = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;
export const feeOn = (cents: number, bps: number) => Math.round((cents * bps) / 10000);

export function monthStart(d: Date): Date { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); }
export function nextMonth(d: Date): Date { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)); }
export function parseMonth(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  return m && +m[2] >= 1 && +m[2] <= 12 ? new Date(Date.UTC(+m[1], +m[2] - 1, 1)) : null;
}
export const monthKey = (d: Date) => d.toISOString().slice(0, 7);
export const monthLabel = (d: Date) => d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

type RateRow = { practiceId: string | null; rateBps: number; effectiveFrom: Date; createdAt: Date };

/** The practice's own rate if one has been set by that date, else ClaimHive's default. */
export function rateOn(rows: RateRow[], date: Date): number | null {
  const valid = rows.filter((r) => r.effectiveFrom.getTime() <= date.getTime())
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime() || b.createdAt.getTime() - a.createdAt.getTime());
  return (valid.find((r) => r.practiceId) ?? valid.find((r) => !r.practiceId))?.rateBps ?? null;
}

/** Rows visible to a practice: the defaults and its own (RLS). */
export const ratesFor = (tx: TenantTx) => tx.billingRate.findMany({ orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }] });

export async function setRate(admin: { userId: string; email: string }, input: {
  practiceId: string | null; rateBps: number; effectiveFrom: Date; note?: string;
}): Promise<void> {
  if (!Number.isInteger(input.rateBps) || input.rateBps < 0 || input.rateBps > 10000) throw new BillingError("Enter a rate between 0% and 100%.");
  const data = { practiceId: input.practiceId, rateBps: input.rateBps, effectiveFrom: input.effectiveFrom, note: input.note?.slice(0, 200) || null, setBy: admin.userId };
  if (input.practiceId) await withPractice(input.practiceId, (tx) => tx.billingRate.create({ data }));
  else await prisma().billingRate.create({ data }); // no practice context: only default rows are writable
  await audit({ action: "billing.rate_set", actorUserId: admin.userId, actorEmail: admin.email, practiceId: input.practiceId,
    resourceType: "billing_rate", details: { rateBps: input.rateBps, effectiveFrom: input.effectiveFrom.toISOString().slice(0, 10), scope: input.practiceId ? "practice" : "default" } });
}

interface Candidate {
  kind: "charge" | "credit"; resultEventId: string; recoveredCents: number; rateBps: number; occurredAt: Date;
  claimId: string; payer: string; cdtCodes: string[]; method: string; explanation: string;
}

/** Unbilled, attributed events up to `before`, priced. Shared by the draft builder and the "accruing" estimate. */
async function candidates(tx: TenantTx, before: Date): Promise<Candidate[]> {
  const rates = await ratesFor(tx);
  const events = await tx.resultEvent.findMany({
    where: { attributed: true, kind: { in: ["recovered", "reversed"] }, occurredAt: { lt: before }, statementLines: { none: {} } },
    include: { claim: { select: { payer: { select: { name: true } } } } }, orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
  });
  const originals = events.filter((e) => e.kind === "reversed").map((e) => (e.evidence as Evidence).reversesEventId as string).filter(Boolean);
  const billedLines = new Map((await tx.statementLine.findMany({ where: { resultEventId: { in: originals } } })).map((l) => [l.resultEventId, l]));
  const originalEvents = new Map((await tx.resultEvent.findMany({ where: { id: { in: originals } } })).map((e) => [e.id, e]));
  const out: Candidate[] = [];
  for (const e of events) {
    const ev = e.evidence as Evidence;
    let rate: number | null;
    if (e.kind === "recovered") rate = rateOn(rates, e.occurredAt);
    else {
      // Credit at the rate the original recovery was (or will be) billed at.
      const orig = ev.reversesEventId as string | undefined;
      rate = billedLines.get(orig ?? "")?.rateBps ?? rateOn(rates, originalEvents.get(orig ?? "")?.occurredAt ?? e.occurredAt);
    }
    if (rate === null) throw new BillingError("No contingency rate is set. Set ClaimHive's default rate in the admin console first.");
    out.push({
      kind: e.kind === "recovered" ? "charge" : "credit", resultEventId: e.id, recoveredCents: e.amountCents, rateBps: rate, occurredAt: e.occurredAt,
      claimId: e.claimId, payer: e.claim.payer.name, cdtCodes: ev.cdtCodes ?? [], method: e.method, explanation: e.explanation,
    });
  }
  return out;
}

function totals(lines: { kind: string; recoveredCents: number; rateBps: number }[]) {
  let fee = 0, credit = 0, recovered = 0;
  for (const l of lines) {
    const f = feeOn(l.recoveredCents, l.rateBps);
    if (l.kind === "charge") { fee += f; recovered += l.recoveredCents; } else { credit += f; recovered -= l.recoveredCents; }
  }
  return { feeCents: fee, creditCents: credit, totalCents: fee - credit, recoveredCents: recovered };
}

/** What the practice would be billed if a statement were built today (shown to the practice as "accruing"). */
export async function accruing(practiceId: string) {
  const c = await withPractice(practiceId, (tx) => candidates(tx, new Date(Date.now() + 86_400_000))).catch((e) => {
    if (e instanceof BillingError) return null;
    throw e;
  });
  return c ? { lines: c.length, ...totals(c) } : null;
}

/**
 * Builds (or rebuilds) the draft for one practice and month. Includes every unbilled
 * attributed event up to the month's end, including late arrivals from earlier months.
 * Returns null when there's nothing to bill.
 */
export async function buildDraft(practiceId: string, month: Date, actor?: { userId: string; email: string }) {
  const periodStart = monthStart(month), periodEnd = nextMonth(month);
  const practice = await prisma().practice.findUniqueOrThrow({ where: { id: practiceId }, select: { isSynthetic: true } });
  const result = await withPractice(practiceId, async (tx) => {
    const existing = await tx.statement.findUnique({ where: { practiceId_periodStart: { practiceId, periodStart } } });
    if (existing?.status === "issued") return existing;
    if (existing) await tx.statementLine.deleteMany({ where: { statementId: existing.id } });
    const lines = await candidates(tx, periodEnd);
    if (!lines.length) {
      if (existing) await tx.statement.delete({ where: { id: existing.id } });
      return null;
    }
    const t = totals(lines);
    const st = existing
      ? await tx.statement.update({ where: { id: existing.id }, data: { ...t, periodEnd } })
      : await tx.statement.create({ data: { practiceId, periodStart, periodEnd, isSynthetic: practice.isSynthetic, ...t } });
    await tx.statementLine.createMany({ data: lines.map((l) => ({
      practiceId, statementId: st.id, kind: l.kind, resultEventId: l.resultEventId, recoveredCents: l.recoveredCents, rateBps: l.rateBps,
      feeCents: feeOn(l.recoveredCents, l.rateBps), occurredAt: l.occurredAt, claimRef: l.claimId.slice(0, 8).toUpperCase(), claimId: l.claimId,
      payer: l.payer, cdtCodes: l.cdtCodes, method: l.method, explanation: l.explanation,
    })) });
    return st;
  });
  if (result && result.status === "draft") {
    await audit({ action: "billing.draft_built", actorUserId: actor?.userId ?? null, actorEmail: actor?.email ?? null, practiceId,
      resourceType: "statement", resourceId: result.id, details: { month: monthKey(periodStart), totalCents: result.totalCents } });
  }
  return result;
}

/** The monthly job (and the admin's "build drafts" button): every practice, one month. */
export async function buildAllDrafts(month: Date, actor?: { userId: string; email: string }) {
  const out = { built: 0, empty: 0, issued: 0, failed: [] as string[] };
  for (const p of await prisma().practice.findMany({ select: { id: true } })) {
    try {
      const s = await buildDraft(p.id, month, actor);
      if (!s) out.empty++; else if (s.status === "issued") out.issued++; else out.built++;
    } catch (e) {
      out.failed.push(p.id);
      log.error({ event: "billing.draft_failed", practiceId: p.id }, e);
    }
  }
  return out;
}

/** Locks the draft exactly as reviewed (the admin passes the updatedAt they saw). */
export async function issueStatement(admin: { userId: string; email: string }, practiceId: string, statementId: string, seenUpdatedAt: string) {
  const issued = await withPractice(practiceId, async (tx) => {
    const st = await tx.statement.findUnique({ where: { id: statementId }, include: { _count: { select: { lines: true } } } });
    if (!st || st.status !== "draft") throw new BillingError("Only a draft can be issued.");
    if (st.updatedAt.toISOString() !== seenUpdatedAt) throw new BillingError("The draft changed since you opened it. Review it again, then issue.");
    if (!st._count.lines) throw new BillingError("This draft has no lines.");
    const [{ n }] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('statement_number_seq') AS n`;
    const now = new Date();
    return tx.statement.update({ where: { id: st.id }, data: {
      status: "issued", number: `CH-${monthKey(st.periodStart).replace("-", "")}-${String(n).padStart(5, "0")}`,
      issuedAt: now, issuedBy: admin.userId, dueDate: new Date(now.getTime() + PAYMENT_TERMS_DAYS * 86_400_000),
    } });
  });
  await audit({ action: "billing.statement_issued", actorUserId: admin.userId, actorEmail: admin.email, practiceId,
    resourceType: "statement", resourceId: statementId, details: { number: issued.number, totalCents: issued.totalCents } });
  return issued;
}

export async function statementWithLines(practiceId: string, statementId: string) {
  return withPractice(practiceId, (tx) => tx.statement.findUnique({
    where: { id: statementId }, include: { lines: { orderBy: [{ kind: "asc" }, { occurredAt: "asc" }] } },
  }));
}

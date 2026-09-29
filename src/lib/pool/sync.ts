/**
 * Keeping a practice's share of the pool in step with its claims.
 *
 *   opt in   → random contributor token, consent recorded, full sync of the last
 *              12 months (by date of service, counted from the opt-in date)
 *   ongoing  → after every import or review, claims changed since the last sync
 *              are re-de-identified and replaced in the pool
 *   opt out  → every record the practice ever shared is deleted from the pool, the
 *              claim links are cleared and the token is discarded
 *
 * Only this module reads claims for the pool, and only through `toPoolRecord`.
 */
import { audit } from "../audit";
import type { PracticeContext } from "../auth/rbac";
import { prisma, withPractice } from "../db";
import { boss, QUEUES } from "../jobs";
import { log } from "../logger";
import type { TenantTx } from "../db";
import { EXTENDED_CONSENT, POOL_CONSENT_VERSION, toPoolRecord, type PoolRecord } from "./deidentify";
import { contributorCount, removeContributor, withContributorLock, writeRecords } from "./store";

const DAY = 86_400_000;
const BATCH = 500;
export const BACKFILL_DAYS = 365;
type Actor = Pick<PracticeContext, "practiceId" | "userId" | "email">;

export interface SyncStats { shared: number; removed: number; skipped: Record<string, number> }

export async function syncPractice(practiceId: string, opts: { full?: boolean } = {}): Promise<SyncStats> {
  const first = await prisma().practice.findUniqueOrThrow({ where: { id: practiceId }, select: { poolOptIn: true, poolToken: true } });
  if (!first.poolOptIn || !first.poolToken) return { shared: 0, removed: 0, skipped: {} };
  // Hold the contributor lock for the whole sync, and re-check consent once we have it,
  // so an opt-out can never be followed by records being written back.
  return withContributorLock(first.poolToken, async () => {
    const p = await prisma().practice.findUniqueOrThrow({ where: { id: practiceId } });
    if (!p.poolOptIn || p.poolToken !== first.poolToken || !p.poolOptInAt) return { shared: 0, removed: 0, skipped: {} };
    return syncLocked(p, opts);
  });
}

async function syncLocked(
  p: { id: string; state: string; poolToken: string | null; poolOptInAt: Date | null; poolSyncedAt: Date | null; poolConsentVersion: string | null },
  opts: { full?: boolean },
): Promise<SyncStats> {
  const practiceId = p.id;
  const started = new Date();
  const stats: SyncStats = { shared: 0, removed: 0, skipped: {} };
  if (!p.poolToken || !p.poolOptInAt) return stats;
  const windowStart = new Date(p.poolOptInAt.getTime() - BACKFILL_DAYS * DAY);
  const since = opts.full ? undefined : p.poolSyncedAt ?? undefined;

  let cursor: string | undefined;
  for (;;) {
    const claims = await withPractice(practiceId, (tx) => tx.claim.findMany({
      where: { serviceDate: { gte: windowStart }, ...(since ? { updatedAt: { gt: since } } : {}) },
      orderBy: { id: "asc" }, take: BATCH, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, poolRecordId: true, planType: true, status: true, appealStatus: true, submittedAt: true, adjudicatedAt: true,
        paidCents: true, attachments: true, isSynthetic: true, payer: { select: { name: true, verified: true } },
        appealAttachments: true, appealArgument: true, patientId: true, serviceDate: true,
        lines: { select: { id: true, cdtCode: true } }, denials: { select: { claimLineId: true, groupCode: true, carc: true, rarc: true } },
      },
    }));
    if (!claims.length) break;
    cursor = claims[claims.length - 1].id;

    const extended = EXTENDED_CONSENT.has(p.poolConsentVersion ?? "");
    const freq = extended ? await withPractice(practiceId, (tx) => frequencyOf(tx, claims)) : undefined;
    const records: PoolRecord[] = [];
    const remove: string[] = [];
    const link: { claimId: string; poolId: string | null }[] = [];
    for (const c of claims) {
      const id = c.poolRecordId ?? crypto.randomUUID();
      const out = toPoolRecord(c, { id, contributor: p.poolToken!, region: p.state, extended, freq });
      if ("record" in out) {
        records.push(out.record);
        if (!c.poolRecordId) link.push({ claimId: c.id, poolId: id });
      } else {
        stats.skipped[out.skip] = (stats.skipped[out.skip] ?? 0) + 1;
        if (c.poolRecordId) { remove.push(c.poolRecordId); link.push({ claimId: c.id, poolId: null }); }
      }
    }
    // Pool first, then the tenant-side link. If the link fails, the orphan pool rows still
    // carry the contributor token, so an opt-out removes them.
    await writeRecords(records, remove);
    if (link.length) {
      await withPractice(practiceId, async (tx) => {
        // Raw SQL so the link doesn't bump updated_at (which would re-sync these claims forever).
        for (const l of link) await tx.$executeRaw`UPDATE claims SET pool_record_id = ${l.poolId}::uuid WHERE id = ${l.claimId}::uuid`;
      });
    }
    stats.shared += records.length;
    stats.removed += remove.length;
    if (claims.length < BATCH) break;
  }

  const [shared, held] = await withPractice(practiceId, (tx) => Promise.all([
    tx.claim.count({ where: { poolRecordId: { not: null } } }),
    tx.claim.count({ where: { poolRecordId: null, serviceDate: { gte: windowStart } } }),
  ]));
  await prisma().practice.update({ where: { id: practiceId }, data: { poolSyncedAt: started, poolShared: shared, poolSkipped: held } });
  log.info({ event: "pool.sync", practiceId, count: stats.shared, outcome: opts.full ? "full" : "incremental" });
  return stats;
}

/**
 * For each procedure line: how many times the same procedure was billed for the same
 * patient in the 12 months up to and including this date of service (inside the
 * practice; only the 1/2/3+ bucket is shared).
 */
export async function frequencyOf(
  tx: TenantTx, claims: { id: string; patientId: string; serviceDate: Date; lines: { id: string; cdtCode: string }[] }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!claims.length) return out;
  const patients = [...new Set(claims.map((c) => c.patientId))];
  const min = new Date(Math.min(...claims.map((c) => c.serviceDate.getTime())) - 365 * DAY);
  const max = new Date(Math.max(...claims.map((c) => c.serviceDate.getTime())));
  const history = await tx.claim.findMany({
    where: { patientId: { in: patients }, serviceDate: { gte: min, lte: max } },
    select: { id: true, patientId: true, serviceDate: true, lines: { select: { id: true, cdtCode: true } } },
  });
  // patient|cdt → [(time, stable order key)]
  const byKey = new Map<string, { t: number; k: string }[]>();
  for (const h of history) for (const l of h.lines) {
    const key = `${h.patientId}|${l.cdtCode}`;
    byKey.set(key, [...(byKey.get(key) ?? []), { t: h.serviceDate.getTime(), k: `${h.serviceDate.toISOString()}|${h.id}|${l.id}` }]);
  }
  for (const c of claims) for (const l of c.lines) {
    const t = c.serviceDate.getTime();
    const me = `${c.serviceDate.toISOString()}|${c.id}|${l.id}`;
    const list = byKey.get(`${c.patientId}|${l.cdtCode}`) ?? [];
    // Earlier ones inside the 365-day window, plus same-day ones ordered before this line, plus this one.
    out.set(l.id, list.filter((x) => x.t > t - 365 * DAY && (x.t < t || (x.t === t && x.k < me))).length + 1);
  }
  return out;
}

/** Queue a sync after new data arrives (no-op for practices that don't share). */
export async function enqueuePoolSync(practiceId: string, full = false): Promise<void> {
  const p = await prisma().practice.findUnique({ where: { id: practiceId }, select: { poolOptIn: true } });
  if (!p?.poolOptIn) return;
  await (await boss()).send(QUEUES.poolSync, { practiceId, full }, { singletonKey: `${practiceId}:${full}`, retryLimit: 3, retryDelay: 60 });
}

/** The owner's decision (onboarding or Settings). Opting out removes everything already shared. */
export async function decidePool(ctx: Actor, share: boolean, opts: { runNow?: boolean } = {}): Promise<{ removed: number }> {
  const p = await prisma().practice.findUniqueOrThrow({ where: { id: ctx.practiceId } });
  const now = new Date();
  let removed = 0;
  if (share) {
    await prisma().practice.update({
      where: { id: ctx.practiceId },
      data: {
        poolOptIn: true, poolDecidedAt: now, poolConsentVersion: POOL_CONSENT_VERSION, poolConsentOffered: POOL_CONSENT_VERSION,
        poolOptInAt: p.poolOptIn ? p.poolOptInAt : now, poolOptInBy: p.poolOptIn ? p.poolOptInBy : ctx.userId,
        poolToken: p.poolToken ?? crypto.randomUUID(), poolSyncedAt: p.poolOptIn ? p.poolSyncedAt : null,
      },
    });
  } else {
    // Stop first, so no sync can add records after the removal.
    await prisma().practice.update({
      where: { id: ctx.practiceId },
      data: { poolOptIn: false, poolDecidedAt: now, poolConsentVersion: POOL_CONSENT_VERSION, poolConsentOffered: POOL_CONSENT_VERSION,
        poolOptInAt: null, poolOptInBy: null, poolSyncedAt: null },
    });
    if (p.poolToken) {
      const token = p.poolToken;
      removed = await withContributorLock(token, async () => {
        const n = await removeContributor(token);
        if (await contributorCount(token)) throw new Error("pool removal incomplete");
        return n;
      });
    }
    await withPractice(ctx.practiceId, (tx) => tx.$executeRaw`UPDATE claims SET pool_record_id = NULL WHERE pool_record_id IS NOT NULL`);
    await prisma().practice.update({ where: { id: ctx.practiceId }, data: { poolToken: null, poolShared: 0, poolSkipped: 0 } });
  }
  await audit({ action: share ? "practice.pool_opt_in" : "practice.pool_opt_out", actorUserId: ctx.userId, actorEmail: ctx.email,
    practiceId: ctx.practiceId, details: { share, consentVersion: POOL_CONSENT_VERSION, removed } });
  if (share && !p.poolOptIn) {
    if (opts.runNow) await syncPractice(ctx.practiceId, { full: true });
    else await (await boss()).send(QUEUES.poolSync, { practiceId: ctx.practiceId, full: true }, { retryLimit: 3, retryDelay: 60 });
  }
  return { removed };
}

/** Does this practice's owner still need to see the updated sharing terms? */
export function needsConsentUpdate(p: { poolOptIn: boolean; poolConsentVersion: string | null; poolConsentOffered: string | null }): boolean {
  return p.poolOptIn && p.poolConsentVersion !== POOL_CONSENT_VERSION && p.poolConsentOffered !== POOL_CONSENT_VERSION;
}

/**
 * The owner's answer to updated sharing terms. Accepting re-shares everything with the
 * new fields; declining keeps sharing only what they originally agreed to (asked once).
 */
export async function answerConsentUpdate(ctx: Actor, accept: boolean, opts: { runNow?: boolean } = {}): Promise<void> {
  const p = await prisma().practice.findUniqueOrThrow({ where: { id: ctx.practiceId } });
  if (!p.poolOptIn) return;
  await prisma().practice.update({
    where: { id: ctx.practiceId },
    data: { poolConsentOffered: POOL_CONSENT_VERSION, ...(accept ? { poolConsentVersion: POOL_CONSENT_VERSION } : {}) },
  });
  await audit({ action: "practice.pool_consent_update", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    details: { accepted: accept, from: p.poolConsentVersion, to: POOL_CONSENT_VERSION } });
  if (accept) {
    if (opts.runNow) await syncPractice(ctx.practiceId, { full: true });
    else await (await boss()).send(QUEUES.poolSync, { practiceId: ctx.practiceId, full: true }, { retryLimit: 3, retryDelay: 60 });
  }
}

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
import { POOL_CONSENT_VERSION, toPoolRecord, type PoolRecord } from "./deidentify";
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
  p: { id: string; state: string; poolToken: string | null; poolOptInAt: Date | null; poolSyncedAt: Date | null },
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
        lines: { select: { id: true, cdtCode: true } }, denials: { select: { claimLineId: true, groupCode: true, carc: true, rarc: true } },
      },
    }));
    if (!claims.length) break;
    cursor = claims[claims.length - 1].id;

    const records: PoolRecord[] = [];
    const remove: string[] = [];
    const link: { claimId: string; poolId: string | null }[] = [];
    for (const c of claims) {
      const id = c.poolRecordId ?? crypto.randomUUID();
      const out = toPoolRecord(c, { id, contributor: p.poolToken!, region: p.state });
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
        poolOptIn: true, poolDecidedAt: now, poolConsentVersion: POOL_CONSENT_VERSION,
        poolOptInAt: p.poolOptIn ? p.poolOptInAt : now, poolOptInBy: p.poolOptIn ? p.poolOptInBy : ctx.userId,
        poolToken: p.poolToken ?? crypto.randomUUID(), poolSyncedAt: p.poolOptIn ? p.poolSyncedAt : null,
      },
    });
  } else {
    // Stop first, so no sync can add records after the removal.
    await prisma().practice.update({
      where: { id: ctx.practiceId },
      data: { poolOptIn: false, poolDecidedAt: now, poolConsentVersion: POOL_CONSENT_VERSION, poolOptInAt: null, poolOptInBy: null, poolSyncedAt: null },
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

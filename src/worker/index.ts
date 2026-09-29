/**
 * Background worker: `npm run worker`. Processes queued jobs from pg-boss.
 * Jobs are logged by id and outcome only (never PHI).
 */
import "dotenv/config";
import { audit } from "../lib/audit";
import { prisma } from "../lib/db";
import { processBatch, purgeOldFiles } from "../lib/ingest/pipeline";
import { draftLetter } from "../lib/appeals/letters";
import { boss, QUEUES, type AppealJob, type ImportJob, type IntelJob, type PoolSyncJob, type SyntheticJob } from "../lib/jobs";
import { syncPractice } from "../lib/pool/sync";
import { rebuildRules } from "../lib/intel/engine";
import { log } from "../lib/logger";
import { loadSyntheticDataset } from "../lib/synthetic/load";

async function main() {
  const b = await boss();
  await b.work<SyntheticJob>(QUEUES.syntheticGenerate, async ([job]) => {
    const started = Date.now();
    const r = await loadSyntheticDataset({ practices: job.data.practices, patientsPerPractice: job.data.patientsPerPractice, seed: job.data.seed });
    await audit({ action: "synthetic.generate", actorUserId: job.data.requestedBy,
      details: { practices: r.practices.length, patients: r.patients, claims: r.claims, denials: r.denials } });
    log.info({ event: "job.done", job: QUEUES.syntheticGenerate, jobId: job.id, count: r.claims, durationMs: Date.now() - started });
  });
  await b.work<ImportJob>(QUEUES.importProcess, { batchSize: 1 }, async ([job]) => {
    await processBatch(job.data.practiceId, job.data.batchId);
  });
  await b.work<PoolSyncJob>(QUEUES.poolSync, { batchSize: 1 }, async ([job]) => {
    await syncPractice(job.data.practiceId, { full: job.data.full });
    // Rebuild rules once things settle: one rebuild per 5 minutes however many syncs arrive.
    const p = await prisma().practice.findUnique({ where: { id: job.data.practiceId }, select: { isSynthetic: true } });
    await b.send(QUEUES.intelRebuild, { synthetic: !!p?.isSynthetic }, { singletonKey: `rules:${!!p?.isSynthetic}`, singletonSeconds: 300, startAfter: 60 });
  });
  await b.work<AppealJob>(QUEUES.appealDraft, { batchSize: 1 }, async ([job]) => {
    await draftLetter(job.data.practiceId, job.data.letterId);
  });
  await b.work<IntelJob>(QUEUES.intelRebuild, { batchSize: 1 }, async ([job]) => {
    await rebuildRules(job.data?.synthetic ?? false);
  });
  await b.schedule(QUEUES.intelRebuild, "41 2 * * *", { synthetic: false }); // nightly, live pool
  await b.work(QUEUES.purgeFiles, async () => {
    let n = 0;
    for (const p of await prisma().practice.findMany({ select: { id: true } })) n += await purgeOldFiles(p.id);
    log.info({ event: "job.done", job: QUEUES.purgeFiles, count: n });
  });
  await b.schedule(QUEUES.purgeFiles, "17 3 * * *"); // daily, 03:17 UTC
  log.info({ event: "worker.started" });
}

main().catch((e) => {
  log.error({ event: "worker.crashed" }, e);
  process.exit(1);
});

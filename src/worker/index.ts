/**
 * Background worker: `npm run worker`. Processes queued jobs from pg-boss.
 * Jobs are logged by id and outcome only (never PHI).
 */
import "dotenv/config";
import { audit } from "../lib/audit";
import { boss, QUEUES, type SyntheticJob } from "../lib/jobs";
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
  log.info({ event: "worker.started" });
}

main().catch((e) => {
  log.error({ event: "worker.crashed" }, e);
  process.exit(1);
});

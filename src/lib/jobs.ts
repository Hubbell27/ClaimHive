/**
 * Background jobs (pg-boss on the same PostgreSQL). Payloads carry ids and
 * options only, never PHI.
 */
import { PgBoss } from "pg-boss";

export const QUEUES = {
  syntheticGenerate: "synthetic.generate",
  importProcess: "import.process",
  purgeFiles: "import.purge_files", // daily: drop stored originals past retention
  poolSync: "pool.sync", // share a practice's new/changed claims with the de-identified pool
  intelRebuild: "intel.rebuild", // recompute denial rules from the pool (after syncs, and nightly)
  appealDraft: "appeal.draft", // write an appeal letter (de-identified request; merged locally)
} as const;

const g = globalThis as unknown as { boss?: Promise<PgBoss> };

export function boss(): Promise<PgBoss> {
  g.boss ??= (async () => {
    // The `pgboss` schema is created by a migration and owned by the app role, which
    // (deliberately) has no CREATE privilege on the database.
    const b = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema: "pgboss", createSchema: false });
    b.on("error", () => undefined);
    await b.start();
    for (const q of Object.values(QUEUES)) await b.createQueue(q);
    return b;
  })();
  return g.boss;
}

export interface IntelJob { synthetic: boolean }
export interface PoolSyncJob { practiceId: string; full: boolean }
export interface AppealJob { practiceId: string; letterId: string }
export interface ImportJob { practiceId: string; batchId: string }
export interface SyntheticJob { practices: number; patientsPerPractice: number; seed: number; requestedBy: string }

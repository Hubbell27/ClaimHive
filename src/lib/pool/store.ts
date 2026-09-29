/**
 * The de-identified pool, reached only through its own role (POOL_DATABASE_URL →
 * claimhive_pool). That role can read and write the `pool` schema and nothing
 * else; the application role can't see the pool. Rows are never updated in
 * place: a changed claim's record is deleted and re-inserted.
 *
 * Every query that shows a pattern goes through `HAVING count(DISTINCT contributor)
 * >= MIN_PRACTICES`, so a pattern from fewer than 5 practices can't be returned
 * by any function here.
 */
import pg from "pg";
import { assertSafeHarbor, type PoolRecord } from "./deidentify";

export const MIN_PRACTICES = 5;

const g = globalThis as unknown as { poolDb?: pg.Pool };
export function poolDb(): pg.Pool {
  if (!g.poolDb) {
    if (!process.env.POOL_DATABASE_URL) throw new Error("POOL_DATABASE_URL is not set");
    g.poolDb = new pg.Pool({ connectionString: process.env.POOL_DATABASE_URL, max: 5 });
  }
  return g.poolDb;
}

/**
 * Serializes work on one contributor's records (sync vs. opt-out): a session-level
 * advisory lock on the pool connection, held for the duration of `fn`.
 */
export async function withContributorLock<T>(contributor: string, fn: () => Promise<T>): Promise<T> {
  const client = await poolDb().connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('pool:' || $1))", [contributor]);
    return await fn();
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('pool:' || $1))", [contributor]).catch(() => undefined);
    client.release();
  }
}

/** Replaces records (by id) and removes others, in one transaction. */
export async function writeRecords(records: PoolRecord[], removeIds: string[] = []): Promise<void> {
  if (!records.length && !removeIds.length) return;
  for (const r of records) assertSafeHarbor(r);
  const client = await poolDb().connect();
  try {
    await client.query("BEGIN");
    const ids = [...new Set([...removeIds, ...records.map((r) => r.id)])];
    if (ids.length) await client.query("DELETE FROM pool.claims WHERE id = ANY($1::uuid[])", [ids]);
    if (records.length) {
      await client.query(
        `INSERT INTO pool.claims (id, contributor, payer, plan_type, region, attachments, outcome, days_to_payment, is_synthetic)
         SELECT id, contributor, payer, plan_type, region, coalesce(string_to_array(nullif(atts, ''), ','), '{}'), outcome, days, syn
           FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::int[], $9::bool[])
             AS t(id, contributor, payer, plan_type, region, atts, outcome, days, syn)`,
        [
          records.map((r) => r.id), records.map((r) => r.contributor), records.map((r) => r.payer), records.map((r) => r.planType),
          records.map((r) => r.region), records.map((r) => r.attachments.join(",")), records.map((r) => r.outcome),
          records.map((r) => r.daysToPayment), records.map((r) => r.isSynthetic),
        ],
      );
      const lines = records.flatMap((r) => r.lines.map((l) => ({ id: r.id, ...l })));
      await client.query(
        `INSERT INTO pool.claim_lines (claim_id, cdt, denied, carcs, rarcs)
         SELECT claim_id, cdt, denied, coalesce(string_to_array(nullif(carcs, ''), ','), '{}'), coalesce(string_to_array(nullif(rarcs, ''), ','), '{}')
         FROM unnest($1::uuid[], $2::text[], $3::bool[], $4::text[], $5::text[]) AS t(claim_id, cdt, denied, carcs, rarcs)`,
        [lines.map((l) => l.id), lines.map((l) => l.cdt), lines.map((l) => l.denied), lines.map((l) => l.carcs.join(",")), lines.map((l) => l.rarcs.join(","))],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Opt-out: everything a contributor ever shared. Returns the number of claims removed. */
export async function removeContributor(contributor: string): Promise<number> {
  const r = await poolDb().query("DELETE FROM pool.claims WHERE contributor = $1", [contributor]);
  return r.rowCount ?? 0;
}

export async function contributorCount(contributor: string): Promise<number> {
  const r = await poolDb().query("SELECT count(*)::int AS n FROM pool.claims WHERE contributor = $1", [contributor]);
  return r.rows[0].n;
}

export interface DenialRateRow {
  payer: string;
  cdt: string;
  lines: number;
  denied: number;
  practices: number;
  rate: number;
}

/**
 * Denial rate by insurer × procedure, only where at least MIN_PRACTICES practices
 * contributed. Synthetic and live data are never mixed.
 */
export async function denialRatesByPayerCode(opts: { synthetic: boolean; payer?: string; limit?: number }): Promise<DenialRateRow[]> {
  const r = await poolDb().query(
    `SELECT c.payer, l.cdt, count(*)::int AS lines, count(*) FILTER (WHERE l.denied)::int AS denied,
            count(DISTINCT c.contributor)::int AS practices
       FROM pool.claims c JOIN pool.claim_lines l ON l.claim_id = c.id
      WHERE c.is_synthetic = $1 AND ($2::text IS NULL OR c.payer = $2) AND c.outcome <> 'pending'
      GROUP BY c.payer, l.cdt
     HAVING count(DISTINCT c.contributor) >= $3
      ORDER BY count(*) FILTER (WHERE l.denied)::float / count(*) DESC, count(*) DESC
      LIMIT $4`,
    [opts.synthetic, opts.payer ?? null, MIN_PRACTICES, opts.limit ?? 50],
  );
  return r.rows.map((x) => ({ ...x, rate: x.lines ? x.denied / x.lines : 0 }));
}

export interface PoolHealth {
  claims: number;
  lines: number;
  contributors: number;
  byPayer: { payer: string; claims: number; practices: number; deniedLines: number; lines: number; meetsThreshold: boolean }[];
  byCode: { cdt: string; lines: number; practices: number; denied: number; meetsThreshold: boolean }[];
}

/** Admin view: record counts per payer and per code (no pattern details), split by synthetic/live. */
export async function poolHealth(synthetic: boolean): Promise<PoolHealth> {
  const db = poolDb();
  const [tot, payers, codes] = await Promise.all([
    db.query(`SELECT count(DISTINCT c.id)::int AS claims, count(l.id)::int AS lines, count(DISTINCT c.contributor)::int AS contributors
                FROM pool.claims c LEFT JOIN pool.claim_lines l ON l.claim_id = c.id WHERE c.is_synthetic = $1`, [synthetic]),
    db.query(`SELECT c.payer, count(DISTINCT c.id)::int AS claims, count(DISTINCT c.contributor)::int AS practices,
                     count(l.id)::int AS lines, count(l.id) FILTER (WHERE l.denied)::int AS denied_lines
                FROM pool.claims c JOIN pool.claim_lines l ON l.claim_id = c.id WHERE c.is_synthetic = $1
               GROUP BY c.payer ORDER BY claims DESC`, [synthetic]),
    db.query(`SELECT l.cdt, count(*)::int AS lines, count(DISTINCT c.contributor)::int AS practices,
                     count(*) FILTER (WHERE l.denied)::int AS denied
                FROM pool.claims c JOIN pool.claim_lines l ON l.claim_id = c.id WHERE c.is_synthetic = $1
               GROUP BY l.cdt ORDER BY lines DESC`, [synthetic]),
  ]);
  return {
    ...tot.rows[0],
    byPayer: payers.rows.map((x) => ({ payer: x.payer, claims: x.claims, practices: x.practices, lines: x.lines, deniedLines: x.denied_lines, meetsThreshold: x.practices >= MIN_PRACTICES })),
    byCode: codes.rows.map((x) => ({ ...x, meetsThreshold: x.practices >= MIN_PRACTICES })),
  };
}

/**
 * The denial intelligence engine (Phase 4): mines the de-identified pool for
 * rules like "BlueHarbor denies ceramic crowns 70% of the time without an X-ray".
 *
 * Kinds of rule, each evaluated per insurer × procedure, and per insurer × plan
 * type × procedure when the insurer-wide version doesn't hold:
 *   missing_attachment  denied more often when an attachment is missing
 *   billed_with         denied more often when billed with another procedure (bundling)
 *   frequency           denied more often when it's the 2nd / 3rd+ time in 12 months
 *   usually_denied      denied most of the time regardless (e.g. not covered)
 *
 * A comparison becomes a rule only if it clears the owner's strict bar (stats.ts):
 * both groups have ≥30 procedures from ≥5 practices, and the gap is ≥15 points even
 * at the cautious end of its 95% range. For each rule, the engine also measures
 * which appeal fix won: appeals that supplied the fix vs. those that didn't, using
 * only records whose practices share appeal details (consent v2).
 *
 * Everything here is aggregate SQL over the pool role; results are written to
 * pool.rules as a whole each time.
 */
import { ATTACHMENTS, type Attachment } from "../reference/codes";
import { log } from "../logger";
import { MIN_PRACTICES, poolDb } from "../pool/store";
import { APPEAL_BAR, newcombe, RULE_BAR, strength, wilson, type Difference, type Interval } from "./stats";

export type RuleKind = "missing_attachment" | "billed_with" | "frequency" | "usually_denied";

export interface GroupStats extends Interval { practices: number }

export interface AppealSide extends GroupStats {}

export interface RuleStats {
  kind: RuleKind;
  condition: { attachment?: Attachment; withCdt?: string; freqAtLeast?: 2 | 3 };
  /** Procedures matching the condition (e.g. without the X-ray). */
  cond: GroupStats;
  /** The comparison group (e.g. with the X-ray); null for usually_denied. */
  base: GroupStats | null;
  gap: Difference | null;
  strength: "strong" | "solid";
  topCarc?: string; // e.g. "CO-16"
  topRarc?: string;
  appeal: {
    fix: string; // what counts as the fix, in words
    withFix: AppealSide | null;    // null = not enough appeals to show
    withoutFix: AppealSide | null;
    gap: Difference | null;
  };
}

export interface Rule {
  key: string;
  kind: RuleKind;
  payer: string;
  planType: string | null;
  cdt: string;
  stats: RuleStats;
}

const BASE = `
  SELECT c.contributor, c.payer, c.plan_type, c.attachments, c.outcome, c.appeal_attachments, c.appeal_argument, c.extended,
         l.id AS lid, l.claim_id AS cid, l.cdt, l.denied, l.carcs, l.rarcs, l.freq_bucket
    FROM pool.claims c JOIN pool.claim_lines l ON l.claim_id = c.id
   WHERE c.is_synthetic = $1 AND c.outcome <> 'pending'`;

interface Row { payer: string; cdt: string; plan: string | null; cond: boolean; n: number; k: number; p: number; top_carc: string | null; top_rarc: string | null }

/** Per insurer × procedure (and × plan type) counts, split by a condition. */
async function grouped(synthetic: boolean, cond: string, where = "true", params: unknown[] = []): Promise<Row[]> {
  const r = await poolDb().query(
    `SELECT payer, cdt, CASE WHEN GROUPING(plan_type) = 1 THEN NULL ELSE plan_type END AS plan, cond,
            count(*)::int AS n, count(*) FILTER (WHERE denied)::int AS k, count(DISTINCT contributor)::int AS p,
            mode() WITHIN GROUP (ORDER BY carcs[1]) FILTER (WHERE denied AND cardinality(carcs) > 0) AS top_carc,
            mode() WITHIN GROUP (ORDER BY rarcs[1]) FILTER (WHERE denied AND cardinality(rarcs) > 0) AS top_rarc
       FROM (SELECT x.*, (${cond}) AS cond FROM (${BASE}) x WHERE ${where}) y
      GROUP BY GROUPING SETS ((payer, cdt, cond), (payer, plan_type, cdt, cond))`,
    [synthetic, ...params],
  );
  return r.rows;
}

const stat = (x: { n: number; k: number; p: number }): GroupStats => ({ ...wilson(x.k, x.n), practices: x.p });
const meets = (g: GroupStats | undefined) => !!g && g.n >= RULE_BAR.minProcedures && g.practices >= RULE_BAR.minPractices;

interface Candidate { kind: RuleKind; payer: string; planType: string | null; cdt: string; condition: RuleStats["condition"];
  condSql: string; cond: GroupStats; base: GroupStats | null; gap: Difference | null; topCarc?: string; topRarc?: string }

/** Pairs cond=true/false rows and keeps the comparisons that clear the bar. */
function compare(rows: Row[], kind: RuleKind, condition: RuleStats["condition"], condSql: string): Candidate[] {
  const byKey = new Map<string, { t?: Row; f?: Row }>();
  for (const r of rows) {
    const k = `${r.payer}|${r.plan ?? "*"}|${r.cdt}`;
    const e = byKey.get(k) ?? {};
    if (r.cond) e.t = r; else e.f = r;
    byKey.set(k, e);
  }
  const out: Candidate[] = [];
  for (const { t, f } of byKey.values()) {
    if (!t || !f) continue;
    const cond = stat(t), base = stat(f);
    if (!meets(cond) || !meets(base)) continue;
    const gap = newcombe(cond, base);
    if (gap.lo < RULE_BAR.minGapLowerBound) continue;
    out.push({ kind, payer: t.payer, planType: t.plan, cdt: t.cdt, condition, condSql, cond, base, gap,
      topCarc: t.top_carc ?? undefined, topRarc: t.top_rarc ?? undefined });
  }
  return out;
}

/**
 * An insurer-wide rule makes the same rule per plan type redundant, unless a plan
 * type is clearly worse (≥15 points higher): then the plan-specific rules replace it,
 * so a DHMO-only policy is reported as a DHMO rule.
 */
function preferGeneral(cands: Candidate[]): Candidate[] {
  const id = (c: Candidate) => `${c.kind}|${c.payer}|${c.cdt}|${JSON.stringify(c.condition)}`;
  const general = new Map(cands.filter((c) => c.planType === null).map((c) => [id(c), c]));
  const sharper = new Set(cands.filter((c) => {
    const g = c.planType !== null ? general.get(id(c)) : undefined;
    return g && c.cond.rate - g.cond.rate >= RULE_BAR.minGapLowerBound;
  }).map(id));
  return cands.filter((c) => (c.planType === null ? !sharper.has(id(c)) : !general.has(id(c)) || sharper.has(id(c))
    && c.cond.rate - general.get(id(c))!.cond.rate >= RULE_BAR.minGapLowerBound));
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function missingAttachment(synthetic: boolean): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const a of ATTACHMENTS) {
    const condSql = `NOT (${q(a)} = ANY(attachments))`;
    out.push(...compare(await grouped(synthetic, condSql), "missing_attachment", { attachment: a }, condSql));
  }
  return out;
}

async function frequency(synthetic: boolean): Promise<Candidate[]> {
  const out: Candidate[] = [];
  // 2nd vs 1st within 12 months, and 3rd-or-later vs 1st/2nd: separate questions, so a
  // third-cleaning rule doesn't make "second cleaning" look risky too.
  out.push(...compare(await grouped(synthetic, "freq_bucket = 2", "freq_bucket IN (1, 2)"), "frequency", { freqAtLeast: 2 }, "freq_bucket = 2"));
  out.push(...compare(await grouped(synthetic, "freq_bucket >= 3", "freq_bucket IS NOT NULL"), "frequency", { freqAtLeast: 3 }, "freq_bucket >= 3"));
  return out;
}

async function billedWith(synthetic: boolean): Promise<Candidate[]> {
  // Candidate pairs: procedures often billed together, with a clearly higher denial rate together.
  const pairs = await poolDb().query(
    `WITH x AS (${BASE}),
          together AS (
            SELECT DISTINCT x.lid, x.payer, x.cdt, o.cdt AS with_cdt, x.denied, x.contributor
              FROM x JOIN pool.claim_lines o ON o.claim_id = x.cid AND o.cdt <> x.cdt),
          t AS (SELECT payer, cdt, with_cdt, count(*)::int n, count(*) FILTER (WHERE denied)::int k, count(DISTINCT contributor)::int p
                  FROM together GROUP BY 1, 2, 3),
          tot AS (SELECT payer, cdt, count(*)::int n, count(*) FILTER (WHERE denied)::int k FROM x GROUP BY 1, 2)
     SELECT t.payer, t.cdt, t.with_cdt FROM t JOIN tot USING (payer, cdt)
      WHERE t.n >= $2 AND t.p >= $3 AND tot.n - t.n >= $2
        AND t.k::float / t.n - (tot.k - t.k)::float / (tot.n - t.n) >= $4`,
    [synthetic, RULE_BAR.minProcedures, RULE_BAR.minPractices, RULE_BAR.minGapLowerBound],
  );
  const out: Candidate[] = [];
  for (const pr of pairs.rows as { payer: string; cdt: string; with_cdt: string }[]) {
    const condSql = `EXISTS (SELECT 1 FROM pool.claim_lines o WHERE o.claim_id = x.cid AND o.cdt = ${q(pr.with_cdt)})`;
    const rows = await grouped(synthetic, condSql, `payer = $2 AND cdt = $3`, [pr.payer, pr.cdt]);
    out.push(...compare(rows, "billed_with", { withCdt: pr.with_cdt }, condSql));
  }
  return out;
}

async function usuallyDenied(synthetic: boolean): Promise<Candidate[]> {
  const rows = await grouped(synthetic, "true");
  return rows.map((r) => ({ r, s: stat(r) }))
    .filter(({ s }) => meets(s) && s.lo >= RULE_BAR.usuallyDeniedLowerBound)
    .map(({ r, s }) => ({ kind: "usually_denied" as const, payer: r.payer, planType: r.plan, cdt: r.cdt, condition: {}, condSql: "true",
      cond: s, base: null, gap: null, topCarc: r.top_carc ?? undefined, topRarc: r.top_rarc ?? undefined }));
}

const FIX: Record<RuleKind, (c: Candidate) => { sql: string; label: string }> = {
  missing_attachment: (c) => ({ sql: `${q(c.condition.attachment!)} = ANY(appeal_attachments)`, label: `sent the missing ${c.condition.attachment}` }),
  billed_with: () => ({ sql: `appeal_argument = 'coding_correction'`, label: "argued the coding (documented the separate service)" }),
  frequency: () => ({ sql: `appeal_argument = 'frequency_exception'`, label: "asked for a frequency exception with clinical notes" }),
  usually_denied: () => ({ sql: `appeal_argument = 'coverage_dispute'`, label: "disputed the coverage decision" }),
};

/** Appeal outcomes for denied procedures matching a rule, split by whether the appeal supplied the fix. */
async function appealStats(synthetic: boolean, c: Candidate): Promise<RuleStats["appeal"]> {
  const fix = FIX[c.kind](c);
  const condSql = c.condSql;
  const r = await poolDb().query(
    `SELECT (${fix.sql}) AS fixed, count(*)::int n, count(*) FILTER (WHERE outcome = 'appeal_won')::int k, count(DISTINCT contributor)::int p
       FROM (${BASE}) x
      WHERE payer = $2 AND cdt = $3 AND ($4::text IS NULL OR plan_type = $4) AND (${condSql}) AND denied
        AND outcome IN ('appeal_won', 'appeal_lost')
        AND extended AND (appeal_argument IS NOT NULL OR cardinality(appeal_attachments) > 0)
      GROUP BY 1`,
    [synthetic, c.payer, c.cdt, c.planType],
  );
  const side = (fixed: boolean): AppealSide | null => {
    const row = r.rows.find((x) => x.fixed === fixed);
    if (!row || row.n < APPEAL_BAR.minAppeals || row.p < Math.max(APPEAL_BAR.minPractices, MIN_PRACTICES)) return null;
    return stat(row);
  };
  const withFix = side(true), withoutFix = side(false);
  return { fix: fix.label, withFix, withoutFix, gap: withFix && withoutFix ? newcombe(withFix, withoutFix) : null };
}

export function ruleKey(c: { kind: RuleKind; payer: string; planType: string | null; cdt: string; condition: RuleStats["condition"] }): string {
  const cond = c.condition.attachment ?? c.condition.withCdt ?? (c.condition.freqAtLeast ? `freq${c.condition.freqAtLeast}` : "all");
  return `${c.kind}:${c.payer}:${c.planType ?? "*"}:${c.cdt}:${cond}`;
}

/** Finds every rule in the pool (synthetic and live are always separate). */
export async function findRules(synthetic: boolean): Promise<Rule[]> {
  const specific = preferGeneral([
    ...(await missingAttachment(synthetic)),
    ...(await billedWith(synthetic)),
    ...(await frequency(synthetic)),
  ]);
  // "Usually denied" only where no more specific rule explains the denials.
  const explained = new Set(specific.map((c) => `${c.payer}|${c.cdt}`));
  const usual = preferGeneral(await usuallyDenied(synthetic)).filter((c) => !explained.has(`${c.payer}|${c.cdt}`));
  const all = [...specific, ...usual];
  const rules: Rule[] = [];
  for (const c of all) {
    rules.push({
      key: ruleKey(c), kind: c.kind, payer: c.payer, planType: c.planType, cdt: c.cdt,
      stats: { kind: c.kind, condition: c.condition, cond: c.cond, base: c.base, gap: c.gap,
        strength: c.gap ? strength(c.gap.lo) : c.cond.lo >= 0.75 ? "strong" : "solid",
        topCarc: c.topCarc, topRarc: c.topRarc, appeal: await appealStats(synthetic, c) },
    });
  }
  return rules.sort((a, b) => (b.stats.gap?.diff ?? b.stats.cond.rate) - (a.stats.gap?.diff ?? a.stats.cond.rate));
}

/** Recomputes and replaces the stored rules. Returns how many were found. */
export async function rebuildRules(synthetic: boolean): Promise<number> {
  const started = Date.now();
  const rules = await findRules(synthetic);
  const client = await poolDb().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM pool.rules WHERE is_synthetic = $1", [synthetic]);
    for (const r of rules) {
      await client.query(
        "INSERT INTO pool.rules (rule_key, kind, payer, plan_type, cdt, stats, is_synthetic) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [r.key, r.kind, r.payer, r.planType, r.cdt, JSON.stringify(r.stats), synthetic],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  log.info({ event: "intel.rebuild", count: rules.length, durationMs: Date.now() - started, outcome: synthetic ? "synthetic" : "live" });
  return rules.length;
}

export interface RuleFilter { synthetic: boolean; payers?: string[]; cdts?: string[]; planType?: string; kind?: RuleKind }

export async function listRules(f: RuleFilter): Promise<(Rule & { computedAt: Date })[]> {
  const r = await poolDb().query(
    `SELECT rule_key, kind, payer, plan_type, cdt, stats, computed_at FROM pool.rules
      WHERE is_synthetic = $1 AND ($2::text[] IS NULL OR payer = ANY($2)) AND ($3::text[] IS NULL OR cdt = ANY($3))
        AND ($4::text IS NULL OR plan_type IS NULL OR plan_type = $4) AND ($5::text IS NULL OR kind = $5)
      ORDER BY coalesce((stats->'gap'->>'diff')::float, (stats->'cond'->>'rate')::float) DESC`,
    [f.synthetic, f.payers?.length ? f.payers : null, f.cdts?.length ? f.cdts : null, f.planType ?? null, f.kind ?? null],
  );
  return r.rows.map((x) => ({ key: x.rule_key, kind: x.kind, payer: x.payer, planType: x.plan_type, cdt: x.cdt, stats: x.stats, computedAt: x.computed_at }));
}

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, withPractice } from "@/lib/db";
import { boss } from "@/lib/jobs";
import { assertSafeHarbor, DeidentificationError, toPoolRecord, type ClaimForPool, type PoolRecord } from "@/lib/pool/deidentify";
import { poolInsights } from "@/lib/pool/insights";
import { denialRatesByPayerCode, MIN_PRACTICES, poolDb, poolHealth } from "@/lib/pool/store";
import { decidePool, syncPractice } from "@/lib/pool/sync";
import { generateDataset } from "@/lib/synthetic/generator";
import { loadSyntheticDataset } from "@/lib/synthetic/load";
import { appQuery, ownerQuery } from "./helpers";

const ctx = (practiceId: string) => ({ practiceId, userId: "00000000-0000-0000-0000-0000000000bb", email: "owner@test.invalid" });
const poolQuery = async (sql: string, params: unknown[] = []) => poolDb().query(sql, params);
let practices: { id: string; name: string; state: string }[] = [];

beforeAll(async () => {
  const r = await loadSyntheticDataset({ seed: 77, practices: 6, patientsPerPractice: 40 });
  practices = r.practices;
});
afterAll(async () => {
  await (await boss()).stop({ graceful: false });
});

// ---------------------------------------------------------------- de-identification (pure)

function claimsForPool(): { input: ClaimForPool; phi: string[] }[] {
  const [data] = generateDataset({ seed: 3, practices: 1, patientsPerPractice: 60 });
  return data.patients.flatMap((p) => p.claims.map((c) => ({
    phi: [p.firstName, p.lastName, p.memberId, p.dob, c.claimNumber, c.serviceDate.toISOString().slice(0, 10)],
    input: {
      planType: c.planType, status: c.status, appealStatus: c.appealStatus, submittedAt: c.submittedAt, adjudicatedAt: c.adjudicatedAt,
      paidCents: c.lines.reduce((s, l) => s + l.paidCents, 0), attachments: c.attachments, isSynthetic: true,
      payer: { name: "Summit Dental Mutual", verified: true },
      lines: c.lines.map((l, i) => ({ id: `L${i}`, cdtCode: l.cdtCode })),
      denials: c.denials.map((d) => ({ claimLineId: `L${d.lineIndex}`, groupCode: d.groupCode, carc: d.carc, rarc: d.rarc ?? null })),
    },
  })));
}
const ids = () => ({ id: crypto.randomUUID(), contributor: crypto.randomUUID(), region: "TX" });

describe("de-identification (Safe Harbor)", () => {
  it("builds records with only the agreed fields and none of the patient's details or dates", () => {
    for (const { input, phi } of claimsForPool()) {
      const out = toPoolRecord(input, ids());
      if (!("record" in out)) throw new Error("expected a record");
      const json = JSON.stringify(out.record);
      for (const v of phi) expect(json).not.toContain(v);
      expect(json).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/); // no dates of any kind
      expect(Object.keys(out.record).sort()).toEqual(["attachments", "contributor", "daysToPayment", "id", "isSynthetic", "lines", "outcome", "payer", "planType", "region"]);
    }
  });

  it("keeps denial codes per procedure and an outcome", () => {
    const denied = claimsForPool().find(({ input }) => input.denials.length)!;
    const out = toPoolRecord(denied.input, ids());
    if (!("record" in out)) throw new Error("expected a record");
    expect(out.record.lines.some((l) => l.denied && l.carcs.length > 0)).toBe(true);
    expect(["denied", "partially_paid", "appeal_won", "appeal_lost"]).toContain(out.record.outcome);
  });

  it("holds back claims whose insurer name isn't verified (a mis-mapped column can't leak a name)", () => {
    const { input } = claimsForPool()[0];
    expect(toPoolRecord({ ...input, payer: { name: "Jane Smith", verified: false } }, ids())).toEqual({ skip: "unverified_payer" });
  });

  it("the validator rejects anything that doesn't fit the allowlist", () => {
    const out = toPoolRecord(claimsForPool()[0].input, ids());
    if (!("record" in out)) throw new Error("expected a record");
    const good = out.record;
    const bad: Partial<PoolRecord & Record<string, unknown>>[] = [
      { patientName: "Jane Smith" }, { region: "Austin" }, { payer: "12345678" }, { id: "claim-1" },
      { daysToPayment: 5000 }, { lines: [{ cdt: "D1110", denied: true, carcs: ["16 lacks info"], rarcs: [] }] },
    ];
    for (const b of bad) expect(() => assertSafeHarbor({ ...good, ...b } as PoolRecord)).toThrow(DeidentificationError);
    expect(() => assertSafeHarbor(good)).not.toThrow();
  });
});

// ---------------------------------------------------------------- isolation (database roles)

describe("pool isolation", () => {
  it("the application role can't read the pool", async () => {
    await expect(appQuery("select count(*) from pool.claims")).rejects.toThrow(/permission denied/);
  });

  it("the pool role can't read practice data", async () => {
    for (const t of ["patients", "claims", "claim_lines", "denials", "practices", "users", "import_batches", "result_events"]) {
      await expect(poolQuery(`select * from public.${t} limit 1`)).rejects.toThrow(/permission denied/);
    }
  });

  it("pool rows can't be edited in place", async () => {
    await expect(poolQuery("update pool.claims set payer = 'x'")).rejects.toThrow(/permission denied/);
  });

  it("the database itself rejects malformed rows", async () => {
    await expect(poolQuery(`insert into pool.claims (id, contributor, payer, plan_type, region, outcome)
      values (gen_random_uuid(), gen_random_uuid(), 'Summit', 'PPO', 'Austin', 'paid')`)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- opt-in, sync, threshold, opt-out

describe("sharing with the pool", () => {
  it("nothing is shared before the owner decides", async () => {
    expect((await poolQuery("select count(*)::int n from pool.claims")).rows[0].n).toBe(0);
    expect(await poolInsights(practices[0].id)).toEqual({ allowed: false, reason: "not_contributing" });
  });

  it("opting in shares the last 12 months, with a random token instead of the practice id", async () => {
    for (const p of practices.slice(0, 5)) await decidePool(ctx(p.id), true, { runNow: true });
    const rows = (await poolQuery("select id, contributor from pool.claims")).rows;
    expect(rows.length).toBeGreaterThan(0);
    const practiceIds = new Set(practices.map((p) => p.id));
    const claimIds = new Set((await ownerQuery("select id from claims")).rows.map((r) => r.id));
    for (const r of rows) {
      expect(practiceIds.has(r.contributor)).toBe(false);
      expect(claimIds.has(r.id)).toBe(false);
    }
    const shared = (await prisma().practice.findMany({ where: { id: { in: practices.slice(0, 5).map((p) => p.id) } } })).reduce((s, p) => s + p.poolShared, 0);
    expect(shared).toBe(rows.length);
    const consent = await prisma().practice.findUniqueOrThrow({ where: { id: practices[0].id } });
    expect(consent.poolDecidedAt).not.toBeNull();
    expect(consent.poolConsentVersion).toBeTruthy();
  });

  it("patterns are shown only when at least 5 practices contributed, and only to contributors", async () => {
    const rows = await denialRatesByPayerCode({ synthetic: true, limit: 500 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.practices >= MIN_PRACTICES)).toBe(true);
    const insights = await poolInsights(practices[0].id);
    expect(insights.allowed).toBe(true);
    // Practice 6 didn't opt in: it sees nothing from the pool.
    expect((await poolInsights(practices[5].id)).allowed).toBe(false);
    // Live practices never see synthetic data.
    expect(await denialRatesByPayerCode({ synthetic: false })).toEqual([]);
  });

  it("filters narrow the list, and the 5-practice minimum is re-checked on the filtered group", async () => {
    const all = await denialRatesByPayerCode({ synthetic: true, limit: 500 });
    const payer = all[0].payer;
    const byPayer = await denialRatesByPayerCode({ synthetic: true, payers: [payer], limit: 500 });
    expect(byPayer.length).toBeGreaterThan(0);
    expect(byPayer.every((r) => r.payer === payer)).toBe(true);
    const byCode = await denialRatesByPayerCode({ synthetic: true, cdt: "D1110", limit: 500 });
    expect(byCode.every((r) => r.cdt === "D1110")).toBe(true);
    expect((await denialRatesByPayerCode({ synthetic: true, minLines: 50, limit: 500 })).every((r) => r.lines >= 50)).toBe(true);

    // Find an insurer × procedure that clears 5 practices overall but not within one plan type:
    // with that plan filter it must disappear, never show with fewer practices.
    const perPlan = (await poolQuery(`
      SELECT c.payer, l.cdt, c.plan_type, count(DISTINCT c.contributor)::int AS practices
        FROM pool.claims c JOIN pool.claim_lines l ON l.claim_id = c.id
       WHERE c.is_synthetic AND c.outcome <> 'pending' GROUP BY 1, 2, 3`)).rows;
    const thin = perPlan.find((x) => x.practices < MIN_PRACTICES && all.some((a) => a.payer === x.payer && a.cdt === x.cdt));
    expect(thin, "expected at least one group that only passes the minimum when plan types are combined").toBeTruthy();
    const filtered = await denialRatesByPayerCode({ synthetic: true, planType: thin.plan_type, limit: 500 });
    expect(filtered.some((r) => r.payer === thin.payer && r.cdt === thin.cdt)).toBe(false);
    expect(filtered.every((r) => r.practices >= MIN_PRACTICES)).toBe(true);

    const insights = await poolInsights(practices[0].id, { mine: true });
    if (!insights.allowed) throw new Error("expected access");
    expect(insights.denialRates.every((r) => insights.options.myPayers.includes(r.payer))).toBe(true);
  });

  it("a changed claim replaces its pool record instead of adding another", async () => {
    const p = practices[0];
    const before = (await poolQuery("select count(*)::int n from pool.claims")).rows[0].n;
    const claim = await withPractice(p.id, (tx) => tx.claim.findFirstOrThrow({ where: { poolRecordId: { not: null }, status: "paid" } }));
    await withPractice(p.id, (tx) => tx.claim.update({ where: { id: claim.id }, data: { status: "denied", appealStatus: "lost" } }));
    await syncPractice(p.id);
    expect((await poolQuery("select count(*)::int n from pool.claims")).rows[0].n).toBe(before);
    expect((await poolQuery("select outcome from pool.claims where id = $1", [claim.poolRecordId])).rows[0].outcome).toBe("appeal_lost");
  });

  it("opting out removes everything the practice shared, and patterns under the threshold disappear", async () => {
    const p = await prisma().practice.findUniqueOrThrow({ where: { id: practices[4].id } });
    const token = p.poolToken!;
    expect((await poolQuery("select count(*)::int n from pool.claims where contributor = $1", [token])).rows[0].n).toBeGreaterThan(0);
    const { removed } = await decidePool(ctx(p.id), false);
    expect(removed).toBeGreaterThan(0);
    expect((await poolQuery("select count(*)::int n from pool.claims where contributor = $1", [token])).rows[0].n).toBe(0);
    const after = await prisma().practice.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.poolToken).toBeNull();
    expect(after.poolOptIn).toBe(false);
    expect(await withPractice(p.id, (tx) => tx.claim.count({ where: { poolRecordId: { not: null } } }))).toBe(0);
    // Only 4 contributors are left, so no pattern meets the 5-practice minimum.
    expect(await denialRatesByPayerCode({ synthetic: true, limit: 500 })).toEqual([]);
    // And a sync after opting out writes nothing back.
    await syncPractice(p.id, { full: true });
    expect((await poolQuery("select count(*)::int n from pool.claims where contributor = $1", [token])).rows[0].n).toBe(0);
  });

  it("the admin health view counts records per payer and per code", async () => {
    const h = await poolHealth(true);
    expect(h.contributors).toBe(4);
    expect(h.byPayer.length).toBeGreaterThan(0);
    expect(h.byCode.every((c) => c.meetsThreshold === c.practices >= MIN_PRACTICES)).toBe(true);
  });

  it("the audit log records each decision", async () => {
    const rows = (await ownerQuery("select action from audit_events where action like 'practice.pool_%'")).rows.map((r) => r.action);
    expect(rows.filter((a) => a === "practice.pool_opt_in")).toHaveLength(5);
    expect(rows).toContain("practice.pool_opt_out");
  });
});


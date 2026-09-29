import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPractice } from "@/lib/db";
import { createImport, processBatch } from "@/lib/ingest/pipeline";
import { mergeClaims } from "@/lib/ingest/merge";
import { rebuildRules } from "@/lib/intel/engine";
import { boss } from "@/lib/jobs";
import { moneySummary } from "@/lib/money";
import { poolDb } from "@/lib/pool/store";
import { decidePool } from "@/lib/pool/sync";
import { keysFor } from "@/lib/practices";
import { basicChecks, combine } from "@/lib/precheck/basic";
import { afterImport, markFixed, runCheck } from "@/lib/precheck/check";
import { checkEnteredClaim, type EntryInput } from "@/lib/precheck/entry";
import { resultsSummary } from "@/lib/results/ledger";
import { loadSyntheticDataset } from "@/lib/synthetic/load";
import { generateDataset } from "@/lib/synthetic/generator";
import { build837 } from "@/lib/synthetic/files";

const ctx = (practiceId: string) => ({ practiceId, userId: "00000000-0000-0000-0000-0000000000dd", email: "biller@test.invalid" });
let practices: { id: string }[] = [];
const today = new Date().toISOString().slice(0, 10);
const entry = (over: Partial<EntryInput>): EntryInput => ({
  firstName: "Tess", lastName: "Checkwell", dob: "1980-05-05", payer: "Summit Dental Mutual", planType: "PPO", serviceDate: today,
  attachments: [], lines: [{ cdt: "D4341", fee: "250.00" }, { cdt: "D4341", fee: "250.00" }], ...over,
});

beforeAll(async () => {
  const r = await loadSyntheticDataset({ seed: 2026, practices: 12, patientsPerPractice: 450 });
  practices = r.practices;
  for (const p of practices.slice(1)) await decidePool(ctx(p.id), true, { runNow: true });
  await rebuildRules(true);
}, 240_000);

afterAll(async () => {
  for (const p of practices) await decidePool(ctx(p.id), false).catch(() => undefined);
  await poolDb().query("DELETE FROM pool.rules WHERE is_synthetic");
  await (await boss()).stop({ graceful: false });
}, 120_000);

describe("basic checks (no pool needed)", () => {
  const sd = new Date("2026-06-01T00:00:00Z");
  const now = new Date("2026-06-10T00:00:00Z");
  it("flags missing tooth numbers and surfaces", () => {
    const f = basicChecks({ id: "c", serviceDate: sd, lines: [
      { id: "a", cdtCode: "D2740", tooth: null, surfaces: null, feeCents: 100000 },
      { id: "b", cdtCode: "D2391", tooth: "3", surfaces: null, feeCents: 20000 },
    ] }, [], now);
    expect(f.map((x) => x.kind).sort()).toEqual(["missing_surface", "missing_tooth"]);
  });
  it("flags duplicates, typical frequency limits and the filing deadline", () => {
    const history = [
      { claimId: "old1", serviceDate: new Date("2026-01-10T00:00:00Z"), cdtCode: "D1110", tooth: null, status: "paid" },
      { claimId: "old2", serviceDate: new Date("2026-04-10T00:00:00Z"), cdtCode: "D1110", tooth: null, status: "paid" },
      { claimId: "same", serviceDate: sd, cdtCode: "D0120", tooth: null, status: "submitted" },
    ];
    const f = basicChecks({ id: "c", serviceDate: sd, lines: [
      { id: "a", cdtCode: "D1110", tooth: null, surfaces: null, feeCents: 10000 },
      { id: "b", cdtCode: "D0120", tooth: null, surfaces: null, feeCents: 6000 },
    ] }, history, now);
    expect(f.find((x) => x.lineId === "a")?.kind).toBe("frequency");
    expect(f.find((x) => x.lineId === "b")?.kind).toBe("duplicate");
    const late = basicChecks({ id: "c", serviceDate: new Date("2025-01-01T00:00:00Z"), lines: [{ id: "a", cdtCode: "D0120", tooth: null, surfaces: null, feeCents: 1 }] }, [], now);
    expect(late[0].kind).toBe("timely_filing");
    expect(late[0].probability).toBeGreaterThan(0.5);
  });
  it("combines independent risks", () => {
    expect(combine([0.5, 0.5])).toBeCloseTo(0.75);
    expect(combine([])).toBe(0);
  });
});

describe("pre-submission check", () => {
  it("scores a risky claim with the pooled rule, the fix and the money at stake", async () => {
    const r = await checkEnteredClaim(ctx(practices[3].id), entry({ claimNumber: "PRE-1001" }));
    expect(r.pooled).toBe(true);
    const f = await withPractice(practices[3].id, (tx) => tx.checkFinding.findMany({ where: { claimId: r.claimId } }));
    const rule = f.find((x) => x.kind === "pool_rule");
    expect(rule?.attachment).toBe("perio_chart");
    expect(rule?.probability).toBeGreaterThan(0.7);
    expect(rule?.detail).toMatch(/\d+ procedures from \d+ practices, 95% range/);
    expect(r.risk).toBeGreaterThan(0.7);
    expect(r.atRiskCents).toBeGreaterThan(30000); // most of the $500 is at risk
    const claim = await withPractice(practices[3].id, (tx) => tx.claim.findUniqueOrThrow({ where: { id: r.claimId } }));
    expect(claim.status).toBe("draft");
  });

  it("ticking the fix adds the attachment, and the risk drops", async () => {
    const p = practices[3].id;
    const claim = await withPractice(p, (tx) => tx.claim.findFirstOrThrow({ where: { status: "draft", findings: { some: { kind: "pool_rule" } } }, include: { findings: true } }));
    const before = claim.atRiskCents!;
    await markFixed(ctx(p), claim.findings.find((f) => f.kind === "pool_rule")!.id);
    const after = await withPractice(p, (tx) => tx.claim.findUniqueOrThrow({ where: { id: claim.id }, include: { findings: true } }));
    expect(after.attachments).toContain("perio_chart");
    expect(after.findings.find((f) => f.kind === "pool_rule")?.status).toBe("fixed_by_user");
    expect(after.atRiskCents!).toBeLessThan(before / 3);
    // With the chart attached, the lines are scored at the "with a perio chart" rate (a few percent).
    expect(after.atRiskCents!).toBeLessThan(5000);
  });

  it("when the fixed claim is paid, the money is credited as protected (not billable)", async () => {
    const p = practices[3].id;
    const keys = await keysFor(p);
    const claim = await withPractice(p, (tx) => tx.claim.findFirstOrThrow({ where: { findings: { some: { status: "fixed_by_user" } } }, include: { payer: true } }));
    const s = await withPractice(p, (tx) => mergeClaims(tx, keys, [{
      source: "era835", claimNumber: "PRE-1001", patient: { lastName: "Checkwell" }, payer: { name: claim.payer.name, payerId: claim.payer.payerCode },
      adjudicatedAt: today, status: "paid", paidCents: 40000, billedCents: 50000, claimDenials: [], ref: "t",
      lines: [{ cdtCode: "D4341", feeCents: 25000, paidCents: 20000, denials: [] }, { cdtCode: "D4341", feeCents: 25000, paidCents: 20000, denials: [] }],
    }], { isSynthetic: true }));
    await afterImport(p, s.claimIds);
    const res = await resultsSummary(p, new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000));
    const row = res.rows.find((r) => r.kind === "protected" && r.method === "attachment_added_before_sending" && r.amountCents === 40000);
    expect(row?.attributed).toBe(true);
    // Protected money is shown, never counted as recovered (never billed).
    expect(res.rows.filter((r) => r.kind === "recovered" && r.claimRef === row!.claimRef)).toHaveLength(0);
  });

  it("a resubmitted 837 that carries the fix is detected automatically, and the draft becomes submitted", async () => {
    const p = practices[4].id;
    const r = await checkEnteredClaim(ctx(p), entry({ lastName: "Autodetect", payer: "BlueHarbor Dental", claimNumber: "PRE-2002",
      lines: [{ cdt: "D2740", tooth: "14", fee: "1200.00" }] }));
    const open = await withPractice(p, (tx) => tx.checkFinding.findFirstOrThrow({ where: { claimId: r.claimId, kind: "pool_rule" } }));
    expect(open.attachment).toBe("xray");
    const keys = await keysFor(p);
    const s = await withPractice(p, (tx) => mergeClaims(tx, keys, [{
      source: "claim837", claimNumber: "PRE-2002", patient: { lastName: "Autodetect", firstName: "Tess", dob: "1980-05-05" },
      payer: { name: "BlueHarbor Dental", payerId: "SYN02" }, serviceDate: today, attachments: ["xray"], status: "submitted", claimDenials: [], ref: "t",
      lines: [{ cdtCode: "D2740", tooth: "14", feeCents: 120000, denials: [] }],
    }], { isSynthetic: true }));
    await afterImport(p, s.claimIds);
    const after = await withPractice(p, (tx) => tx.claim.findUniqueOrThrow({ where: { id: r.claimId }, include: { findings: true } }));
    expect(after.status).toBe("submitted");
    expect(after.findings.find((f) => f.id === open.id)?.status).toBe("fixed_detected");
  });

  it("practices that don't share get the basic checks only", async () => {
    const p = practices[0].id; // never opted in
    const r = await checkEnteredClaim(ctx(p), entry({ lastName: "Basiconly", lines: [{ cdt: "D2740", fee: "1200" }], payer: "BlueHarbor Dental" }));
    expect(r.pooled).toBe(false);
    const f = await withPractice(p, (tx) => tx.checkFinding.findMany({ where: { claimId: r.claimId } }));
    expect(f.every((x) => x.source === "basic")).toBe(true);
    expect(f.map((x) => x.kind)).toContain("missing_tooth");
  });

  it("an 837 uploaded to check before sending creates draft claims and totals the money at risk", async () => {
    const p = practices[5].id;
    const [data] = generateDataset({ seed: 99, practices: 1, patientsPerPractice: 40, claimPrefix: "PSB" });
    const up = await createImport(ctx(p), "outgoing.837", new TextEncoder().encode(build837(data)), { purpose: "precheck" });
    await processBatch(p, up.batchId);
    const b = await withPractice(p, (tx) => tx.importBatch.findUniqueOrThrow({ where: { id: up.batchId } }));
    expect(b.purpose).toBe("precheck");
    expect(b.status).toBe("done");
    expect(b.atRiskCents).toBeGreaterThan(0);
    expect(b.riskyClaims).toBeGreaterThan(0);
    const drafts = await withPractice(p, (tx) => tx.claim.count({ where: { status: "draft", precheckedAt: { not: null } } }));
    expect(drafts).toBe(b.claimsCreated);
    expect(b.checkedClaimIds).toHaveLength(b.claimsCreated);
    // Drafts aren't counted as billed money until they're sent.
    const m = await moneySummary(p);
    const sent = await withPractice(p, (tx) => tx.claim.count({ where: { status: { not: "draft" }, serviceDate: { gte: new Date(Date.now() - 365 * 86_400_000) } } }));
    expect(m.claims).toBe(sent);
  }, 120_000);

  it("rejects a pre-send check for anything but an 837", async () => {
    await expect(createImport(ctx(practices[5].id), "x.csv", new TextEncoder().encode("a,b\n1,2"), { purpose: "precheck" })).rejects.toThrow(/837D/);
  });

  it("findings are invisible to other practices", async () => {
    const mine = await withPractice(practices[3].id, (tx) => tx.checkFinding.count());
    expect(mine).toBeGreaterThan(0);
    await withPractice(practices[6].id, async (tx) => {
      const ids = (await withPractice(practices[3].id, (t2) => t2.checkFinding.findMany({ select: { id: true } }))).map((x) => x.id);
      expect(await tx.checkFinding.count({ where: { id: { in: ids } } })).toBe(0);
    });
  });

  it("re-running the check never re-opens a fix", async () => {
    const p = practices[3].id;
    const claim = await withPractice(p, (tx) => tx.claim.findFirstOrThrow({ where: { findings: { some: { status: "fixed_by_user" } } } }));
    await runCheck(p, claim.id);
    const f = await withPractice(p, (tx) => tx.checkFinding.findMany({ where: { claimId: claim.id, kind: "pool_rule" } }));
    expect(f.map((x) => x.status)).toEqual(["fixed_by_user"]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, withPractice } from "@/lib/db";
import { confirmMapping, createImport, mappingPreview, processBatch } from "@/lib/ingest/pipeline";
import { boss } from "@/lib/jobs";
import { createPractice, keysFor } from "@/lib/practices";
import { APPEAL_WINDOW_DAYS, opportunityReport } from "@/lib/reports/opportunity";
import { opportunityPdf } from "@/lib/reports/opportunity-pdf";
import { setupSteps } from "@/lib/setup";
import { generateDataset } from "@/lib/synthetic/generator";
import { build835, buildAgingCsv } from "@/lib/synthetic/files";
import { loadSyntheticDataset } from "@/lib/synthetic/load";

const ctx = (practiceId: string) => ({ practiceId, userId: "00000000-0000-0000-0000-0000000000f1", email: "owner@test.invalid" });
let synthetic: string;

beforeAll(async () => {
  synthetic = (await loadSyntheticDataset({ seed: 808, practices: 1, patientsPerPractice: 200 })).practices[0].id;
}, 120_000);
afterAll(async () => { await (await boss()).stop({ graceful: false }).catch(() => undefined); });

describe("guided setup", () => {
  it("tracks each step from what's actually been done", async () => {
    const p = (await createPractice({ name: "Setup Test Dental", state: "OR", isSynthetic: true })).id;
    let s = await setupSteps(p);
    const done = (k: string) => s.steps.find((x) => x.key === k)!.done;
    expect(done("account")).toBe(true);
    expect(["pool", "letterhead", "aging", "era835", "report"].every((k) => !done(k))).toBe(true);
    expect(s.complete).toBe(false);

    await prisma().practice.update({ where: { id: p }, data: {
      poolDecidedAt: new Date(), addressLine1: "1 Test St", city: "Salem", zip: "97301", phone: "555-010-0199", npi: "1234567893", signerName: "Pat Doe",
      setupSkipped: ["team", "claim837"],
    } });
    const [data] = generateDataset({ seed: 5, practices: 1, patientsPerPractice: 30, claimPrefix: "SET" });
    for (const [name, body] of [["aging.csv", buildAgingCsv(data, "dentrix")], ["remit.835", build835(data)]] as const) {
      const up = await createImport(ctx(p), name, new TextEncoder().encode(body));
      // A new aging layout is confirmed once, as the office would on the mapping screen.
      if (up.needsMapping) expect(await confirmMapping(ctx(p), up.batchId, (await mappingPreview(ctx(p), up.batchId)).suggestion.mapping)).toBeUndefined();
      await processBatch(p, up.batchId);
    }
    s = await setupSteps(p);
    expect(s.left).toBe(1); // only the report is left
    expect(s.steps.find((x) => x.key === "team")!.skipped).toBe(true);
    await prisma().practice.update({ where: { id: p }, data: { reportViewedAt: new Date() } });
    expect((await setupSteps(p)).complete).toBe(true);
  }, 120_000);
});

describe("money left on the table", () => {
  it("adds up, ranks by expected value, and only lists what can still be appealed", async () => {
    const now = new Date();
    const r = await opportunityReport(synthetic, now);
    expect(r.deniedCents).toBeGreaterThan(0);
    expect(r.recoverable.items.length).toBeGreaterThan(0);
    expect(r.recoverable.deniedCents + r.tooLateCents + r.underAppealCents).toBeLessThanOrEqual(r.deniedCents);
    for (let i = 1; i < r.recoverable.items.length; i++) expect(r.recoverable.items[i - 1].expectedCents).toBeGreaterThanOrEqual(r.recoverable.items[i].expectedCents);
    for (const i of r.recoverable.items) {
      expect(i.daysLeft).toBeGreaterThan(0);
      expect(i.daysLeft).toBeLessThanOrEqual(APPEAL_WINDOW_DAYS);
      expect(i.expectedCents).toBe(Math.round(i.deniedCents * i.likelihood));
    }
    const listed = await withPractice(synthetic, (tx) => tx.claim.findMany({ where: { id: { in: r.recoverable.items.map((i) => i.claimId) } }, select: { appealStatus: true } }));
    expect(listed.every((c) => c.appealStatus === "none" || c.appealStatus === "drafted")).toBe(true);
  });

  it("non-sharers get causes from the denial codes (typical rates), each with a fix", async () => {
    const r = await opportunityReport(synthetic);
    expect(r.pooled).toBe(false);
    expect(r.preventable.groups.length).toBeGreaterThan(0);
    expect(r.preventable.groups.every((g) => g.source === "basic" && g.fix && g.avoidableCents <= g.deniedCents)).toBe(true);
    expect(r.recoverable.items.every((i) => i.source === "typical")).toBe(true);
  });

  it("the PDF carries no patient details", async () => {
    const r = await opportunityReport(synthetic);
    const pdf = await opportunityPdf("Synthetic Practice", r);
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
    const keys = await keysFor(synthetic);
    const text = Buffer.from(pdf).toString("latin1");
    const pts = await withPractice(synthetic, (tx) => tx.patient.findMany({ where: { claims: { some: { id: { in: r.recoverable.items.slice(0, 20).map((i) => i.claimId) } } } } }));
    for (const pt of pts) expect(text.includes(keys.decrypt("patients", "last_name", pt.id, pt.lastNameEnc))).toBe(false);
  });
});

describe("readiness checks", () => {
  it("pass the database security checks, and flag what a development setup is missing", async () => {
    const { automatedChecks } = await import("@/lib/readiness");
    const c = new Map((await automatedChecks()).map((x) => [x.key, x]));
    expect(c.get("db_role")!.ok).toBe(true);
    expect(c.get("rls")!.ok).toBe(true);
    expect(c.get("audit")!.ok).toBe(true);
    expect(c.get("kms")!.ok).toBe(false); // tests use the local key provider
    expect(c.get("env")!.ok).toBe(false);
    expect(c.get("synthetic")!.ok).toBe(false);
  });
});

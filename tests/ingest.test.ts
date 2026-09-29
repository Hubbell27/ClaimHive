import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPractice } from "@/lib/db";
import { acceptReview, confirmMapping, createImport, ImportError, processBatch, purgeOldFiles, reviewDetail } from "@/lib/ingest/pipeline";
import { boss } from "@/lib/jobs";
import { mergeClaims } from "@/lib/ingest/merge";
import { createPractice, keysFor } from "@/lib/practices";
import { resultsSummary } from "@/lib/results/ledger";
import { ensureSyntheticPayers } from "@/lib/synthetic/load";
import { generateDataset } from "@/lib/synthetic/generator";
import { build835, build837, buildAgingCsv, buildEobPdf } from "@/lib/synthetic/files";
import { appQuery, ownerQuery } from "./helpers";

const [data] = generateDataset({ seed: 5, practices: 1, patientsPerPractice: 30, endDate: new Date("2026-06-01") });
const claims = data.patients.flatMap((p) => p.claims.map((c) => ({ p, c })));
const enc = (s: string) => new TextEncoder().encode(s);
let practiceId: string;
let other: string;
const ctx = () => ({ practiceId, userId: "00000000-0000-0000-0000-0000000000aa", email: "biller@test.invalid" });

async function run(name: string, bytes: Uint8Array, c = ctx()) {
  const r = await createImport(c, name, bytes);
  if (!r.needsMapping) await processBatch(c.practiceId, r.batchId);
  return r;
}
const batch = (id: string) => withPractice(practiceId, (tx) => tx.importBatch.findUniqueOrThrow({ where: { id } }));

beforeAll(async () => {
  await ensureSyntheticPayers();
  practiceId = (await createPractice({ name: "Import Test Dental", state: "TX", isSynthetic: true })).id;
  other = (await createPractice({ name: "Other Practice", state: "OH", isSynthetic: true })).id;
});
afterAll(async () => (await boss()).stop({ graceful: false }));

describe("import pipeline", () => {
  it("837D creates claims with procedures, teeth and attachments", async () => {
    const r = await run("claims.837", enc(build837(data)));
    const b = await batch(r.batchId);
    expect(b.status).toBe("done");
    expect(b.claimsCreated).toBe(claims.length);
    const stored = await withPractice(practiceId, (tx) => tx.claim.findMany({ include: { lines: true } }));
    expect(stored).toHaveLength(claims.length);
    expect(stored.reduce((s, c) => s + c.lines.length, 0)).toBe(claims.reduce((s, { c }) => s + c.lines.length, 0));
    expect(stored.every((c) => c.status === "submitted" && c.sources.includes("claim837"))).toBe(true);
  });

  it("835 updates the same claims with payments and denials (no duplicates)", async () => {
    const r = await run("era.835", enc(build835(data)));
    const b = await batch(r.batchId);
    expect(b.claimsCreated).toBe(0);
    expect(b.claimsUpdated).toBe(claims.length);
    const expectedDenied = claims.reduce((s, { c }) => s + c.denials.reduce((t, d) => t + d.amountCents, 0), 0);
    expect(b.deniedCents).toBe(expectedDenied);
    const stored = await withPractice(practiceId, (tx) => tx.claim.findMany({ include: { denials: true } }));
    expect(stored.reduce((s, c) => s + c.denials.length, 0)).toBe(claims.reduce((s, { c }) => s + c.denials.length, 0));
    expect(stored.filter((c) => c.status === "denied").length).toBe(claims.filter(({ c }) => c.status === "denied").length);
  });

  it("refuses the exact same file twice", async () => {
    await expect(createImport(ctx(), "era-again.835", enc(build835(data)))).rejects.toThrow(ImportError);
  });

  it("a later payment on a denied claim is recorded as recovered, with how and why, and is not billable yet", async () => {
    const won = claims.filter(({ c }) => c.appealStatus === "won");
    expect(won.length).toBeGreaterThan(0);
    await run("appeals.835", enc(build835(data, { appealPayments: true, date: new Date("2026-08-15") })));
    const s = await resultsSummary(practiceId, new Date("2026-01-01"), new Date("2026-12-31"));
    expect(s.outsideCount).toBe(won.length);
    expect(s.outsideCents).toBe(won.reduce((t, { c }) => t + c.recoveredCents, 0));
    expect(s.recoveredCents).toBe(0); // nothing is attributed to ClaimHive until Phases 5–6 link fixes and appeals
    const row = s.rows[0];
    expect(row.explanation).toMatch(/paid .*after an earlier denial \(reason \d+/);
    expect(row.explanation).not.toMatch(new RegExp(data.patients.map((p) => p.lastName).join("|")));
    // Denial history is kept, so the dashboard still shows what was denied.
    const stored = await withPractice(practiceId, (tx) => tx.claim.findMany({ where: { appealStatus: "won" }, include: { denials: true } }));
    expect(stored).toHaveLength(won.length);
    expect(stored.every((c) => c.denials.length > 0 && c.recoveredCents > 0)).toBe(true);
  });

  it("re-importing the appeal payment can't credit the same money twice", async () => {
    const before = await resultsSummary(practiceId, new Date("2026-01-01"), new Date("2026-12-31"));
    const bytes = enc(build835(data, { appealPayments: true, date: new Date("2026-08-16") })); // different file, same payments
    await run("appeals-copy.835", bytes);
    const after = await resultsSummary(practiceId, new Date("2026-01-01"), new Date("2026-12-31"));
    expect(after.outsideCents).toBe(before.outsideCents);
  });

  it("an aging report with unknown columns waits for mapping; the confirmed mapping is remembered", async () => {
    const custom = (n: number) => enc(buildAgingCsv(data, "custom", ({ claim }) => Number(claim.claimNumber.slice(4)) % 2 === n));
    const first = await createImport(ctx(), "aging1.csv", custom(0));
    expect(first.needsMapping).toBe(true);
    expect((await batch(first.batchId)).status).toBe("mapping_needed");
    expect(await confirmMapping(ctx(), first.batchId, { payer: "Ins" })).toMatch(/Choose a column/);
    expect(await confirmMapping(ctx(), first.batchId, { patientName: "Who", payer: "Ins", serviceDate: "When", billed: "Owed by ins" })).toBeUndefined();
    await processBatch(practiceId, first.batchId);
    const b1 = await batch(first.batchId);
    expect(b1.status).toBe("done");
    expect(b1.claimsCreated).toBe(0); // matched existing claims by patient + carrier + date
    const second = await createImport(ctx(), "aging2.csv", custom(1));
    expect(second.needsMapping).toBe(false);
  });

  it("a messy EOB goes to review; accepting the corrected data merges it", async () => {
    const { p, c } = claims.find(({ c }) => c.denials.length && c.appealStatus === "none")!;
    const r = await run("eob.pdf", await buildEobPdf(p, c, { messy: true }));
    const b = await batch(r.batchId);
    expect(b.status).toBe("needs_review");
    const item = await withPractice(practiceId, (tx) => tx.reviewItem.findFirstOrThrow({ where: { batchId: r.batchId } }));
    expect(item.flags.join(" ")).toMatch(/claimNumber/);
    expect(item.flags.join(" ")).not.toContain(p.lastName);
    const { payload } = await reviewDetail(ctx(), item.id);
    await acceptReview(ctx(), item.id, { ...payload.claim, claimNumber: c.claimNumber });
    expect((await batch(r.batchId)).status).toBe("done");
  });

  it("never merges two claims with different claim numbers, even for the same patient, day and carrier", async () => {
    const keys = await keysFor(practiceId);
    const base = { source: "claim837" as const, patient: { lastName: "Twinvisit", firstName: "Tess", dob: "1990-02-02" },
      payer: { name: "Summit Dental Mutual" }, serviceDate: "2026-03-03", status: "submitted" as const, claimDenials: [],
      lines: [{ cdtCode: "D1110", feeCents: 10000, denials: [] }] };
    const s = await withPractice(practiceId, (tx) => mergeClaims(tx, keys, [
      { ...base, claimNumber: "TWIN-1", ref: "claim 1" }, { ...base, claimNumber: "TWIN-2", ref: "claim 2" },
    ], { isSynthetic: true }));
    expect(s.created).toBe(2);
  });

  it("rejects files that aren't claim data", async () => {
    await expect(createImport(ctx(), "notes.docx", enc("PK\u0003\u0004 not really"))).rejects.toThrow(ImportError);
    await expect(createImport(ctx(), "empty.csv", new Uint8Array())).rejects.toThrow(/empty/);
  });
});

describe("ingestion security", () => {
  it("file names and contents are stored encrypted", async () => {
    const rows = (await ownerQuery("select file_name_enc, file_enc from import_batches where practice_id = $1", [practiceId])).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Buffer.from(r.file_name_enc).toString("latin1")).not.toMatch(/\.835|\.837|\.csv|\.pdf/);
      if (r.file_enc) expect(Buffer.from(r.file_enc).toString("latin1")).not.toMatch(/ISA\*|CLP\*/);
    }
  });

  it("another practice sees none of the imports, review items or results", async () => {
    await withPractice(other, async (tx) => {
      expect(await tx.importBatch.count()).toBe(0);
      expect(await tx.reviewItem.count()).toBe(0);
      expect(await tx.resultEvent.count()).toBe(0);
    });
  });

  it("the results ledger is append-only for the app, and immutable for everyone", async () => {
    await expect(appQuery("update result_events set amount_cents = 1")).rejects.toThrow(/permission denied/);
    await expect(appQuery("delete from result_events")).rejects.toThrow(/permission denied/);
    await expect(ownerQuery("update result_events set amount_cents = 1")).rejects.toThrow(/append-only/);
  });

  it("the audit log records imports without file names or patient data", async () => {
    const rows = (await ownerQuery("select action, details::text from audit_events where practice_id = $1 and action like 'import.%'", [practiceId])).rows;
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["import.upload", "import.process", "import.map"]));
    const all = rows.map((r) => r.details).join(" ");
    expect(all).not.toMatch(/\.835|\.csv|SYN\d{9}/);
    expect(all).not.toMatch(new RegExp(data.patients.map((p) => p.lastName).join("|")));
  });

  it("stored originals are purged after the retention window", async () => {
    const n = await purgeOldFiles(practiceId, new Date(Date.now() + 91 * 86_400_000));
    expect(n).toBeGreaterThan(0);
    const left = (await ownerQuery("select count(*)::int as n from import_batches where practice_id = $1 and file_enc is not null and status in ('done','failed')", [practiceId])).rows[0].n;
    expect(left).toBe(0);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPractice } from "@/lib/db";
import { quickbooksCsv, statementCsv, statementPdf } from "@/lib/billing/exports";
import {
  accruing, BillingError, buildDraft, feeOn, issueStatement, monthStart, nextMonth, rateOn, setRate, statementWithLines,
} from "@/lib/billing/statements";
import { mergeClaims } from "@/lib/ingest/merge";
import { boss } from "@/lib/jobs";
import { keysFor } from "@/lib/practices";
import { resultsSummary } from "@/lib/results/ledger";
import { loadSyntheticDataset } from "@/lib/synthetic/load";

const admin = { userId: "00000000-0000-0000-0000-0000000000ad", email: "staff@claimhive.test" };
let practices: { id: string }[] = [];
const thisMonth = monthStart(new Date());
const d = (s: string) => new Date(`${s}T00:00:00Z`);

beforeAll(async () => {
  practices = (await loadSyntheticDataset({ seed: 55, practices: 2, patientsPerPractice: 150 })).practices;
}, 120_000);
afterAll(async () => { await (await boss()).stop({ graceful: false }).catch(() => undefined); });

describe("rates", () => {
  const row = (practiceId: string | null, rateBps: number, from: string, created = from) => ({ practiceId, rateBps, effectiveFrom: d(from), createdAt: d(created) });
  it("uses the practice's own rate once set, else the default in force that day", () => {
    const rows = [row(null, 2000, "2025-01-01"), row(null, 2500, "2026-06-01"), row("p", 1500, "2026-03-01")];
    expect(rateOn(rows, d("2024-12-31"))).toBeNull();
    expect(rateOn(rows, d("2026-02-01"))).toBe(2000);
    expect(rateOn(rows, d("2026-04-01"))).toBe(1500);
    expect(rateOn(rows, d("2026-07-01"))).toBe(1500);
    expect(rateOn([row(null, 2000, "2025-01-01"), row(null, 2200, "2025-01-01", "2025-02-01")], d("2025-05-01"))).toBe(2200);
  });
  it("rounds fees to the cent", () => { expect(feeOn(12345, 2000)).toBe(2469); });

  it("won't build a statement before a rate is set", async () => {
    await expect(buildDraft(practices[0].id, thisMonth)).rejects.toThrow(BillingError);
  });
});

describe("statements", () => {
  let draftId = "";
  it("bills every attributed recovery once, at the rate in force, and nothing else", async () => {
    await setRate(admin, { practiceId: null, rateBps: 2000, effectiveFrom: d("2020-01-01"), note: "test default" });
    const p = practices[0].id;
    const st = (await buildDraft(p, thisMonth, admin))!;
    draftId = st.id;
    const full = (await statementWithLines(p, st.id))!;
    const billable = await withPractice(p, (tx) => tx.resultEvent.findMany({ where: { kind: "recovered", attributed: true } }));
    expect(billable.length).toBeGreaterThan(0);
    expect(full.lines.map((l) => l.resultEventId).sort()).toEqual(billable.map((e) => e.id).sort());
    expect(full.lines.every((l) => l.rateBps === 2000 && l.feeCents === feeOn(l.recoveredCents, 2000))).toBe(true);
    expect(full.feeCents).toBe(full.lines.reduce((s, l) => s + l.feeCents, 0));
    expect(full.recoveredCents).toBe(billable.reduce((s, e) => s + e.amountCents, 0));
    // Protected money and the office's own recoveries never appear.
    const excluded = await withPractice(p, (tx) => tx.resultEvent.findMany({ where: { OR: [{ kind: "protected" }, { attributed: false }] }, select: { id: true } }));
    expect(full.lines.some((l) => excluded.some((e) => e.id === l.resultEventId))).toBe(false);
    expect(JSON.stringify(full.lines)).not.toMatch(/SYN\d{6,}/); // no member IDs / claim numbers
  });

  it("rebuilding a draft gives the same statement", async () => {
    const p = practices[0].id;
    const before = (await statementWithLines(p, draftId))!;
    const again = (await buildDraft(p, thisMonth, admin))!;
    expect(again.id).toBe(draftId);
    expect(again.totalCents).toBe(before.totalCents);
    expect((await statementWithLines(p, draftId))!.lines).toHaveLength(before.lines.length);
    expect((await accruing(p))!.totalCents).toBe(0); // everything is on the draft already
  });

  it("issues exactly the reviewed version, then the database locks it", async () => {
    const p = practices[0].id;
    await expect(issueStatement(admin, p, draftId, new Date(0).toISOString())).rejects.toThrow(/changed/);
    const st = (await statementWithLines(p, draftId))!;
    const issued = await issueStatement(admin, p, draftId, st.updatedAt.toISOString());
    expect(issued.number).toMatch(/^CH-\d{6}-\d{5}$/);
    expect(issued.dueDate!.getTime()).toBeGreaterThan(issued.issuedAt!.getTime());
    await expect(withPractice(p, (tx) => tx.statement.update({ where: { id: draftId }, data: { feeCents: 1, totalCents: 1 } }))).rejects.toThrow(/locked/);
    await expect(withPractice(p, (tx) => tx.statementLine.deleteMany({ where: { statementId: draftId } }))).rejects.toThrow(/locked/);
    await expect(withPractice(p, (tx) => tx.statement.delete({ where: { id: draftId } }))).rejects.toThrow(/locked/);
    // Building the same month again returns the issued statement untouched.
    expect((await buildDraft(p, thisMonth, admin))!.status).toBe("issued");
  });

  it("when an insurer takes billed money back, the fee is credited on the next statement at the original rate", async () => {
    const p = practices[0].id;
    await setRate(admin, { practiceId: p, rateBps: 1000, effectiveFrom: d("2020-01-01"), note: "pilot discount" });
    const line = await withPractice(p, (tx) => tx.statementLine.findFirstOrThrow({
      where: { statementId: draftId, kind: "charge", recoveredCents: { gte: 2000 } },
      include: { resultEvent: { include: { claim: { include: { payer: true, lines: true, patient: true } } } } },
    }));
    const c = line.resultEvent.claim;
    const keys = await keysFor(p);
    const lastName = keys.decrypt("patients", "last_name", c.patient.id, c.patient.lastNameEnc);
    const take = 1500;
    let cut = take;
    const lines = c.lines.map((l) => { const r = Math.min(l.paidCents, cut); cut -= r; return { cdtCode: l.cdtCode, tooth: l.tooth ?? undefined, feeCents: l.feeCents, paidCents: l.paidCents - r, denials: [] }; });
    const paid = c.paidCents - take;
    const s = await withPractice(p, (tx) => mergeClaims(tx, keys, [{
      source: "era835", claimNumber: keys.decrypt("claims", "claim_number", c.id, c.claimNumberEnc!), patient: { lastName },
      payer: { name: c.payer.name, payerId: c.payer.payerCode }, adjudicatedAt: new Date().toISOString().slice(0, 10), status: "partially_paid",
      paidCents: paid, billedCents: c.billedCents, claimDenials: [], ref: "t", lines,
    }], { isSynthetic: true }));
    expect(s.reversedCents).toBe(take);
    const rev = await withPractice(p, (tx) => tx.resultEvent.findFirstOrThrow({ where: { claimId: c.id, kind: "reversed" } }));
    expect(rev.attributed).toBe(true);
    expect((rev.evidence as { reversesEventId: string }).reversesEventId).toBe(line.resultEventId);
    const claim = await withPractice(p, (tx) => tx.claim.findUniqueOrThrow({ where: { id: c.id } }));
    expect(claim.recoveredCents).toBe(c.recoveredCents - take);

    const next = (await buildDraft(p, nextMonth(thisMonth), admin))!;
    const nl = (await statementWithLines(p, next.id))!.lines;
    const credit = nl.find((l) => l.resultEventId === rev.id)!;
    expect(credit.kind).toBe("credit");
    expect(credit.rateBps).toBe(2000); // the rate the original was billed at, not the new 10%
    expect(credit.feeCents).toBe(feeOn(take, 2000));
    expect(next.creditCents).toBeGreaterThanOrEqual(credit.feeCents);
    // Results nets it out too.
    const r = await resultsSummary(p, new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000));
    expect(r.reversedCents).toBeGreaterThanOrEqual(take);
  });

  it("a second payment on the same claim is its own recovery (not silently dropped)", async () => {
    const p = practices[1].id;
    const ev = await withPractice(p, (tx) => tx.resultEvent.findFirstOrThrow({
      where: { kind: "recovered", claim: { claimNumberEnc: { not: null }, status: "partially_paid" } },
      include: { claim: { include: { payer: true, lines: true, patient: true } } },
    }));
    const c = ev.claim;
    const keys = await keysFor(p);
    const more = Math.min(1000, c.billedCents - c.paidCents);
    expect(more).toBeGreaterThan(0);
    let add = more;
    const lines = c.lines.map((l) => { const r = Math.min(l.feeCents - l.paidCents, add); add -= r; return { cdtCode: l.cdtCode, tooth: l.tooth ?? undefined, feeCents: l.feeCents, paidCents: l.paidCents + r, denials: [] }; });
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await withPractice(p, (tx) => mergeClaims(tx, keys, [{
      source: "era835", claimNumber: keys.decrypt("claims", "claim_number", c.id, c.claimNumberEnc!),
      patient: { lastName: keys.decrypt("patients", "last_name", c.patient.id, c.patient.lastNameEnc) },
      payer: { name: c.payer.name, payerId: c.payer.payerCode }, adjudicatedAt: future, status: "partially_paid",
      paidCents: c.paidCents + more, billedCents: c.billedCents, claimDenials: [], ref: "t", lines,
    }], { isSynthetic: true }));
    const events = await withPractice(p, (tx) => tx.resultEvent.findMany({ where: { claimId: c.id, kind: "recovered" } }));
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.amountCents === more)).toBe(true);
  });

  it("exports a CSV, a QuickBooks file and a PDF, with no patient details", async () => {
    const p = practices[0].id;
    const st = (await withPractice(p, (tx) => tx.statement.findFirstOrThrow({ where: { status: "issued" }, include: { lines: true } })));
    const csv = statementCsv(st);
    expect(csv.split("\r\n")[0].replaceAll('"', "")).toBe("statement,line,date,claim_ref,insurer,procedures,how,explanation,amount,rate,fee");
    expect(csv).toContain(`"${st.number}","total"`);
    const qbo = quickbooksCsv([{ customer: "Test Practice", s: st }]);
    expect(qbo.split("\r\n").filter(Boolean)).toHaveLength(st.lines.length + 1);
    expect(qbo).toContain("Contingency fee");
    const pdf = await statementPdf({ name: "Test Practice", state: "TX" }, st);
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
    const keys = await keysFor(p);
    const pts = await withPractice(p, (tx) => tx.patient.findMany({ where: { claims: { some: { id: { in: st.lines.map((l) => l.claimId) } } } } }));
    for (const pt of pts.slice(0, 20)) expect(csv.includes(keys.decrypt("patients", "last_name", pt.id, pt.lastNameEnc))).toBe(false);
  });

  it("statements and practice rates are private to the practice", async () => {
    const [a, b] = practices.map((x) => x.id);
    const mine = await withPractice(a, (tx) => tx.statement.findMany({ select: { id: true } }));
    expect(await withPractice(b, (tx) => tx.statement.count({ where: { id: { in: mine.map((m) => m.id) } } }))).toBe(0);
    const bRates = await withPractice(b, (tx) => tx.billingRate.findMany());
    expect(bRates.every((r) => r.practiceId === null || r.practiceId === b)).toBe(true);
    expect(bRates.some((r) => r.practiceId === a)).toBe(false);
    // Rate history can't be rewritten.
    await expect(withPractice(a, (tx) => tx.billingRate.updateMany({ data: { rateBps: 0 } }))).rejects.toThrow();
  });
});

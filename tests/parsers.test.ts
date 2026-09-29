import { describe, expect, it } from "vitest";
import { assertSafeZip, parseAging, readTable, suggestMapping, validateMapping, headerSignature } from "@/lib/ingest/aging";
import { extractEob, pdfText, REVIEW_THRESHOLD, minConfidence } from "@/lib/ingest/eob";
import { parse835, parse837, parseX12, X12Error } from "@/lib/ingest/x12";
import { parseDate, parseMoney, parseName, planFromFilingIndicator, planFromText } from "@/lib/ingest/values";
import { generateDataset, SYNTHETIC_PAYERS } from "@/lib/synthetic/generator";
import { build835, build837, buildAgingCsv, buildAgingXlsx, buildEobPdf } from "@/lib/synthetic/files";

const [practice] = generateDataset({ seed: 11, practices: 1, patientsPerPractice: 40, endDate: new Date("2026-09-01") });
const allClaims = practice.patients.flatMap((p) => p.claims.map((c) => ({ p, c })));
const enc = (s: string) => new TextEncoder().encode(s);

describe("value parsing", () => {
  it("reads money the way reports print it", () => {
    expect(parseMoney("$1,234.56")).toBe(123456);
    expect(parseMoney("(12.00)")).toBe(-1200);
    expect(parseMoney("-5")).toBe(-500);
    expect(parseMoney(99.5)).toBe(9950);
    expect(parseMoney("n/a")).toBeUndefined();
    expect(parseMoney("")).toBeUndefined();
  });
  it("reads dates in every common format and rejects impossible ones", () => {
    expect(parseDate("03/14/2026")).toBe("2026-03-14");
    expect(parseDate("3/4/26")).toBe("2026-03-04");
    expect(parseDate("20260314")).toBe("2026-03-14");
    expect(parseDate("2026-03-14")).toBe("2026-03-14");
    expect(parseDate(46095)).toBe("2026-03-14"); // Excel serial
    expect(parseDate("02/31/2026")).toBeUndefined();
    expect(parseDate("hello")).toBeUndefined();
  });
  it("splits names in either order", () => {
    expect(parseName("Doe, Jane A")).toEqual({ lastName: "Doe", firstName: "Jane" });
    expect(parseName("Jane Doe")).toEqual({ firstName: "Jane", lastName: "Doe" });
  });
  it("maps plan types from X12 codes and free text", () => {
    expect(planFromFilingIndicator("17")).toBe("DHMO");
    expect(planFromFilingIndicator("MC")).toBe("MEDICAID");
    expect(planFromFilingIndicator("ZZ")).toBe("UNKNOWN");
    expect(planFromText("Delta PPO Premier")).toBe("PPO");
    expect(planFromText("DMO")).toBe("DHMO");
  });
});

describe("X12", () => {
  it("rejects files that aren't X12", () => {
    expect(() => parseX12("hello")).toThrow(X12Error);
    expect(() => parse835(build837(practice))).toThrow(/not an 835/);
  });

  it("837D: every claim, line, tooth, surface and attachment round-trips", () => {
    const r = parse837(build837(practice));
    expect(r.problems).toEqual([]);
    expect(r.claims).toHaveLength(allClaims.length);
    for (const { p, c } of allClaims) {
      const got = r.claims.find((x) => x.claimNumber === c.claimNumber)!;
      expect(got.patient).toMatchObject({ lastName: p.lastName.toUpperCase(), dob: p.dob, memberId: p.memberId });
      expect(got.serviceDate).toBe(c.serviceDate.toISOString().slice(0, 10));
      expect(got.planType).toBe(c.planType);
      expect(new Set(got.attachments)).toEqual(new Set(c.attachments));
      expect(got.billedCents).toBe(c.lines.reduce((s, l) => s + l.feeCents, 0));
      expect(got.lines.map((l) => [l.cdtCode, l.tooth, l.surfaces, l.feeCents])).toEqual(
        c.lines.map((l) => [l.cdtCode, l.tooth, l.surfaces, l.feeCents]));
    }
  });

  it("835: payments and denials (with remark codes) round-trip; routine write-offs are not denials", () => {
    const r = parse835(build835(practice));
    expect(r.claims).toHaveLength(allClaims.length);
    for (const { c } of allClaims) {
      const got = r.claims.find((x) => x.claimNumber === c.claimNumber)!;
      expect(got.paidCents).toBe(c.lines.reduce((s, l) => s + l.paidCents, 0));
      expect(got.status).toBe(c.status);
      const denials = got.lines.flatMap((l) => l.denials);
      expect(denials.map((d) => [d.carc, d.rarc ?? null])).toEqual(c.denials.map((d) => [d.carc, d.rarc ?? null]));
      expect(denials.every((d) => d.carc !== "45")).toBe(true);
      expect(got.payer.name?.toLowerCase()).toBe(SYNTHETIC_PAYERS.find((x) => x.payerCode === c.payerCode)!.name.toLowerCase());
    }
  });

  it("handles other delimiters and line breaks from different clearinghouses", () => {
    const x = build835(practice).replace(/\*/g, "|").replace(/~\n/g, "~\r\n");
    const fixed = x.slice(0, 104) + ":" + x.slice(105); // ISA16 stays ":"
    expect(parse835(fixed).claims).toHaveLength(allClaims.length);
  });
});

describe("aging reports", () => {
  for (const style of ["opendental", "dentrix", "eaglesoft"] as const) {
    it(`auto-maps a ${style}-style export and groups rows into claims`, async () => {
      const t = await readTable(enc(buildAgingCsv(practice, style)), "aging.csv");
      const s = suggestMapping(t.headers);
      expect(s.confident, JSON.stringify(s)).toBe(true);
      expect(validateMapping(s.mapping, t.headers)).toBeUndefined();
      const r = parseAging(t, s.mapping);
      expect(r.problems).toEqual([]);
      // Without a claim number, same patient + day + carrier is indistinguishable from one claim.
      const distinct = style === "eaglesoft"
        ? new Set(allClaims.map(({ p, c }) => `${p.lastName}|${p.firstName}|${c.serviceDate.toISOString()}|${c.payerCode}`)).size
        : allClaims.length;
      expect(r.claims.length).toBe(distinct);
      const totalBilled = allClaims.reduce((s2, { c }) => s2 + c.lines.reduce((t2, l) => t2 + l.feeCents, 0), 0);
      expect(r.claims.reduce((s2, c) => s2 + (c.billedCents ?? 0), 0)).toBe(totalBilled);
    });
  }

  it("recognizes Open Dental by its column names", async () => {
    const t = await readTable(enc(buildAgingCsv(practice, "opendental")), "a.csv");
    expect(suggestMapping(t.headers).detectedSystem).toBe("Open Dental");
  });

  it("skips a report's title block to find the header row", async () => {
    const t = await readTable(enc(buildAgingCsv(practice, "dentrix")), "a.csv");
    expect(t.headers[0]).toBe("Patient");
  });

  it("reads Excel files the same as CSV", async () => {
    const t = await readTable(await buildAgingXlsx(practice, "dentrix"), "aging.xlsx");
    const r = parseAging(t, suggestMapping(t.headers).mapping);
    expect(r.claims.length).toBe(allClaims.length);
  });

  it("refuses an Excel file that would unpack to an enormous size (zip bomb)", async () => {
    const good = await buildAgingXlsx(practice, "dentrix");
    expect(() => assertSafeZip(good)).not.toThrow();
    // Rewrite one central-directory entry to claim 200 MB uncompressed.
    const bomb = new Uint8Array(good);
    const v = new DataView(bomb.buffer);
    for (let i = 0; i < bomb.length - 4; i++) if (v.getUint32(i, true) === 0x02014b50) { v.setUint32(i + 24, 200 * 1024 * 1024, true); break; }
    expect(() => assertSafeZip(bomb)).toThrow(/too large/);
    await expect(readTable(bomb, "bomb.xlsx")).rejects.toThrow(/too large/);
  });

  it("asks a person when it can't recognize the columns", async () => {
    const t = await readTable(enc(buildAgingCsv(practice, "custom")), "a.csv");
    const s = suggestMapping(t.headers);
    expect(s.confident).toBe(false);
    expect(validateMapping(s.mapping, t.headers)).toMatch(/Choose a column/);
    const manual = { patientName: "Who", payer: "Ins", serviceDate: "When", billed: "Owed by ins" };
    expect(validateMapping(manual, t.headers)).toBeUndefined();
    expect(parseAging(t, manual).claims.length).toBeGreaterThan(0);
  });

  it("reports bad rows by row number without echoing their contents", () => {
    const t = { headers: ["Patient", "Carrier", "DOS", "Amount"], rows: [
      { Patient: "Doe, Jane", Carrier: "X", DOS: "13/45/2026", Amount: "$10" },
      { Patient: "Doe, John", Carrier: "X", DOS: "01/02/2026", Amount: "ten" },
    ] };
    const r = parseAging(t, { patientName: "Patient", payer: "Carrier", serviceDate: "DOS", billed: "Amount" });
    expect(r.problems).toEqual([{ ref: "row 2", code: "missing_service_date" }, { ref: "row 3", code: "bad_amount" }]);
    expect(JSON.stringify(r.problems)).not.toMatch(/Doe/);
  });

  it("remembers layouts by header signature regardless of order or punctuation", () => {
    expect(headerSignature(["Claim #", "Patient"])).toBe(headerSignature(["patient", "claim"]));
  });
});

describe("EOB PDFs (local extraction)", () => {
  const payers = SYNTHETIC_PAYERS.map((p) => p.name);
  const denied = allClaims.filter(({ c }) => c.denials.length).slice(0, 6);

  for (const layout of ["a", "b"] as const) {
    it(`reads layout ${layout} with high confidence`, async () => {
      for (const { p, c } of denied) {
        const x = extractEob(await pdfText(await buildEobPdf(p, c, { layout })), payers);
        expect(minConfidence(x.confidence), x.flags.join("; ")).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
        expect(x.claim.claimNumber).toBe(c.claimNumber);
        expect(x.claim.patient.lastName).toBe(p.lastName);
        expect(x.claim.patient.memberId).toBe(p.memberId);
        expect(x.claim.paidCents).toBe(c.lines.reduce((s, l) => s + l.paidCents, 0));
        expect(x.claim.lines.map((l) => l.cdtCode)).toEqual(c.lines.map((l) => l.cdtCode));
        expect(x.claim.lines.flatMap((l) => l.denials.map((d) => d.carc))).toEqual(c.denials.map((d) => d.carc));
      }
    });
  }

  it("flags a messy EOB for a person to check, naming the fields but not their values", async () => {
    const { p, c } = denied[0];
    const x = extractEob(await pdfText(await buildEobPdf(p, c, { messy: true })), payers);
    expect(minConfidence(x.confidence)).toBeLessThan(REVIEW_THRESHOLD);
    expect(x.flags.some((f) => f.startsWith("claimNumber"))).toBe(true);
    expect(x.flags.join(" ")).not.toContain(p.lastName);
  });

  it("sends a scanned (text-less) PDF straight to review", () => {
    const x = extractEob("   \n  ", payers);
    expect(x.hasText).toBe(false);
    expect(minConfidence(x.confidence)).toBe(0);
  });
});

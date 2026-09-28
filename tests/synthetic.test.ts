import { describe, expect, it } from "vitest";
import { CARC_CODES, CDT_BY_CODE, RARC_CODES } from "@/lib/reference/codes";
import { generateDataset, HIDDEN_RULES } from "@/lib/synthetic/generator";
import { loadSyntheticDataset } from "@/lib/synthetic/load";
import { withPractice } from "@/lib/db";
import { listPatients } from "@/lib/phi";

const end = new Date("2026-09-01T00:00:00Z");

describe("synthetic data generator", () => {
  it("is deterministic for a seed", () => {
    const a = generateDataset({ seed: 7, practices: 2, patientsPerPractice: 20, endDate: end });
    const b = generateDataset({ seed: 7, practices: 2, patientsPerPractice: 20, endDate: end });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("only uses known codes and marks everything as synthetic", () => {
    const data = generateDataset({ seed: 1, practices: 3, patientsPerPractice: 60, endDate: end });
    for (const p of data) for (const pt of p.patients) {
      expect(pt.memberId.startsWith("SYN")).toBe(true);
      for (const c of pt.claims) {
        expect(c.claimNumber.startsWith("SYN-")).toBe(true);
        for (const l of c.lines) expect(CDT_BY_CODE.has(l.cdtCode)).toBe(true);
        for (const d of c.denials) {
          expect(CARC_CODES.has(d.carc)).toBe(true);
          if (d.rarc) expect(RARC_CODES.has(d.rarc)).toBe(true);
        }
      }
    }
  });

  it("plants hidden rules strongly enough to be learnable", () => {
    const data = generateDataset({ seed: 3, practices: 8, patientsPerPractice: 250, endDate: end });
    const claims = data.flatMap((p) => p.patients.flatMap((pt) => pt.claims));
    const r1 = HIDDEN_RULES.find((r) => r.id === "R1")!;
    const target = claims.filter((c) => c.payerCode === "SYN01" && c.lines.some((l) => l.cdtCode === "D4341"));
    const without = target.filter((c) => !c.attachments.includes("perio_chart"));
    const withChart = target.filter((c) => c.attachments.includes("perio_chart"));
    const rate = (cs: typeof claims) => cs.filter((c) => c.denials.some((d) => d.ruleId === "R1")).length / cs.length;
    expect(without.length).toBeGreaterThan(20);
    expect(rate(without)).toBeGreaterThan(r1.denyRate - 0.2);
    expect(rate(withChart)).toBe(0);
  });

  it("loads into isolated, encrypted practices", async () => {
    const res = await loadSyntheticDataset({ seed: 11, practices: 2, patientsPerPractice: 15, endDate: end });
    expect(res.practices).toHaveLength(2);
    expect(res.claims).toBeGreaterThan(20);
    const [p1, p2] = res.practices;
    const n1 = await withPractice(p1.id, (tx) => tx.claim.count());
    const n2 = await withPractice(p2.id, (tx) => tx.claim.count());
    expect(n1 + n2).toBe(res.claims);
    const patients = await listPatients({ practiceId: p1.id, userId: "00000000-0000-0000-0000-000000000009", email: "t@test.invalid" });
    expect(patients).toHaveLength(15);
    expect(patients[0].memberId?.startsWith("SYN")).toBe(true);
  });
});

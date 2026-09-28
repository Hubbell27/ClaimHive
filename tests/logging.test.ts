import { describe, expect, it } from "vitest";
import { log, scrub } from "@/lib/logger";

describe("PHI-safe logging", () => {
  it("drops any field that is not allow-listed", () => {
    const out = log.sanitize({ event: "x", patientName: "Ana Alpha", body: { dob: "1980-01-01" }, count: 3 });
    expect(out).toEqual({ event: "x", count: 3 });
  });
  it("masks identifiers that sneak into allowed strings", () => {
    const s = scrub("failed for ana@example.com dob 1980-01-01 phone (555) 123-4567 ssn 123-45-6789 member SYN123456789");
    expect(s).not.toMatch(/ana@example|1980-01-01|555|123-45-6789|SYN123456789/);
  });
  it("logs errors by class and scrubbed message only", () => {
    const e = new Error("patient 1980-01-01 not found");
    const out = log.sanitize({ event: "err", errorClass: e.name, errorMessage: e.message });
    expect(out.errorMessage).not.toContain("1980-01-01");
  });
});

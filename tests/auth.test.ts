import { describe, expect, it } from "vitest";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password";
import { codeAt, currentStep, newSecret, verifyCode } from "@/lib/auth/totp";
import { can } from "@/lib/auth/rbac";

describe("passwords", () => {
  it("hashes with argon2id and verifies", async () => {
    const h = await hashPassword("Correct-Horse-Battery-9");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword("Correct-Horse-Battery-9", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await verifyPassword("anything", null)).toBe(false);
  });
  it("enforces a strength policy", () => {
    expect(passwordProblem("short")).toBeTruthy();
    expect(passwordProblem("alllowercaseletters")).toBeTruthy();
    expect(passwordProblem("Brushing-Twice-Daily-9")).toBeNull();
  });
});

describe("TOTP", () => {
  it("matches the RFC 6238 test vector", () => {
    // Secret "12345678901234567890" in base32; T=59s -> step 1 -> 8-digit 94287082, 6-digit 287082.
    expect(codeAt("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1)).toBe("287082");
  });
  it("accepts one step of drift and blocks reuse", () => {
    const s = newSecret();
    const now = Date.now();
    const step = verifyCode(s, codeAt(s, currentStep(now)), null, now);
    expect(step).toBe(currentStep(now));
    expect(verifyCode(s, codeAt(s, currentStep(now)), BigInt(step!), now)).toBeNull();
    expect(verifyCode(s, codeAt(s, currentStep(now) - 5), null, now)).toBeNull();
  });
});

describe("roles", () => {
  it("owners manage the practice; billers work claims; neither is a platform admin", () => {
    expect(can("owner", "members.manage")).toBe(true);
    expect(can("biller", "members.manage")).toBe(false);
    expect(can("biller", "phi.view")).toBe(true);
    expect(can("biller", "audit.view")).toBe(false);
    expect(can("biller", "pool.opt_in")).toBe(false);
  });
});

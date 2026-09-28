import { describe, expect, it } from "vitest";
import { LocalKeyProvider, newPracticeKey, PracticeKeys } from "@/lib/crypto";

describe("field-level encryption", () => {
  const keys = new PracticeKeys("11111111-1111-1111-1111-111111111111", Buffer.alloc(32, 7));

  it("round-trips and never contains the plaintext", () => {
    const blob = keys.encrypt("patients", "last_name", "row-1", "Ramirez");
    expect(Buffer.from(blob).includes(Buffer.from("Ramirez"))).toBe(false);
    expect(keys.decrypt("patients", "last_name", "row-1", blob)).toBe("Ramirez");
  });

  it("binds ciphertext to its row, column and practice", () => {
    const blob = keys.encrypt("patients", "last_name", "row-1", "Ramirez");
    expect(() => keys.decrypt("patients", "last_name", "row-2", blob)).toThrow();
    expect(() => keys.decrypt("patients", "first_name", "row-1", blob)).toThrow();
    const other = new PracticeKeys("22222222-2222-2222-2222-222222222222", Buffer.alloc(32, 7));
    expect(() => other.decrypt("patients", "last_name", "row-1", blob)).toThrow();
  });

  it("uses a fresh nonce every time", () => {
    const a = keys.encrypt("patients", "dob", "r", "1980-01-01");
    const b = keys.encrypt("patients", "dob", "r", "1980-01-01");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("lookup index normalizes case/accents but differs per practice", () => {
    expect(keys.lookupIndex("Muñoz", "1980-01-01")).toBe(keys.lookupIndex(" MUNOZ ", "1980-01-01"));
    const other = new PracticeKeys("22222222-2222-2222-2222-222222222222", Buffer.alloc(32, 7));
    expect(other.lookupIndex("Munoz", "1980-01-01")).not.toBe(keys.lookupIndex("Munoz", "1980-01-01"));
  });

  it("wraps practice keys with the master key", async () => {
    const { dek, wrapped } = await newPracticeKey();
    const p = new LocalKeyProvider(process.env.MASTER_KEY!);
    expect((await p.unwrap(wrapped)).equals(dek)).toBe(true);
    expect(Buffer.from(wrapped).includes(dek)).toBe(false);
  });
});

describe("deployment guard", () => {
  it("refuses local keys in a production build unless APP_ENV=local", async () => {
    const { isRealDeployment } = await import("@/lib/env");
    const saved = { n: process.env.NODE_ENV, a: process.env.APP_ENV };
    const env = process.env as Record<string, string | undefined>;
    try {
      env.NODE_ENV = "production"; delete env.APP_ENV;
      expect(isRealDeployment()).toBe(true);
      env.APP_ENV = "local";
      expect(isRealDeployment()).toBe(false);
      env.APP_ENV = "production"; env.NODE_ENV = "development";
      expect(isRealDeployment()).toBe(true);
    } finally {
      env.NODE_ENV = saved.n; env.APP_ENV = saved.a;
      if (saved.a === undefined) delete env.APP_ENV;
    }
  });
});

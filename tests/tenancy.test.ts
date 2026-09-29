import { beforeAll, describe, expect, it } from "vitest";
import { prisma, withPractice } from "@/lib/db";
import { createPatient, exportPatientsCsv, findPatientsByLastNameDob, listPatients } from "@/lib/phi";
import { createPractice } from "@/lib/practices";
import { appQuery, ownerQuery } from "./helpers";

let a: string, b: string;
const actor = (practiceId: string) => ({ practiceId, userId: "00000000-0000-0000-0000-000000000001", email: "t@test.invalid" });

beforeAll(async () => {
  a = (await createPractice({ name: "Practice A", state: "TX" })).id;
  b = (await createPractice({ name: "Practice B", state: "OH" })).id;
  await createPatient(actor(a), { firstName: "Ana", lastName: "Alpha", dob: "1980-01-01", memberId: "M1" });
  await createPatient(actor(b), { firstName: "Ben", lastName: "Bravo", dob: "1975-05-05" });
});

describe("tenant isolation (PostgreSQL row-level security)", () => {
  it("the app role is not a superuser and cannot bypass RLS", async () => {
    const r = await appQuery("select rolsuper, rolbypassrls from pg_roles where rolname = current_user");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("each practice only sees its own patients", async () => {
    const seenA = await listPatients(actor(a));
    const seenB = await listPatients(actor(b));
    expect(seenA.map((p) => p.lastName)).toEqual(["Alpha"]);
    expect(seenB.map((p) => p.lastName)).toEqual(["Bravo"]);
  });

  it("no tenant context means no rows at all", async () => {
    expect((await appQuery("select count(*)::int as n from patients")).rows[0].n).toBe(0);
    expect(await prisma().patient.count()).toBe(0);
  });

  it("writes into another practice are rejected", async () => {
    await expect(withPractice(a, (tx) => tx.patient.create({ data: {
      practiceId: b, firstNameEnc: Buffer.from("x"), lastNameEnc: Buffer.from("x"), dobEnc: Buffer.from("x"), lookupIndex: "x",
    } }))).rejects.toThrow();
  });

  it("claims cannot point at another practice's patient", async () => {
    const payer = await prisma().payer.create({ data: { name: "Test Payer", payerCode: "TST01", isSynthetic: true } });
    const bPatient = (await ownerQuery("select id from patients where practice_id = $1", [b])).rows[0].id;
    await expect(withPractice(a, (tx) => tx.claim.create({ data: {
      practiceId: a, patientId: bPatient, payerId: payer.id, planType: "PPO", serviceDate: new Date(), status: "draft", billedCents: 100,
    } }))).rejects.toThrow();
  });

  it("identifiers are ciphertext in the database", async () => {
    // This test's own patients only: other files' random ciphertext can contain short strings like "Ana" by chance.
    const rows = (await ownerQuery("select first_name_enc, last_name_enc, dob_enc from patients where practice_id = any($1::uuid[])", [[a, b]])).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      for (const v of Object.values(r) as Buffer[]) {
        expect(v.toString("latin1")).not.toMatch(/Alpha|Bravo|Ana|Ben|1980-01-01|1975-05-05/);
      }
    }
  });

  it("lookup by last name + DOB works without plaintext names", async () => {
    expect(await findPatientsByLastNameDob(actor(a), "ALPHA", "1980-01-01")).toHaveLength(1);
    expect(await findPatientsByLastNameDob(actor(a), "Bravo", "1975-05-05")).toHaveLength(0);
  });

  it("every PHI read and export is audited", async () => {
    await exportPatientsCsv(actor(a));
    const events = await prisma().auditEvent.findMany({ where: { practiceId: a } });
    const actions = new Set(events.map((e) => e.action));
    expect(actions).toEqual(new Set(["phi.create", "phi.list", "phi.view", "phi.export"]));
    expect(JSON.stringify(events, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(/Alpha|Ana|1980-01-01/);
  });

  it("the audit trail cannot be changed or deleted, even by the owner", async () => {
    await expect(appQuery("update audit_events set action = 'x'")).rejects.toThrow();
    await expect(appQuery("delete from audit_events")).rejects.toThrow();
    await expect(ownerQuery("delete from audit_events")).rejects.toThrow(/append-only/);
  });
});

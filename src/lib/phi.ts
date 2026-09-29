/**
 * The only way application code reads or writes patient identifiers.
 * Every call runs inside the practice's RLS context and writes an audit event.
 */
import { randomUUID } from "node:crypto";
import { audit } from "./audit";
import type { PracticeContext } from "./auth/rbac";
import { withPractice } from "./db";
import { keysFor } from "./practices";
import { csvCell } from "./csv";

export interface PatientInput {
  firstName: string;
  lastName: string;
  dob: string; // YYYY-MM-DD
  memberId?: string;
}

export interface PatientView extends Omit<PatientInput, "dob"> {
  id: string;
  dob?: string; // missing for patients first seen on a remittance
}

export async function createPatient(ctx: Pick<PracticeContext, "practiceId" | "userId" | "email">, input: PatientInput) {
  const keys = await keysFor(ctx.practiceId);
  const id = randomUUID();
  await withPractice(ctx.practiceId, (tx) =>
    tx.patient.create({
      data: {
        id,
        practiceId: ctx.practiceId,
        firstNameEnc: keys.encrypt("patients", "first_name", id, input.firstName),
        lastNameEnc: keys.encrypt("patients", "last_name", id, input.lastName),
        dobEnc: keys.encrypt("patients", "dob", id, input.dob),
        memberIdEnc: input.memberId ? keys.encrypt("patients", "member_id", id, input.memberId) : null,
        lookupIndex: keys.lookupIndex(input.lastName, input.dob),
        memberLookup: input.memberId ? keys.lookupIndex(input.memberId, input.lastName) : null,
      },
    }),
  );
  await audit({ action: "phi.create", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "patient", resourceId: id });
  return id;
}

export async function listPatients(ctx: Pick<PracticeContext, "practiceId" | "userId" | "email">, opts: { take?: number; skip?: number } = {}) {
  const keys = await keysFor(ctx.practiceId);
  const rows = await withPractice(ctx.practiceId, (tx) =>
    tx.patient.findMany({ orderBy: { createdAt: "desc" }, take: opts.take ?? 50, skip: opts.skip ?? 0 }),
  );
  const out: PatientView[] = rows.map((r) => ({
    id: r.id,
    firstName: keys.decrypt("patients", "first_name", r.id, r.firstNameEnc),
    lastName: keys.decrypt("patients", "last_name", r.id, r.lastNameEnc),
    dob: r.dobEnc ? keys.decrypt("patients", "dob", r.id, r.dobEnc) : undefined,
    memberId: r.memberIdEnc ? keys.decrypt("patients", "member_id", r.id, r.memberIdEnc) : undefined,
  }));
  await audit({ action: "phi.list", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "patient", details: { count: out.length } });
  return out;
}

export async function findPatientsByLastNameDob(ctx: Pick<PracticeContext, "practiceId" | "userId" | "email">, lastName: string, dob: string) {
  const keys = await keysFor(ctx.practiceId);
  const idx = keys.lookupIndex(lastName, dob);
  const rows = await withPractice(ctx.practiceId, (tx) => tx.patient.findMany({ where: { lookupIndex: idx } }));
  await audit({ action: "phi.view", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "patient", details: { lookup: true, matches: rows.length } });
  return rows.map((r) => r.id);
}

/** CSV export of the practice's patient list. Audited as an export. */
export async function exportPatientsCsv(ctx: Pick<PracticeContext, "practiceId" | "userId" | "email">) {
  const patients = await listPatients(ctx, { take: 100_000 });
  const esc = csvCell;
  const csv = ["first_name,last_name,dob,member_id", ...patients.map((p) =>
    [p.firstName, p.lastName, p.dob, p.memberId].map(esc).join(","))].join("\n");
  await audit({ action: "phi.export", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "patient", details: { rows: patients.length, format: "csv" } });
  return csv;
}

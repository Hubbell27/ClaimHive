/** Entering a single claim for a pre-submission check (the quick form). */
import { audit } from "../audit";
import type { PracticeContext } from "../auth/rbac";
import { prisma, withPractice } from "../db";
import { mergeClaims } from "../ingest/merge";
import type { NormalizedClaim, PlanType } from "../ingest/types";
import { parseDate, parseMoney, parseSurfaces, parseTooth } from "../ingest/values";
import { keysFor } from "../practices";
import { ATTACHMENTS, CDT_BY_CODE, type Attachment } from "../reference/codes";
import { runCheck, type CheckResult } from "./check";

type Actor = Pick<PracticeContext, "practiceId" | "userId" | "email">;

export interface EntryInput {
  firstName: string; lastName: string; dob: string; memberId?: string;
  payer: string; planType: string; serviceDate: string; claimNumber?: string;
  attachments: string[];
  lines: { cdt: string; tooth?: string; surfaces?: string; fee: string }[];
}

export class EntryError extends Error {}

const PLANS = new Set(["PPO", "DHMO", "INDEMNITY", "MEDICAID", "MEDICARE_ADVANTAGE", "UNKNOWN"]);

/** Insurers offered in the form: verified ones, plus any this practice already bills (never another practice's names). */
export async function payerOptions(practiceId: string): Promise<string[]> {
  const verified = await prisma().payer.findMany({ where: { verified: true }, select: { name: true } });
  const own = await withPractice(practiceId, (tx) => tx.claim.findMany({ distinct: ["payerId"], select: { payer: { select: { name: true } } } }));
  return [...new Set([...verified.map((p) => p.name), ...own.map((c) => c.payer.name)])].sort();
}

export async function checkEnteredClaim(ctx: Actor, input: EntryInput): Promise<CheckResult> {
  const dob = parseDate(input.dob);
  const serviceDate = parseDate(input.serviceDate);
  if (!input.lastName.trim() || !input.firstName.trim() || !dob) throw new EntryError("Enter the patient's first and last name and date of birth.");
  if (!serviceDate) throw new EntryError("Enter the date of service.");
  if (!(await payerOptions(ctx.practiceId)).includes(input.payer)) throw new EntryError("Choose the insurer from the list.");
  const lines = input.lines.filter((l) => l.cdt.trim());
  if (!lines.length) throw new EntryError("Add at least one procedure.");
  const parsed = lines.map((l, i) => {
    const cdt = l.cdt.trim().toUpperCase();
    if (!CDT_BY_CODE.has(cdt) && !/^D\d{4}$/.test(cdt)) throw new EntryError(`Procedure ${i + 1}: enter a CDT code like D2740.`);
    const fee = parseMoney(l.fee);
    if (fee === undefined || fee <= 0) throw new EntryError(`Procedure ${i + 1}: enter the fee.`);
    return { cdtCode: cdt, tooth: parseTooth(l.tooth), surfaces: parseSurfaces(l.surfaces), feeCents: fee, denials: [] };
  });
  const claim: NormalizedClaim = {
    source: "precheck", claimNumber: input.claimNumber?.trim() || undefined,
    patient: { firstName: input.firstName.trim(), lastName: input.lastName.trim(), dob, memberId: input.memberId?.trim() || undefined },
    payer: { name: input.payer }, planType: (PLANS.has(input.planType) ? input.planType : "UNKNOWN") as PlanType,
    serviceDate, status: "draft", attachments: input.attachments.filter((a): a is Attachment => (ATTACHMENTS as readonly string[]).includes(a)),
    lines: parsed, claimDenials: [], ref: "form",
  };
  const keys = await keysFor(ctx.practiceId);
  const practice = await prisma().practice.findUniqueOrThrow({ where: { id: ctx.practiceId }, select: { isSynthetic: true } });
  const stats = await withPractice(ctx.practiceId, (tx) => mergeClaims(tx, keys, [claim], { isSynthetic: practice.isSynthetic, asDraft: true }));
  const claimId = stats.claimIds[0];
  if (!claimId) throw new EntryError("That claim couldn't be saved.");
  const result = await runCheck(ctx.practiceId, claimId);
  await audit({ action: "claim.precheck", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "claim", resourceId: claimId, details: { lines: parsed.length, risk: Math.round(result.risk * 100) / 100 } });
  return result;
}

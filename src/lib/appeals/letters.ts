/**
 * Appeal letters (Phase 6).
 *
 *   request -> [job] draft: de-identify, check, write, merge locally -> draft
 *   draft -> biller edits (each save is a new version) -> approve (this exact version)
 *   approved -> PDF / "mark as sent" (ClaimHive never sends anything itself)
 *
 * Only de-identified content reaches a writer. Patient and practice details are
 * merged in here, after the text comes back, and stored encrypted. Every step is
 * audited without PHI.
 */
import { createHash } from "node:crypto";
import { audit } from "../audit";
import type { PracticeContext } from "../auth/rbac";
import { prisma, withPractice } from "../db";
import { listRules } from "../intel/engine";
import { explainRule } from "../intel/explain";
import { boss, QUEUES } from "../jobs";
import { log } from "../logger";
import { keysFor } from "../practices";
import { ATTACHMENTS } from "../reference/codes";
import { APPEAL_ARGUMENTS } from "../pool/deidentify";
import { assertNoIdentifiers, buildAppealRequest, IdentifierFound, type KnownIdentifiers } from "./deidentify";
import { merge, unknownPlaceholders, type MergeValues } from "./placeholders";
import { anthropicWriter, templateWriter, WriterError, type LetterWriter } from "./writers";

type Actor = Pick<PracticeContext, "practiceId" | "userId" | "email">;

export class LetterError extends Error {}

/** Something the biller must fill in by hand before approving, e.g. "[add member ID]". */
export const MISSING = /\[add [^\]]+\]/;

export const ERROR_TEXT: Record<string, string> = {
  identifier_in_request: "ClaimHive stopped because the request would have included a patient or practice detail (a name, date or ID number). Remove it from your notes and try again.",
  refused: "The AI writer declined this letter. Try again, or use ClaimHive's standard letter.",
  too_long: "The letter came back too long. Try again.",
  empty: "The writer returned nothing. Try again.",
  api_error: "The AI writer isn't available right now. Try again, or use ClaimHive's standard letter.",
  rate_limited: "The AI writer is busy. Try again in a minute.",
  unknown_placeholder: "The letter came back with a detail ClaimHive can't fill in. Try again.",
};

/**
 * AI letters need an API key, and the practice's content may only go to the API when it's
 * synthetic (development) or, in production, once the Anthropic BAA is in place.
 */
export function aiAllowed(p: { isSynthetic: boolean }): boolean {
  if (!process.env.ANTHROPIC_API_KEY) return false;
  if (process.env.APP_ENV === "production") return !p.isSynthetic && process.env.ANTHROPIC_BAA === "signed";
  return p.isSynthetic;
}

const PROFILE_FIELDS = [
  ["addressLine1", "street address"], ["city", "city"], ["zip", "ZIP code"], ["phone", "phone"],
  ["npi", "NPI"], ["signerName", "signer's name"],
] as const;

/** Letterhead details still missing from Settings (letters can't be approved until they're there). */
export function profileGaps(p: Record<string, unknown>): string[] {
  return PROFILE_FIELDS.filter(([k]) => !String(p[k] ?? "").trim()).map(([, label]) => label);
}

export async function requestLetter(ctx: Actor, claimId: string, opts: {
  enclosures: string[]; argument?: string; ruleKey?: string; notes?: string; useTemplate?: boolean; runNow?: boolean;
}): Promise<string> {
  const enclosures = opts.enclosures.filter((e) => (ATTACHMENTS as readonly string[]).includes(e));
  const argument = opts.argument && (APPEAL_ARGUMENTS as readonly string[]).includes(opts.argument) ? opts.argument : null;
  if (!enclosures.length && !argument) throw new LetterError("Tick what you're enclosing, or choose what the appeal argues.");
  const keys = await keysFor(ctx.practiceId);
  const id = crypto.randomUUID();
  await withPractice(ctx.practiceId, async (tx) => {
    const c = await tx.claim.findUnique({ where: { id: claimId }, select: { id: true, _count: { select: { denials: true } } } });
    if (!c) throw new LetterError("Claim not found.");
    if (!c._count.denials) throw new LetterError("Only denied claims can be appealed.");
    // One live letter per claim: earlier unsent ones are replaced.
    await tx.appealLetter.updateMany({ where: { claimId, sentAt: null, status: { not: "superseded" } }, data: { status: "superseded" } });
    await tx.appealLetter.create({ data: {
      id, practiceId: ctx.practiceId, claimId, enclosures, argument, ruleKey: opts.ruleKey?.slice(0, 200) || null,
      notesEnc: opts.notes?.trim() ? keys.encrypt("appeal_letters", "notes", id, opts.notes.trim().slice(0, 1500)) : null,
      writer: opts.useTemplate ? "template" : null, createdBy: ctx.userId,
    } });
  });
  await audit({ action: "appeal.request", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "appeal_letter", resourceId: id, details: { claimId, enclosures, argument, rule: !!opts.ruleKey, notes: !!opts.notes?.trim() } });
  if (opts.runNow) await draftLetter(ctx.practiceId, id);
  else await (await boss()).send(QUEUES.appealDraft, { practiceId: ctx.practiceId, letterId: id });
  return id;
}

const fmt = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;

/** The job: build the de-identified request, check it, write, merge locally. */
export async function draftLetter(practiceId: string, letterId: string, writerOverride?: LetterWriter): Promise<void> {
  const started = Date.now();
  const practice = await prisma().practice.findUniqueOrThrow({ where: { id: practiceId } });
  const keys = await keysFor(practiceId);
  const l = await withPractice(practiceId, (tx) => tx.appealLetter.findUniqueOrThrow({
    where: { id: letterId },
    include: { claim: { include: { patient: true, payer: true, lines: true, denials: { orderBy: { deniedAt: "asc" } } } } },
  }));
  if (l.status !== "generating") return; // superseded, or already drafted (job retried)
  const c = l.claim;
  const pt = c.patient;
  const first = keys.decrypt("patients", "first_name", pt.id, pt.firstNameEnc);
  const last = keys.decrypt("patients", "last_name", pt.id, pt.lastNameEnc);
  const dob = pt.dobEnc ? keys.decrypt("patients", "dob", pt.id, pt.dobEnc) : "";
  const memberId = pt.memberIdEnc ? keys.decrypt("patients", "member_id", pt.id, pt.memberIdEnc) : "";
  const claimNumber = c.claimNumberEnc ? keys.decrypt("claims", "claim_number", c.id, c.claimNumberEnc) : "";
  const notes = l.notesEnc ? keys.decrypt("appeal_letters", "notes", l.id, l.notesEnc) : null;
  const deniedAt = c.denials[0]?.deniedAt ?? c.adjudicatedAt ?? null;

  // ClaimHive's evidence for the rule the letter uses (practices that share only).
  const evidence: string[] = [];
  if (l.ruleKey && practice.poolOptIn) {
    const rule = (await listRules({ synthetic: practice.isSynthetic, payers: [c.payer.name] })).find((r) => r.key === l.ruleKey);
    if (rule) { const t = explainRule(rule); evidence.push(t.headline, ...(t.appeal ? [t.appeal] : [])); }
  }
  const request = buildAppealRequest({ ...c, payer: { name: c.payer.name, verified: c.payer.verified } }, { enclosures: l.enclosures, argument: l.argument, evidence, notes });

  const known: KnownIdentifiers = {
    names: [first, last, `${first} ${last}`, practice.name, practice.letterName ?? "", practice.signerName ?? "", practice.addressLine1 ?? ""].filter(Boolean),
    numbers: [memberId, claimNumber, practice.npi ?? "", practice.taxId ?? "", practice.phone ?? "", practice.fax ?? ""].filter(Boolean),
    dates: [c.serviceDate, ...(deniedAt ? [deniedAt] : []), ...(/^\d{4}-\d{2}-\d{2}$/.test(dob) ? [new Date(`${dob}T00:00:00Z`)] : [])],
  };
  const writer = writerOverride ?? (l.writer !== "template" && aiAllowed(practice) ? anthropicWriter() : templateWriter);
  const fail = async (code: string) => {
    await withPractice(practiceId, (tx) => tx.appealLetter.update({ where: { id: l.id }, data: { status: "failed", errorCode: code } }));
    await audit({ action: "appeal.draft", practiceId, resourceType: "appeal_letter", resourceId: l.id, outcome: "failure", details: { writer: writer.name, code } });
    log.info({ event: "appeal.draft_failed", practiceId, jobId: l.id, outcome: code });
  };

  try {
    assertNoIdentifiers(JSON.stringify(request), known);
  } catch (e) {
    if (e instanceof IdentifierFound) return fail("identifier_in_request");
    throw e;
  }
  let written;
  try {
    written = await writer.write(request);
  } catch (e) {
    if (e instanceof WriterError) return fail(e.code);
    throw e;
  }
  if (unknownPlaceholders(written.body).length) return fail("unknown_placeholder");

  const values: MergeValues = {
    PATIENT_NAME: `${first} ${last}`,
    PATIENT_DOB: /^\d{4}-\d{2}-\d{2}$/.test(dob) ? fmt(new Date(`${dob}T00:00:00Z`)) : "[add date of birth]",
    MEMBER_ID: memberId || "[add member ID]",
    CLAIM_NUMBER: claimNumber || "[add claim number]",
    SERVICE_DATE: fmt(c.serviceDate),
    DENIAL_DATE: deniedAt ? fmt(deniedAt) : "[add denial date]",
    PRACTICE_NAME: practice.letterName || practice.name,
    PROVIDER_NPI: practice.npi || "[add NPI]",
    SIGNER_NAME: practice.signerName || "[add signer name]",
    SIGNER_TITLE: practice.signerTitle || "",
  };
  const body = merge(written.body, values);
  // Reuse the address this practice last used for the same insurer.
  const prev = await withPractice(practiceId, (tx) => tx.appealLetter.findFirst({
    where: { recipient: { not: null }, claim: { payerId: c.payerId }, id: { not: l.id } }, orderBy: { updatedAt: "desc" }, select: { recipient: true },
  }));
  await withPractice(practiceId, async (tx) => {
    const n = await tx.appealLetter.updateMany({ where: { id: l.id, status: "generating" }, data: {
      status: "draft", writer: written.writer, model: written.model ?? null, version: 1, errorCode: null,
      templateEnc: keys.encrypt("appeal_letters", "template", l.id, written.body),
      bodyEnc: keys.encrypt("appeal_letters", "body", l.id, body),
      recipient: prev?.recipient ?? null,
    } });
    if (n.count && c.appealStatus === "none") await tx.claim.update({ where: { id: c.id }, data: { appealStatus: "drafted" } });
  });
  await audit({ action: "appeal.draft", practiceId, resourceType: "appeal_letter", resourceId: l.id,
    details: { writer: written.writer, model: written.model ?? null, requestChars: JSON.stringify(request).length } });
  log.info({ event: "appeal.drafted", practiceId, jobId: l.id, outcome: written.writer, durationMs: Date.now() - started });
}

export async function letterDetail(ctx: Actor, letterId: string) {
  const keys = await keysFor(ctx.practiceId);
  const l = await withPractice(ctx.practiceId, (tx) => tx.appealLetter.findUnique({
    where: { id: letterId },
    include: { claim: { include: { patient: true, payer: { select: { name: true } }, lines: true, denials: { orderBy: { deniedAt: "asc" } } } } },
  }));
  if (!l) return null;
  const pt = l.claim.patient;
  const dob = pt.dobEnc ? keys.decrypt("patients", "dob", pt.id, pt.dobEnc) : "";
  return {
    letter: l,
    body: l.bodyEnc ? keys.decrypt("appeal_letters", "body", l.id, l.bodyEnc) : "",
    template: l.templateEnc ? keys.decrypt("appeal_letters", "template", l.id, l.templateEnc) : "",
    notes: l.notesEnc ? keys.decrypt("appeal_letters", "notes", l.id, l.notesEnc) : "",
    patient: {
      name: `${keys.decrypt("patients", "first_name", pt.id, pt.firstNameEnc)} ${keys.decrypt("patients", "last_name", pt.id, pt.lastNameEnc)}`,
      dob: /^\d{4}-\d{2}-\d{2}$/.test(dob) ? fmt(new Date(`${dob}T00:00:00Z`)) : "",
      memberId: pt.memberIdEnc ? keys.decrypt("patients", "member_id", pt.id, pt.memberIdEnc) : "",
    },
    claimNumber: l.claim.claimNumberEnc ? keys.decrypt("claims", "claim_number", l.claim.id, l.claim.claimNumberEnc) : "",
    serviceDate: fmt(l.claim.serviceDate),
    deniedAt: l.claim.denials[0] ? fmt(l.claim.denials[0].deniedAt) : "",
  };
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** Every save is a new version and clears any approval: the biller approves exactly what's used. */
export async function saveLetter(ctx: Actor, letterId: string, input: { body: string; recipient: string; enclosures: string[] }): Promise<number> {
  const body = input.body.replace(/\r\n/g, "\n").trim();
  if (!body) throw new LetterError("The letter is empty.");
  if (body.length > 20000) throw new LetterError("The letter is too long.");
  const keys = await keysFor(ctx.practiceId);
  const version = await withPractice(ctx.practiceId, async (tx) => {
    const l = await tx.appealLetter.findUnique({ where: { id: letterId } });
    if (!l || (l.status !== "draft" && l.status !== "approved")) throw new LetterError("This letter can't be edited.");
    if (l.sentAt) throw new LetterError("This letter was already sent.");
    const v = l.version + 1;
    await tx.appealLetter.update({ where: { id: l.id }, data: {
      bodyEnc: keys.encrypt("appeal_letters", "body", l.id, body), recipient: input.recipient.replace(/\r\n?/g, "\n").trim().slice(0, 500) || null,
      enclosures: input.enclosures.filter((e) => (ATTACHMENTS as readonly string[]).includes(e)),
      version: v, status: "draft", approvedVersion: null, approvedHash: null, approvedBy: null, approvedAt: null,
    } });
    return v;
  });
  await audit({ action: "appeal.edit", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "appeal_letter", resourceId: letterId, details: { version } });
  return version;
}

export async function approveLetter(ctx: Actor, letterId: string, version: number): Promise<void> {
  const practice = await prisma().practice.findUniqueOrThrow({ where: { id: ctx.practiceId } });
  const gaps = profileGaps(practice);
  if (gaps.length) throw new LetterError(`Add the practice's ${gaps.join(", ")} in Settings first: they go on the letterhead.`);
  const d = await letterDetail(ctx, letterId);
  if (!d || d.letter.status !== "draft") throw new LetterError("Only a draft can be approved.");
  if (d.letter.version !== version) throw new LetterError("The letter changed since you opened it. Review the latest version, then approve.");
  if (/\{\{|\}\}/.test(d.body) || MISSING.test(d.body)) throw new LetterError("Fill in every [add …] item in the letter first.");
  if (!d.letter.recipient?.trim()) throw new LetterError("Add the insurer's appeals address first.");
  const h = hash(`${d.letter.recipient}\n${d.body}\n${d.letter.enclosures.join(",")}`);
  await withPractice(ctx.practiceId, (tx) => tx.appealLetter.update({ where: { id: letterId }, data: {
    status: "approved", approvedVersion: version, approvedHash: h, approvedBy: ctx.userId, approvedAt: new Date(),
  } }));
  await audit({ action: "appeal.approve", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "appeal_letter", resourceId: letterId, details: { version, sha256: h } });
}

/** The biller sent the approved letter themselves. Records the appeal on the claim (and its attribution). */
export async function markLetterSent(ctx: Actor, letterId: string): Promise<string> {
  const claimId = await withPractice(ctx.practiceId, async (tx) => {
    const l = await tx.appealLetter.findUnique({ where: { id: letterId } });
    if (!l || l.status !== "approved") throw new LetterError("Approve the letter before marking it sent.");
    if (l.sentAt) return l.claimId;
    const now = new Date();
    await tx.appealLetter.update({ where: { id: l.id }, data: { sentAt: now } });
    await tx.claim.update({ where: { id: l.claimId }, data: {
      appealStatus: "sent", appealSentAt: now, appealAttachments: l.enclosures, appealArgument: l.argument,
      appealRuleKey: l.ruleKey, appealLetterId: l.id,
    } });
    return l.claimId;
  });
  await audit({ action: "appeal.sent", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "appeal_letter", resourceId: letterId, details: { claimId } });
  return claimId;
}

/**
 * Reconciles NormalizedClaims from any source with the practice's claims.
 *
 * Matching (in order):
 *   1. claim number (keyed hash; 837 CLM01 is echoed back as 835 CLP01)
 *   2. same patient + payer + date of service
 * Patients match on last name + DOB, or member ID + last name.
 *
 * Each source owns the fields it knows best:
 *   837D   procedures, teeth, surfaces, attachments, billed amount, plan type
 *   835/EOB payment, denials, adjudication date, status
 *   aging  fills gaps only (it's a summary report)
 *
 * When a claim that was denied is later paid more, the difference is recorded in
 * the results ledger as recovered money, and the original denials are kept as history.
 */
import type { PracticeKeys } from "../crypto";
import type { TenantTx } from "../db";
import { isAttachment, recordResults, isClaimHiveAttributed, type ResultInput } from "../results/ledger";
import type { Attachment } from "../reference/codes";
import { claimTotals, type NormalizedClaim, type ParseProblem, type SourceKind } from "./types";

export interface MergeStats {
  created: number;
  updated: number;
  skipped: number;
  deniedCents: number;
  paidCents: number;
  recoveredCents: number;
  problems: ParseProblem[];
}

const DAY = 86_400_000;
const toDate = (s: string | undefined) => (s ? new Date(`${s}T00:00:00Z`) : undefined);

/**
 * Finds or creates the insurer. `trusted` sources (835/837, which carry an X12 payer
 * ID) mark it verified; names typed into a spreadsheet never do, so only verified
 * names can appear in the shared pool.
 */
export async function resolvePayer(tx: TenantTx, name: string | undefined, payerId: string | undefined, trusted = false): Promise<string | undefined> {
  const cleanName = name?.replace(/\s+/g, " ").trim();
  const verify = trusted && !!payerId;
  const found = (payerId && (await tx.payer.findUnique({ where: { payerCode: payerId } })))
    || (cleanName && (await tx.payer.findFirst({ where: { name: { equals: cleanName, mode: "insensitive" } } })))
    || null;
  if (found) {
    if (verify && !found.verified) await tx.payer.update({ where: { id: found.id }, data: { verified: true } });
    return found.id;
  }
  if (!cleanName && !payerId) return undefined;
  const code = payerId ?? `NAME:${cleanName!.toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 40)}`;
  const created = await tx.payer.upsert({ where: { payerCode: code }, create: { name: titleCase(cleanName ?? code), payerCode: code, verified: verify }, update: {} });
  return created.id;
}

function titleCase(s: string): string {
  return s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s;
}

async function findPatient(tx: TenantTx, keys: PracticeKeys, p: NormalizedClaim["patient"]) {
  if (p.lastName && p.dob) {
    const hit = await tx.patient.findFirst({ where: { lookupIndex: keys.lookupIndex(p.lastName, p.dob) } });
    if (hit) return hit;
  }
  if (p.lastName && p.memberId) {
    const hit = await tx.patient.findFirst({ where: { memberLookup: keys.lookupIndex(p.memberId, p.lastName) } });
    if (hit) return hit;
  }
  return null;
}

async function upsertPatient(tx: TenantTx, keys: PracticeKeys, p: NormalizedClaim["patient"]) {
  const existing = await findPatient(tx, keys, p);
  if (existing) {
    // Fill in what this source knows that we didn't (e.g. DOB from an 837 for a patient first seen on an 835).
    const data: Record<string, unknown> = {};
    if (!existing.dobEnc && p.dob) {
      data.dobEnc = keys.encrypt("patients", "dob", existing.id, p.dob);
      data.lookupIndex = keys.lookupIndex(p.lastName, p.dob);
    }
    if (!existing.memberLookup && p.memberId) {
      data.memberIdEnc = keys.encrypt("patients", "member_id", existing.id, p.memberId);
      data.memberLookup = keys.lookupIndex(p.memberId, p.lastName);
    }
    if (Object.keys(data).length) await tx.patient.update({ where: { id: existing.id }, data });
    return existing.id;
  }
  const id = crypto.randomUUID();
  await tx.patient.create({
    data: {
      id, practiceId: tx.practiceId,
      firstNameEnc: keys.encrypt("patients", "first_name", id, p.firstName ?? ""),
      lastNameEnc: keys.encrypt("patients", "last_name", id, p.lastName),
      dobEnc: p.dob ? keys.encrypt("patients", "dob", id, p.dob) : null,
      memberIdEnc: p.memberId ? keys.encrypt("patients", "member_id", id, p.memberId) : null,
      lookupIndex: p.dob ? keys.lookupIndex(p.lastName, p.dob) : null,
      memberLookup: p.memberId ? keys.lookupIndex(p.memberId, p.lastName) : null,
    },
  });
  return id;
}

const claimInclude = { lines: true, denials: true } as const;

async function findClaim(tx: TenantTx, keys: PracticeKeys, c: NormalizedClaim, payerId: string | undefined) {
  if (c.claimNumber) {
    const hit = await tx.claim.findFirst({ where: { claimKey: keys.lookupIndex("claim", c.claimNumber) }, include: claimInclude });
    if (hit) return hit;
  }
  if (!c.serviceDate || !payerId) return null;
  // A claim with a different claim number is a different claim, even for the same patient, day and carrier.
  const sameOrUnknownNumber = c.claimNumber ? { OR: [{ claimKey: null }, { claimKey: keys.lookupIndex("claim", c.claimNumber) }] } : {};
  const patient = await findPatient(tx, keys, c.patient);
  if (patient) {
    return tx.claim.findFirst({
      where: { patientId: patient.id, payerId, serviceDate: toDate(c.serviceDate), ...sameOrUnknownNumber },
      include: claimInclude, orderBy: { createdAt: "asc" },
    });
  }
  // No DOB or member ID (some aging reports): compare names, but only among this
  // carrier's claims on this date of service, decrypting just those few patients.
  const candidates = await tx.claim.findMany({
    where: { payerId, serviceDate: toDate(c.serviceDate), ...sameOrUnknownNumber }, include: { ...claimInclude, patient: true }, take: 50,
  });
  const norm = (v: string | undefined) => (v ?? "").normalize("NFKD").replace(/[^\p{L}]/gu, "").toLowerCase();
  const matches = candidates.filter((k) => {
    const last = keys.decrypt("patients", "last_name", k.patient.id, k.patient.lastNameEnc);
    const first = keys.decrypt("patients", "first_name", k.patient.id, k.patient.firstNameEnc);
    return norm(last) === norm(c.patient.lastName) && (!c.patient.firstName || !first || norm(first) === norm(c.patient.firstName));
  });
  return matches.length === 1 ? matches[0] : null; // ambiguous → treat as new rather than guess
}

function statusOf(c: NormalizedClaim): "submitted" | "paid" | "partially_paid" | "denied" {
  return c.status ?? "submitted";
}

/** Merge one parsed file into the practice. Runs inside the caller's withPractice transaction. */
export async function mergeClaims(
  tx: TenantTx, keys: PracticeKeys, claims: NormalizedClaim[],
  opts: { batchId?: string; isSynthetic: boolean; now?: Date },
): Promise<MergeStats> {
  const stats: MergeStats = { created: 0, updated: 0, skipped: 0, deniedCents: 0, paidCents: 0, recoveredCents: 0, problems: [] };
  const results: ResultInput[] = [];

  for (const c of claims) {
    if (c.isReversal) { stats.skipped++; stats.problems.push({ ref: c.ref, code: "reversal_skipped" }); continue; }
    if (!c.patient.lastName) { stats.skipped++; stats.problems.push({ ref: c.ref, code: "missing_patient" }); continue; }
    const payerId = await resolvePayer(tx, c.payer.name, c.payer.payerId, c.source === "era835" || c.source === "claim837");
    if (!payerId) { stats.skipped++; stats.problems.push({ ref: c.ref, code: "missing_carrier" }); continue; }
    const totals = claimTotals(c);
    stats.deniedCents += totals.denied;
    stats.paidCents += totals.paid;

    const existing = await findClaim(tx, keys, c, payerId);
    if (!existing) {
      if (!c.serviceDate) { stats.skipped++; stats.problems.push({ ref: c.ref, code: "missing_service_date" }); continue; }
      const patientId = await upsertPatient(tx, keys, c.patient);
      const id = crypto.randomUUID();
      await tx.claim.create({
        data: {
          id, practiceId: tx.practiceId, patientId, payerId,
          planType: c.planType ?? "UNKNOWN",
          claimNumberEnc: c.claimNumber ? keys.encrypt("claims", "claim_number", id, c.claimNumber) : null,
          claimKey: c.claimNumber ? keys.lookupIndex("claim", c.claimNumber) : null,
          serviceDate: toDate(c.serviceDate)!, submittedAt: toDate(c.submittedAt) ?? null, adjudicatedAt: toDate(c.adjudicatedAt) ?? null,
          status: statusOf(c), billedCents: totals.billed, paidCents: totals.paid,
          attachments: c.attachments ?? [], sources: [c.source], isSynthetic: opts.isSynthetic,
        },
      });
      await writeLines(tx, id, c, toDate(c.adjudicatedAt ?? c.serviceDate)!);
      stats.created++;
      continue;
    }

    // ---- update an existing claim
    const data: Record<string, unknown> = {};
    const sources = new Set(existing.sources);
    sources.add(c.source);
    data.sources = [...sources];
    if (!existing.claimKey && c.claimNumber) {
      data.claimKey = keys.lookupIndex("claim", c.claimNumber);
      data.claimNumberEnc = keys.encrypt("claims", "claim_number", existing.id, c.claimNumber);
    }
    if (c.planType && c.planType !== "UNKNOWN" && (existing.planType === "UNKNOWN" || c.source === "claim837")) data.planType = c.planType;
    if (c.submittedAt && !existing.submittedAt) data.submittedAt = toDate(c.submittedAt);

    const remittance = c.source === "era835" || c.source === "eob_pdf";
    if (c.source === "claim837") {
      data.attachments = mergeAttachments(existing.attachments, c.attachments);
      if (totals.billed) data.billedCents = totals.billed;
      const hasPayment = existing.sources.includes("era835") || existing.sources.includes("eob_pdf");
      if (!hasPayment && c.lines.length) {
        await tx.claimLine.deleteMany({ where: { claimId: existing.id } });
        await writeLines(tx, existing.id, c, toDate(c.serviceDate)!);
      } else {
        await fillLineDetail(tx, existing.lines, c);
      }
    } else if (remittance) {
      const newAt = toDate(c.adjudicatedAt);
      const oldAt = existing.adjudicatedAt;
      if (oldAt && newAt && newAt < oldAt) {
        stats.skipped++; stats.problems.push({ ref: c.ref, code: "older_than_current_remittance" });
        await tx.claim.update({ where: { id: existing.id }, data: { sources: data.sources as string[] } });
        continue;
      }
      const wasDenied = existing.denials.length > 0;
      const increase = totals.paid - existing.paidCents;
      const later = !oldAt || !newAt || newAt.getTime() - oldAt.getTime() >= DAY;
      if (wasDenied && increase > 0 && later) {
        // Paid after a denial: keep the denials as history, credit the difference.
        data.paidCents = totals.paid;
        data.adjudicatedAt = newAt ?? existing.adjudicatedAt;
        data.status = totals.denied > 0 ? "partially_paid" : "paid";
        data.appealStatus = "won";
        data.recoveredCents = existing.recoveredCents + increase;
        const first = existing.denials[0];
        const payer = await tx.payer.findUnique({ where: { id: existing.payerId }, select: { name: true } });
        // Attributed to ClaimHive when the office appealed with the fix a ClaimHive rule suggested.
        const viaClaimHive = isClaimHiveAttributed({ flaggedFixApplied: !!existing.appealRuleKey });
        results.push({
          practiceId: tx.practiceId, claimId: existing.id, kind: "recovered", amountCents: increase,
          attributed: viaClaimHive,
          method: !viaClaimHive ? "paid_after_denial" : existing.appealAttachments.length ? "appeal_with_attachment" : "appeal_with_argument",
          evidence: {
            payer: payer?.name, cdtCodes: [...new Set(existing.lines.filter((l) => existing.denials.some((d) => d.claimLineId === l.id)).map((l) => l.cdtCode))],
            carc: first.carc, rarc: first.rarc ?? undefined, deniedAt: first.deniedAt.toISOString().slice(0, 10), paidAt: c.adjudicatedAt,
            attachment: existing.appealAttachments.find(isAttachment), ruleId: existing.appealRuleKey ?? undefined,
          },
          occurredAt: newAt ?? opts.now ?? new Date(), sourceBatchId: opts.batchId, isSynthetic: opts.isSynthetic,
        });
        stats.recoveredCents += increase;
      } else {
        // First (or replacement) adjudication: this remittance is the claim's current state.
        data.paidCents = totals.paid;
        data.status = statusOf(c);
        if (newAt) data.adjudicatedAt = newAt;
        if (!existing.lines.length && c.lines.length) {
          await writeLines(tx, existing.id, c, newAt ?? existing.serviceDate);
        } else {
          await tx.denial.deleteMany({ where: { claimId: existing.id } });
          await applyRemittanceToLines(tx, existing.id, existing.lines, c, newAt ?? existing.serviceDate);
        }
      }
    } else {
      // Aging report: fill gaps only.
      if (!existing.billedCents && totals.billed) data.billedCents = totals.billed;
      if (!existing.lines.length && c.lines.length) await writeLines(tx, existing.id, c, existing.serviceDate);
    }
    await tx.claim.update({ where: { id: existing.id }, data });
    stats.updated++;
  }
  await recordResults(tx, results);
  return stats;
}

function mergeAttachments(a: string[], b: Attachment[] | undefined): string[] {
  return [...new Set([...a, ...(b ?? [])])];
}

async function writeLines(tx: TenantTx, claimId: string, c: NormalizedClaim, deniedAt: Date) {
  for (const l of c.lines) {
    const line = await tx.claimLine.create({
      data: {
        practiceId: tx.practiceId, claimId, cdtCode: l.cdtCode, tooth: l.tooth ?? null, surfaces: l.surfaces ?? null,
        feeCents: l.feeCents ?? 0, paidCents: l.paidCents ?? 0,
      },
    });
    for (const d of l.denials) {
      await tx.denial.create({ data: { practiceId: tx.practiceId, claimId, claimLineId: line.id, groupCode: d.groupCode, carc: d.carc, rarc: d.rarc ?? null, amountCents: d.amountCents, deniedAt } });
    }
  }
  for (const d of c.claimDenials) {
    await tx.denial.create({ data: { practiceId: tx.practiceId, claimId, groupCode: d.groupCode, carc: d.carc, rarc: d.rarc ?? null, amountCents: d.amountCents, deniedAt } });
  }
}

/** Pairs incoming lines with stored ones by procedure code, in order. */
function pairLines<T extends { cdtCode: string }>(stored: T[], incoming: NormalizedClaim["lines"]) {
  const used = new Set<number>();
  return incoming.map((l) => {
    const i = stored.findIndex((s, idx) => !used.has(idx) && s.cdtCode === l.cdtCode);
    if (i >= 0) used.add(i);
    return { incoming: l, stored: i >= 0 ? stored[i] : undefined };
  });
}

async function fillLineDetail(tx: TenantTx, stored: { id: string; cdtCode: string; tooth: string | null; surfaces: string | null }[], c: NormalizedClaim) {
  for (const { incoming, stored: s } of pairLines(stored, c.lines)) {
    if (!s) continue;
    const data: Record<string, string> = {};
    if (!s.tooth && incoming.tooth) data.tooth = incoming.tooth;
    if (!s.surfaces && incoming.surfaces) data.surfaces = incoming.surfaces;
    if (Object.keys(data).length) await tx.claimLine.update({ where: { id: s.id }, data });
  }
}

async function applyRemittanceToLines(tx: TenantTx, claimId: string, stored: { id: string; cdtCode: string }[], c: NormalizedClaim, deniedAt: Date) {
  for (const { incoming, stored: s } of pairLines(stored, c.lines)) {
    let lineId = s?.id;
    if (s) {
      await tx.claimLine.update({ where: { id: s.id }, data: { paidCents: incoming.paidCents ?? 0, ...(incoming.feeCents ? { feeCents: incoming.feeCents } : {}) } });
    } else {
      const created = await tx.claimLine.create({ data: { practiceId: tx.practiceId, claimId, cdtCode: incoming.cdtCode, feeCents: incoming.feeCents ?? 0, paidCents: incoming.paidCents ?? 0 } });
      lineId = created.id;
    }
    for (const d of incoming.denials) {
      await tx.denial.create({ data: { practiceId: tx.practiceId, claimId, claimLineId: lineId, groupCode: d.groupCode, carc: d.carc, rarc: d.rarc ?? null, amountCents: d.amountCents, deniedAt } });
    }
  }
  for (const d of c.claimDenials) {
    await tx.denial.create({ data: { practiceId: tx.practiceId, claimId, groupCode: d.groupCode, carc: d.carc, rarc: d.rarc ?? null, amountCents: d.amountCents, deniedAt } });
  }
}

export type { SourceKind };

/**
 * The results ledger: every dollar recovered or protected, what earned it, and
 * the evidence, in plain English and without PHI. It is append-only (database
 * trigger), and the results page, the monthly report and Phase 7 contingency
 * invoices all read from here, so they can't disagree.
 *
 * Kinds:
 *   recovered  money that arrived after a denial. Billable only when `attributed`,
 *              meaning it came through a ClaimHive-flagged fix or a ClaimHive appeal.
 *   protected  a claim ClaimHive flagged before sending, fixed, then paid.
 *              Shown to the office, never billed.
 */
import { ATTACHMENTS, CARC, type Attachment } from "../reference/codes";
import { withPractice, type TenantTx } from "../db";
import type { Prisma } from "@/generated/prisma/client";

const ATTACHMENT_LABEL: Record<Attachment, string> = {
  xray: "X-ray", narrative: "narrative", perio_chart: "periodontal chart", photo: "photo",
};

export const METHODS = {
  appeal_with_attachment: "Appeal with the missing attachment",
  appeal_with_argument: "Appeal with a written argument",
  appeal_letter: "Appeal letter drafted by ClaimHive",
  attachment_added_before_sending: "Attachment added before sending",
  code_fixed_before_sending: "Coding fixed before sending",
  paid_after_denial: "Paid after your team resubmitted",
} as const;
export type Method = keyof typeof METHODS;

export interface Evidence {
  payer?: string;
  cdtCodes?: string[];
  carc?: string;
  rarc?: string;
  attachment?: Attachment;
  ruleId?: string;
  deniedAt?: string;
  paidAt?: string;
  [k: string]: string | string[] | undefined;
}

const reason = (carc?: string, rarc?: string) => {
  if (!carc) return "";
  const label = CARC.find((c) => c.code === carc)?.label.toLowerCase();
  const remark = rarc ? ` / ${rarc}` : "";
  return label ? ` (reason ${carc}${remark}: ${label})` : ` (reason ${carc}${remark})`;
};

/** One PHI-free sentence explaining how the money was won. */
export function explain(method: Method, e: Evidence): string {
  const payer = e.payer ?? "the insurer";
  const att = e.attachment ? ATTACHMENT_LABEL[e.attachment] : "documentation";
  const codes = e.cdtCodes?.length ? ` for ${e.cdtCodes.join(", ")}` : "";
  switch (method) {
    case "appeal_with_attachment":
      return `Appealed${codes} with the ${att} ${payer} asked for${reason(e.carc, e.rarc)}.`;
    case "appeal_with_argument":
      return `Appealed the ${payer} denial${codes} with a written argument${reason(e.carc, e.rarc)}.`;
    case "appeal_letter":
      return `Appealed the ${payer} denial${codes} with a letter ClaimHive drafted${e.attachment ? ` and the ${att}` : ""}${reason(e.carc, e.rarc)}.`;
    case "attachment_added_before_sending":
      return `ClaimHive flagged the missing ${att}${codes} before the claim was sent. ${payer} usually denies it without one, and this time paid.`;
    case "code_fixed_before_sending":
      return `ClaimHive flagged a coding problem${codes} before the claim was sent, and ${payer} paid.`;
    case "paid_after_denial":
      return `${payer} paid${codes} after an earlier denial${reason(e.carc, e.rarc)}, once your team resubmitted or appealed it.`;
  }
}

export interface ResultInput {
  practiceId: string;
  claimId: string;
  kind: "recovered" | "protected";
  amountCents: number;
  attributed: boolean;
  method: Method;
  evidence: Evidence;
  occurredAt: Date;
  sourceBatchId?: string;
  isSynthetic?: boolean;
}

/** Adds ledger rows; a claim can only be credited once per kind and method. */
export async function recordResults(tx: TenantTx, rows: ResultInput[]): Promise<number> {
  if (!rows.length) return 0;
  const r = await tx.resultEvent.createMany({
    data: rows.filter((x) => x.amountCents > 0).map((x) => ({
      practiceId: x.practiceId, claimId: x.claimId, kind: x.kind, amountCents: x.amountCents, attributed: x.attributed,
      method: x.method, explanation: explain(x.method, x.evidence), evidence: x.evidence as Prisma.InputJsonValue,
      occurredAt: x.occurredAt, sourceBatchId: x.sourceBatchId ?? null, isSynthetic: x.isSynthetic ?? false,
    })),
    skipDuplicates: true,
  });
  return r.count;
}

/**
 * Attribution: did this money come through ClaimHive? True when the office appealed
 * using the fix a ClaimHive rule suggested (recorded on the claim, Phase 4), or
 * (Phase 5/6) fixed a claim ClaimHive flagged before sending, or sent a ClaimHive-drafted appeal.
 */
export function isClaimHiveAttributed(_link: { flaggedFixApplied?: boolean; claimHiveAppeal?: boolean }): boolean {
  return !!(_link.flaggedFixApplied || _link.claimHiveAppeal);
}

export interface ResultRow {
  id: string;
  claimRef: string;
  kind: "recovered" | "protected";
  amountCents: number;
  attributed: boolean;
  method: Method;
  methodLabel: string;
  explanation: string;
  occurredAt: string;
  payer: string;
  cdtCodes: string[];
  carc?: string;
  rarc?: string;
}

export interface ResultsSummary {
  from: string;
  to: string;
  recoveredCents: number;
  recoveredCount: number;
  protectedCents: number;
  protectedCount: number;
  outsideCents: number; // recovered by the office without ClaimHive: shown, not billed
  outsideCount: number;
  byMethod: { method: Method; label: string; kind: "recovered" | "protected"; cents: number; count: number }[];
  byPayer: { payer: string; cents: number; count: number }[];
  rows: ResultRow[];
  anySynthetic: boolean;
}

export async function resultsSummary(practiceId: string, from: Date, to: Date): Promise<ResultsSummary> {
  const events = await withPractice(practiceId, (tx) => tx.resultEvent.findMany({
    where: { occurredAt: { gte: from, lte: to } },
    orderBy: [{ occurredAt: "desc" }, { amountCents: "desc" }],
    select: { id: true, claimId: true, kind: true, amountCents: true, attributed: true, method: true, explanation: true,
      occurredAt: true, evidence: true, isSynthetic: true, claim: { select: { payer: { select: { name: true } } } } },
  }));
  const s: ResultsSummary = {
    from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10),
    recoveredCents: 0, recoveredCount: 0, protectedCents: 0, protectedCount: 0, outsideCents: 0, outsideCount: 0,
    byMethod: [], byPayer: [], rows: [], anySynthetic: false,
  };
  const methods = new Map<string, ResultsSummary["byMethod"][number]>();
  const payers = new Map<string, ResultsSummary["byPayer"][number]>();
  for (const e of events) {
    const ev = e.evidence as Evidence;
    const method = e.method as Method;
    s.anySynthetic ||= e.isSynthetic;
    if (e.kind === "recovered" && !e.attributed) { s.outsideCents += e.amountCents; s.outsideCount++; }
    else if (e.kind === "recovered") { s.recoveredCents += e.amountCents; s.recoveredCount++; }
    else { s.protectedCents += e.amountCents; s.protectedCount++; }
    if (e.kind === "protected" || e.attributed) {
      const k = `${e.kind}|${method}`;
      const m = methods.get(k) ?? { method, label: METHODS[method] ?? method, kind: e.kind, cents: 0, count: 0 };
      m.cents += e.amountCents; m.count++; methods.set(k, m);
      const p = payers.get(e.claim.payer.name) ?? { payer: e.claim.payer.name, cents: 0, count: 0 };
      p.cents += e.amountCents; p.count++; payers.set(p.payer, p);
    }
    s.rows.push({
      id: e.id, claimRef: e.claimId.slice(0, 8).toUpperCase(), kind: e.kind, amountCents: e.amountCents, attributed: e.attributed,
      method, methodLabel: METHODS[method] ?? method, explanation: e.explanation, occurredAt: e.occurredAt.toISOString().slice(0, 10),
      payer: e.claim.payer.name, cdtCodes: ev.cdtCodes ?? [], carc: ev.carc, rarc: ev.rarc,
    });
  }
  s.byMethod = [...methods.values()].sort((a, b) => b.cents - a.cents);
  s.byPayer = [...payers.values()].sort((a, b) => b.cents - a.cents);
  return s;
}

export const isAttachment = (v: unknown): v is Attachment => (ATTACHMENTS as readonly string[]).includes(String(v));

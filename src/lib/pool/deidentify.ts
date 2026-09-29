/**
 * De-identification for the shared pool (HIPAA Safe Harbor, 45 CFR 164.514(b)(2)).
 *
 * A pool record is BUILT from an allowlist; nothing is copied wholesale. It
 * contains only the fields the owner agreed to share:
 *   v1 (2026-09-v1): payer, plan type, region (state), CDT codes, attachments
 *       present, denial codes (CARC/RARC), outcome, days to payment.
 *   v2 (2026-09-v2) adds: what an appeal included (attachments added, kind of
 *       argument) and, per procedure, how many times it was billed for the same
 *       patient in the past 12 months as a bucket (1, 2, 3+), computed inside the
 *       practice. A practice on v1 shares the v2 fields as empty.
 *
 * How each of the 18 Safe Harbor identifiers is handled:
 *   names, addresses, phone/fax, email, SSN, medical record / health plan
 *   beneficiary / account numbers, certificate/license numbers, vehicle and
 *   device ids, URLs, IP addresses, biometrics, photos → never read into the record.
 *   Geography smaller than a state → only the practice's state is used.
 *   Dates (service, birth, submission, payment) → dropped; only the whole-day
 *   interval "days to payment" is kept, capped at 730.
 *   Ages → not included.
 *   Any other unique identifying number or code → the record id is random and the
 *   contributor is a random token, neither derived from patient or practice data
 *   (164.514(c)); claim numbers and ClaimHive ids never leave the practice.
 *
 * Extra defenses: an insurer is named only if verified (from an X12 payer ID, or
 * curated), so a mis-mapped spreadsheet column can't put a person's name in the
 * pool; `assertSafeHarbor` re-validates every record before it's written, and the
 * pool tables enforce the same shapes with CHECK constraints.
 */
import { ATTACHMENTS, US_STATES } from "../reference/codes";

export const POOL_CONSENT_VERSION = "2026-09-v2";
/** Consent versions that include the appeal-fix and frequency fields. */
export const EXTENDED_CONSENT = new Set(["2026-09-v2"]);
export const APPEAL_ARGUMENTS = ["documentation", "medical_necessity", "coding_correction", "frequency_exception", "coverage_dispute", "other"] as const;
export type AppealArgument = (typeof APPEAL_ARGUMENTS)[number];

export type PoolOutcome = "pending" | "paid" | "partially_paid" | "denied" | "appeal_won" | "appeal_lost";

export interface PoolLine {
  cdt: string;
  denied: boolean;
  carcs: string[]; // "CO-16"
  rarcs: string[]; // "N706"
  freqBucket: 1 | 2 | 3 | null; // v2 only
}

export interface PoolRecord {
  id: string;
  contributor: string;
  payer: string;
  planType: string;
  region: string;
  attachments: string[];
  outcome: PoolOutcome;
  daysToPayment: number | null;
  appealAttachments: string[];         // v2 only
  appealArgument: AppealArgument | null; // v2 only
  extended: boolean;                   // true when the v2 fields are shared
  isSynthetic: boolean;
  lines: PoolLine[];
}

/** The claim fields de-identification is allowed to look at. */
export interface ClaimForPool {
  planType: string;
  status: string;
  appealStatus: string;
  submittedAt: Date | null;
  adjudicatedAt: Date | null;
  paidCents: number;
  attachments: string[];
  appealAttachments: string[];
  appealArgument: string | null;
  isSynthetic: boolean;
  payer: { name: string; verified: boolean };
  lines: { id: string; cdtCode: string }[];
  denials: { claimLineId: string | null; groupCode: string; carc: string; rarc: string | null }[];
}

export type SkipReason = "unverified_payer" | "no_procedures" | "draft";

const DAY = 86_400_000;
const PLAN_TYPES = new Set(["PPO", "DHMO", "INDEMNITY", "MEDICAID", "MEDICARE_ADVANTAGE", "UNKNOWN"]);
const OUTCOMES = new Set<PoolOutcome>(["pending", "paid", "partially_paid", "denied", "appeal_won", "appeal_lost"]);
const CDT = /^D\d{4}$/;
const CARC = /^(CO|PR|OA|PI)-[A-Z0-9]{1,5}$/;
const RARC = /^[A-Z]{1,2}\d{1,4}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Payer names: letters, digits, spaces and ordinary punctuation; no digits-only runs that could be ids.
const PAYER = /^[A-Za-z][A-Za-z0-9 .,&'()/-]{1,79}$/;

export function outcomeOf(c: Pick<ClaimForPool, "status" | "appealStatus">): PoolOutcome {
  if (c.appealStatus === "won") return "appeal_won";
  if (c.appealStatus === "lost") return "appeal_lost";
  if (c.status === "paid" || c.status === "partially_paid" || c.status === "denied") return c.status;
  return "pending";
}

export function toPoolRecord(
  c: ClaimForPool,
  ctx: { id: string; contributor: string; region: string; extended?: boolean; freq?: Map<string, number> },
): { record: PoolRecord } | { skip: SkipReason } {
  if (c.status === "draft") return { skip: "draft" };
  if (!c.lines.length) return { skip: "no_procedures" };
  if (!c.payer.verified || !PAYER.test(c.payer.name)) return { skip: "unverified_payer" };

  const days = c.submittedAt && c.adjudicatedAt ? Math.round((c.adjudicatedAt.getTime() - c.submittedAt.getTime()) / DAY) : null;
  const record: PoolRecord = {
    id: ctx.id,
    contributor: ctx.contributor,
    payer: c.payer.name.replace(/\s+/g, " ").trim(),
    planType: c.planType,
    region: ctx.region,
    attachments: [...new Set(c.attachments)].filter((a) => (ATTACHMENTS as readonly string[]).includes(a)).sort(),
    outcome: outcomeOf(c),
    daysToPayment: days !== null && days >= 0 && days <= 730 && c.paidCents > 0 ? days : null,
    appealAttachments: ctx.extended ? [...new Set(c.appealAttachments)].filter((a) => (ATTACHMENTS as readonly string[]).includes(a)).sort() : [],
    appealArgument: ctx.extended && (APPEAL_ARGUMENTS as readonly string[]).includes(c.appealArgument ?? "") ? (c.appealArgument as AppealArgument) : null,
    extended: !!ctx.extended,
    isSynthetic: c.isSynthetic,
    lines: c.lines.map((l) => {
      const d = c.denials.filter((x) => x.claimLineId === l.id);
      return {
        cdt: l.cdtCode,
        denied: d.length > 0,
        carcs: [...new Set(d.map((x) => `${x.groupCode}-${x.carc}`))].sort(),
        rarcs: [...new Set(d.map((x) => x.rarc).filter((x): x is string => !!x))].sort(),
        freqBucket: ctx.extended ? bucket(ctx.freq?.get(l.id)) : null,
      };
    }),
  };
  // Claim-level denials (not tied to a line) apply to every line.
  const claimLevel = c.denials.filter((x) => !x.claimLineId);
  if (claimLevel.length) {
    for (const l of record.lines) {
      l.denied = true;
      l.carcs = [...new Set([...l.carcs, ...claimLevel.map((x) => `${x.groupCode}-${x.carc}`)])].sort();
      l.rarcs = [...new Set([...l.rarcs, ...claimLevel.map((x) => x.rarc).filter((x): x is string => !!x)])].sort();
    }
  }
  assertSafeHarbor(record);
  return { record };
}

function bucket(n: number | undefined): 1 | 2 | 3 | null {
  if (!n || n < 1) return null;
  return n >= 3 ? 3 : (n as 1 | 2);
}

export class DeidentificationError extends Error {}

/** Re-validates a record's exact shape and every value. Throws on anything unexpected. */
export function assertSafeHarbor(r: PoolRecord): void {
  const fail = (why: string) => { throw new DeidentificationError(`pool record rejected: ${why}`); };
  const keys = Object.keys(r).sort().join(",");
  if (keys !== "appealArgument,appealAttachments,attachments,contributor,daysToPayment,extended,id,isSynthetic,lines,outcome,payer,planType,region") fail("unexpected fields");
  if (!r.appealAttachments.every((a) => (ATTACHMENTS as readonly string[]).includes(a))) fail("appeal attachments");
  if (r.appealArgument !== null && !(APPEAL_ARGUMENTS as readonly string[]).includes(r.appealArgument)) fail("appeal argument");
  if (!UUID.test(r.id) || !UUID.test(r.contributor)) fail("ids must be random UUIDs");
  if (!PAYER.test(r.payer)) fail("payer");
  if (!PLAN_TYPES.has(r.planType)) fail("plan type");
  if (!US_STATES.includes(r.region)) fail("region must be a US state");
  if (!r.attachments.every((a) => (ATTACHMENTS as readonly string[]).includes(a))) fail("attachments");
  if (!OUTCOMES.has(r.outcome)) fail("outcome");
  if (r.daysToPayment !== null && (!Number.isInteger(r.daysToPayment) || r.daysToPayment < 0 || r.daysToPayment > 730)) fail("days to payment");
  if (typeof r.isSynthetic !== "boolean" || typeof r.extended !== "boolean") fail("flags");
  if (!r.extended && (r.appealAttachments.length || r.appealArgument !== null || r.lines.some((l) => l.freqBucket !== null))) fail("v2 fields without v2 consent");
  if (!r.lines.length) fail("no lines");
  for (const l of r.lines) {
    if (Object.keys(l).sort().join(",") !== "carcs,cdt,denied,freqBucket,rarcs") fail("unexpected line fields");
    if (l.freqBucket !== null && ![1, 2, 3].includes(l.freqBucket)) fail("frequency bucket");
    if (!CDT.test(l.cdt) || typeof l.denied !== "boolean") fail("line");
    if (!l.carcs.every((x) => CARC.test(x)) || !l.rarcs.every((x) => RARC.test(x))) fail("denial codes");
  }
}

/**
 * The one claim shape every importer produces (aging report, 835, 837D, EOB PDF).
 * Parsers are pure: they turn file contents into NormalizedClaims and never
 * touch the database. `merge.ts` reconciles them with existing claims.
 *
 * Fields a source doesn't carry are left undefined, never guessed, so a merge
 * can tell "unknown" from "zero".
 */
import type { Attachment } from "../reference/codes";

export type PlanType = "PPO" | "DHMO" | "INDEMNITY" | "MEDICAID" | "MEDICARE_ADVANTAGE" | "UNKNOWN";
export type ClaimStatus = "draft" | "submitted" | "paid" | "partially_paid" | "denied";
export type SourceKind = "aging" | "era835" | "claim837" | "eob_pdf" | "precheck";

export interface NormalizedDenial {
  groupCode: string; // CO, PR, OA, PI
  carc: string;
  rarc?: string;
  amountCents: number;
}

export interface NormalizedLine {
  cdtCode: string;
  tooth?: string;
  surfaces?: string;
  feeCents?: number;
  paidCents?: number;
  serviceDate?: string; // YYYY-MM-DD
  denials: NormalizedDenial[];
}

export interface NormalizedClaim {
  source: SourceKind;
  /** The practice's claim number (837 CLM01, echoed as 835 CLP01). */
  claimNumber?: string;
  patient: { firstName?: string; lastName: string; dob?: string; memberId?: string };
  payer: { name?: string; payerId?: string };
  planType?: PlanType;
  serviceDate?: string;
  submittedAt?: string;
  adjudicatedAt?: string;
  status?: ClaimStatus;
  billedCents?: number;
  paidCents?: number;
  attachments?: Attachment[];
  lines: NormalizedLine[];
  /** Claim-level adjustments that aren't tied to a line. */
  claimDenials: NormalizedDenial[];
  /** 835 only: this payment reverses an earlier one. */
  isReversal?: boolean;
  /** Where in the file it came from (row number / claim index): PHI-free, for problem reports. */
  ref: string;
}

/** Per-field confidence (0..1) for extracted data that a person may need to check. */
export type Confidence = Partial<Record<ConfidenceField, number>>;
export type ConfidenceField =
  | "patientName" | "memberId" | "claimNumber" | "payer" | "serviceDate" | "billed" | "paid" | "lines" | "denialCodes";

export interface ParseProblem {
  ref: string;
  code: string; // e.g. "missing_service_date", "bad_amount"
}

export interface ParseResult {
  claims: NormalizedClaim[];
  problems: ParseProblem[];
  rows: number;
}

/** CARC codes that are routine adjustments (contractual write-off, deductible, co-insurance, co-pay), not denials. */
export const NON_DENIAL_CARCS = new Set(["1", "2", "3", "45", "253", "23", "237", "94"]);

export function isDenialAdjustment(groupCode: string, carc: string): boolean {
  if (NON_DENIAL_CARCS.has(carc)) return false;
  return ["CO", "OA", "PI", "PR"].includes(groupCode);
}

export function claimTotals(c: NormalizedClaim) {
  const billed = c.billedCents ?? sum(c.lines.map((l) => l.feeCents));
  const paid = c.paidCents ?? sum(c.lines.map((l) => l.paidCents));
  const denied = sum(c.claimDenials.map((d) => d.amountCents)) + sum(c.lines.flatMap((l) => l.denials.map((d) => d.amountCents)));
  return { billed, paid, denied };
}

function sum(xs: (number | undefined)[]): number {
  return xs.reduce<number>((s, x) => s + (x ?? 0), 0);
}

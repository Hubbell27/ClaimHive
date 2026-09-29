/**
 * What an appeal writer is allowed to see. Built from the claim with an
 * allowlist: insurer, plan type, procedure codes, tooth numbers, fees and
 * denial codes, what's enclosed and why ClaimHive thinks it will win.
 * No names, dates, member IDs, claim numbers, addresses or practice details:
 * the writer uses {{PLACEHOLDERS}} and they're merged in locally afterwards.
 *
 * `assertNoIdentifiers` runs on the finished request, right before any writer
 * sees it, and refuses to continue if an identifier slipped in (for example in
 * the biller's own notes).
 */
import { APPEAL_ARGUMENTS, type AppealArgument } from "../pool/deidentify";
import { ATTACHMENTS, CARC, CDT_BY_CODE, RARC, type Attachment } from "../reference/codes";
import { PLACEHOLDERS } from "./placeholders";

const carc = new Map(CARC.map((c) => [c.code, c.label]));
const rarc = new Map(RARC.map((c) => [c.code, c.label]));

export const ATTACHMENT_LABEL: Record<Attachment, string> = {
  xray: "X-ray", narrative: "clinical narrative", perio_chart: "periodontal chart", photo: "intraoral photo",
};
export const ARGUMENT_LABEL: Record<AppealArgument, string> = {
  documentation: "The documentation the insurer needs is now enclosed",
  medical_necessity: "The treatment was medically necessary",
  coding_correction: "The coding is correct, or the service is separate and distinct",
  frequency_exception: "An exception to the frequency limit is justified",
  coverage_dispute: "The service is covered under the plan",
  other: "Other",
};

export interface AppealRequest {
  insurer: string; // verified insurer name, or "the insurer"
  planType: string | null;
  procedures: {
    code: string; description: string; tooth: string | null; surfaces: string | null;
    feeDollars: string; deniedDollars: string; denialReasons: string[];
  }[];
  claimLevelReasons: string[];
  enclosures: string[];
  argument: string | null;
  evidence: string[]; // ClaimHive's pooled findings for this insurer and procedure (numbers only)
  notes: string | null; // the biller's own extra points (checked below)
  placeholders: Record<string, string>;
}

export interface ClaimForAppeal {
  planType: string;
  payer: { name: string; verified: boolean };
  lines: { id: string; cdtCode: string; tooth: string | null; surfaces: string | null; feeCents: number; paidCents: number }[];
  denials: { claimLineId: string | null; groupCode: string; carc: string; rarc: string | null; amountCents: number }[];
}

const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
const reason = (d: { groupCode: string; carc: string; rarc: string | null }) =>
  `${d.groupCode}-${d.carc}${carc.get(d.carc) ? ` (${carc.get(d.carc)})` : ""}${d.rarc ? `; remark ${d.rarc}${rarc.get(d.rarc) ? ` (${rarc.get(d.rarc)})` : ""}` : ""}`;

export function buildAppealRequest(c: ClaimForAppeal, opts: {
  enclosures: string[]; argument?: string | null; evidence?: string[]; notes?: string | null;
}): AppealRequest {
  const denied = new Set(c.denials.map((d) => d.claimLineId));
  const lines = c.lines.filter((l) => denied.has(l.id));
  return {
    insurer: c.payer.verified ? c.payer.name : "the insurer",
    planType: c.planType === "UNKNOWN" ? null : c.planType,
    procedures: (lines.length ? lines : c.lines).map((l) => ({
      code: l.cdtCode, description: CDT_BY_CODE.get(l.cdtCode)?.label ?? l.cdtCode, tooth: l.tooth, surfaces: l.surfaces,
      feeDollars: dollars(l.feeCents),
      deniedDollars: dollars(c.denials.filter((d) => d.claimLineId === l.id).reduce((s, d) => s + d.amountCents, 0)),
      denialReasons: c.denials.filter((d) => d.claimLineId === l.id).map(reason),
    })),
    claimLevelReasons: c.denials.filter((d) => !d.claimLineId).map(reason),
    enclosures: opts.enclosures.filter((e): e is Attachment => (ATTACHMENTS as readonly string[]).includes(e)).map((e) => ATTACHMENT_LABEL[e]),
    argument: opts.argument && (APPEAL_ARGUMENTS as readonly string[]).includes(opts.argument) ? ARGUMENT_LABEL[opts.argument as AppealArgument] : null,
    evidence: opts.evidence ?? [],
    notes: opts.notes?.trim() ? opts.notes.trim().slice(0, 1500) : null,
    placeholders: { ...PLACEHOLDERS },
  };
}

export class IdentifierFound extends Error {
  constructor(public readonly kind: string) { super(`identifier found: ${kind}`); }
}

/** Values that must never leave ClaimHive: the patient's and practice's details for this letter. */
export interface KnownIdentifiers {
  names: string[]; // patient first/last name, signer name, practice name
  numbers: string[]; // member ID, claim number, NPI, tax ID, phone, zip
  dates: Date[]; // DOB, service date, denial date
}

const PATTERNS: [string, RegExp][] = [
  ["date", /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/],
  ["date", /\b(19|20)\d{2}-\d{2}-\d{2}\b/],
  ["date", /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?\b/i],
  ["email", /[\w.+-]+@[\w-]+\.[\w.]+/],
  ["phone", /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/],
  ["ssn", /\b\d{3}-\d{2}-\d{4}\b/],
  ["long_number", /\b[A-Z]{0,4}\d{7,}\b/i], // member IDs, claim numbers, NPIs
  ["url", /\bhttps?:\/\//i],
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const digits = (s: string) => s.replace(/\D/g, "");

/** Throws IdentifierFound (with the kind, never the value) if the text carries an identifier. */
export function assertNoIdentifiers(text: string, known: KnownIdentifiers): void {
  for (const [kind, re] of PATTERNS) if (re.test(text)) throw new IdentifierFound(kind);
  const words = ` ${norm(text)} `;
  for (const n of known.names) {
    const k = norm(n);
    if (k.length >= 3 && words.includes(` ${k} `)) throw new IdentifierFound("name");
  }
  const allDigits = digits(text);
  for (const num of known.numbers) {
    const d = digits(num);
    const raw = norm(num);
    if ((d.length >= 5 && allDigits.includes(d)) || (raw.length >= 5 && words.includes(` ${raw} `))) throw new IdentifierFound("id_number");
  }
  for (const dt of known.dates) {
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, day = dt.getUTCDate();
    const forms = [`${m}/${day}/${y}`, `${String(m).padStart(2, "0")}/${String(day).padStart(2, "0")}/${y}`, `${y}${String(m).padStart(2, "0")}${String(day).padStart(2, "0")}`];
    if (forms.some((f) => text.includes(f))) throw new IdentifierFound("date");
  }
}

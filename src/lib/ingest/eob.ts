/**
 * EOB PDFs, read locally: text is extracted on ClaimHive's own server (pdf.js
 * build with no eval code path) and never sent to a third party.
 *
 * Extraction is label-driven: the table header tells us which money column is
 * which ("Submitted / Allowed / Paid", "Charge / Benefit Paid"...). Every field
 * gets a confidence score; anything under REVIEW_THRESHOLD goes to a person
 * before it counts. Scanned PDFs (no text layer) go straight to review. Reading
 * scans will come with AWS Textract, under the BAA, at deployment.
 */
import type { Confidence, ConfidenceField, NormalizedClaim, NormalizedDenial, NormalizedLine } from "./types";
import { parseDate, parseMoney, parseName, parseTooth } from "./values";

export const REVIEW_THRESHOLD = 0.85;

export interface EobExtraction {
  claim: NormalizedClaim;
  confidence: Confidence;
  /** PHI-free reasons, e.g. "paid: line total and printed total disagree". */
  flags: string[];
  hasText: boolean;
}

export async function pdfText(pdf: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // The bundled pdf.js has no eval()/new Function code path (the class of bug behind CVE-2024-4367).
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const { text } = await extractText(doc, { mergePages: true });
  return text;
}

const MONEY = /\(?-?\$?\d{1,3}(?:,\d{3})*\.\d{2}\)?/g;
const DATE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/;
const ADJ = /\b(CO|PR|OA|PI)[\s-]?(\d{1,3})\b(?:\s*[/ ]\s*((?:MA|N|M)\d{1,3}))?/g;

type MoneyCol = "submitted" | "allowed" | "paid" | "patient" | "other";
const MONEY_LABELS: [RegExp, MoneyCol][] = [
  [/submitted|charge[sd]?|billed|fee/i, "submitted"],
  [/allowed|approved|maximum|eligible/i, "allowed"],
  [/benefit paid|plan pays|paid|payment/i, "paid"],
  [/patient|you owe|member resp/i, "patient"],
  [/deductible|co-?ins|copay|discount|write/i, "other"],
];

function headerColumns(line: string): MoneyCol[] | undefined {
  if (!/(procedure|code|cdt)/i.test(line) || !/(date|svc|dos)/i.test(line)) return undefined;
  // Order of appearance in the header line = order of amounts in each row.
  const found: { at: number; col: MoneyCol }[] = [];
  const taken: [number, number][] = [];
  for (const [re, col] of MONEY_LABELS) {
    const g = new RegExp(re.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = g.exec(line))) {
      const span: [number, number] = [m.index, m.index + m[0].length];
      if (taken.some(([a, b]) => span[0] < b && span[1] > a)) continue;
      taken.push(span);
      found.push({ at: m.index, col });
    }
  }
  const cols = found.sort((a, b) => a.at - b.at).map((f) => f.col);
  return cols.length ? cols : undefined;
}

function labelled(text: string, labels: RegExp): string | undefined {
  const m = text.match(labels);
  return m?.[1]?.trim();
}

export function extractEob(text: string, knownPayers: string[] = []): EobExtraction {
  const conf: Confidence = {};
  const flags: string[] = [];
  const set = (f: ConfidenceField, v: number, why?: string) => {
    conf[f] = v;
    if (v < REVIEW_THRESHOLD && why) flags.push(`${f}: ${why}`);
  };
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const claim: NormalizedClaim = { source: "eob_pdf", patient: { lastName: "" }, payer: {}, lines: [], claimDenials: [], ref: "document" };

  if (text.replace(/\s/g, "").length < 40) {
    for (const f of ["patientName", "payer", "serviceDate", "paid", "lines"] as ConfidenceField[]) conf[f] = 0;
    return { claim, confidence: conf, flags: ["document: no readable text (scanned). Enter the details by hand"], hasText: false };
  }

  // Payer: a known payer name anywhere near the top is strongest.
  const top = lines.slice(0, 8).join(" ").toLowerCase();
  const known = knownPayers.find((p) => top.includes(p.toLowerCase()));
  if (known) { claim.payer.name = known; set("payer", 0.97); }
  else { claim.payer.name = lines[0]; set("payer", 0.6, "payer name not recognized"); }

  // Patient / subscriber.
  const who = labelled(text, /(?:Patient(?: Name)?|Subscriber|Member Name)\s*:?\s*([A-Za-z][A-Za-z'.\- ]*(?:,\s*[A-Za-z][A-Za-z'.\- ]*)?)(?=\s+(?:Member|Subscriber|ID|Claim|Date)\b|\n|$)/m);
  const name = who ? parseName(who) : undefined;
  if (name?.lastName) { claim.patient = { ...claim.patient, ...name }; set("patientName", 0.92); }
  else set("patientName", 0, "patient name not found");

  const member = labelled(text, /(?:Member|Subscriber)\s*(?:ID|#|No\.?|Number)\s*:?\s*([A-Z0-9][A-Z0-9-]{4,})/i);
  if (member) { claim.patient.memberId = member; set("memberId", 0.95); }
  else set("memberId", 0.5, "member ID not found");

  const claimNo = labelled(text, /Claim\s*(?:#|Number|No\.?|ID)\s*:?\s*([A-Z0-9][A-Z0-9-]{3,})/i);
  if (claimNo) { claim.claimNumber = claimNo; set("claimNumber", 0.95); }
  else set("claimNumber", 0.4, "claim number not found; matched by patient and date instead");

  const processed = labelled(text, /(?:Date Processed|Processed|Payment Date|Check Date)\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  claim.adjudicatedAt = processed ? parseDate(processed) : undefined;

  // Service lines.
  let cols: MoneyCol[] | undefined;
  for (const l of lines) {
    const hdr = headerColumns(l);
    if (hdr) { cols = hdr; continue; }
    const code = l.match(/\bD\d{4}\b/)?.[0];
    const date = l.match(DATE)?.[0];
    if (!code || !date) continue;
    const amounts = [...l.matchAll(MONEY)].map((m) => parseMoney(m[0])!).filter((x) => x !== undefined);
    const afterCode = l.slice(l.indexOf(code) + 5).replace(MONEY, " ").replace(ADJ, " ");
    const tooth = parseTooth(afterCode.trim().split(" ")[0]);
    const line: NormalizedLine = { cdtCode: code, tooth, serviceDate: parseDate(date), denials: [] };
    if (cols && amounts.length === cols.length) {
      cols.forEach((c, i) => {
        if (c === "submitted") line.feeCents = amounts[i];
        if (c === "paid") line.paidCents = amounts[i];
      });
    } else if (amounts.length >= 2) {
      // No usable header: first amount = charge, last = paid (a guess, so it goes to review).
      line.feeCents = amounts[0];
      line.paidCents = amounts[amounts.length - 1];
      set("lines", 0.6, "amount columns could not be identified");
    } else {
      set("lines", 0.5, "a service line has too few amounts");
    }
    for (const m of l.matchAll(ADJ)) {
      const denial: NormalizedDenial = { groupCode: m[1], carc: m[2], rarc: m[3], amountCents: Math.max(0, (line.feeCents ?? 0) - (line.paidCents ?? 0)) };
      line.denials.push(denial);
    }
    claim.lines.push(line);
  }
  if (!claim.lines.length) set("lines", 0, "no service lines found");
  else conf.lines ??= cols ? 0.93 : 0.6;

  const dates = claim.lines.map((l) => l.serviceDate).filter(Boolean).sort() as string[];
  claim.serviceDate = dates[0];
  set("serviceDate", dates.length ? 0.95 : 0, "date of service not found");

  // Totals: cross-check the printed total against the lines.
  const lineBilled = claim.lines.reduce((s, l) => s + (l.feeCents ?? 0), 0);
  const linePaid = claim.lines.reduce((s, l) => s + (l.paidCents ?? 0), 0);
  const printedPaid = labelled(text, /(?:Total Paid|Benefit Paid|Total Benefit|Plan Paid|Amount Paid)\s*:?\s*(\(?-?\$?\d{1,3}(?:,\d{3})*\.\d{2}\)?)\s*$/im)
    ?? labelled(text, /(?:Total Paid|Total Benefit|Plan Paid)\s*:?\s*(\(?-?\$?\d{1,3}(?:,\d{3})*\.\d{2}\)?)/i);
  const printed = printedPaid ? parseMoney(printedPaid) : undefined;
  claim.billedCents = lineBilled || undefined;
  claim.paidCents = claim.lines.length ? linePaid : printed;
  if (printed === undefined) set("paid", 0.7, "no printed total to check the paid amount against");
  else if (printed !== linePaid) set("paid", 0.4, "line total and printed total disagree");
  else set("paid", 0.96);
  set("billed", lineBilled ? 0.93 : 0.3, "billed amount not found");

  const denials = claim.lines.flatMap((l) => l.denials);
  const hasZeroPaidLine = claim.lines.some((l) => l.paidCents === 0 && (l.feeCents ?? 0) > 0);
  if (hasZeroPaidLine && !denials.length) set("denialCodes", 0.5, "a line paid $0 but no reason code was found");
  else conf.denialCodes = 0.95;
  claim.status = denials.length ? (linePaid > 0 ? "partially_paid" : "denied") : "paid";

  return { claim, confidence: conf, flags, hasText: true };
}

export function minConfidence(c: Confidence): number {
  const v = Object.values(c);
  return v.length ? Math.min(...v) : 0;
}

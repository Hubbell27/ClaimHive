/**
 * X12 EDI: tokenizer plus the two transactions ClaimHive reads.
 *   835  Health Care Claim Payment/Advice (ERA): what the insurer paid or denied.
 *   837D Dental claim: what the practice billed, with teeth, surfaces and attachments.
 *
 * The delimiters come from the ISA segment itself (element separator at
 * position 3, component separator at 104, segment terminator at 105), so
 * files from any clearinghouse parse the same way.
 */
import type { Attachment } from "../reference/codes";
import { isDenialAdjustment, type NormalizedClaim, type NormalizedDenial, type NormalizedLine, type ParseResult } from "./types";
import { parseDate, parseSurfaces, parseTooth, planFromFilingIndicator } from "./values";

export interface X12Segment {
  id: string;
  el: string[]; // el[1] is the first element, matching X12 numbering (el[0] = segment id)
}

export interface X12Document {
  segments: X12Segment[];
  component: string;
  transaction?: "835" | "837";
}

export class X12Error extends Error {}

export function parseX12(text: string): X12Document {
  const start = text.indexOf("ISA");
  if (start < 0 || text.length < start + 106) throw new X12Error("not an X12 file (no ISA segment)");
  const isa = text.slice(start, start + 106);
  const elementSep = isa[3];
  const componentSep = isa[104];
  const segmentTerm = isa[105];
  if (!elementSep || !segmentTerm || /[A-Za-z0-9]/.test(elementSep)) throw new X12Error("malformed ISA segment");
  const segments = text
    .slice(start)
    .split(segmentTerm)
    .map((s) => s.replace(/^[\r\n]+|[\r\n]+$/g, ""))
    .filter(Boolean)
    .map((raw) => {
      const el = raw.split(elementSep);
      return { id: el[0], el };
    });
  const st = segments.find((s) => s.id === "ST");
  const t = st?.el[1];
  return { segments, component: componentSep, transaction: t === "835" || t === "837" ? t : undefined };
}

/** Dental procedure from a composite like "AD:D2740" (835 SVC01 / 837 SV301). */
function procedure(composite: string | undefined, sep: string): string | undefined {
  if (!composite) return undefined;
  const parts = composite.split(sep);
  const code = (parts[0] === "AD" || parts[0] === "CJ" || parts[0] === "HC" ? parts[1] : parts[0])?.toUpperCase();
  return code && /^D\d{4}$/.test(code) ? code : undefined;
}

const cents = (v: string | undefined) => (v && /^-?\d+(\.\d+)?$/.test(v) ? Math.round(parseFloat(v) * 100) : undefined);

/** CAS*group*reason*amount*qty*reason*amount*qty... → adjustments (up to 6 per segment). */
function casAdjustments(seg: X12Segment): NormalizedDenial[] {
  const out: NormalizedDenial[] = [];
  const group = seg.el[1];
  for (let i = 2; i + 1 < seg.el.length; i += 3) {
    const carc = seg.el[i];
    const amt = cents(seg.el[i + 1]);
    if (carc && amt !== undefined) out.push({ groupCode: group, carc, amountCents: amt });
  }
  return out;
}

// ------------------------------------------------------------------ 835

export function parse835(text: string): ParseResult {
  const doc = parseX12(text);
  if (doc.transaction !== "835") throw new X12Error("this X12 file is not an 835 remittance");
  const claims: NormalizedClaim[] = [];
  const problems: ParseResult["problems"] = [];
  let payerName: string | undefined;
  let payerId: string | undefined;
  let checkDate: string | undefined;
  let claim: NormalizedClaim | undefined;
  let line: NormalizedLine | undefined;
  let lineRarcs: string[] = [];
  let claimRarcs: string[] = [];
  let n1: string | undefined;

  const finishLine = () => {
    if (claim && line) {
      if (lineRarcs.length) line.denials.forEach((d, i) => (d.rarc ??= lineRarcs[Math.min(i, lineRarcs.length - 1)]));
      claim.lines.push(line);
    }
    line = undefined;
    lineRarcs = [];
  };
  const finishClaim = () => {
    finishLine();
    if (claim) {
      if (claimRarcs.length) claim.claimDenials.forEach((d) => (d.rarc ??= claimRarcs[0]));
      // A denial is a non-routine adjustment; routine ones (contractual, deductible) are dropped.
      for (const l of claim.lines) l.denials = l.denials.filter((d) => isDenialAdjustment(d.groupCode, d.carc) && d.amountCents > 0);
      claim.claimDenials = claim.claimDenials.filter((d) => isDenialAdjustment(d.groupCode, d.carc) && d.amountCents > 0);
      const denied = claim.claimDenials.length > 0 || claim.lines.some((l) => l.denials.length);
      const paid = claim.paidCents ?? 0;
      if (!claim.status) claim.status = denied ? (paid > 0 ? "partially_paid" : "denied") : "paid";
      if (!claim.serviceDate) {
        const dates = claim.lines.map((l) => l.serviceDate).filter(Boolean) as string[];
        claim.serviceDate = dates.sort()[0];
      }
      if (!claim.serviceDate) problems.push({ ref: claim.ref, code: "missing_service_date" });
      claims.push(claim);
    }
    claim = undefined;
    claimRarcs = [];
  };

  let index = 0;
  for (const s of doc.segments) {
    switch (s.id) {
      case "BPR": checkDate = parseDate(s.el[16]); break;
      case "N1":
        n1 = s.el[1];
        if (n1 === "PR") { payerName = s.el[2]; if (s.el[3] === "XV" || s.el[3] === "PI") payerId = s.el[4]; }
        break;
      case "REF":
        if (n1 === "PR" && s.el[1] === "2U" && !claim) payerId = s.el[2];
        break;
      case "CLP": {
        finishClaim();
        index++;
        const status = s.el[2];
        claim = {
          source: "era835",
          claimNumber: s.el[1] || undefined,
          patient: { lastName: "" },
          payer: { name: payerName, payerId },
          planType: planFromFilingIndicator(s.el[6]),
          billedCents: cents(s.el[3]),
          paidCents: cents(s.el[4]),
          adjudicatedAt: checkDate,
          status: status === "4" ? "denied" : undefined,
          isReversal: status === "22",
          lines: [],
          claimDenials: [],
          ref: `claim ${index}`,
        };
        break;
      }
      case "CAS":
        if (line) line.denials.push(...casAdjustments(s));
        else if (claim) claim.claimDenials.push(...casAdjustments(s));
        break;
      case "NM1":
        if (!claim) break;
        if (s.el[1] === "QC") {
          claim.patient.lastName = s.el[3] ?? "";
          claim.patient.firstName = s.el[4] || undefined;
          if (s.el[8] === "MI" || s.el[8] === "34") claim.patient.memberId = s.el[9] || undefined;
        } else if (s.el[1] === "IL" && (s.el[8] === "MI") && !claim.patient.memberId) {
          claim.patient.memberId = s.el[9] || undefined;
        }
        break;
      case "MOA": // claim-level remark codes (MOA03..MOA07)
        if (claim) claimRarcs.push(...s.el.slice(3, 8).filter(Boolean));
        break;
      case "DTM":
        if (!claim) break;
        if (s.el[1] === "472" && line) line.serviceDate = parseDate(s.el[2]);
        else if ((s.el[1] === "232" || s.el[1] === "472") && !line) claim.serviceDate = parseDate(s.el[2]);
        else if (s.el[1] === "050" && !line) claim.submittedAt ??= parseDate(s.el[2]);
        break;
      case "SVC": {
        finishLine();
        if (!claim) break;
        const code = procedure(s.el[1], doc.component);
        if (!code) { problems.push({ ref: claim.ref, code: "unknown_procedure_code" }); break; }
        line = { cdtCode: code, feeCents: cents(s.el[2]), paidCents: cents(s.el[3]), denials: [] };
        break;
      }
      case "LQ":
        if (line && s.el[1] === "HE" && s.el[2]) lineRarcs.push(s.el[2]);
        break;
      case "SE":
        finishClaim();
        break;
    }
  }
  finishClaim();
  if (!claims.length) problems.push({ ref: "file", code: "no_claims_found" });
  return { claims, problems, rows: claims.length };
}

// ------------------------------------------------------------------ 837D

/** PWK01 report type → ClaimHive attachment kind. */
const PWK_ATTACHMENT: Record<string, Attachment> = {
  RB: "xray", RR: "xray", DA: "xray",
  P6: "perio_chart",
  OZ: "narrative", OB: "narrative", DG: "narrative", "77": "narrative", B4: "narrative",
  XP: "photo", PZ: "photo",
};

export function parse837(text: string): ParseResult {
  const doc = parseX12(text);
  if (doc.transaction !== "837") throw new X12Error("this X12 file is not an 837 claim");
  const claims: NormalizedClaim[] = [];
  const problems: ParseResult["problems"] = [];
  let hlLevel: string | undefined;
  let subscriber: NormalizedClaim["patient"] = { lastName: "" };
  let patient: NormalizedClaim["patient"] | undefined;
  let payer: NormalizedClaim["payer"] = {};
  let planType: NormalizedClaim["planType"];
  let nm1: string | undefined;
  let claim: NormalizedClaim | undefined;
  let line: NormalizedLine | undefined;
  let attachments = new Set<Attachment>();
  let index = 0;

  const finishLine = () => {
    if (claim && line) claim.lines.push(line);
    line = undefined;
  };
  const finishClaim = () => {
    finishLine();
    if (claim) {
      claim.attachments = [...attachments];
      if (!claim.serviceDate) claim.serviceDate = claim.lines.map((l) => l.serviceDate).filter(Boolean).sort()[0] as string | undefined;
      if (!claim.serviceDate) problems.push({ ref: claim.ref, code: "missing_service_date" });
      if (!claim.lines.length) problems.push({ ref: claim.ref, code: "no_procedures" });
      claims.push(claim);
    }
    claim = undefined;
    attachments = new Set();
  };

  for (const s of doc.segments) {
    switch (s.id) {
      case "HL":
        finishClaim();
        hlLevel = s.el[3]; // 20 billing provider, 22 subscriber, 23 patient
        if (hlLevel === "22") { subscriber = { lastName: "" }; patient = undefined; payer = {}; planType = undefined; }
        if (hlLevel === "23") patient = { lastName: "" };
        break;
      case "SBR":
        planType = planFromFilingIndicator(s.el[9]);
        break;
      case "NM1": {
        nm1 = s.el[1];
        const person = { lastName: s.el[3] ?? "", firstName: s.el[4] || undefined, memberId: s.el[8] === "MI" ? s.el[9] : undefined };
        if (nm1 === "IL") subscriber = { ...subscriber, ...person };
        else if (nm1 === "QC") patient = { ...(patient ?? { lastName: "" }), ...person, memberId: person.memberId ?? subscriber.memberId };
        else if (nm1 === "PR") payer = { name: s.el[3], payerId: s.el[9] || undefined };
        break;
      }
      case "DMG":
        if (s.el[1] === "D8") {
          const dob = parseDate(s.el[2]);
          if (nm1 === "IL") subscriber.dob = dob;
          else if (nm1 === "QC" && patient) patient.dob = dob;
        }
        break;
      case "CLM":
        finishClaim();
        index++;
        claim = {
          source: "claim837",
          claimNumber: s.el[1] || undefined,
          billedCents: cents(s.el[2]),
          patient: patient ? { ...patient, memberId: patient.memberId ?? subscriber.memberId } : { ...subscriber },
          payer: { ...payer },
          planType,
          status: "submitted",
          lines: [],
          claimDenials: [],
          ref: `claim ${index}`,
        };
        break;
      case "DTP":
        if (!claim) break;
        if (s.el[1] === "472") {
          const d = parseDate(s.el[3]?.split("-")[0]);
          if (line) line.serviceDate = d;
          else claim.serviceDate = d;
        }
        break;
      case "PWK": {
        const a = PWK_ATTACHMENT[s.el[1]];
        if (claim && a) attachments.add(a);
        break;
      }
      case "NTE":
        if (claim && s.el[2]) attachments.add("narrative");
        break;
      case "LX":
        finishLine();
        break;
      case "SV3": {
        finishLine();
        if (!claim) break;
        const code = procedure(s.el[1], doc.component);
        if (!code) { problems.push({ ref: claim.ref, code: "unknown_procedure_code" }); break; }
        line = { cdtCode: code, feeCents: cents(s.el[2]), denials: [] };
        break;
      }
      case "TOO":
        if (line) {
          line.tooth ??= parseTooth(s.el[2]);
          const surf = parseSurfaces((s.el[3] ?? "").split(doc.component).join(""));
          if (surf) line.surfaces = surf;
        }
        break;
      case "SE":
        finishClaim();
        break;
    }
  }
  finishClaim();
  if (!claims.length) problems.push({ ref: "file", code: "no_claims_found" });
  return { claims, problems, rows: claims.length };
}

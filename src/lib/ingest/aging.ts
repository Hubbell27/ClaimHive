/**
 * Insurance aging reports from any practice management system (CSV or Excel).
 *
 * 1. readTable() turns the file into header + rows.
 * 2. suggestMapping() matches headers to ClaimHive fields using a synonym list
 *    that covers the common PM systems (Dentrix, Eaglesoft, Open Dental, Curve,
 *    Denticon, Carestream/CS, Dentimax, Practice-Web, tab32, Oryx, Planet DDS,
 *    Fuse and generic exports). Staff confirm or fix it on the mapping screen,
 *    and the confirmed mapping is remembered for that header layout.
 * 3. parseAging() applies a mapping and groups rows into claims: one row per
 *    claim, or one row per procedure (grouped by claim number, or by patient +
 *    service date + carrier when there is no claim number).
 *
 * The synonym lists are ClaimHive's best knowledge of how these systems label
 * columns; exports vary by version and by the report a practice chooses, which
 * is why the mapping screen always lets a person confirm.
 */
import Papa from "papaparse";
import { normHeader, parseCdtCodes, parseDate, parseMoney, parseName, parseSurfaces, parseTooth, planFromText } from "./values";
import type { NormalizedClaim, ParseResult } from "./types";

export const AGING_FIELDS = [
  { key: "patientName", label: "Patient name (full)", required: false },
  { key: "patientLast", label: "Patient last name", required: false },
  { key: "patientFirst", label: "Patient first name", required: false },
  { key: "dob", label: "Patient date of birth", required: false },
  { key: "memberId", label: "Subscriber / member ID", required: false },
  { key: "payer", label: "Insurance carrier", required: true },
  { key: "payerId", label: "Carrier payer ID", required: false },
  { key: "planType", label: "Plan type", required: false },
  { key: "claimNumber", label: "Claim number", required: false },
  { key: "serviceDate", label: "Date of service", required: true },
  { key: "submittedAt", label: "Date sent", required: false },
  { key: "cdt", label: "Procedure code(s)", required: false },
  { key: "tooth", label: "Tooth", required: false },
  { key: "surfaces", label: "Surface(s)", required: false },
  { key: "billed", label: "Amount billed", required: true },
  { key: "paid", label: "Insurance paid", required: false },
  { key: "status", label: "Claim status", required: false },
] as const;
export type AgingField = (typeof AGING_FIELDS)[number]["key"];
export type AgingMapping = Partial<Record<AgingField, string>>;

// Normalized header synonyms (see normHeader). Order matters: earlier = stronger.
const SYNONYMS: Record<AgingField, string[]> = {
  patientName: ["patient", "patientname", "patname", "patientfullname", "name", "patientnamelastfirst", "pt", "ptname", "guarantorpatient"],
  patientLast: ["lastname", "patientlastname", "patlast", "lname", "ptlastname", "patientlname"],
  patientFirst: ["firstname", "patientfirstname", "patfirst", "fname", "ptfirstname", "patientfname"],
  dob: ["birthdate", "dob", "dateofbirth", "patientdob", "patbirthdate", "patientbirthdate", "birthday", "ptdob"],
  memberId: ["subscriberid", "subid", "memberid", "insuredid", "subscriberidnumber", "insid", "idnumber", "policyid", "subscribernum", "memberno"],
  payer: ["carrier", "carriername", "insurance", "insurancecompany", "insco", "insurancecarrier", "payer", "payername", "primarycarrier", "insname", "insurancename", "plan", "planname", "carriernamegroup"],
  payerId: ["payerid", "carrierid", "electronicid", "elecid", "eid", "payerno", "carrierpayerid"],
  planType: ["plantype", "benefittype", "coveragetype", "networktype"],
  claimNumber: ["claimnum", "claimnumber", "claimid", "claim", "claimno", "claimnbr", "claimref"],
  serviceDate: ["dateofservice", "dos", "servicedate", "procdate", "proceduredate", "datetreated", "treatmentdate", "dateservice", "svcdate", "servdate"],
  submittedAt: ["datesent", "sentdate", "claimdate", "submitted", "datesubmitted", "billeddate", "datebilled", "sent", "submitdate", "createddate"],
  cdt: ["procedurecode", "proccode", "code", "adacode", "cdt", "cdtcode", "procedures", "procedurecodes", "codes", "procs", "adacodes"],
  tooth: ["tooth", "toothnum", "toothnumber", "th", "toothno"],
  surfaces: ["surface", "surfaces", "surf", "toothsurface"],
  billed: ["claimfee", "claimamount", "claimamt", "amount", "billed", "billedamount", "amountbilled", "fee", "totalfee", "charges", "totalcharges", "totalbilled", "feebilled", "procfee", "chargeamount"],
  paid: ["inspayamt", "inspaid", "insurancepaid", "paid", "amountpaid", "paidamount", "totalpaid", "paymentamount", "inspayment", "received"],
  status: ["claimstatus", "status", "statusdesc", "claimstate"],
};

/** Header layouts that identify a PM system (shown to staff as a hint only). */
const SYSTEM_HINTS: { system: string; headers: string[] }[] = [
  { system: "Open Dental", headers: ["claimnum", "patnum", "dateservice", "datesent", "claimfee", "inspayest", "inspayamt"] },
  { system: "Dentrix", headers: ["carrier", "patient", "datesent", "claimamount", "subscriberid", "guarantor"] },
  { system: "Eaglesoft", headers: ["carriername", "patientname", "datesent", "totalfee", "estimated", "subscriber"] },
  { system: "Curve Dental", headers: ["patient", "insurance", "dateofservice", "billed", "insuranceportion"] },
  { system: "Denticon", headers: ["patient", "carrier", "dos", "submitted", "claimamount", "balance"] },
];

export interface Table {
  headers: string[];
  rows: Record<string, unknown>[];
}

export async function readTable(file: Uint8Array, fileName: string): Promise<Table> {
  const lower = fileName.toLowerCase();
  const isXlsx = lower.endsWith(".xlsx") || (file[0] === 0x50 && file[1] === 0x4b); // "PK" zip
  if (isXlsx) {
    assertSafeZip(file);
    const { readSheet } = await import("read-excel-file/node");
    const sheet = await readSheet(Buffer.from(file));
    return tableFromRows(sheet.map((r) => r.map((c) => (c === null ? "" : c))));
  }
  const text = new TextDecoder("utf-8").decode(file).replace(/^﻿/, "");
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
  return tableFromRows(parsed.data);
}

/** Excel files are zip archives. Refuse ones that would expand far beyond their size (zip bombs). */
export const MAX_XLSX_EXPANDED_BYTES = 100 * 1024 * 1024;
export function assertSafeZip(file: Uint8Array): void {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  // End-of-central-directory record: signature 0x06054b50, within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = file.byteLength - 22; i >= Math.max(0, file.byteLength - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a valid Excel file");
  const entries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (entries > 2000) throw new Error("Excel file has too many parts");
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > file.byteLength || view.getUint32(offset, true) !== 0x02014b50) throw new Error("not a valid Excel file");
    const uncompressed = view.getUint32(offset + 24, true);
    if (uncompressed === 0xffffffff) throw new Error("Excel file is too large"); // ZIP64
    total += uncompressed;
    if (total > MAX_XLSX_EXPANDED_BYTES) throw new Error("Excel file is too large when unpacked");
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
}

/** Finds the header row (reports often start with a title block) and builds row objects. */
export function tableFromRows(raw: unknown[][]): Table {
  let headerIdx = 0;
  let best = -1;
  for (let i = 0; i < Math.min(raw.length, 15); i++) {
    const score = raw[i].filter((c) => typeof c === "string" && matchField(c)).length;
    if (score > best) { best = score; headerIdx = i; }
  }
  const headers = (raw[headerIdx] ?? []).map((h, i) => String(h ?? "").trim() || `Column ${i + 1}`);
  const rows: Record<string, unknown>[] = [];
  for (const r of raw.slice(headerIdx + 1)) {
    if (!r.some((c) => String(c ?? "").trim())) continue;
    const row: Record<string, unknown> = {};
    headers.forEach((h, i) => (row[h] = r[i] ?? ""));
    rows.push(row);
  }
  return { headers, rows };
}

function matchField(header: string): AgingField | undefined {
  const h = normHeader(header);
  if (!h) return undefined;
  for (const [field, syns] of Object.entries(SYNONYMS) as [AgingField, string[]][]) {
    if (syns.includes(h)) return field;
  }
  return undefined;
}

export interface MappingSuggestion {
  mapping: AgingMapping;
  confident: boolean; // every required field found by an exact synonym
  missing: AgingField[];
  detectedSystem?: string;
}

export function suggestMapping(headers: string[]): MappingSuggestion {
  const mapping: AgingMapping = {};
  const taken = new Set<string>();
  // Exact synonym matches first, in synonym-strength order.
  for (const field of Object.keys(SYNONYMS) as AgingField[]) {
    for (const syn of SYNONYMS[field]) {
      const h = headers.find((x) => !taken.has(x) && normHeader(x) === syn);
      if (h) { mapping[field] = h; taken.add(h); break; }
    }
  }
  // Then "contains" matches for anything still missing (e.g. "Primary Carrier Name").
  for (const field of Object.keys(SYNONYMS) as AgingField[]) {
    if (mapping[field]) continue;
    const h = headers.find((x) => !taken.has(x) && SYNONYMS[field].some((syn) => syn.length > 3 && normHeader(x).includes(syn)));
    if (h) { mapping[field] = h; taken.add(h); }
  }
  if (mapping.patientName && (mapping.patientLast || mapping.patientFirst)) delete mapping.patientName;
  const missing = AGING_FIELDS.filter((f) => f.required && !mapping[f.key]).map((f) => f.key);
  const hasPatient = !!(mapping.patientName || mapping.patientLast);
  if (!hasPatient) missing.push("patientName");
  const normalized = new Set(headers.map(normHeader));
  const detected = SYSTEM_HINTS.map((s) => ({ s: s.system, n: s.headers.filter((h) => normalized.has(h)).length }))
    .sort((a, b) => b.n - a.n)[0];
  return {
    mapping,
    confident: missing.length === 0,
    missing,
    detectedSystem: detected && detected.n >= 3 ? detected.s : undefined,
  };
}

/** Stable signature of a header layout, for remembering confirmed mappings. */
export function headerSignature(headers: string[]): string {
  return headers.map(normHeader).filter(Boolean).sort().join("|");
}

export function validateMapping(m: AgingMapping, headers: string[]): string | undefined {
  for (const v of Object.values(m)) if (v && !headers.includes(v)) return "The mapping refers to a column that isn't in this file.";
  const need: string[] = AGING_FIELDS.filter((f) => f.required && !m[f.key]).map((f) => f.label);
  if (!m.patientName && !m.patientLast) need.push("Patient name");
  return need.length ? `Choose a column for: ${need.join(", ")}.` : undefined;
}

function statusFromText(v: unknown): NormalizedClaim["status"] {
  const s = String(v ?? "").toLowerCase();
  if (!s.trim()) return undefined;
  if (/den|reject/.test(s)) return "denied";
  if (/partial/.test(s)) return "partially_paid";
  if (/paid|received|closed|complete/.test(s)) return "paid";
  return "submitted";
}

export function parseAging(table: Table, mapping: AgingMapping): ParseResult {
  const col = (row: Record<string, unknown>, f: AgingField) => (mapping[f] ? row[mapping[f]!] : undefined);
  const problems: ParseResult["problems"] = [];
  const groups = new Map<string, NormalizedClaim>();

  table.rows.forEach((row, i) => {
    const ref = `row ${i + 2}`; // spreadsheet row number (header is row 1)
    const name = mapping.patientName
      ? parseName(String(col(row, "patientName") ?? ""))
      : col(row, "patientLast")
        ? { lastName: String(col(row, "patientLast")).trim(), firstName: String(col(row, "patientFirst") ?? "").trim() || undefined }
        : undefined;
    const payer = String(col(row, "payer") ?? "").trim();
    const serviceDate = parseDate(col(row, "serviceDate"));
    const billed = parseMoney(col(row, "billed"));
    // Totals and subtotal rows in reports have no patient or date: skip them quietly.
    if (!name?.lastName && !serviceDate) return;
    if (!name?.lastName) return void problems.push({ ref, code: "missing_patient" });
    if (!payer) return void problems.push({ ref, code: "missing_carrier" });
    if (!serviceDate) return void problems.push({ ref, code: "missing_service_date" });
    if (billed === undefined) return void problems.push({ ref, code: "bad_amount" });

    const claimNumber = String(col(row, "claimNumber") ?? "").trim() || undefined;
    const key = claimNumber ?? `${name.lastName}|${name.firstName}|${serviceDate}|${payer}`.toLowerCase();
    const codes = parseCdtCodes(col(row, "cdt"));
    let c = groups.get(key);
    if (!c) {
      c = {
        source: "aging",
        claimNumber,
        patient: { ...name, dob: parseDate(col(row, "dob")), memberId: String(col(row, "memberId") ?? "").trim() || undefined },
        payer: { name: payer, payerId: String(col(row, "payerId") ?? "").trim() || undefined },
        planType: planFromText(col(row, "planType")),
        serviceDate,
        submittedAt: parseDate(col(row, "submittedAt")),
        status: statusFromText(col(row, "status")) ?? "submitted",
        billedCents: 0,
        paidCents: mapping.paid ? 0 : undefined,
        lines: [],
        claimDenials: [],
        ref,
      };
      groups.set(key, c);
    }
    c.billedCents = (c.billedCents ?? 0) + billed;
    const paid = parseMoney(col(row, "paid"));
    if (paid !== undefined) c.paidCents = (c.paidCents ?? 0) + paid;
    // A single code on the row carries its fee; several codes in one cell share the row total, so fees stay unknown.
    const tooth = parseTooth(col(row, "tooth"));
    const surfaces = parseSurfaces(col(row, "surfaces"));
    codes.forEach((code) => c!.lines.push({
      cdtCode: code,
      tooth: codes.length === 1 ? tooth : undefined,
      surfaces: codes.length === 1 ? surfaces : undefined,
      feeCents: codes.length === 1 ? billed : undefined,
      paidCents: codes.length === 1 ? paid : undefined,
      denials: [],
    }));
  });

  return { claims: [...groups.values()], problems, rows: table.rows.length };
}

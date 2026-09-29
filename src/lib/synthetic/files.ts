/**
 * Synthetic import files built from a synthetic dataset: 837D claims, 835
 * remittances, aging reports in several PM-system layouts, and EOB PDFs.
 * Used by tests and by the "try it with sample files" button in development.
 * Everything here is fictional (SYN member IDs, SYN claim numbers, fictional payers).
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { CARC } from "../reference/codes";
import { SYNTHETIC_PAYERS, type GenClaim, type GenPatient, type GenPractice, type PlanType } from "./generator";

const PWK: Record<string, string> = { xray: "RB", perio_chart: "P6", narrative: "OZ", photo: "XP" };
const FILING: Record<PlanType, string> = { PPO: "12", DHMO: "17", INDEMNITY: "15", MEDICAID: "MC", MEDICARE_ADVANTAGE: "16" };
const payerOf = (code: string) => SYNTHETIC_PAYERS.find((p) => p.payerCode === code)!;
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
const mdy = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
const amt = (cents: number) => (cents / 100).toFixed(2);
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function isa(control: number, date: Date): string {
  const f = (v: string, n: number) => v.padEnd(n).slice(0, n);
  return ["ISA", "00", f("", 10), "00", f("", 10), "ZZ", f("SYNSENDER", 15), "ZZ", f("SYNRECEIVER", 15),
    ymd(date).slice(2), "1200", "^", "00501", String(control).padStart(9, "0"), "0", "T", ":"].join("*") + "~";
}

function envelope(st: string, version: string, bodies: string[][], date: Date): string {
  const segs: string[] = [isa(1, date), `GS*${st === "835" ? "HP" : "HC"}*SYNSENDER*SYNRECEIVER*${ymd(date)}*1200*1*X*${version}~`];
  bodies.forEach((body, i) => {
    const st02 = String(i + 1).padStart(4, "0");
    const seg = [`ST*${st}*${st02}*${version}`, ...body];
    segs.push(...seg.map((s) => `${s}~`), `SE*${seg.length + 1}*${st02}~`);
  });
  segs.push(`GE*${bodies.length}*1~`, "IEA*1*000000001~");
  return segs.join("\n");
}

type Row = { patient: GenPatient; claim: GenClaim };
const rowsOf = (practice: GenPractice): Row[] => practice.patients.flatMap((patient) => patient.claims.map((claim) => ({ patient, claim })));

/** 837D: one transaction per payer; subscriber = patient (SBR02 18). */
export function build837(practice: GenPractice, filter: (r: Row) => boolean = () => true, date = new Date()): string {
  const byPayer = new Map<string, Row[]>();
  for (const r of rowsOf(practice).filter(filter)) byPayer.set(r.claim.payerCode, [...(byPayer.get(r.claim.payerCode) ?? []), r]);
  const bodies = [...byPayer.entries()].map(([code, rows]) => {
    const payer = payerOf(code);
    const b = ["BHT*0019*00*SYN0001*" + ymd(date) + "*1200*CH", `NM1*41*2*${practice.name.toUpperCase()}*****46*SYN0000001`,
      `NM1*40*2*SYNTHETIC CLEARINGHOUSE*****46*SYNCH`, "HL*1**20*1", `NM1*85*2*${practice.name.toUpperCase()}*****XX*1999999999`];
    let hl = 1;
    for (const { patient, claim } of rows) {
      hl++;
      b.push(`HL*${hl}*1*22*0`, `SBR*P*18*SYNGROUP******${FILING[claim.planType]}`,
        `NM1*IL*1*${patient.lastName.toUpperCase()}*${patient.firstName.toUpperCase()}****MI*${patient.memberId}`,
        `DMG*D8*${patient.dob.replace(/-/g, "")}*U`, `NM1*PR*2*${payer.name.toUpperCase()}*****PI*${payer.payerCode}`);
      const billed = claim.lines.reduce((s, l) => s + l.feeCents, 0);
      b.push(`CLM*${claim.claimNumber}*${amt(billed)}***11:B:1*Y*A*Y*Y`, `DTP*472*D8*${ymd(claim.serviceDate)}`);
      for (const a of claim.attachments) b.push(`PWK*${PWK[a]}*EL***AC*SYN${claim.claimNumber.slice(4)}${PWK[a]}`);
      claim.lines.forEach((l, i) => {
        b.push(`LX*${i + 1}`, `SV3*AD:${l.cdtCode}*${amt(l.feeCents)}****1`);
        if (l.tooth) b.push(`TOO*JP*${l.tooth}${l.surfaces ? `*${l.surfaces.split("").join(":")}` : ""}`);
      });
    }
    return b;
  });
  return envelope("837", "005010X224A2", bodies, date);
}

/** 835: one transaction per payer. `appealPayments` builds the later remittance that pays won appeals. */
export function build835(practice: GenPractice, opts: { appealPayments?: boolean; filter?: (r: Row) => boolean; date?: Date } = {}): string {
  const date = opts.date ?? new Date();
  const byPayer = new Map<string, Row[]>();
  for (const r of rowsOf(practice).filter(opts.filter ?? (() => true))) {
    if (opts.appealPayments && r.claim.appealStatus !== "won") continue;
    byPayer.set(r.claim.payerCode, [...(byPayer.get(r.claim.payerCode) ?? []), r]);
  }
  const bodies = [...byPayer.entries()].map(([code, rows]) => {
    const payer = payerOf(code);
    const paidOf = (c: GenClaim) => c.lines.reduce((t, l) => t + l.paidCents, 0) + (opts.appealPayments ? c.recoveredCents : 0);
    const total = rows.reduce((s, r) => s + (opts.appealPayments ? r.claim.recoveredCents : paidOf(r.claim)), 0);
    const payDate = opts.appealPayments ? date : rows[0].claim.adjudicatedAt;
    const b = [`BPR*I*${amt(total)}*C*ACH*CCP*01*999999999*DA*123456*1999999999**01*999999999*DA*654321*${ymd(payDate)}`,
      `TRN*1*SYNEFT${code}*1999999999`, `N1*PR*${payer.name.toUpperCase()}*XV*${payer.payerCode}`, `N1*PE*${practice.name.toUpperCase()}*XX*1999999999`, "LX*1"];
    for (const { patient, claim } of rows) {
      const billed = claim.lines.reduce((s, l) => s + l.feeCents, 0);
      if (opts.appealPayments) {
        // Reprocessed after a won appeal: the claim's new totals, with the denied lines now paid.
        const deniedFees = claim.denials.reduce((s, d) => s + claim.lines[d.lineIndex].feeCents, 0) || 1;
        b.push(`CLP*${claim.claimNumber}*1*${amt(billed)}*${amt(paidOf(claim))}**${FILING[claim.planType]}*SYNPCN${claim.claimNumber.slice(4)}A`,
          `NM1*QC*1*${patient.lastName.toUpperCase()}*${patient.firstName.toUpperCase()}****MI*${patient.memberId}`, `DTM*232*${ymd(claim.serviceDate)}`);
        claim.lines.forEach((l, i) => {
          const denied = claim.denials.some((d) => d.lineIndex === i);
          const linePaid = denied ? Math.round((claim.recoveredCents * l.feeCents) / deniedFees) : l.paidCents;
          b.push(`SVC*AD:${l.cdtCode}*${amt(l.feeCents)}*${amt(linePaid)}`, `DTM*472*${ymd(claim.serviceDate)}`);
          if (l.feeCents > linePaid) b.push(`CAS*CO*45*${amt(l.feeCents - linePaid)}`);
        });
        continue;
      }
      const paid = claim.lines.reduce((s, l) => s + l.paidCents, 0);
      b.push(`CLP*${claim.claimNumber}*${paid === 0 ? "4" : "1"}*${amt(billed)}*${amt(paid)}**${FILING[claim.planType]}*SYNPCN${claim.claimNumber.slice(4)}`,
        `NM1*QC*1*${patient.lastName.toUpperCase()}*${patient.firstName.toUpperCase()}****MI*${patient.memberId}`, `DTM*232*${ymd(claim.serviceDate)}`);
      claim.lines.forEach((l, i) => {
        b.push(`SVC*AD:${l.cdtCode}*${amt(l.feeCents)}*${amt(l.paidCents)}`, `DTM*472*${ymd(claim.serviceDate)}`);
        const d = claim.denials.find((x) => x.lineIndex === i);
        if (d) {
          b.push(`CAS*${d.groupCode}*${d.carc}*${amt(d.amountCents)}`);
          if (d.rarc) b.push(`LQ*HE*${d.rarc}`);
        } else if (l.feeCents > l.paidCents) b.push(`CAS*CO*45*${amt(l.feeCents - l.paidCents)}`);
      });
    }
    return b;
  });
  return envelope("835", "005010X221A1", bodies, date);
}

export type AgingStyle = "opendental" | "dentrix" | "eaglesoft" | "custom";

const AGING_LAYOUTS: Record<AgingStyle, { title?: string[]; headers: string[]; row: (r: Row, i: number) => string[][] }> = {
  // One row per claim.
  opendental: {
    headers: ["ClaimNum", "PatNum", "Patient", "Birthdate", "CarrierName", "SubscriberID", "DateService", "DateSent", "ClaimFee", "InsPayEst", "InsPayAmt", "ClaimStatus", "Procedures"],
    row: ({ patient: p, claim: c }, i) => [[c.claimNumber, String(1000 + i), `${p.lastName}, ${p.firstName}`, p.dob, payerOf(c.payerCode).name, p.memberId,
      c.serviceDate.toISOString().slice(0, 10), c.submittedAt.toISOString().slice(0, 10), amt(c.lines.reduce((s, l) => s + l.feeCents, 0)),
      amt(Math.round(c.lines.reduce((s, l) => s + l.feeCents, 0) * 0.7)), "0.00", "S", c.lines.map((l) => l.cdtCode).join(", ")]],
  },
  // A report title block, then one row per procedure.
  dentrix: {
    title: ["Insurance Aging Report", "Synthetic data - not real patients", ""],
    headers: ["Patient", "Birth Date", "Carrier", "Subscriber ID", "Claim #", "Date of Service", "Date Sent", "Proc Code", "Tooth", "Surface", "Claim Amount", "Ins Paid", "0-30", "31-60", "61-90", "90+"],
    row: ({ patient: p, claim: c }) => c.lines.map((l) => [`${p.firstName} ${p.lastName}`, mdy(new Date(p.dob)), payerOf(c.payerCode).name, p.memberId, c.claimNumber,
      mdy(c.serviceDate), mdy(c.submittedAt), l.cdtCode, l.tooth ?? "", l.surfaces ?? "", money(l.feeCents), "", money(l.feeCents), "", "", ""]),
  },
  eaglesoft: {
    headers: ["Patient Name", "Date of Birth", "Carrier Name", "Subscriber Id", "Service Date", "Date Submitted", "Total Fee", "Estimated", "Plan Type"],
    row: ({ patient: p, claim: c }) => [[`${p.lastName}, ${p.firstName}`, mdy(new Date(p.dob)), payerOf(c.payerCode).name, p.memberId, mdy(c.serviceDate),
      mdy(c.submittedAt), money(c.lines.reduce((s, l) => s + l.feeCents, 0)), money(Math.round(c.lines.reduce((s, l) => s + l.feeCents, 0) * 0.7)), c.planType]],
  },
  // Headers ClaimHive can't guess: exercises the mapping screen.
  custom: {
    headers: ["Who", "Ins", "When", "Owed by ins"],
    row: ({ patient: p, claim: c }) => [[`${p.lastName}, ${p.firstName}`, payerOf(c.payerCode).name, mdy(c.serviceDate), money(c.lines.reduce((s, l) => s + l.feeCents, 0))]],
  },
};

export function agingRows(practice: GenPractice, style: AgingStyle, filter: (r: Row) => boolean = () => true): string[][] {
  const layout = AGING_LAYOUTS[style];
  const rows = rowsOf(practice).filter(filter).flatMap((r, i) => layout.row(r, i));
  return [...(layout.title ?? []).map((t) => [t]), layout.headers, ...rows];
}

export function buildAgingCsv(practice: GenPractice, style: AgingStyle, filter?: (r: Row) => boolean): string {
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return agingRows(practice, style, filter).map((r) => r.map(q).join(",")).join("\r\n");
}

export async function buildAgingXlsx(practice: GenPractice, style: AgingStyle, filter?: (r: Row) => boolean): Promise<Uint8Array> {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Aging");
  for (const r of agingRows(practice, style, filter)) ws.addRow(r);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/**
 * One EOB PDF for a claim. Two layouts (payers word things differently);
 * `messy` drops the claim number and prints an ambiguous total, so the
 * importer has to flag it for review.
 */
export async function buildEobPdf(patient: GenPatient, claim: GenClaim, opts: { layout?: "a" | "b"; messy?: boolean } = {}): Promise<Uint8Array> {
  const layout = opts.layout ?? "a";
  const payer = payerOf(claim.payerCode);
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 740;
  const text = (s: string, x = 50, f = font, size = 10) => page.drawText(s, { x, y, size, font: f, color: rgb(0, 0, 0) });
  const nl = (n = 16) => (y -= n);

  text(payer.name, 50, bold, 16); nl(20);
  text(layout === "a" ? "EXPLANATION OF BENEFITS" : "Dental Claim Statement - This is not a bill", 50, bold, 12); nl(14);
  text("SYNTHETIC SAMPLE - NOT A REAL PATIENT", 50, font, 8); nl(24);
  const paid = claim.lines.reduce((s, l) => s + l.paidCents, 0);
  const billed = claim.lines.reduce((s, l) => s + l.feeCents, 0);
  if (layout === "a") {
    text(`Patient: ${patient.lastName}, ${patient.firstName}`); text(`Member ID: ${patient.memberId}`, 330); nl();
    if (!opts.messy) { text(`Claim #: ${claim.claimNumber}`); }
    text(`Date Processed: ${mdy(claim.adjudicatedAt)}`, 330); nl(26);
    const cols = [50, 130, 190, 230, 310, 390, 460];
    ["Date of Service", "Procedure", "Tooth", "Submitted", "Allowed", "Paid", "Reason"].forEach((h, i) => text(h, cols[i], bold, 9)); nl();
    claim.lines.forEach((l, i) => {
      const d = claim.denials.find((x) => x.lineIndex === i);
      [mdy(claim.serviceDate), l.cdtCode, l.tooth ?? "", money(l.feeCents), money(d ? 0 : l.paidCents), money(l.paidCents),
        d ? `${d.groupCode}-${d.carc}${d.rarc ? ` ${d.rarc}` : ""}` : ""].forEach((v, j) => text(v, cols[j], font, 9));
      nl(14);
    });
    nl(10);
    text(`Total Submitted: ${money(billed)}`, 50, bold); text(`Total Paid: ${money(paid)}`, 330, bold); nl();
    if (opts.messy) { text(`Amount due from patient: ${money(billed - paid)}`, 330); nl(); }
  } else {
    text(`Subscriber: ${patient.firstName} ${patient.lastName}`); nl();
    text(`Subscriber ID ${patient.memberId}`); nl();
    if (!opts.messy) { text(`Claim Number ${claim.claimNumber}`); nl(); }
    nl(10);
    const cols = [50, 120, 180, 260, 340, 420];
    ["Svc Date", "Code", "Tooth", "Charge", "Benefit Paid", "Adj Code"].forEach((h, i) => text(h, cols[i], bold, 9)); nl();
    claim.lines.forEach((l, i) => {
      const d = claim.denials.find((x) => x.lineIndex === i);
      [mdy(claim.serviceDate), l.cdtCode, l.tooth ?? "", money(l.feeCents), money(l.paidCents), d ? `${d.groupCode}${d.carc}${d.rarc ? `/${d.rarc}` : ""}` : ""]
        .forEach((v, j) => text(v, cols[j], font, 9));
      nl(14);
    });
    nl(10);
    text(`Benefit Paid ${money(paid)}`, 50, bold); nl();
  }
  nl(20);
  const reasons = [...new Set(claim.denials.map((d) => d.carc))];
  if (reasons.length) {
    text("Reason codes", 50, bold, 9); nl(12);
    for (const r of reasons) { text(`${r}: ${CARC.find((c) => c.code === r)?.label ?? ""}`, 50, font, 8); nl(11); }
  }
  return doc.save();
}

/**
 * Statement exports. None of them contain patient details: lines carry
 * ClaimHive's own claim reference, the insurer, procedure codes and a PHI-free
 * explanation of how the money was won (or taken back).
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { csvCell } from "../csv";
import { usd } from "../money";
import { METHODS, type Method } from "../results/ledger";
import { feeOn, monthLabel, pctOf } from "./statements";

export interface StatementForExport {
  number: string | null; status: string; periodStart: Date; periodEnd: Date; issuedAt: Date | null; dueDate: Date | null;
  recoveredCents: number; feeCents: number; creditCents: number; totalCents: number;
  lines: { kind: string; occurredAt: Date; claimRef: string; payer: string; cdtCodes: string[]; method: string; explanation: string;
    recoveredCents: number; rateBps: number; feeCents: number }[];
}
export interface BillTo {
  name: string; addressLine1?: string | null; addressLine2?: string | null; city?: string | null; state: string; zip?: string | null;
}

/** ClaimHive's own details for the invoice header (set per deployment). */
export const ISSUER = {
  name: process.env.BILLING_ISSUER_NAME || "ClaimHive Inc.",
  address: process.env.BILLING_ISSUER_ADDRESS || "",
  email: process.env.BILLING_ISSUER_EMAIL || "",
};

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
const money = (c: number) => (c / 100).toFixed(2);
const label = (m: string) => METHODS[m as Method] ?? m;

export function statementCsv(s: StatementForExport): string {
  const head = ["statement", "line", "date", "claim_ref", "insurer", "procedures", "how", "explanation", "amount", "rate", "fee"];
  const rows = s.lines.map((l) => [
    s.number ?? "DRAFT", l.kind, day(l.occurredAt), l.claimRef, l.payer, l.cdtCodes.join(" "), label(l.method), l.explanation,
    money(l.kind === "credit" ? -l.recoveredCents : l.recoveredCents), pctOf(l.rateBps), money(l.kind === "credit" ? -l.feeCents : l.feeCents),
  ]);
  rows.push([s.number ?? "DRAFT", "total", "", "", "", "", "", "", money(s.recoveredCents), "", money(s.totalCents)]);
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/**
 * QuickBooks Online invoice import: one row per line, grouped by InvoiceNo.
 * Headings follow QuickBooks' sample invoice file; its import screen lets you
 * confirm the column mapping the first time.
 */
export function quickbooksCsv(items: { customer: string; s: StatementForExport }[]): string {
  const head = ["InvoiceNo", "Customer", "InvoiceDate", "DueDate", "Terms", "Memo", "Item(Product/Service)", "ItemDescription", "ItemQuantity", "ItemRate", "ItemAmount", "Service Date"];
  const rows: (string | number)[][] = [];
  for (const { customer, s } of items) {
    for (const l of s.lines) {
      const amount = l.kind === "credit" ? -l.feeCents : l.feeCents;
      rows.push([
        s.number ?? "", customer, day(s.issuedAt), day(s.dueDate), "Net 30", `ClaimHive contingency fees, ${monthLabel(s.periodStart)}`,
        l.kind === "credit" ? "Contingency fee credit" : "Contingency fee",
        `${l.claimRef} ${l.payer} ${l.cdtCodes.join(" ")}: ${l.kind === "credit" ? "reversal of " : ""}${usd(l.recoveredCents)} at ${pctOf(l.rateBps)}`,
        1, money(amount), money(amount), day(l.occurredAt),
      ]);
    }
  }
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const GREY = rgb(0.4, 0.4, 0.4);
const GREEN = rgb(0.08, 0.5, 0.24);
const safe = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of safe(text).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = w; } else line = next;
  }
  out.push(line);
  return out;
}

export async function statementPdf(billTo: BillTo, s: StatementForExport): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`ClaimHive statement ${s.number ?? "(draft)"}`);
  doc.setProducer("ClaimHive");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 50;
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
  const t = (x: number, s2: string, o: { f?: PDFFont; sz?: number; c?: typeof GREY; right?: boolean } = {}) => {
    const f = o.f ?? font, sz = o.sz ?? 9.5, str = safe(s2);
    page.drawText(str, { x: o.right ? x - f.widthOfTextAtSize(str, sz) : x, y, size: sz, font: f, color: o.c });
  };

  t(M, ISSUER.name, { f: bold, sz: 16 });
  t(W - M, s.status === "issued" ? "STATEMENT" : "DRAFT STATEMENT", { f: bold, sz: 14, right: true });
  y -= 16;
  if (ISSUER.address) { t(M, ISSUER.address, { c: GREY }); }
  t(W - M, s.number ? `No. ${s.number}` : "Not yet issued", { right: true });
  y -= 13;
  if (ISSUER.email) t(M, ISSUER.email, { c: GREY });
  t(W - M, `Period: ${monthLabel(s.periodStart)}`, { right: true });
  y -= 13;
  if (s.issuedAt) { t(W - M, `Issued ${day(s.issuedAt)} · Due ${day(s.dueDate)}`, { right: true }); }
  y -= 26;
  t(M, "Bill to", { f: bold, c: GREY });
  y -= 13;
  for (const line of [billTo.name, billTo.addressLine1, billTo.addressLine2, [billTo.city, [billTo.state, billTo.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean) as string[]) {
    t(M, line); y -= 12;
  }
  y -= 14;

  // Totals box.
  const box = [["Recovered through ClaimHive (billed)", usd(s.recoveredCents)], ["Contingency fees", usd(s.feeCents)],
    ...(s.creditCents ? [["Credits for money insurers took back", `-${usd(s.creditCents)}`]] : []),
    [s.totalCents >= 0 ? "Amount due" : "Credit balance", usd(Math.abs(s.totalCents))]];
  for (const [k, v] of box) {
    const last = k === box.at(-1)![0];
    t(M, k, { f: last ? bold : font, sz: last ? 11 : 9.5 }); t(W - M, v, { f: last ? bold : font, sz: last ? 11 : 9.5, right: true, c: last ? GREEN : undefined });
    y -= last ? 18 : 13;
  }
  y -= 10;

  // Lines.
  const cols = { date: M, ref: M + 58, desc: M + 118, amt: W - M - 110, rate: W - M - 58, fee: W - M };
  const header = () => {
    page.drawLine({ start: { x: M, y: y + 10 }, end: { x: W - M, y: y + 10 }, thickness: 0.6, color: GREY });
    t(cols.date, "Date", { f: bold }); t(cols.ref, "Claim", { f: bold }); t(cols.desc, "How ClaimHive helped", { f: bold });
    t(cols.amt, "Amount", { f: bold, right: true }); t(cols.rate, "Rate", { f: bold, right: true }); t(cols.fee, "Fee", { f: bold, right: true });
    y -= 14;
  };
  header();
  for (const l of s.lines) {
    const desc = wrap(`${l.payer}${l.cdtCodes.length ? `, ${l.cdtCodes.join(", ")}` : ""}: ${l.explanation}`, font, 8.5, cols.amt - cols.desc - 60);
    if (y - desc.length * 11 < M + 30) { newPage(); header(); }
    const sign = l.kind === "credit" ? "-" : "";
    t(cols.date, day(l.occurredAt), { sz: 8.5 }); t(cols.ref, l.claimRef, { sz: 8.5 });
    t(cols.amt, `${sign}${usd(l.recoveredCents)}`, { sz: 8.5, right: true }); t(cols.rate, pctOf(l.rateBps), { sz: 8.5, right: true });
    t(cols.fee, `${sign}${usd(feeOn(l.recoveredCents, l.rateBps))}`, { sz: 8.5, right: true });
    for (const d of desc) { t(cols.desc, d, { sz: 8.5, c: l.kind === "credit" ? GREY : undefined }); y -= 11; }
    y -= 4;
  }
  y -= 10;
  if (y < M + 50) newPage();
  for (const note of [
    "Only money recovered through ClaimHive and received by your practice is billed. Money ClaimHive protected before sending",
    "is shown on your Results page but never billed. If an insurer takes back money we billed for, the fee is credited.",
    "Claim references are ClaimHive's own; open them in ClaimHive to see the claim.",
  ]) { t(M, note, { sz: 8, c: GREY }); y -= 10; }
  const pages = doc.getPages();
  pages.forEach((pg, i) => pg.drawText(`Page ${i + 1} of ${pages.length}`, { x: W - M - 50, y: 25, size: 8, font, color: GREY }));
  return doc.save();
}

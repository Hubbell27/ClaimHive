/**
 * Monthly "what ClaimHive did for you" PDF. Built from the results ledger, with
 * no patient details (claim references are ClaimHive's own), so an office can
 * share it freely.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { usd } from "../money";
import type { ResultsSummary } from "./ledger";

const GREEN = rgb(0.08, 0.5, 0.24);
const GREY = rgb(0.4, 0.4, 0.4);

/** pdf-lib's standard fonts are WinAnsi-only: replace anything else so a payer name can't break the report. */
const safe = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of safe(text).split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  return out;
}

export async function buildResultsPdf(practiceName: string, periodLabel: string, s: ResultsSummary): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`ClaimHive results - ${periodLabel}`);
  doc.setProducer("ClaimHive");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage = doc.addPage([612, 792]);
  let y = 740;
  const M = 50;
  const text = (t: string, x: number, f = font, size = 10, color = rgb(0, 0, 0)) => page.drawText(safe(t), { x, y, size, font: f, color });
  const need = (h: number) => { if (y - h < 60) { page = doc.addPage([612, 792]); y = 740; } };

  text("ClaimHive", M, bold, 12, rgb(0.7, 0.33, 0.04)); y -= 24;
  text(`What ClaimHive did for ${practiceName}`, M, bold, 18); y -= 18;
  text(periodLabel, M, font, 11, GREY); y -= 14;
  if (s.anySynthetic) { text("Demo figures from synthetic (fictional) data.", M, font, 9, GREY); y -= 12; }
  y -= 18;

  text("Money ClaimHive brought in or protected", M, bold, 11); y -= 30;
  text(usd(s.recoveredCents + s.protectedCents), M, bold, 30, GREEN); y -= 30;
  const tiles: [string, number, number, string][] = [
    ["Recovered", s.recoveredCents, s.recoveredCount, "fee applies"],
    ["Protected", s.protectedCents, s.protectedCount, "never billed"],
    ["Recovered by your team", s.outsideCents, s.outsideCount, "not billed"],
  ];
  tiles.forEach(([label, cents, n, note], i) => {
    const x = M + i * 172;
    page.drawText(safe(label), { x, y, size: 9, font: bold });
    page.drawText(usd(cents), { x, y: y - 18, size: 16, font: bold, color: i < 2 ? GREEN : rgb(0, 0, 0) });
    page.drawText(`${n} claim${n === 1 ? "" : "s"} - ${note}`, { x, y: y - 32, size: 8, font, color: GREY });
  });
  y -= 56;
  for (const l of wrap("Recovered: cash an insurer paid after a denial, through a ClaimHive fix or appeal. Protected: claims ClaimHive flagged before sending that were then paid.", font, 8, 512)) {
    text(l, M, font, 8, GREY); y -= 11;
  }
  y -= 14;

  if (s.byMethod.length) {
    text("How the money was won", M, bold, 12); y -= 18;
    for (const m of s.byMethod) {
      need(16);
      text(m.label, M, font, 10); text(`${m.count} claim${m.count === 1 ? "" : "s"}`, 380, font, 10, GREY); text(usd(m.cents), 480, bold, 10);
      y -= 15;
    }
    y -= 12;
  }

  text("Every dollar, and how", M, bold, 12); y -= 18;
  const cols = { date: M, ref: 112, how: 170, amt: 500 };
  const header = () => {
    text("Date", cols.date, bold, 8); text("Claim", cols.ref, bold, 8); text("How", cols.how, bold, 8); text("Amount", cols.amt, bold, 8);
    y -= 12;
  };
  header();
  for (const r of s.rows) {
    const tag = r.kind === "reversed" ? "[Taken back]" : r.kind === "protected" ? "[Protected]" : r.attributed ? "[Recovered]" : "[Your team]";
    const lines = wrap(`${tag} ${r.explanation}`, font, 8, 320);
    if (y - lines.length * 10 - 6 < 60) { page = doc.addPage([612, 792]); y = 740; header(); }
    text(r.occurredAt, cols.date, font, 8); text(r.claimRef, cols.ref, font, 8); text(`${r.kind === "reversed" ? "-" : ""}${usd(r.amountCents)}`, cols.amt, bold, 8);
    for (const l of lines) { text(l, cols.how, font, 8); y -= 10; }
    y -= 4;
  }
  if (!s.rows.length) { text("No results in this period.", M, font, 9, GREY); y -= 12; }

  const pages = doc.getPages();
  pages.forEach((p, i) => p.drawText(`ClaimHive - contains no patient information - page ${i + 1} of ${pages.length}`, { x: M, y: 30, size: 7, font, color: GREY }));
  return doc.save();
}

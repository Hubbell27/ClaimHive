/**
 * The 12-month report as a PDF for the owner to share. No patient details:
 * claims are identified by ClaimHive's own reference, insurer and procedure codes.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { usd } from "../money";
import { APPEAL_WINDOW_DAYS, type OpportunityReport } from "./opportunity";

const GREY = rgb(0.4, 0.4, 0.4), GREEN = rgb(0.08, 0.5, 0.24), RED = rgb(0.7, 0.1, 0.1);
const safe = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = []; let line = "";
  for (const w of safe(text).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = w; } else line = next;
  }
  out.push(line);
  return out;
}

export async function opportunityPdf(practiceName: string, r: OpportunityReport): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Money left on the table"); doc.setProducer("ClaimHive");
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 50;
  let page: PDFPage = doc.addPage([W, H]); let y = H - M;
  const need = (h: number) => { if (y - h < M) { page = doc.addPage([W, H]); y = H - M; } };
  const t = (x: number, s: string, o: { f?: PDFFont; sz?: number; c?: typeof GREY; right?: boolean } = {}) => {
    const f = o.f ?? font, sz = o.sz ?? 9.5, str = safe(s);
    page.drawText(str, { x: o.right ? x - f.widthOfTextAtSize(str, sz) : x, y, size: sz, font: f, color: o.c });
  };
  const para = (s: string, sz = 9.5, c?: typeof GREY) => { for (const l of wrap(s, font, sz, W - 2 * M)) { need(13); t(M, l, { sz, c }); y -= sz + 3.5; } };

  t(M, "Money left on the table", { f: bold, sz: 18 }); y -= 20;
  t(M, `${practiceName} · denials from ${r.from} to ${r.to}`, { c: GREY }); y -= 14;
  if (r.anySynthetic) { t(M, "Demo figures from synthetic (fictional) data.", { c: GREY }); y -= 14; }
  y -= 8;
  for (const [k, v, c] of [
    ["Denied in the last 12 months (not yet paid)", usd(r.deniedCents), RED],
    ["Still recoverable (expected from appeals)", usd(r.recoverable.expectedCents), GREEN],
    [`   from ${usd(r.recoverable.deniedCents)} still inside a ${APPEAL_WINDOW_DAYS}-day appeal window`, "", GREY],
    ["Preventable next year with checks before sending", usd(r.preventable.avoidableCents), undefined],
    ["Too late to appeal", usd(r.tooLateCents), GREY],
  ] as [string, string, typeof GREY | undefined][]) { t(M, k, { c: k.startsWith("   ") ? GREY : undefined }); if (v) t(W - M, v, { f: bold, right: true, c }); y -= 15; }
  y -= 12;

  t(M, "Appeal these first", { f: bold, sz: 13 }); y -= 16;
  para("Ranked by expected value: the denied amount times the chance an appeal wins (\"measured\" = ClaimHive's pooled appeal results; \"typical\" = a rough rate for that kind of denial). Check each insurer's appeal deadline.", 8.5, GREY);
  y -= 6;
  const cols = { ref: M, payer: M + 62, denied: M + 250, amt: M + 355, chance: M + 405, exp: M + 460, days: W - M };
  const head = () => { t(cols.ref, "Claim", { f: bold, sz: 8.5 }); t(cols.payer, "Insurer · procedures", { f: bold, sz: 8.5 }); t(cols.denied, "Denied", { f: bold, sz: 8.5 });
    t(cols.amt, "Amount", { f: bold, sz: 8.5, right: true }); t(cols.chance, "Chance", { f: bold, sz: 8.5, right: true }); t(cols.exp, "Expected", { f: bold, sz: 8.5, right: true }); t(cols.days, "Days left", { f: bold, sz: 8.5, right: true }); y -= 12; };
  head();
  for (const i of r.recoverable.items.slice(0, 40)) {
    need(24); if (y > H - M - 5) head();
    t(cols.ref, i.claimRef, { sz: 8.5 }); t(cols.payer, `${i.payer} · ${i.cdtCodes.join(", ")}`.slice(0, 44), { sz: 8.5 }); t(cols.denied, i.deniedAt, { sz: 8.5 });
    t(cols.amt, usd(i.deniedCents), { sz: 8.5, right: true }); t(cols.chance, `${Math.round(i.likelihood * 100)}% ${i.source === "pool" ? "m" : "t"}`, { sz: 8.5, right: true });
    t(cols.exp, usd(i.expectedCents), { sz: 8.5, right: true, c: GREEN }); t(cols.days, String(i.daysLeft), { sz: 8.5, right: true, c: i.daysLeft <= 30 ? RED : undefined });
    y -= 11;
    for (const l of wrap(i.fix, font, 7.5, W - 2 * M - 62).slice(0, 2)) { t(cols.payer, l, { sz: 7.5, c: GREY }); y -= 9; }
    y -= 3;
  }
  if (r.recoverable.items.length > 40) { t(M, `...and ${r.recoverable.items.length - 40} more in ClaimHive.`, { sz: 8.5, c: GREY }); y -= 12; }
  y -= 10;

  need(40); t(M, "Stop these before they happen", { f: bold, sz: 13 }); y -= 16;
  for (const g of r.preventable.groups.slice(0, 12)) {
    need(50);
    t(M, g.title, { f: bold }); t(W - M, `${usd(g.avoidableCents)} avoidable of ${usd(g.deniedCents)} (${g.claims} claims)`, { right: true }); y -= 13;
    if (g.evidence) para(g.evidence, 8.5, GREY);
    para(`Fix: ${g.fix}`, 8.5);
    y -= 6;
  }
  const pages = doc.getPages();
  pages.forEach((pg, i) => pg.drawText(`ClaimHive · page ${i + 1} of ${pages.length} · claim references are ClaimHive's own, no patient details`, { x: M, y: 25, size: 7.5, font, color: GREY }));
  return doc.save();
}

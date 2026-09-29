/**
 * The approved letter as a PDF on the practice's letterhead. Built entirely on
 * ClaimHive's servers from the approved text; nothing here goes to a writer.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { ATTACHMENT_LABEL } from "./deidentify";
import type { Attachment } from "../reference/codes";

const GREY = rgb(0.35, 0.35, 0.35);
const safe = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of safe(text).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = word; } else line = next;
  }
  out.push(line);
  return out;
}

export interface LetterPdfInput {
  practice: { name: string; addressLine1?: string | null; addressLine2?: string | null; city?: string | null; state: string; zip?: string | null;
    phone?: string | null; fax?: string | null; npi?: string | null; taxId?: string | null; signerName?: string | null; signerTitle?: string | null };
  date: Date;
  recipient: string;
  re: [string, string][];
  body: string;
  enclosures: string[];
}

export async function buildLetterPdf(x: LetterPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Appeal letter");
  doc.setProducer("ClaimHive");
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const W = 612, H = 792, M = 72, width = W - 2 * M, size = 11.5, lh = 15;
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - 60;
  const need = (h: number) => { if (y - h < M) { page = doc.addPage([W, H]); y = H - M; } };
  const text = (s: string, o: { f?: PDFFont; sz?: number; color?: typeof GREY; x?: number } = {}) => {
    for (const line of wrap(s, o.f ?? font, o.sz ?? size, width - ((o.x ?? M) - M))) {
      need(lh);
      page.drawText(line, { x: o.x ?? M, y, size: o.sz ?? size, font: o.f ?? font, color: o.color });
      y -= lh;
    }
  };

  // Letterhead.
  const p = x.practice;
  text(p.name, { f: bold, sz: 16 });
  const addr = [p.addressLine1, p.addressLine2, [p.city, [p.state, p.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
  if (addr) text(addr, { sz: 10, color: GREY });
  const contact = [p.phone && `Phone ${p.phone}`, p.fax && `Fax ${p.fax}`, p.npi && `NPI ${p.npi}`, p.taxId && `Tax ID ${p.taxId}`].filter(Boolean).join(" · ");
  if (contact) text(contact, { sz: 10, color: GREY });
  y -= 4;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: GREY });
  y -= 24;

  text(x.date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }));
  y -= lh;
  for (const line of x.recipient.split(/\r?\n/)) text(line);
  y -= lh;

  // Reference block.
  text("Re: Request for reconsideration of a denied claim", { f: bold });
  for (const [k, v] of x.re) {
    need(lh);
    page.drawText(safe(`${k}:`), { x: M + 18, y, size, font });
    page.drawText(safe(v), { x: M + 140, y, size, font });
    y -= lh;
  }
  y -= lh;

  // Body (the approved text, paragraph by paragraph).
  for (const para of x.body.split(/\r?\n\s*\r?\n/)) {
    for (const line of para.split(/\r?\n/)) text(line);
    y -= lh * 0.6;
  }

  // Signature.
  y -= lh * 2;
  if (p.signerName) text(p.signerName);
  if (p.signerTitle) text(p.signerTitle);
  text(p.name);

  if (x.enclosures.length) {
    y -= lh;
    text(`Enclosures: ${x.enclosures.map((e) => ATTACHMENT_LABEL[e as Attachment] ?? e).join(", ")}`);
  }

  const pages = doc.getPages();
  if (pages.length > 1) pages.forEach((pg, i) => pg.drawText(`Page ${i + 1} of ${pages.length}`, { x: W - M - 60, y: 40, size: 9, font, color: GREY }));
  return doc.save();
}

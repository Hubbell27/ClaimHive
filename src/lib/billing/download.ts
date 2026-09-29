import { NextResponse } from "next/server";
import { audit } from "../audit";
import { prisma } from "../db";
import { statementCsv, statementPdf } from "./exports";
import { statementWithLines } from "./statements";

/** Shared by the practice and admin download routes (the caller has already checked access). */
export async function statementDownload(practiceId: string, statementId: string, format: string, actor: { userId: string; email: string }, opts: { issuedOnly: boolean }) {
  const st = await statementWithLines(practiceId, statementId);
  if (!st || (opts.issuedOnly && st.status !== "issued")) return new NextResponse("Not found", { status: 404 });
  const p = await prisma().practice.findUniqueOrThrow({ where: { id: practiceId } });
  const name = `claimhive-statement-${st.number ?? `draft-${st.periodStart.toISOString().slice(0, 7)}`}`;
  await audit({ action: "billing.export", actorUserId: actor.userId, actorEmail: actor.email, practiceId, resourceType: "statement", resourceId: statementId, details: { format } });
  if (format === "csv") {
    return new NextResponse(statementCsv(st), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"`, "cache-control": "no-store" } });
  }
  const pdf = await statementPdf({ ...p, name: p.letterName || p.name }, st);
  return new NextResponse(new Uint8Array(pdf), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${name}.pdf"`, "cache-control": "no-store" } });
}

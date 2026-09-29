import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { requirePractice } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";
import { opportunityReport } from "@/lib/reports/opportunity";
import { opportunityPdf } from "@/lib/reports/opportunity-pdf";

export async function GET() {
  const ctx = await requirePractice("dashboard.view");
  const p = await prisma().practice.findUniqueOrThrow({ where: { id: ctx.practiceId }, select: { name: true, letterName: true } });
  const r = await opportunityReport(ctx.practiceId);
  const pdf = await opportunityPdf(p.letterName || p.name, r);
  await audit({ action: "report.export", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId, resourceType: "opportunity_report", details: { items: r.recoverable.items.length } });
  return new NextResponse(new Uint8Array(pdf), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="claimhive-money-left-on-the-table-${r.to}.pdf"`, "cache-control": "no-store" } });
}

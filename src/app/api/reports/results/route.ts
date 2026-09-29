import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { requirePractice } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";
import { resultsSummary } from "@/lib/results/ledger";
import { monthPeriod } from "@/lib/results/period";
import { buildResultsPdf } from "@/lib/results/report";

export async function GET(req: Request) {
  const ctx = await requirePractice("dashboard.view");
  const period = monthPeriod(new URL(req.url).searchParams.get("month") ?? "");
  if (!period) return new NextResponse("Choose a month (YYYY-MM).", { status: 400 });
  const practice = await prisma().practice.findUniqueOrThrow({ where: { id: ctx.practiceId }, select: { name: true } });
  const s = await resultsSummary(ctx.practiceId, period.from, period.to);
  const pdf = await buildResultsPdf(practice.name, period.label, s);
  await audit({ action: "report.export", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "results_report", details: { month: period.key, rows: s.rows.length } });
  return new NextResponse(new Uint8Array(pdf), {
    headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="claimhive-results-${period.key}.pdf"`, "cache-control": "no-store" },
  });
}

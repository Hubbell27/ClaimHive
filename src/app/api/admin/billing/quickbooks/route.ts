import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth/rbac";
import { quickbooksCsv } from "@/lib/billing/exports";
import { monthKey, parseMonth } from "@/lib/billing/statements";
import { prisma, withPractice } from "@/lib/db";
import { isRealDeployment } from "@/lib/env";

/** Every issued statement for one month, as a QuickBooks Online invoice import file. */
export async function GET(req: Request) {
  const s = await requireAdmin();
  const month = parseMonth(new URL(req.url).searchParams.get("month") ?? "");
  if (!month) return new NextResponse("Choose a month (YYYY-MM).", { status: 400 });
  // Synthetic practices never reach ClaimHive's books in a real deployment.
  const practices = await prisma().practice.findMany({ where: isRealDeployment() ? { isSynthetic: false } : {}, select: { id: true, name: true, letterName: true } });
  const items = [];
  for (const p of practices) {
    const st = await withPractice(p.id, (tx) => tx.statement.findFirst({ where: { periodStart: month, status: "issued" }, include: { lines: { orderBy: [{ kind: "asc" }, { occurredAt: "asc" }] } } }));
    if (st) items.push({ customer: p.letterName || p.name, s: st });
  }
  await audit({ action: "billing.export", actorUserId: s.userId, actorEmail: s.user.email, details: { format: "quickbooks", month: monthKey(month), statements: items.length } });
  return new NextResponse(quickbooksCsv(items), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="claimhive-invoices-${monthKey(month)}.csv"`, "cache-control": "no-store" },
  });
}

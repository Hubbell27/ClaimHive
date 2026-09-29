/**
 * Development only: synthetic sample files to try the importer end to end.
 * Refused in a real deployment and for non-synthetic practices.
 * The same practice always gets the same fictional dataset, so the 837, the 835
 * and the appeal remittance describe the same claims.
 */
import { NextResponse } from "next/server";
import { requirePractice } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";
import { isRealDeployment } from "@/lib/env";
import { generateDataset } from "@/lib/synthetic/generator";
import { build835, build837, buildAgingCsv, buildAgingXlsx, buildEobPdf } from "@/lib/synthetic/files";


export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const ctx = await requirePractice("phi.edit");
  const practice = await prisma().practice.findUniqueOrThrow({ where: { id: ctx.practiceId }, select: { isSynthetic: true } });
  if (isRealDeployment() || !practice.isSynthetic) return new NextResponse("Not found", { status: 404 });

  const seed = parseInt(ctx.practiceId.replace(/-/g, "").slice(0, 8), 16);
  const now = new Date();
  const [data] = generateDataset({ seed, practices: 1, patientsPerPractice: 25, months: 6, endDate: new Date(now.getTime() - 60 * 86_400_000), claimPrefix: "SMP" });
  const all = data.patients.flatMap((p) => p.claims.map((c) => ({ p, c })));
  const denied = all.filter(({ c }) => c.denials.length);
  // Make sure the sample set always shows a recovery: a few denied claims win on appeal.
  denied.filter(({ c }) => c.appealStatus !== "won").slice(2, 5).forEach(({ c }) => {
    c.appealStatus = "won";
    c.recoveredCents = Math.round(c.denials.reduce((t, d) => t + d.amountCents, 0) * 0.75);
  });
  let body: string | Uint8Array;
  let type = "text/plain";
  switch (file) {
    case "1-claims.837": body = build837(data, undefined, now); break;
    case "2-remittance.835": body = build835(data); break;
    case "3-appeal-payments.835": body = build835(data, { appealPayments: true, date: now }); break;
    case "aging-dentrix-style.csv": body = buildAgingCsv(data, "dentrix"); type = "text/csv"; break;
    case "aging-opendental-style.xlsx": body = await buildAgingXlsx(data, "opendental"); type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; break;
    case "aging-unusual-columns.csv": body = buildAgingCsv(data, "custom"); type = "text/csv"; break;
    case "eob-clear.pdf": body = await buildEobPdf(denied[0].p, denied[0].c, { layout: "b" }); type = "application/pdf"; break;
    case "eob-hard-to-read.pdf": body = await buildEobPdf(denied[1].p, denied[1].c, { messy: true }); type = "application/pdf"; break;
    default: return new NextResponse("Not found", { status: 404 });
  }
  return new NextResponse(typeof body === "string" ? body : new Uint8Array(body), {
    headers: { "content-type": type, "content-disposition": `attachment; filename="synthetic-${file}"`, "cache-control": "no-store" },
  });
}

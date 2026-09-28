import { NextResponse } from "next/server";
import { requirePractice } from "@/lib/auth/rbac";
import { exportPatientsCsv } from "@/lib/phi";

export async function GET() {
  const ctx = await requirePractice("phi.export");
  const csv = await exportPatientsCsv(ctx);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="patients.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

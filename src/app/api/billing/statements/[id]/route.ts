import { NextResponse } from "next/server";
import { requirePractice } from "@/lib/auth/rbac";
import { statementDownload } from "@/lib/billing/download";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePractice("dashboard.view");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  return statementDownload(ctx.practiceId, id, new URL(req.url).searchParams.get("format") ?? "pdf", ctx, { issuedOnly: true });
}

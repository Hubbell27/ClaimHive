import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/rbac";
import { statementDownload } from "@/lib/billing/download";

export async function GET(req: Request, { params }: { params: Promise<{ practiceId: string; id: string }> }) {
  const { practiceId, id } = await params;
  const s = await requireAdmin();
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(practiceId)) return new NextResponse("Not found", { status: 404 });
  return statementDownload(practiceId, id, new URL(req.url).searchParams.get("format") ?? "pdf", { userId: s.userId, email: s.user.email }, { issuedOnly: false });
}

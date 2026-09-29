import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { requirePractice } from "@/lib/auth/rbac";
import { letterDetail } from "@/lib/appeals/letters";
import { buildLetterPdf } from "@/lib/appeals/pdf";
import { prisma } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePractice("phi.view");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  const d = await letterDetail(ctx, id);
  // Only the approved version is ever printed.
  if (!d || d.letter.status !== "approved") return new NextResponse("Approve the letter first.", { status: 409 });
  const p = await prisma().practice.findUniqueOrThrow({ where: { id: ctx.practiceId } });
  const pdf = await buildLetterPdf({
    practice: { ...p, name: p.letterName || p.name }, date: d.letter.approvedAt ?? new Date(), recipient: d.letter.recipient ?? "",
    re: [["Patient", d.patient.name], ["Date of birth", d.patient.dob], ["Member ID", d.patient.memberId], ["Claim number", d.claimNumber],
      ["Date of service", d.serviceDate], ["Date denied", d.deniedAt]].filter(([, v]) => v) as [string, string][],
    body: d.body, enclosures: d.letter.enclosures,
  });
  await audit({ action: "appeal.download", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "appeal_letter", resourceId: id, details: { version: d.letter.approvedVersion } });
  return new NextResponse(new Uint8Array(pdf), {
    // The file name carries no patient details.
    headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="appeal-${id.slice(0, 8)}.pdf"`, "cache-control": "no-store" },
  });
}

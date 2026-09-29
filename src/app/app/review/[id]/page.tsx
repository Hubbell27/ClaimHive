import Link from "next/link";
import { notFound } from "next/navigation";
import { ReviewForm, type ReviewFormData } from "@/components/ReviewForm";
import { requirePractice } from "@/lib/auth/rbac";
import { REVIEW_THRESHOLD } from "@/lib/ingest/eob";
import { reviewDetail } from "@/lib/ingest/pipeline";

const dollars = (c?: number) => (c === undefined ? "" : (c / 100).toFixed(2));

export default async function ReviewItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePractice("phi.edit");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { item, payload } = await reviewDetail(ctx, id).catch(() => notFound());
  if (item.status !== "open") notFound();
  const c = payload.claim;
  const unsure = (k: keyof typeof payload.confidence) => (payload.confidence[k] ?? 1) < REVIEW_THRESHOLD;
  const data: ReviewFormData = {
    reviewId: id,
    fields: [
      { name: "lastName", label: "Patient last name", value: c.patient.lastName, unsure: unsure("patientName") },
      { name: "firstName", label: "Patient first name", value: c.patient.firstName ?? "", unsure: unsure("patientName") },
      { name: "memberId", label: "Member ID", value: c.patient.memberId ?? "", unsure: unsure("memberId") },
      { name: "claimNumber", label: "Claim number", value: c.claimNumber ?? "", unsure: unsure("claimNumber") },
      { name: "payer", label: "Insurer", value: c.payer.name ?? "", unsure: unsure("payer") },
      { name: "serviceDate", label: "Date of service", value: c.serviceDate ?? "", unsure: unsure("serviceDate") },
      { name: "paid", label: "Total paid", value: dollars(c.paidCents), unsure: unsure("paid") },
    ],
    lines: c.lines.map((l) => ({ cdtCode: l.cdtCode, tooth: l.tooth, fee: dollars(l.feeCents), paid: dollars(l.paidCents),
      reasons: l.denials.map((d) => `${d.groupCode}-${d.carc}`).join(" "), unsure: unsure("lines") })),
  };
  return (
    <div className="space-y-4">
      <p className="text-sm"><Link href="/app/review" className="underline">← Needs a check</Link></p>
      <h1 className="text-2xl font-bold">Check this EOB</h1>
      <ul className="list-disc pl-5 text-sm text-amber-900">{item.flags.map((f) => <li key={f}>{f}</li>)}</ul>
      <ReviewForm data={data} />
    </div>
  );
}

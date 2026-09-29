import Link from "next/link";
import { notFound } from "next/navigation";
import { StatementView } from "@/components/StatementView";
import { audit } from "@/lib/audit";
import { requirePractice } from "@/lib/auth/rbac";
import { monthLabel, statementWithLines } from "@/lib/billing/statements";

export default async function StatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePractice("dashboard.view");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const st = await statementWithLines(ctx.practiceId, id);
  if (!st || st.status !== "issued") notFound(); // drafts are ClaimHive-internal
  await audit({ action: "billing.view", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId, resourceType: "statement", resourceId: id });
  return (
    <div className="space-y-4">
      <p className="text-sm"><Link href="/app/billing" className="underline">← Billing</Link></p>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold">Statement {st.number}: {monthLabel(st.periodStart)}</h1>
        <div className="flex gap-2">
          <a className="btn-primary" href={`/api/billing/statements/${id}?format=pdf`}>Download PDF</a>
          <a className="btn-secondary" href={`/api/billing/statements/${id}?format=csv`}>CSV</a>
        </div>
      </div>
      <StatementView s={st} claimLinks />
    </div>
  );
}

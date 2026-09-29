import Link from "next/link";
import { notFound } from "next/navigation";
import { StatementView } from "@/components/StatementView";
import { issueStatementAction, rebuildDraftAction } from "@/lib/actions/billing";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth/rbac";
import { monthKey, monthLabel, statementWithLines } from "@/lib/billing/statements";
import { prisma } from "@/lib/db";

const UUID = /^[0-9a-f-]{36}$/i;

export default async function AdminStatement({ params, searchParams }: { params: Promise<{ practiceId: string; statementId: string }>; searchParams: Promise<{ msg?: string }> }) {
  const s = await requireAdmin();
  const { practiceId, statementId } = await params;
  if (!UUID.test(practiceId) || !UUID.test(statementId)) notFound();
  const practice = await prisma().practice.findUnique({ where: { id: practiceId }, select: { name: true } });
  const st = practice && await statementWithLines(practiceId, statementId);
  if (!st) notFound();
  const { msg } = await searchParams;
  await audit({ action: "billing.view", actorUserId: s.userId, actorEmail: s.user.email, practiceId, resourceType: "statement", resourceId: statementId });
  const api = `/api/admin/billing/statements/${practiceId}/${statementId}`;
  return (
    <div className="min-h-screen">
      <nav className="flex items-center gap-4 border-b bg-white px-5 py-3">
        <span className="font-bold text-brand">ClaimHive admin</span>
        <Link href="/admin" className="font-medium">Practices</Link>
        <Link href={`/admin/billing?month=${monthKey(st.periodStart)}`} className="font-medium">Billing</Link>
      </nav>
      <main className="mx-auto max-w-6xl space-y-4 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-bold">{practice!.name}: {monthLabel(st.periodStart)}</h1>
          <span className={`rounded px-2 py-0.5 text-sm font-semibold ${st.status === "issued" ? "bg-green-100 text-green-900" : "bg-amber-100 text-amber-900"}`}>{st.status === "issued" ? `Issued ${st.number}` : "Draft"}</span>
        </div>
        {msg && <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm">{msg}</p>}
        <StatementView s={st} />
        <div className="card flex flex-wrap items-center gap-2">
          <a className="btn-secondary" href={`${api}?format=pdf`}>PDF</a>
          <a className="btn-secondary" href={`${api}?format=csv`}>CSV</a>
          {st.status === "draft" && (<>
            <form action={rebuildDraftAction}><input type="hidden" name="practiceId" value={practiceId} /><input type="hidden" name="month" value={monthKey(st.periodStart)} /><button className="btn-secondary">Rebuild draft</button></form>
            <form action={issueStatementAction} className="ml-auto flex items-center gap-2">
              <input type="hidden" name="practiceId" value={practiceId} /><input type="hidden" name="statementId" value={st.id} />
              <input type="hidden" name="seen" value={st.updatedAt.toISOString()} />
              <span className="text-sm text-stone-600">Issuing locks this statement and shows it to the practice.</span>
              <button className="btn-primary">Issue statement</button>
            </form>
          </>)}
        </div>
      </main>
    </div>
  );
}

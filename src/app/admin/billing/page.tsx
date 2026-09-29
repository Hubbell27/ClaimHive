import Link from "next/link";
import { buildDraftsAction, setRateAction } from "@/lib/actions/billing";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth/rbac";
import { monthKey, monthLabel, monthStart, parseMonth, pctOf } from "@/lib/billing/statements";
import { currentRates, defaultRates } from "@/lib/billing/view";
import { prisma, withPractice } from "@/lib/db";
import { usd } from "@/lib/money";

/** ClaimHive staff: contingency rates and monthly statements. Billing data only, no patient details. */
export default async function AdminBilling({ searchParams }: { searchParams: Promise<{ month?: string; msg?: string }> }) {
  const s = await requireAdmin();
  const q = await searchParams;
  const lastMonth = monthStart(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)));
  const month = parseMonth(q.month ?? "") ?? lastMonth;
  const practices = await prisma().practice.findMany({ orderBy: { name: "asc" }, take: 200, select: { id: true, name: true, isSynthetic: true } });
  const rates = await currentRates(practices.map((p) => p.id));
  const defaults = await defaultRates();
  const statements = new Map<string, { id: string; status: string; totalCents: number; number: string | null; lines: number }>();
  for (const p of practices) {
    const st = await withPractice(p.id, (tx) => tx.statement.findUnique({ where: { practiceId_periodStart: { practiceId: p.id, periodStart: month } }, include: { _count: { select: { lines: true } } } }));
    if (st) statements.set(p.id, { id: st.id, status: st.status, totalCents: st.totalCents, number: st.number, lines: st._count.lines });
  }
  await audit({ action: "billing.view", actorUserId: s.userId, actorEmail: s.user.email, details: { page: "admin_billing", month: monthKey(month) } });
  const drafts = [...statements.values()].filter((x) => x.status === "draft");
  const today = new Date().toISOString().slice(0, 10);
  const months = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() - i + 1, 1)));

  return (
    <div className="min-h-screen">
      <nav className="flex items-center gap-4 border-b bg-white px-5 py-3">
        <span className="font-bold text-brand">ClaimHive admin</span>
        <Link href="/admin" className="font-medium">Practices</Link>
        <Link href="/admin/billing" className="font-medium">Billing</Link>
      </nav>
      <main className="mx-auto max-w-6xl space-y-5 p-5">
        <h1 className="text-2xl font-bold">Billing</h1>
        {q.msg && <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm">{q.msg}</p>}

        <section className="card space-y-3">
          <h2 className="text-lg font-bold">Default contingency rate</h2>
          <p className="text-sm text-stone-600">Applies to every practice without its own rate. A recovery is billed at the rate in force on the day the money came in, so a change never re-prices past recoveries.</p>
          <p className="text-sm">In force today: <b>{defaults.find((r) => r.effectiveFrom.toISOString().slice(0, 10) <= today) ? pctOf(defaults.find((r) => r.effectiveFrom.toISOString().slice(0, 10) <= today)!.rateBps) : "not set"}</b></p>
          <form action={setRateAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="month" value={monthKey(month)} />
            <label><span className="label">Rate (%)</span><input name="rate" inputMode="decimal" required className="field w-24" placeholder="20" /></label>
            <label><span className="label">Starting</span><input name="effectiveFrom" type="date" defaultValue={today} required className="field" /></label>
            <label className="grow"><span className="label">Note</span><input name="note" className="field" placeholder="e.g. standard terms" /></label>
            <button className="btn-primary">Set default rate</button>
          </form>
          {defaults.length > 0 && (
            <ul className="text-xs text-stone-500">{defaults.map((r) => <li key={r.id}>{pctOf(r.rateBps)} from {r.effectiveFrom.toISOString().slice(0, 10)}{r.note ? ` (${r.note})` : ""} · set {r.createdAt.toLocaleDateString("en-US")}</li>)}</ul>
          )}
        </section>

        <section className="card space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold">Statements for {monthLabel(month)}</h2>
              <p className="text-sm text-stone-600">Drafts are built automatically on the 1st. Review each one, then issue it; the practice sees only issued statements.</p>
            </div>
            <form className="flex gap-2">
              <select name="month" defaultValue={monthKey(month)} className="field w-auto">{months.map((m) => <option key={monthKey(m)} value={monthKey(m)}>{monthLabel(m)}</option>)}</select>
              <button className="btn-secondary">Show</button>
            </form>
          </div>
          <div className="flex flex-wrap gap-2">
            <form action={buildDraftsAction}><input type="hidden" name="month" value={monthKey(month)} /><button className="btn-primary">Build or refresh drafts</button></form>
            <a className="btn-secondary" href={`/api/admin/billing/quickbooks?month=${monthKey(month)}`}>QuickBooks import file (issued)</a>
            {drafts.length > 0 && <span className="self-center text-sm text-amber-800">{drafts.length} draft{drafts.length === 1 ? "" : "s"} to review</span>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-stone-500"><th className="py-2">Practice</th><th>Rate today</th><th>Statement</th><th className="text-right">Total</th><th className="pl-4">Own rate</th></tr></thead>
              <tbody>{practices.map((p) => {
                const st = statements.get(p.id);
                const r = rates.get(p.id)!;
                return (
                  <tr key={p.id} className="border-t align-top">
                    <td className="py-2">{p.name}{p.isSynthetic && <span className="ml-1 rounded bg-stone-100 px-1 text-xs">synthetic</span>}</td>
                    <td>{r.bps === null ? "—" : pctOf(r.bps)}{r.own ? " (own)" : r.bps !== null ? " (default)" : ""}</td>
                    <td>{st ? <Link className="underline" href={`/admin/billing/${p.id}/${st.id}`}>{st.status === "issued" ? st.number : `Draft · ${st.lines} lines`}</Link> : <span className="text-stone-400">nothing to bill</span>}</td>
                    <td className="text-right">{st ? usd(st.totalCents) : ""}</td>
                    <td className="pl-4">
                      <form action={setRateAction} className="flex flex-wrap gap-1">
                        <input type="hidden" name="month" value={monthKey(month)} /><input type="hidden" name="practiceId" value={p.id} />
                        <input name="rate" inputMode="decimal" required className="field w-16 py-1" placeholder="%" aria-label={`Rate for ${p.name}`} />
                        <input name="effectiveFrom" type="date" defaultValue={today} required className="field w-36 py-1" aria-label="Starting" />
                        <input name="note" className="field w-32 py-1" placeholder="note" aria-label="Note" />
                        <button className="btn-secondary py-1 text-xs">Set</button>
                      </form>
                    </td>
                  </tr>);
              })}</tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

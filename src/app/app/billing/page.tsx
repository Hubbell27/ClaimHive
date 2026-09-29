import Link from "next/link";
import { audit } from "@/lib/audit";
import { requirePractice } from "@/lib/auth/rbac";
import { accruing, monthLabel, pctOf, rateOn, ratesFor } from "@/lib/billing/statements";
import { withPractice } from "@/lib/db";
import { usd } from "@/lib/money";

export default async function BillingPage() {
  const ctx = await requirePractice("dashboard.view");
  const { rates, statements } = await withPractice(ctx.practiceId, async (tx) => ({
    rates: await ratesFor(tx),
    statements: await tx.statement.findMany({ where: { status: "issued" }, orderBy: { periodStart: "desc" }, take: 36 }),
  }));
  const acc = await accruing(ctx.practiceId);
  const rate = rateOn(rates, new Date());
  const own = rates.filter((r) => r.practiceId);
  await audit({ action: "billing.view", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId, details: { page: "billing" } });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Billing</h1>
      <p className="max-w-3xl text-sm text-stone-600">
        ClaimHive is paid a share of money it helps you recover: cash an insurer paid after a denial, following a ClaimHive fix or appeal letter.
        Money protected before sending, and recoveries your team made on its own, are never billed. See every line on <Link className="underline" href="/app/results">Results</Link>.
      </p>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card"><p className="text-sm font-semibold text-stone-500">Your rate</p><p className="text-3xl font-bold">{rate === null ? "—" : pctOf(rate)}</p>
          <p className="text-xs text-stone-500">{own.length ? "your practice's agreed rate" : "ClaimHive's standard rate"}</p></div>
        <div className="card"><p className="text-sm font-semibold text-stone-500">Recovered, not yet billed</p><p className="text-3xl font-bold text-money-saved">{acc ? usd(acc.recoveredCents) : "—"}</p>
          <p className="text-xs text-stone-500">{acc ? `${acc.lines} item${acc.lines === 1 ? "" : "s"}` : ""}</p></div>
        <div className="card"><p className="text-sm font-semibold text-stone-500">Fees so far (estimate)</p><p className="text-3xl font-bold">{acc ? usd(acc.totalCents) : "—"}</p>
          <p className="text-xs text-stone-500">billed on your next monthly statement</p></div>
      </div>
      <section className="space-y-2">
        <h2 className="text-lg font-bold">Statements</h2>
        {statements.length === 0 ? <p className="card text-sm text-stone-500">No statements yet.</p> : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-stone-500"><th className="p-3">Statement</th><th>Month</th><th className="text-right">Recovered</th><th className="text-right">Fees</th><th className="text-right">Credits</th><th className="text-right">Total</th><th className="p-3">Due</th><th></th></tr></thead>
              <tbody>{statements.map((s) => (
                <tr key={s.id} className="border-t">
                  <td className="p-3"><Link className="underline" href={`/app/billing/${s.id}`}>{s.number}</Link></td>
                  <td>{monthLabel(s.periodStart)}</td>
                  <td className="text-right">{usd(s.recoveredCents)}</td><td className="text-right">{usd(s.feeCents)}</td>
                  <td className="text-right">{s.creditCents ? `-${usd(s.creditCents)}` : "—"}</td>
                  <td className="text-right font-semibold">{usd(s.totalCents)}</td>
                  <td className="p-3">{s.dueDate?.toISOString().slice(0, 10)}</td>
                  <td className="p-3 text-xs"><a className="underline" href={`/api/billing/statements/${s.id}?format=pdf`}>PDF</a> · <a className="underline" href={`/api/billing/statements/${s.id}?format=csv`}>CSV</a></td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </section>
      {own.length > 0 && (
        <p className="text-xs text-stone-500">Rate history: {own.map((r) => `${pctOf(r.rateBps)} from ${r.effectiveFrom.toISOString().slice(0, 10)}`).join("; ")}.</p>
      )}
    </div>
  );
}

import Link from "next/link";
import { requirePractice } from "@/lib/auth/rbac";
import { usd } from "@/lib/money";
import { resultsSummary } from "@/lib/results/ledger";
import { recentMonths, resolvePeriod } from "@/lib/results/period";

function Tile({ label, cents, count, note, tone }: { label: string; cents: number; count: number; note: string; tone?: string }) {
  return (
    <div className="card">
      <p className="text-sm font-semibold text-stone-500">{label}</p>
      <p className={`mt-1 text-3xl font-bold ${tone ?? ""}`}>{usd(cents)}</p>
      <p className="mt-1 text-xs text-stone-500">{count} claim{count === 1 ? "" : "s"} · {note}</p>
    </div>
  );
}

export default async function ResultsPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const ctx = await requirePractice("dashboard.view");
  const period = resolvePeriod((await searchParams).period);
  const s = await resultsSummary(ctx.practiceId, period.from, period.to);
  const total = s.recoveredCents + s.protectedCents;
  const maxMethod = Math.max(1, ...s.byMethod.map((m) => m.cents));
  const pdfMonth = period.key === "12m" ? recentMonths(1)[0].key : period.key;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">What ClaimHive did for you</h1>
          <p className="text-sm text-stone-600">{period.label}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <form className="flex gap-2">
            <select name="period" defaultValue={period.key} className="field w-auto">
              <option value="12m">Last 12 months</option>
              {recentMonths().map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
            <button type="submit" className="btn-secondary">Show</button>
          </form>
          <a className="btn-primary" href={`/api/reports/results?month=${pdfMonth}`}>Monthly report (PDF)</a>
        </div>
      </div>

      {s.anySynthetic && (
        <p className="rounded-lg bg-stone-100 p-3 text-sm text-stone-600">
          Demo figures from synthetic (fictional) data. They show how this page will look once ClaimHive&apos;s pre-submission checks and appeals are in use.
        </p>
      )}

      <section className="card border-2 border-money-saved/30">
        <p className="text-sm font-semibold text-stone-500">Money ClaimHive brought in or protected</p>
        <p className="mt-1 text-5xl font-bold text-money-saved">{usd(total)}</p>
        <p className="mt-2 max-w-3xl text-sm text-stone-600">
          <b>Recovered</b> is cash the insurer paid after a denial, thanks to a ClaimHive fix or appeal. It&apos;s the only amount ClaimHive&apos;s fee is based on.{" "}
          <b>Protected</b> is claims ClaimHive caught before they were sent, which were then paid. It&apos;s shown so you can see the benefit, and never billed.
        </p>
      </section>

      <div className="grid gap-4 sm:grid-cols-3">
        <Tile label="Recovered through ClaimHive" cents={s.recoveredCents} count={s.recoveredCount} note={s.reversedCents ? `won back after a denial, net of ${usd(s.reversedCents)} insurers took back` : "won back after a denial"} tone="text-money-saved" />
        <Tile label="Protected before sending" cents={s.protectedCents} count={s.protectedCount} note="fixed first, then paid" tone="text-money-saved" />
        <Tile label="Recovered by your team" cents={s.outsideCents} count={s.outsideCount} note="without ClaimHive, not billed" />
      </div>

      <section className="card">
        <h2 className="mb-3 text-lg font-bold">How the money was won</h2>
        <div className="space-y-3">
          {s.byMethod.map((m) => (
            <div key={`${m.kind}-${m.method}`}>
              <div className="flex justify-between text-sm"><span className="font-semibold">{m.label}</span><span>{usd(m.cents)} · {m.count} claim{m.count === 1 ? "" : "s"}</span></div>
              <div className="mt-1 h-3 rounded bg-stone-100"><div className="h-3 rounded bg-money-saved" style={{ width: `${(m.cents / maxMethod) * 100}%` }} /></div>
            </div>
          ))}
          {!s.byMethod.length && <p className="text-sm text-stone-500">Nothing yet for this period. Recoveries show up here as insurers pay.</p>}
        </div>
      </section>

      {s.byPayer.length > 0 && (
        <section className="card">
          <h2 className="mb-3 text-lg font-bold">By insurer</h2>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-stone-500"><th className="py-1">Insurer</th><th className="text-right">Claims</th><th className="text-right">Amount</th></tr></thead>
            <tbody>{s.byPayer.map((p) => <tr key={p.payer} className="border-t"><td className="py-2">{p.payer}</td><td className="text-right">{p.count}</td><td className="text-right font-semibold text-money-saved">{usd(p.cents)}</td></tr>)}</tbody>
          </table>
        </section>
      )}

      <section className="card overflow-x-auto">
        <h2 className="mb-1 text-lg font-bold">Every dollar, and how</h2>
        <p className="mb-3 text-xs text-stone-500">Claim references are ClaimHive&apos;s own; this list has no patient details, so it&apos;s safe to share.</p>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-stone-500"><th className="py-1">Date</th><th>Claim</th><th>Insurer</th><th>How</th><th className="text-right">Amount</th></tr></thead>
          <tbody>
            {s.rows.map((r) => (
              <tr key={r.id} className="border-t align-top">
                <td className="whitespace-nowrap py-2 pr-3">{r.occurredAt}</td>
                <td className="pr-3 pt-2.5 font-mono text-xs">{r.claimRef}</td>
                <td className="pr-3">{r.payer}</td>
                <td>
                  <span className={`mr-2 rounded px-1.5 py-0.5 text-xs font-semibold ${r.kind === "reversed" ? "bg-red-100 text-red-900" : r.kind === "protected" ? "bg-sky-100 text-sky-900" : r.attributed ? "bg-green-100 text-green-900" : "bg-stone-100 text-stone-700"}`}>
                    {r.kind === "reversed" ? "Taken back" : r.kind === "protected" ? "Protected" : r.attributed ? "Recovered" : "Your team"}
                  </span>
                  {r.explanation}
                </td>
                <td className={`text-right font-semibold ${r.kind === "reversed" ? "text-money-lost" : ""}`}>{r.kind === "reversed" ? "-" : ""}{usd(r.amountCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!s.rows.length && <p className="text-sm text-stone-500">No results in this period.</p>}
      </section>
      <p className="text-xs text-stone-500">See also <Link className="underline" href="/app">Money</Link> for what&apos;s still recoverable.</p>
    </div>
  );
}

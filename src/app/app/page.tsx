import { requirePractice } from "@/lib/auth/rbac";
import { moneySummary, usd } from "@/lib/money";
import { CARC } from "@/lib/reference/codes";

const carcLabel = new Map(CARC.map((c) => [c.code, c.label]));

function Tile({ label, cents, tone, note }: { label: string; cents: number; tone?: "lost" | "saved" | "risk"; note: string }) {
  const color = tone === "lost" ? "text-money-lost" : tone === "saved" ? "text-money-saved" : tone === "risk" ? "text-brand" : "";
  return (
    <div className="card">
      <p className="text-sm font-semibold text-stone-500">{label}</p>
      <p className={`mt-1 text-3xl font-bold ${color}`}>{usd(cents)}</p>
      <p className="mt-1 text-xs text-stone-500">{note}</p>
    </div>
  );
}

export default async function MoneyPage() {
  const ctx = await requirePractice("dashboard.view");
  const m = await moneySummary(ctx.practiceId);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Your money, last 12 months</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Denied by insurers" cents={m.denied} tone="lost" note={`across ${m.claims} claims billed at ${usd(m.billed)}`} />
        <Tile label="Still recoverable" cents={m.atRisk} tone="risk" note="denied, not yet appealed or decided, inside the appeal window" />
        <Tile label="Recovered on appeal" cents={m.recovered} tone="saved" note="won back after a denial" />
        <Tile label="Lost for good" cents={m.lost} tone="lost" note="appeal lost, or never appealed in time" />
      </div>
      <section className="card">
        <h2 className="mb-3 text-lg font-bold">Biggest denial causes</h2>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-stone-500"><th className="py-1">Payer</th><th>Reason</th><th className="text-right">Denials</th><th className="text-right">Amount</th></tr></thead>
          <tbody>
            {m.topCauses.map((c) => (
              <tr key={`${c.payer}-${c.carc}`} className="border-t">
                <td className="py-2">{c.payer}</td>
                <td>{carcLabel.get(c.carc) ?? `Code ${c.carc}`} <span className="text-stone-400">({c.carc})</span></td>
                <td className="text-right">{c.count}</td>
                <td className="text-right font-semibold text-money-lost">{usd(c.cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {m.topCauses.length === 0 && <p className="text-sm text-stone-500">No denials yet. Import claims to see where money is leaking.</p>}
      </section>
    </div>
  );
}

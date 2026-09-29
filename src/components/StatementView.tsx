import Link from "next/link";
import { feeOn, monthLabel, pctOf } from "@/lib/billing/statements";
import { usd } from "@/lib/money";
import { METHODS, type Method } from "@/lib/results/ledger";

interface Line { id: string; kind: string; occurredAt: Date; claimRef: string; claimId: string; payer: string; cdtCodes: string[]; method: string; explanation: string; recoveredCents: number; rateBps: number }
interface St { number: string | null; status: string; periodStart: Date; issuedAt: Date | null; dueDate: Date | null; recoveredCents: number; feeCents: number; creditCents: number; totalCents: number; lines: Line[] }

/** A statement with every line's attribution. `claimLinks` only for the practice itself (staff never open claims). */
export function StatementView({ s, claimLinks }: { s: St; claimLinks?: boolean }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card"><p className="text-sm font-semibold text-stone-500">Recovered through ClaimHive</p><p className="text-2xl font-bold text-money-saved">{usd(s.recoveredCents)}</p><p className="text-xs text-stone-500">{monthLabel(s.periodStart)}</p></div>
        <div className="card"><p className="text-sm font-semibold text-stone-500">Contingency fees</p><p className="text-2xl font-bold">{usd(s.feeCents)}</p></div>
        <div className="card"><p className="text-sm font-semibold text-stone-500">Credits</p><p className="text-2xl font-bold">{s.creditCents ? `-${usd(s.creditCents)}` : usd(0)}</p><p className="text-xs text-stone-500">money insurers took back</p></div>
        <div className="card border-2 border-brand/30"><p className="text-sm font-semibold text-stone-500">{s.totalCents >= 0 ? "Amount due" : "Credit balance"}</p><p className="text-2xl font-bold">{usd(Math.abs(s.totalCents))}</p>
          <p className="text-xs text-stone-500">{s.status === "issued" ? `${s.number} · due ${s.dueDate?.toISOString().slice(0, 10)}` : "Draft: not issued"}</p></div>
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-stone-500"><th className="p-3">Date</th><th>Claim</th><th>How ClaimHive helped</th><th className="text-right">Amount</th><th className="text-right">Rate</th><th className="p-3 text-right">Fee</th></tr></thead>
          <tbody>{s.lines.map((l) => {
            const credit = l.kind === "credit";
            return (
              <tr key={l.id} className={`border-t align-top ${credit ? "bg-red-50/50" : ""}`}>
                <td className="p-3 whitespace-nowrap">{l.occurredAt.toISOString().slice(0, 10)}</td>
                <td className="font-mono text-xs">{claimLinks ? <Link className="underline" href={`/app/claims/${l.claimId}`}>{l.claimRef}</Link> : l.claimRef}</td>
                <td className="py-3 pr-3">
                  <span className={`mr-1 rounded px-1.5 py-0.5 text-xs font-semibold ${credit ? "bg-red-100 text-red-900" : "bg-green-100 text-green-900"}`}>{credit ? "Credit" : METHODS[l.method as Method] ?? l.method}</span>
                  <span className="text-stone-500">{l.payer}{l.cdtCodes.length ? ` · ${l.cdtCodes.join(", ")}` : ""}</span>
                  <p className="text-xs text-stone-600">{l.explanation}</p>
                </td>
                <td className="text-right">{credit ? "-" : ""}{usd(l.recoveredCents)}</td>
                <td className="text-right">{pctOf(l.rateBps)}</td>
                <td className="p-3 text-right font-semibold">{credit ? "-" : ""}{usd(feeOn(l.recoveredCents, l.rateBps))}</td>
              </tr>);
          })}</tbody>
        </table>
        <p className="border-t p-3 text-xs text-stone-500">Only money recovered through ClaimHive and received by the practice is billed, at the rate in force the day it was recovered. Money protected before sending, and recoveries the office made on its own, are never billed.</p>
      </div>
    </div>
  );
}

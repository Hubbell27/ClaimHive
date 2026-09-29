import Link from "next/link";
import { audit } from "@/lib/audit";
import { can, requirePractice } from "@/lib/auth/rbac";
import { poolInsights } from "@/lib/pool/insights";
import { CDT_BY_CODE } from "@/lib/reference/codes";

const pct = (x: number) => `${Math.round(x * 100)}%`;

export default async function PoolPage() {
  const ctx = await requirePractice("dashboard.view");
  const insights = await poolInsights(ctx.practiceId, { limit: 60 });
  await audit({ action: "pool.view", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    details: { allowed: insights.allowed } });

  if (!insights.allowed) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Insurer patterns</h1>
        <div className="card max-w-2xl space-y-2">
          <p className="font-semibold">Patterns from other practices are available to practices that share their de-identified data.</p>
          <p className="text-sm text-stone-600">Your own claims, denials and results are always on the Money, Claims and Results pages.</p>
          {can(ctx.role, "pool.opt_in")
            ? <Link href="/app/settings" className="btn-primary">See what sharing means</Link>
            : <p className="text-sm text-stone-600">Your practice owner can turn this on in Settings.</p>}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Insurer patterns</h1>
      <p className="max-w-3xl text-sm text-stone-600">
        How often each insurer denies each procedure, across practices that share de-identified data. A pattern appears only once
        at least {insights.minPractices} practices have contributed to it. Phase 4 adds which fixes win, with confidence ranges.
      </p>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-stone-500"><th className="p-3">Insurer</th><th>Procedure</th><th className="text-right">Denied</th><th className="p-3">Evidence</th></tr></thead>
          <tbody>
            {insights.denialRates.map((r) => (
              <tr key={`${r.payer}-${r.cdt}`} className="border-t">
                <td className="p-3">{r.payer}</td>
                <td><span className="font-mono">{r.cdt}</span> <span className="text-stone-500">{CDT_BY_CODE.get(r.cdt)?.label ?? ""}</span></td>
                <td className={`text-right font-semibold ${r.rate >= 0.3 ? "text-money-lost" : ""}`}>{pct(r.rate)}</td>
                <td className="p-3 text-xs text-stone-500">{r.denied} of {r.lines} procedures denied · {r.practices} practices</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!insights.denialRates.length && <p className="p-4 text-sm text-stone-500">Not enough practices have shared yet for any pattern to be shown.</p>}
      </div>
    </div>
  );
}

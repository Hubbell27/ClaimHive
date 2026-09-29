import Link from "next/link";
import { CodeLink } from "@/components/CodeLink";
import { audit } from "@/lib/audit";
import { requirePractice } from "@/lib/auth/rbac";
import { prisma, withPractice } from "@/lib/db";
import { usd } from "@/lib/money";
import { keysFor } from "@/lib/practices";
import { APPEAL_WINDOW_DAYS, opportunityReport } from "@/lib/reports/opportunity";

const pct = (x: number) => `${Math.round(x * 100)}%`;

export default async function ReportPage() {
  const ctx = await requirePractice("dashboard.view");
  const r = await opportunityReport(ctx.practiceId);
  await prisma().practice.updateMany({ where: { id: ctx.practiceId, reportViewedAt: null }, data: { reportViewedAt: new Date() } });
  const top = r.recoverable.items.slice(0, 50);
  const keys = await keysFor(ctx.practiceId);
  const names = new Map((await withPractice(ctx.practiceId, (tx) => tx.claim.findMany({ where: { id: { in: top.map((i) => i.claimId) } }, select: { id: true, patient: true } })))
    .map((c) => [c.id, `${keys.decrypt("patients", "last_name", c.patient.id, c.patient.lastNameEnc)}, ${keys.decrypt("patients", "first_name", c.patient.id, c.patient.firstNameEnc)}`]));
  await audit({ action: "phi.list", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId, resourceType: "claim", details: { view: "opportunity_report", count: top.length } });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Money left on the table</h1>
          <p className="text-sm text-stone-600">Denials from {r.from} to {r.to}, from the files you imported.</p>
        </div>
        <a className="btn-primary" href="/api/reports/opportunity">Download PDF (no patient names)</a>
      </div>
      {r.anySynthetic && <p className="rounded-lg bg-stone-100 p-3 text-sm text-stone-600">Demo figures from synthetic (fictional) data.</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card"><p className="text-sm font-semibold text-stone-500">Denied in 12 months</p><p className="text-3xl font-bold text-money-lost">{usd(r.deniedCents)}</p><p className="text-xs text-stone-500">{r.deniedClaims} claims, not yet paid</p></div>
        <div className="card border-2 border-money-saved/30"><p className="text-sm font-semibold text-stone-500">Still recoverable</p><p className="text-3xl font-bold text-money-saved">{usd(r.recoverable.expectedCents)}</p><p className="text-xs text-stone-500">expected from {usd(r.recoverable.deniedCents)} still inside the appeal window</p></div>
        <div className="card"><p className="text-sm font-semibold text-stone-500">Preventable next year</p><p className="text-3xl font-bold text-brand">{usd(r.preventable.avoidableCents)}</p><p className="text-xs text-stone-500">if the fixes below are made before sending</p></div>
        <div className="card"><p className="text-sm font-semibold text-stone-500">Too late to appeal</p><p className="text-3xl font-bold">{usd(r.tooLateCents)}</p><p className="text-xs text-stone-500">past {APPEAL_WINDOW_DAYS} days{r.underAppealCents ? ` · ${usd(r.underAppealCents)} already under appeal` : ""}</p></div>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-bold">Appeal these first</h2>
        <p className="text-sm text-stone-600">Ranked by expected value: the denied amount times the chance an appeal wins. Most plans allow 90–180 days to appeal; check each insurer&apos;s deadline.</p>
        {top.length === 0 ? <p className="card text-sm text-stone-500">Nothing recoverable right now.</p> : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-stone-500"><th className="p-3">Patient</th><th>Insurer</th><th>Denied</th><th className="pr-3 text-right">Amount</th><th className="pr-3 text-right">Chance</th><th className="pr-3 text-right">Expected</th><th className="p-3">Days left</th><th>What to do</th></tr></thead>
              <tbody>{top.map((i) => (
                <tr key={i.claimId} className="border-t align-top">
                  <td className="p-3"><Link className="underline" href={`/app/claims/${i.claimId}`}>{names.get(i.claimId)}</Link><span className="block text-xs text-stone-500">{i.cdtCodes.join(", ")}</span></td>
                  <td className="py-3">{i.payer}<span className="block text-xs text-stone-500"><CodeLink kind="carc" code={i.carc} group={i.group} />{i.rarc && <> / <CodeLink kind="rarc" code={i.rarc} /></>} {i.reason.replace(/^\S+\s?/, "")}</span></td>
                  <td className="py-3 whitespace-nowrap">{i.deniedAt}</td>
                  <td className="py-3 pr-3 text-right">{usd(i.deniedCents)}</td>
                  <td className="py-3 pr-3 text-right">{pct(i.likelihood)}<span className="block text-xs text-stone-500">{i.source === "pool" ? "measured" : "typical"}</span></td>
                  <td className="py-3 pr-3 text-right font-semibold text-money-saved">{usd(i.expectedCents)}</td>
                  <td className={`p-3 ${i.daysLeft <= 30 ? "font-semibold text-money-lost" : ""}`}>{i.daysLeft}</td>
                  <td className="py-3 pr-3 text-xs">{i.fix}</td>
                </tr>))}</tbody>
            </table>
            {r.recoverable.items.length > top.length && <p className="border-t p-3 text-xs text-stone-500">Showing the top {top.length} of {r.recoverable.items.length}.</p>}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-bold">Stop these before they happen</h2>
        <p className="text-sm text-stone-600">
          {r.pooled ? "Causes found by ClaimHive's pooled rules (measured across practices) and by the denial codes." : "Causes found from the denial codes. Practices that share de-identified data also get ClaimHive's pooled rules (Settings)."}
          {" "}Use <Link className="underline" href="/app/check">Check a claim</Link> before sending.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          {r.preventable.groups.slice(0, 12).map((g) => (
            <div key={g.key} className="card space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className="font-semibold">{g.title}</p>
                <span className={`rounded px-1.5 text-xs ${g.source === "pool" ? "bg-amber-100 text-amber-900" : "bg-stone-100"}`}>{g.source === "pool" ? "pooled rule" : "from denial codes"}</span>
              </div>
              {g.evidence && <p className="text-xs text-stone-600">{g.evidence}</p>}
              <p className="text-sm"><b>{g.claims}</b> claims, <b className="text-money-lost">{usd(g.deniedCents)}</b> denied; about <b>{usd(g.avoidableCents)}</b> avoidable.</p>
              <p className="text-sm"><b>Fix:</b> {g.fix}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

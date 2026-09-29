import Link from "next/link";
import { UploadForm } from "@/components/UploadForm";
import { audit } from "@/lib/audit";
import { requirePractice } from "@/lib/auth/rbac";
import { withPractice } from "@/lib/db";
import { usd } from "@/lib/money";
import { keysFor } from "@/lib/practices";
import { pct, riskLevel } from "@/lib/precheck/check";

export default async function CheckHub() {
  const ctx = await requirePractice("phi.view");
  const keys = await keysFor(ctx.practiceId);
  const drafts = await withPractice(ctx.practiceId, (tx) => tx.claim.findMany({
    where: { status: "draft", precheckedAt: { not: null } }, orderBy: { precheckedAt: "desc" }, take: 50,
    include: { patient: { select: { id: true, firstNameEnc: true, lastNameEnc: true } }, payer: { select: { name: true } },
      _count: { select: { findings: { where: { status: "open" } } } } },
  }));
  await audit({ action: "phi.list", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "claim", details: { count: drafts.length, view: "precheck" } });
  const atRisk = drafts.reduce((s, c) => s + (c.atRiskCents ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold">Check a claim before sending</h1>
        <p className="text-sm text-stone-500">ClaimHive never sends claims. Fix what it finds, then send from your own software.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="card space-y-3">
          <h2 className="text-lg font-bold">Check one claim</h2>
          <p className="text-sm text-stone-600">Type in the patient, insurer and procedures. Takes about a minute.</p>
          <Link href="/app/check/new" className="btn-primary">Start a check</Link>
        </div>
        <UploadForm precheck />
      </div>
      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-bold">Checked, not sent yet</h2>
          {drafts.length > 0 && <p className="text-sm">At risk: <b className="text-money-lost">{usd(atRisk)}</b></p>}
        </div>
        {drafts.length === 0 ? <p className="card text-sm text-stone-500">No checked claims waiting to be sent.</p> : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-stone-500"><th className="p-3">Patient</th><th>Insurer</th><th>Service</th><th className="text-right">Billed</th><th className="text-right">At risk</th><th className="p-3">Risk</th><th>To fix</th></tr></thead>
              <tbody>{drafts.map((c) => {
                const r = riskLevel(c.riskScore ?? 0);
                return (
                  <tr key={c.id} className="border-t">
                    <td className="p-3"><Link className="underline" href={`/app/check/${c.id}`}>
                      {keys.decrypt("patients", "last_name", c.patient.id, c.patient.lastNameEnc)}, {keys.decrypt("patients", "first_name", c.patient.id, c.patient.firstNameEnc)}
                    </Link></td>
                    <td>{c.payer.name}</td><td>{c.serviceDate.toISOString().slice(0, 10)}</td>
                    <td className="text-right">{usd(c.billedCents)}</td>
                    <td className="text-right font-semibold text-money-lost">{usd(c.atRiskCents ?? 0)}</td>
                    <td className="p-3"><span className={`rounded px-2 py-0.5 text-xs font-semibold ${r.tone}`}>{r.label} · {pct(c.riskScore ?? 0)}</span></td>
                    <td>{c._count.findings || "—"}</td>
                  </tr>);
              })}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

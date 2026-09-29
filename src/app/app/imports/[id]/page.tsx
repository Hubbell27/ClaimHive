import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { MappingForm } from "@/components/MappingForm";
import { audit } from "@/lib/audit";
import { requirePractice } from "@/lib/auth/rbac";
import { withPractice } from "@/lib/db";
import { AGING_FIELDS } from "@/lib/ingest/aging";
import { KIND_LABEL, PROBLEM_LABEL, STATUS_LABEL } from "@/lib/ingest/labels";
import { mappingPreview } from "@/lib/ingest/pipeline";
import { usd } from "@/lib/money";
import { keysFor } from "@/lib/practices";
import { pct, riskLevel } from "@/lib/precheck/check";

const UUID = /^[0-9a-f-]{36}$/i;

export default async function ImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePractice("phi.view");
  if (!UUID.test(id)) notFound();
  const b = await withPractice(ctx.practiceId, (tx) => tx.importBatch.findUnique({ where: { id }, include: { _count: { select: { results: true } } } }));
  if (!b) notFound();
  const status = STATUS_LABEL[b.status];
  const problems = (b.problems as { ref: string; code: string }[]) ?? [];
  const grouped = new Map<string, string[]>();
  for (const p of problems) grouped.set(p.code, [...(grouped.get(p.code) ?? []), p.ref]);
  const recovered = await withPractice(ctx.practiceId, (tx) => tx.resultEvent.aggregate({ where: { sourceBatchId: id }, _sum: { amountCents: true } }));
  const preview = b.status === "mapping_needed" ? await mappingPreview(ctx, id) : undefined;
  const precheck = b.purpose === "precheck";
  const checked = precheck && b.checkedClaimIds.length ? await withPractice(ctx.practiceId, (tx) => tx.claim.findMany({
    where: { id: { in: b.checkedClaimIds } }, orderBy: { atRiskCents: "desc" },
    include: { patient: { select: { id: true, firstNameEnc: true, lastNameEnc: true } }, payer: { select: { name: true } },
      _count: { select: { findings: { where: { status: "open" } } } } },
  })) : [];
  const keys = checked.length ? await keysFor(ctx.practiceId) : undefined;
  if (checked.length) {
    await audit({ action: "phi.list", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
      resourceType: "claim", details: { count: checked.length, view: "precheck_batch", batchId: id } });
  }

  return (
    <div className="space-y-4">
      {(b.status === "queued" || b.status === "processing") && <AutoRefresh />}
      <p className="text-sm"><Link href="/app/imports" className="underline">← Imports</Link></p>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{precheck ? "Check before sending: " : ""}{KIND_LABEL[b.kind]}</h1>
        <span className={`rounded px-2 py-0.5 text-sm font-semibold ${status.tone}`}>{status.text}</span>
        {b.detectedSystem && <span className="text-sm text-stone-500">Looks like an export from {b.detectedSystem}</span>}
      </div>

      {preview && (
        <MappingForm batchId={id} fields={AGING_FIELDS.map((f) => ({ key: f.key, label: f.label, required: f.required }))}
          headers={preview.headers} suggested={preview.suggestion.mapping}
          sample={preview.sample.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "")])))} />
      )}

      {b.status === "needs_review" && (
        <div className="card border-amber-300 bg-amber-50">
          <p className="font-semibold">Some details need a quick check before they count.</p>
          <Link href="/app/review" className="btn-primary mt-2">Review now</Link>
        </div>
      )}

      {precheck && b.status === "done" && (<>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="card"><p className="text-sm font-semibold text-stone-500">Claims checked</p><p className="text-3xl font-bold">{b.checkedClaimIds.length}</p></div>
          <div className="card"><p className="text-sm font-semibold text-stone-500">Need a fix or a look</p><p className="text-3xl font-bold">{b.riskyClaims}</p></div>
          <div className="card"><p className="text-sm font-semibold text-stone-500">Money at risk</p><p className="text-3xl font-bold text-money-lost">{usd(b.atRiskCents)}</p><p className="text-xs text-stone-500">if sent as is</p></div>
        </div>
        <p className="text-sm text-stone-600">Nothing was sent. Fix the claims at the top of the list in your practice software, then send the file as usual.</p>
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-stone-500"><th className="p-3">Patient</th><th>Insurer</th><th>Service</th><th className="text-right">Billed</th><th className="text-right">At risk</th><th className="p-3">Risk</th><th>To fix</th></tr></thead>
            <tbody>{checked.map((c) => {
              const r = riskLevel(c.riskScore ?? 0);
              return (
                <tr key={c.id} className="border-t">
                  <td className="p-3"><Link className="underline" href={`/app/check/${c.id}`}>
                    {keys!.decrypt("patients", "last_name", c.patient.id, c.patient.lastNameEnc)}, {keys!.decrypt("patients", "first_name", c.patient.id, c.patient.firstNameEnc)}
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
      </>)}

      {(!precheck || b.status === "failed") && (b.status === "done" || b.status === "needs_review" || b.status === "failed") && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="card"><p className="text-sm font-semibold text-stone-500">Claims</p><p className="text-3xl font-bold">{b.claimsCreated + b.claimsUpdated}</p><p className="text-xs text-stone-500">{b.claimsCreated} new, {b.claimsUpdated} updated</p></div>
          <div className="card"><p className="text-sm font-semibold text-stone-500">Denied in this file</p><p className="text-3xl font-bold text-money-lost">{usd(b.deniedCents)}</p><p className="text-xs text-stone-500">see Money for what&apos;s still recoverable</p></div>
          <div className="card"><p className="text-sm font-semibold text-stone-500">Paid in this file</p><p className="text-3xl font-bold">{usd(b.paidCents)}</p></div>
          <div className="card"><p className="text-sm font-semibold text-stone-500">Recovered after a denial</p><p className="text-3xl font-bold text-money-saved">{usd(recovered._sum.amountCents ?? 0)}</p><p className="text-xs text-stone-500"><Link className="underline" href="/app/results">see Results</Link></p></div>
        </div>
      )}

      {grouped.size > 0 && (
        <div className="card space-y-2">
          <h2 className="text-lg font-bold">Skipped or noted ({problems.length})</h2>
          <ul className="space-y-1 text-sm">
            {[...grouped.entries()].map(([code, refs]) => (
              <li key={code}><b>{PROBLEM_LABEL[code] ?? code}</b>: {refs.slice(0, 12).join(", ")}{refs.length > 12 ? ` and ${refs.length - 12} more` : ""}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { MappingForm } from "@/components/MappingForm";
import { requirePractice } from "@/lib/auth/rbac";
import { withPractice } from "@/lib/db";
import { AGING_FIELDS } from "@/lib/ingest/aging";
import { KIND_LABEL, PROBLEM_LABEL, STATUS_LABEL } from "@/lib/ingest/labels";
import { mappingPreview } from "@/lib/ingest/pipeline";
import { usd } from "@/lib/money";

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

  return (
    <div className="space-y-4">
      {(b.status === "queued" || b.status === "processing") && <AutoRefresh />}
      <p className="text-sm"><Link href="/app/imports" className="underline">← Imports</Link></p>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{KIND_LABEL[b.kind]}</h1>
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

      {(b.status === "done" || b.status === "needs_review" || b.status === "failed") && (
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

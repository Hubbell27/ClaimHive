import Link from "next/link";
import { UploadForm } from "@/components/UploadForm";
import { audit } from "@/lib/audit";
import { requirePractice } from "@/lib/auth/rbac";
import { prisma, withPractice } from "@/lib/db";
import { isRealDeployment } from "@/lib/env";
import { KIND_LABEL, STATUS_LABEL } from "@/lib/ingest/labels";
import { usd } from "@/lib/money";
import { keysFor } from "@/lib/practices";
import { SAMPLE_FILES } from "@/lib/synthetic/samples";

export default async function ImportsPage() {
  const ctx = await requirePractice("phi.view");
  const keys = await keysFor(ctx.practiceId);
  const batches = await withPractice(ctx.practiceId, (tx) => tx.importBatch.findMany({ orderBy: { createdAt: "desc" }, take: 50,
    select: { id: true, kind: true, status: true, fileNameEnc: true, createdAt: true, claimsCreated: true, claimsUpdated: true,
      rowsSkipped: true, deniedCents: true, paidCents: true, detectedSystem: true } }));
  // File names can contain patient names, so showing them is an audited view.
  if (batches.length) await audit({ action: "phi.list", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "import_batch", details: { count: batches.length } });
  const practice = await prisma().practice.findUniqueOrThrow({ where: { id: ctx.practiceId }, select: { isSynthetic: true } });
  const samples = !isRealDeployment() && practice.isSynthetic;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Imports</h1>
      <div className="grid gap-4 lg:grid-cols-2">
        <UploadForm />
        {samples && (
          <div className="card space-y-2 text-sm">
            <h2 className="text-lg font-bold">Try it with synthetic sample files</h2>
            <p className="text-stone-600">Fictional patients only. Import them in order to see claims, payments, denials and a recovery appear.</p>
            <ul className="list-disc space-y-1 pl-5">
              {SAMPLE_FILES.map((s) => <li key={s.file}><a className="underline" href={`/api/dev/samples/${s.file}`}>{s.label}</a></li>)}
            </ul>
          </div>
        )}
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-stone-500"><th className="p-3">File</th><th>Type</th><th>Status</th><th className="text-right">Claims new / updated</th><th className="text-right">Denied found</th><th className="text-right">Paid</th><th className="p-3">When</th></tr></thead>
          <tbody>
            {batches.map((b) => {
              const s = STATUS_LABEL[b.status];
              return (
                <tr key={b.id} className="border-t">
                  <td className="p-3"><Link className="underline" href={`/app/imports/${b.id}`}>{keys.decrypt("import_batches", "file_name", b.id, b.fileNameEnc)}</Link></td>
                  <td>{KIND_LABEL[b.kind]}{b.detectedSystem ? <span className="text-stone-400"> · {b.detectedSystem}</span> : null}</td>
                  <td><span className={`rounded px-2 py-0.5 text-xs font-semibold ${s.tone}`}>{s.text}</span></td>
                  <td className="text-right">{b.claimsCreated} / {b.claimsUpdated}</td>
                  <td className="text-right font-semibold text-money-lost">{b.deniedCents ? usd(b.deniedCents) : ""}</td>
                  <td className="text-right">{b.paidCents ? usd(b.paidCents) : ""}</td>
                  <td className="p-3 text-stone-500">{b.createdAt.toLocaleString("en-US")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!batches.length && <p className="p-4 text-sm text-stone-500">Nothing imported yet.</p>}
      </div>
    </div>
  );
}

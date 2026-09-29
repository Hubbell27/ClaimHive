import Link from "next/link";
import { notFound } from "next/navigation";
import { audit } from "@/lib/audit";
import { can, requirePractice } from "@/lib/auth/rbac";
import { dismissFindingAction, fixFindingAction, markSentAction } from "@/lib/actions/precheck";
import { withPractice } from "@/lib/db";
import { usd } from "@/lib/money";
import { keysFor } from "@/lib/practices";
import { pct, riskLevel, runCheck, type CheckResult } from "@/lib/precheck/check";
import { CDT_BY_CODE } from "@/lib/reference/codes";

const STATUS_TEXT: Record<string, string> = {
  fixed_by_user: "Fixed", fixed_detected: "Fixed (seen in the claim you sent)", dismissed: "Dismissed",
};

export default async function CheckResultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePractice("phi.view");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const exists = await withPractice(ctx.practiceId, (tx) => tx.claim.findUnique({ where: { id }, select: { status: true, precheckedAt: true } }));
  if (!exists?.precheckedAt) notFound();
  // Drafts are re-checked on every view: pooled rules are rebuilt as data grows.
  const fresh: CheckResult | undefined = exists.status === "draft" ? await runCheck(ctx.practiceId, id) : undefined;
  const c = await withPractice(ctx.practiceId, (tx) => tx.claim.findUniqueOrThrow({
    where: { id }, include: { patient: true, payer: { select: { name: true } }, lines: true, findings: { orderBy: { atRiskCents: "desc" } } },
  }));
  const keys = await keysFor(ctx.practiceId);
  await audit({ action: "phi.view", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId, resourceType: "claim", resourceId: id, details: { view: "precheck" } });
  const name = `${keys.decrypt("patients", "last_name", c.patient.id, c.patient.lastNameEnc)}, ${keys.decrypt("patients", "first_name", c.patient.id, c.patient.firstNameEnc)}`;
  const risk = c.riskScore ?? 0;
  const level = riskLevel(risk);
  const open = c.findings.filter((f) => f.status === "open");
  const closed = c.findings.filter((f) => f.status !== "open");
  const edit = can(ctx.role, "phi.edit");
  const draft = c.status === "draft";

  return (
    <div className="space-y-4">
      <p className="text-sm"><Link href="/app/check" className="underline">← Check a claim</Link></p>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold">{name}</h1>
        <p className="text-sm text-stone-500">{c.payer.name} · {c.planType} · service {c.serviceDate.toISOString().slice(0, 10)}{c.claimNumberEnc ? ` · claim ${keys.decrypt("claims", "claim_number", c.id, c.claimNumberEnc)}` : ""}</p>
      </div>

      <div className={`card ${risk >= 0.5 ? "border-red-300 bg-red-50" : risk >= 0.2 ? "border-amber-300 bg-amber-50" : "border-green-300 bg-green-50"}`}>
        <p className="text-2xl font-bold" data-testid="at-risk">
          {usd(c.atRiskCents ?? 0)} <span className="text-base font-normal">of {usd(c.billedCents)} at risk</span>
        </p>
        <p className="mt-1"><span className={`rounded px-2 py-0.5 text-sm font-semibold ${level.tone}`}>{level.label}</span>{" "}
          {pct(risk)} chance at least one procedure is denied{open.length ? `; ${open.length} thing${open.length === 1 ? "" : "s"} to fix` : ""}.</p>
        {!fresh?.pooled && draft && (
          <p className="mt-2 text-sm text-stone-600">Basic checks only. Rules learned from other practices&apos; claims are available to practices that share de-identified data (Settings).</p>
        )}
      </div>

      {open.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-bold">Fix before sending</h2>
          {open.map((f) => (
            <div key={f.id} className="card space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-semibold">{f.title}</p>
                <p className="text-sm"><b className="text-money-lost">{usd(f.atRiskCents)}</b> at risk · {pct(f.probability)} denied{f.source === "basic" ? " (typical)" : ""}</p>
              </div>
              <p className="text-sm text-stone-600">{f.detail}</p>
              <p className="text-sm"><b>Fix:</b> {f.fix}</p>
              {edit && (
                <div className="flex flex-wrap items-end gap-2">
                  <form action={fixFindingAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="findingId" value={f.id} />
                    {f.kind === "missing_tooth" && <label className="text-sm">Tooth <input name="tooth" required className="field w-20" /></label>}
                    {f.kind === "missing_surface" && <label className="text-sm">Surfaces <input name="surfaces" required className="field w-24" placeholder="MOD" /></label>}
                    <button className="btn-primary">{f.fixType === "attachment" ? `I've attached the ${f.attachment?.replaceAll("_", " ")}` : f.fixType === "verify" ? "Checked, it's fine" : "Fixed it"}</button>
                  </form>
                  <form action={dismissFindingAction}>
                    <input type="hidden" name="findingId" value={f.id} />
                    <button className="text-sm underline">Not relevant</button>
                  </form>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-stone-500"><th className="p-3">Procedure</th><th>Tooth</th><th className="text-right">Fee</th><th className="p-3 text-right">Chance of denial</th></tr></thead>
          <tbody>{c.lines.map((l) => {
            const r = fresh?.lines.find((x) => x.id === l.id);
            return (
              <tr key={l.id} className="border-t">
                <td className="p-3"><span className="font-mono">{l.cdtCode}</span> {CDT_BY_CODE.get(l.cdtCode)?.label}</td>
                <td>{l.tooth}{l.surfaces ? ` ${l.surfaces}` : ""}</td>
                <td className="text-right">{usd(l.feeCents)}</td>
                <td className="p-3 text-right">{r ? pct(r.risk) : "—"}
                  {r?.typicalRate !== undefined && <span className="block text-xs text-stone-500">{c.payer.name} usually: {pct(r.typicalRate)}</span>}</td>
              </tr>);
          })}</tbody>
        </table>
        <p className="border-t p-3 text-xs text-stone-500">Attachments: {c.attachments.length ? c.attachments.join(", ").replaceAll("_", " ") : "none"}</p>
      </div>

      {closed.length > 0 && (
        <section className="space-y-1">
          <h2 className="text-lg font-bold">Already handled</h2>
          <ul className="card space-y-1 text-sm">
            {closed.map((f) => <li key={f.id}><b>{STATUS_TEXT[f.status]}:</b> {f.title}</li>)}
          </ul>
        </section>
      )}

      <div className="card space-y-2">
        {draft ? (<>
          <p className="text-sm">ClaimHive never sends claims. Send it from your practice software or clearinghouse, then mark it sent here (or import the 837 you sent, and ClaimHive will notice).</p>
          {edit && <form action={markSentAction}><input type="hidden" name="claimId" value={c.id} /><button className="btn-primary">Mark as sent</button></form>}
        </>) : (
          <p className="text-sm">Sent. <Link className="underline" href={`/app/claims/${c.id}`}>See the claim</Link>.</p>
        )}
      </div>
    </div>
  );
}

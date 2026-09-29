import Link from "next/link";
import { notFound } from "next/navigation";
import { AppealForm } from "@/components/AppealForm";
import { RuleCard } from "@/components/RuleCard";
import { audit } from "@/lib/audit";
import { requirePractice } from "@/lib/auth/rbac";
import { prisma, withPractice } from "@/lib/db";
import { KIND_LABEL } from "@/lib/ingest/labels";
import { matchClaims } from "@/lib/intel/match";
import { usd } from "@/lib/money";
import { keysFor } from "@/lib/practices";
import { CARC, CDT_BY_CODE, RARC } from "@/lib/reference/codes";

const carc = new Map(CARC.map((c) => [c.code, c.label]));
const rarc = new Map(RARC.map((c) => [c.code, c.label]));

export default async function ClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePractice("phi.view");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const c = await withPractice(ctx.practiceId, (tx) => tx.claim.findUnique({
    where: { id }, include: { patient: true, payer: { select: { name: true } }, lines: true, denials: true },
  }));
  if (!c) notFound();
  const keys = await keysFor(ctx.practiceId);
  await audit({ action: "phi.view", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId, resourceType: "claim", resourceId: id });
  const name = `${keys.decrypt("patients", "last_name", c.patient.id, c.patient.lastNameEnc)}, ${keys.decrypt("patients", "first_name", c.patient.id, c.patient.firstNameEnc)}`;
  const matches = (await matchClaims(ctx.practiceId, [c])).get(c.id) ?? [];
  const sharing = (await prisma().practice.findUniqueOrThrow({ where: { id: ctx.practiceId }, select: { poolOptIn: true } })).poolOptIn;
  const denied = c.denials.reduce((s, d) => s + d.amountCents, 0);

  return (
    <div className="space-y-4">
      <p className="text-sm"><Link href="/app/claims" className="underline">← Claims</Link></p>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold">{name}</h1>
        <p className="text-sm text-stone-500">{c.payer.name} · {c.planType} · service {c.serviceDate.toISOString().slice(0, 10)} · from {c.sources.map((s) => KIND_LABEL[s] ?? s).join(", ")}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card"><p className="text-sm text-stone-500">Billed</p><p className="text-2xl font-bold">{usd(c.billedCents)}</p></div>
        <div className="card"><p className="text-sm text-stone-500">Paid</p><p className="text-2xl font-bold">{usd(c.paidCents)}</p></div>
        <div className="card"><p className="text-sm text-stone-500">Denied</p><p className="text-2xl font-bold text-money-lost">{usd(denied)}</p>
          {c.recoveredCents > 0 && <p className="text-sm text-money-saved">{usd(c.recoveredCents)} recovered</p>}</div>
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-stone-500"><th className="p-3">Procedure</th><th>Tooth</th><th className="text-right">Fee</th><th className="text-right">Paid</th><th className="p-3">Denial</th></tr></thead>
          <tbody>{c.lines.map((l) => (
            <tr key={l.id} className="border-t align-top">
              <td className="p-3"><span className="font-mono">{l.cdtCode}</span> {CDT_BY_CODE.get(l.cdtCode)?.label}</td>
              <td>{l.tooth}{l.surfaces ? ` ${l.surfaces}` : ""}</td>
              <td className="text-right">{usd(l.feeCents)}</td><td className="text-right">{usd(l.paidCents)}</td>
              <td className="p-3 text-xs">{c.denials.filter((d) => d.claimLineId === l.id).map((d) => (
                <p key={d.id}><b>{d.groupCode}-{d.carc}</b> {carc.get(d.carc)}{d.rarc ? ` · ${d.rarc} ${rarc.get(d.rarc) ?? ""}` : ""}</p>
              ))}</td>
            </tr>))}</tbody>
        </table>
        <p className="border-t p-3 text-xs text-stone-500">Attachments sent: {c.attachments.length ? c.attachments.join(", ") : "none"}</p>
      </div>

      {denied > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-bold">Why it was likely denied</h2>
          {matches.map((m) => <RuleCard key={m.rule.key} rule={m.rule} />)}
          {!matches.length && (
            <p className="card text-sm text-stone-500">
              {sharing ? "This denial doesn't match a rule ClaimHive has found yet." : "Pooled rules are available to practices that share de-identified data (Settings)."}
            </p>
          )}
        </section>
      )}
      {denied > 0 && (
        // Keyed on updatedAt: after a save the form remounts with the saved values (React keeps a form's first defaults otherwise).
        <AppealForm key={c.updatedAt.getTime()} claimId={c.id}
          savedAt={c.appealStatus !== "none" ? c.updatedAt.toLocaleString("en-US") : undefined}
          current={{ status: c.appealStatus, attachments: c.appealAttachments, argument: c.appealArgument, ruleKey: c.appealRuleKey }}
          suggestions={matches.map((m) => ({ key: m.rule.key, title: `${m.text.title}. ${m.text.fix}` }))} />
      )}
    </div>
  );
}

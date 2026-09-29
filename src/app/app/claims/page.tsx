import Link from "next/link";
import { CodeLink } from "@/components/CodeLink";
import { audit } from "@/lib/audit";
import { requirePractice } from "@/lib/auth/rbac";
import { withPractice } from "@/lib/db";
import { KIND_LABEL } from "@/lib/ingest/labels";
import { usd } from "@/lib/money";
import { keysFor } from "@/lib/practices";
import { matchClaims } from "@/lib/intel/match";

const FILTERS = [
  { key: "all", label: "All" }, { key: "denied", label: "Denied" }, { key: "partially_paid", label: "Partly paid" },
  { key: "submitted", label: "Waiting on insurer" }, { key: "paid", label: "Paid" },
] as const;
const STATUS_TEXT: Record<string, string> = { draft: "Draft", submitted: "Waiting", paid: "Paid", partially_paid: "Partly paid", denied: "Denied" };

export default async function ClaimsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const ctx = await requirePractice("phi.view");
  const { status = "all" } = await searchParams;
  const filter = FILTERS.find((f) => f.key === status)?.key ?? "all";
  const keys = await keysFor(ctx.practiceId);
  const claims = await withPractice(ctx.practiceId, (tx) => tx.claim.findMany({
    where: filter === "all" ? {} : { status: filter },
    orderBy: { serviceDate: "desc" }, take: 100,
    include: { patient: { select: { id: true, firstNameEnc: true, lastNameEnc: true } }, payer: { select: { name: true } },
      lines: { select: { id: true, cdtCode: true } }, denials: { select: { carc: true, rarc: true } } },
  }));
  await audit({ action: "phi.list", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "claim", details: { count: claims.length, filter } });
  // Denied claims that fit a known pool rule (contributors only): likely cause and what wins.
  const matches = await matchClaims(ctx.practiceId, claims.filter((c) => c.denials.length));
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Claims</h1>
      <nav className="flex flex-wrap gap-2 text-sm">
        {FILTERS.map((f) => (
          <Link key={f.key} href={`/app/claims?status=${f.key}`} className={`rounded-full border px-3 py-1 ${f.key === filter ? "border-brand bg-brand text-white" : "bg-white"}`}>{f.label}</Link>
        ))}
      </nav>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-stone-500"><th className="p-3">Patient</th><th>Service date</th><th>Insurer</th><th>Procedures</th><th className="text-right">Billed</th><th className="text-right">Paid</th><th>Status</th><th>Denial reasons</th><th>ClaimHive says</th><th className="p-3">From</th></tr></thead>
          <tbody>
            {claims.map((c) => (
              <tr key={c.id} className="border-t align-top">
                <td className="p-3"><Link className="underline" href={`/app/claims/${c.id}`}>{keys.decrypt("patients", "last_name", c.patient.id, c.patient.lastNameEnc)}, {keys.decrypt("patients", "first_name", c.patient.id, c.patient.firstNameEnc)}</Link></td>
                <td>{c.serviceDate.toISOString().slice(0, 10)}</td>
                <td>{c.payer.name}</td>
                <td className="font-mono text-xs">{c.lines.map((l) => l.cdtCode).join(" ")}</td>
                <td className="text-right">{usd(c.billedCents)}</td>
                <td className="text-right">{usd(c.paidCents)}</td>
                <td>{STATUS_TEXT[c.status]}{c.appealStatus === "won" ? <span className="ml-1 text-money-saved">· recovered {usd(c.recoveredCents)}</span> : null}</td>
                <td className="text-xs">{[...new Map(c.denials.map((d) => [`${d.carc}/${d.rarc ?? ""}`, d])).values()].map((d, i) => (
                  <span key={i}>{i > 0 && ", "}<CodeLink kind="carc" code={d.carc} />{d.rarc && <>/<CodeLink kind="rarc" code={d.rarc} /></>}</span>
                ))}</td>
                <td className="max-w-xs text-xs">{(matches.get(c.id) ?? []).slice(0, 1).map((m) => (
                  <Link key={m.rule.key} href={`/app/claims/${c.id}`} className="block rounded bg-amber-50 p-1.5 text-amber-900 hover:bg-amber-100">
                    <b>{m.text.title}.</b> {m.text.appeal ?? m.text.fix}
                  </Link>
                ))}</td>
                <td className="p-3 text-xs text-stone-500">{c.sources.map((s) => KIND_LABEL[s] ?? s).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!claims.length && <p className="p-4 text-sm text-stone-500">No claims here yet.</p>}
      </div>
      <p className="text-xs text-stone-500">Showing the latest 100. Viewing claims is recorded in the audit log.</p>
    </div>
  );
}

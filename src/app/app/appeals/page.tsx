import Link from "next/link";
import { markLostAction } from "@/lib/actions/appeals";
import { audit } from "@/lib/audit";
import { can, requirePractice } from "@/lib/auth/rbac";
import { withPractice } from "@/lib/db";
import { usd } from "@/lib/money";
import { keysFor } from "@/lib/practices";

const FILTERS = [["all", "All"], ["drafted", "Drafted"], ["sent", "Sent"], ["won", "Won"], ["lost", "Lost"]] as const;
const STATUS: Record<string, { text: string; tone: string }> = {
  drafted: { text: "Drafted", tone: "bg-stone-100 text-stone-800" }, sent: { text: "Sent, waiting", tone: "bg-blue-100 text-blue-900" },
  won: { text: "Won", tone: "bg-green-100 text-green-900" }, lost: { text: "Lost", tone: "bg-red-100 text-red-900" },
};
const LETTER: Record<string, string> = { generating: "Writing…", draft: "Needs review", approved: "Approved", failed: "Couldn't write", superseded: "" };

export default async function AppealsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const ctx = await requirePractice("phi.view");
  const { status = "all" } = await searchParams;
  const filter = FILTERS.find(([k]) => k === status)?.[0] ?? "all";
  const keys = await keysFor(ctx.practiceId);
  const all = await withPractice(ctx.practiceId, (tx) => tx.claim.findMany({
    where: { OR: [{ appealStatus: { not: "none" } }, { letters: { some: { status: { not: "superseded" } } } }] },
    orderBy: { updatedAt: "desc" }, take: 500,
    include: { patient: { select: { id: true, firstNameEnc: true, lastNameEnc: true } }, payer: { select: { name: true } },
      denials: { select: { amountCents: true } }, letters: { where: { status: { not: "superseded" } }, orderBy: { createdAt: "desc" }, take: 1 } },
  }));
  const count = (s: string) => all.filter((c) => c.appealStatus === s).length;
  const recovered = all.filter((c) => c.appealStatus === "won").reduce((s, c) => s + c.recoveredCents, 0);
  const pending = all.filter((c) => c.appealStatus === "sent").reduce((s, c) => s + c.denials.reduce((t, d) => t + d.amountCents, 0), 0);
  const decided = count("won") + count("lost");
  const rows = filter === "all" ? all.slice(0, 100) : all.filter((c) => c.appealStatus === filter).slice(0, 100);
  await audit({ action: "phi.list", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "claim", details: { count: rows.length, view: "appeals", filter } });
  const edit = can(ctx.role, "phi.edit");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold">Appeals</h1>
        <p className="text-sm text-stone-500">Draft a letter from any denied claim. <Link className="underline" href="/app/claims?status=denied">Denied claims</Link></p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card"><p className="text-sm font-semibold text-stone-500">Drafted</p><p className="text-3xl font-bold">{count("drafted")}</p><p className="text-xs text-stone-500">letters in progress</p></div>
        <div className="card"><p className="text-sm font-semibold text-stone-500">Sent, waiting</p><p className="text-3xl font-bold">{count("sent")}</p><p className="text-xs text-stone-500">{usd(pending)} under appeal</p></div>
        <div className="card"><p className="text-sm font-semibold text-stone-500">Won</p><p className="text-3xl font-bold text-money-saved">{usd(recovered)}</p><p className="text-xs text-stone-500">{count("won")} appeals{decided ? ` · ${Math.round((100 * count("won")) / decided)}% win rate` : ""}</p></div>
        <div className="card"><p className="text-sm font-semibold text-stone-500">Lost</p><p className="text-3xl font-bold">{count("lost")}</p></div>
      </div>
      <nav className="flex flex-wrap gap-2 text-sm">
        {FILTERS.map(([k, label]) => (
          <Link key={k} href={`/app/appeals?status=${k}`} className={`rounded-full border px-3 py-1 ${k === filter ? "border-brand bg-brand text-white" : "bg-white"}`}>{label}</Link>
        ))}
      </nav>
      {rows.length === 0 ? <p className="card text-sm text-stone-500">No appeals here yet.</p> : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-stone-500"><th className="p-3">Patient</th><th>Insurer</th><th>Service</th><th className="text-right">Denied</th><th className="p-3">Letter</th><th>Appeal</th><th className="text-right">Recovered</th><th className="p-3"></th></tr></thead>
            <tbody>{rows.map((c) => {
              const l = c.letters[0];
              const s = STATUS[c.appealStatus];
              return (
                <tr key={c.id} className="border-t">
                  <td className="p-3"><Link className="underline" href={`/app/claims/${c.id}`}>
                    {keys.decrypt("patients", "last_name", c.patient.id, c.patient.lastNameEnc)}, {keys.decrypt("patients", "first_name", c.patient.id, c.patient.firstNameEnc)}
                  </Link></td>
                  <td>{c.payer.name}</td><td>{c.serviceDate.toISOString().slice(0, 10)}</td>
                  <td className="text-right text-money-lost">{usd(c.denials.reduce((t, d) => t + d.amountCents, 0))}</td>
                  <td className="p-3">{l ? <Link className="underline" href={`/app/appeals/${l.id}`}>{l.sentAt ? "Sent" : LETTER[l.status]}</Link> : "—"}</td>
                  <td>{s ? <span className={`rounded px-2 py-0.5 text-xs font-semibold ${s.tone}`}>{s.text}</span> : "—"}</td>
                  <td className="text-right text-money-saved">{c.recoveredCents ? usd(c.recoveredCents) : "—"}</td>
                  <td className="p-3">{edit && c.appealStatus === "sent" && (
                    <form action={markLostAction}><input type="hidden" name="claimId" value={c.id} /><button className="text-xs underline">Mark lost</button></form>
                  )}</td>
                </tr>);
            })}</tbody>
          </table>
          <p className="border-t p-3 text-xs text-stone-500">Wins and amounts come from the insurer&apos;s 835 payments. Mark an appeal lost when the insurer upholds the denial.</p>
        </div>
      )}
    </div>
  );
}

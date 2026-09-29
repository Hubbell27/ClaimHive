import Link from "next/link";
import { requirePractice } from "@/lib/auth/rbac";
import { withPractice } from "@/lib/db";
import { usd } from "@/lib/money";
import { actionFor, anchorFor, CATEGORY, REASON_CODES, searchReasons, type ReasonKind } from "@/lib/reference/reasons";

const KINDS: [string, string][] = [["all", "All"], ["group", "Group codes"], ["carc", "Reason codes (CARC)"], ["rarc", "Remark codes (RARC)"]];
const KIND_LABEL: Record<ReasonKind, string> = { group: "Group", carc: "CARC", rarc: "RARC" };
const APPEAL: Record<string, { text: string; tone: string }> = {
  yes: { text: "Usually worth appealing", tone: "bg-green-100 text-green-900" },
  sometimes: { text: "Fix, then resubmit or appeal", tone: "bg-amber-100 text-amber-900" },
  no: { text: "Not a denial to appeal", tone: "bg-stone-100 text-stone-700" },
};

export default async function CodesPage({ searchParams }: { searchParams: Promise<{ q?: string; kind?: string }> }) {
  const ctx = await requirePractice("dashboard.view");
  const { q = "", kind = "all" } = await searchParams;
  const found = searchReasons(q).filter((x) => kind === "all" || x.kind === kind);
  const looksLikeCode = /^([A-Z]{2}[\s-]+)?[A-Z]{0,2}\d{1,4}$/i.test(q.trim());
  const exact = found.some((x) => x.code.toUpperCase() === q.trim().toUpperCase().replace(/^(CO|PR|OA|PI)[\s-]+/, ""));

  // How often each code hit this practice in the last 12 months (counts and dollars only).
  const since = new Date(Date.now() - 365 * 86_400_000);
  const [carcs, rarcs] = await withPractice(ctx.practiceId, (tx) => Promise.all([
    tx.denial.groupBy({ by: ["carc"], where: { deniedAt: { gte: since } }, _count: true, _sum: { amountCents: true } }),
    tx.denial.groupBy({ by: ["rarc"], where: { deniedAt: { gte: since }, rarc: { not: null } }, _count: true, _sum: { amountCents: true } }),
  ]));
  const usage = new Map<string, { n: number; cents: number }>([
    ...carcs.map((x) => [`carc:${x.carc}`, { n: x._count, cents: x._sum.amountCents ?? 0 }] as const),
    ...rarcs.map((x) => [`rarc:${x.rarc}`, { n: x._count, cents: x._sum.amountCents ?? 0 }] as const),
  ]);
  const yours = [...usage.entries()].sort((a, b) => b[1].cents - a[1].cents).slice(0, 8);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Reason codes</h1>
        <p className="text-sm text-stone-600">What the codes on an EOB or 835 mean, and what to do about them. Search by code (16, CO-16, N706) or by words (x-ray, frequency, eligibility).</p>
      </div>
      <form className="flex flex-wrap gap-2" role="search">
        <input name="q" defaultValue={q} autoFocus placeholder="Code or words, e.g. 16, N706, x-ray" className="field max-w-md grow" aria-label="Search reason codes" />
        <input type="hidden" name="kind" value={kind} />
        <button className="btn-primary">Search</button>
        {q && <Link href={`/app/codes?kind=${kind}`} className="btn-secondary">Clear</Link>}
      </form>
      <nav className="flex flex-wrap gap-2 text-sm">
        {KINDS.map(([k, l]) => (
          <Link key={k} href={`/app/codes?kind=${k}${q ? `&q=${encodeURIComponent(q)}` : ""}`} className={`rounded-full border px-3 py-1 ${k === kind ? "border-brand bg-brand text-white" : "bg-white"}`}>{l}</Link>
        ))}
      </nav>

      {!q && yours.length > 0 && (
        <section className="card space-y-2">
          <h2 className="font-bold">Your most costly codes (last 12 months)</h2>
          <div className="flex flex-wrap gap-2 text-sm">
            {yours.map(([key, u]) => {
              const [k, code] = key.split(":");
              return <a key={key} href={`#${anchorFor(k as ReasonKind, code)}`} className="rounded border bg-white px-2 py-1 hover:border-brand"><b>{code}</b> · {u.n}× · <span className="text-money-lost">{usd(u.cents)}</span></a>;
            })}
          </div>
        </section>
      )}

      {q && looksLikeCode && !exact && (
        <p className="card text-sm">
          <b>{q.trim().toUpperCase()}</b> isn&apos;t in ClaimHive&apos;s list of codes dental offices usually see.
          Look it up on the official <a className="underline" href="https://x12.org/codes" target="_blank" rel="noopener noreferrer">X12 code lists</a>.
        </p>
      )}

      <p className="text-sm text-stone-500">{found.length} of {REASON_CODES.length} codes</p>
      <ul className="space-y-2">
        {found.map((x) => {
          const cat = CATEGORY[x.category];
          const u = usage.get(`${x.kind}:${x.code}`);
          const a = APPEAL[cat.appealable];
          return (
            <li key={`${x.kind}-${x.code}`} id={anchorFor(x.kind, x.code)} className="card scroll-mt-4 space-y-1 target:border-2 target:border-brand">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-lg font-bold">{x.code}</span>
                <span className="rounded bg-stone-100 px-1.5 text-xs">{KIND_LABEL[x.kind]}</span>
                <span className="font-semibold">{x.label}</span>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded border px-1.5">{cat.name}</span>
                {x.kind !== "group" && <span className={`rounded px-1.5 ${a.tone}`}>{a.text}</span>}
                {u && <span className="rounded bg-red-50 px-1.5 text-red-900">At your practice: {u.n} time{u.n === 1 ? "" : "s"}, {usd(u.cents)} in 12 months</span>}
              </div>
              <p className="text-sm"><b>What to do:</b> {actionFor(x)}</p>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-stone-500">Descriptions are ClaimHive&apos;s own plain-English summaries, not the official wording. The official code lists are maintained by <a className="underline" href="https://x12.org/codes" target="_blank" rel="noopener noreferrer">X12</a>.</p>
    </div>
  );
}

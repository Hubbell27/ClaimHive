import { PoolExplainer } from "@/components/PoolExplainer";
import { poolDecisionAction } from "@/lib/actions/practice";
import { requirePractice } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const ctx = await requirePractice("pool.opt_in");
  const p = await prisma().practice.findUniqueOrThrow({ where: { id: ctx.practiceId } });
  const saved = (await searchParams).saved;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Settings</h1>
      {saved && <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-900">Saved.</p>}
      <section className="card space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold">De-identified data pool</h2>
          <span className={`rounded px-2 py-0.5 text-sm font-semibold ${p.poolOptIn ? "bg-green-100 text-green-900" : "bg-stone-100 text-stone-700"}`}>
            {p.poolOptIn ? "Sharing" : "Not sharing"}
          </span>
        </div>
        {p.poolOptIn && (
          <div className="grid gap-3 text-sm sm:grid-cols-3">
            <p><span className="block text-stone-500">Sharing since</span>{p.poolOptInAt?.toLocaleDateString("en-US")}</p>
            <p><span className="block text-stone-500">Claims in the pool</span>{p.poolShared.toLocaleString("en-US")}</p>
            <p><span className="block text-stone-500">Held back</span>{p.poolSkipped.toLocaleString("en-US")}
              <span className="block text-xs text-stone-500">e.g. an insurer name ClaimHive couldn&apos;t verify from an 835/837 file</span></p>
          </div>
        )}
        <PoolExplainer />
        <form action={poolDecisionAction} className="flex flex-wrap items-center gap-3">
          {p.poolOptIn ? (
            <button type="submit" name="share" value="no" className="btn-secondary">Stop sharing and delete what we shared</button>
          ) : (
            <button type="submit" name="share" value="yes" className="btn-primary">Share de-identified data</button>
          )}
          {p.poolDecidedAt && <span className="text-xs text-stone-500">Last decided {p.poolDecidedAt.toLocaleDateString("en-US")} (consent {p.poolConsentVersion})</span>}
        </form>
      </section>
    </div>
  );
}

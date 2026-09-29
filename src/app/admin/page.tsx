import Link from "next/link";
import { CreatePracticeForm } from "@/components/CreatePracticeForm";
import { logoutAction } from "@/lib/actions/auth";
import { generateSyntheticAction } from "@/lib/actions/admin";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";
import { isRealDeployment } from "@/lib/env";
import { MIN_PRACTICES, poolHealth } from "@/lib/pool/store";
import { listRules } from "@/lib/intel/engine";
import { rebuildRulesAction } from "@/lib/actions/admin";

/** ClaimHive staff console. Shows practice metadata only; no patient data is reachable from here. */
export default async function AdminPage() {
  const s = await requireAdmin();
  const practices = await prisma().practice.findMany({
    orderBy: { createdAt: "desc" }, take: 200,
    select: { id: true, name: true, state: true, poolOptIn: true, isSynthetic: true, createdAt: true, _count: { select: { memberships: true } } },
  });
  // Pool health: counts only (no patterns), live and synthetic kept apart.
  const syntheticPool = isRealDeployment() ? false : practices.some((p) => p.isSynthetic);
  const health = await poolHealth(syntheticPool);
  const rules = await listRules({ synthetic: syntheticPool });
  await audit({ action: "admin.view", actorUserId: s.userId, actorEmail: s.user.email, details: { page: "practices" } });
  return (
    <div className="min-h-screen">
      <nav className="flex items-center gap-4 border-b bg-white px-5 py-3">
        <span className="font-bold text-brand">ClaimHive admin</span>
        <Link href="/admin/billing" className="font-medium">Billing</Link>
        <Link href="/admin/readiness" className="font-medium">Readiness</Link>
        <Link href="/choose-practice" className="ml-auto text-sm underline">My practices</Link>
        <form action={logoutAction}><button className="text-sm underline">Sign out</button></form>
      </nav>
      <main className="mx-auto max-w-6xl space-y-5 p-5">
        <CreatePracticeForm />
        <form action={generateSyntheticAction} className="card flex flex-wrap items-end gap-3">
          <div className="grow">
            <h2 className="text-lg font-bold">Generate a synthetic dataset</h2>
            <p className="text-sm text-stone-500">Creates fictional practices, patients, claims and denials in the background (development only).</p>
          </div>
          <label><span className="label">Practices</span><input name="practices" type="number" defaultValue={8} min={1} max={40} className="field w-28" /></label>
          <label><span className="label">Patients each</span><input name="patients" type="number" defaultValue={150} min={10} max={2000} className="field w-28" /></label>
          <button className="btn-secondary">Queue job</button>
        </form>
        <section className="card space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-bold">Pool health</h2>
            <p className="text-sm text-stone-500">
              {health.contributors} contributing practices · {health.claims.toLocaleString("en-US")} claims · {health.lines.toLocaleString("en-US")} procedures
              {isRealDeployment() ? "" : " (synthetic pool)"}
            </p>
          </div>
          <p className="text-xs text-stone-500">Rows below {MIN_PRACTICES} practices aren&apos;t shown to any practice yet.</p>
          <form action={rebuildRulesAction} className="flex flex-wrap items-center gap-3 text-sm">
            <span><b>{rules.length}</b> denial rules{rules[0] ? `, computed ${rules[0].computedAt.toLocaleString("en-US")}` : ""}</span>
            <button type="submit" className="btn-secondary">Rebuild rules now</button>
          </form>
          <div className="grid gap-4 lg:grid-cols-2">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-stone-500"><th>Insurer</th><th className="text-right">Claims</th><th className="text-right">Practices</th><th className="text-right">Denied lines</th></tr></thead>
              <tbody>{health.byPayer.map((r) => (
                <tr key={r.payer} className={`border-t ${r.meetsThreshold ? "" : "text-stone-400"}`}>
                  <td className="py-1">{r.payer}</td><td className="text-right">{r.claims}</td><td className="text-right">{r.practices}</td>
                  <td className="text-right">{r.deniedLines} / {r.lines}</td>
                </tr>))}</tbody>
            </table>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-stone-500"><th>Procedure</th><th className="text-right">Lines</th><th className="text-right">Practices</th><th className="text-right">Denied</th></tr></thead>
              <tbody>{health.byCode.map((r) => (
                <tr key={r.cdt} className={`border-t ${r.meetsThreshold ? "" : "text-stone-400"}`}>
                  <td className="py-1 font-mono">{r.cdt}</td><td className="text-right">{r.lines}</td><td className="text-right">{r.practices}</td><td className="text-right">{r.denied}</td>
                </tr>))}</tbody>
            </table>
          </div>
          {!health.claims && <p className="text-sm text-stone-500">No practice is sharing yet.</p>}
        </section>
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-stone-500"><th className="p-3">Practice</th><th>State</th><th>Members</th><th>Pool</th><th>Data</th><th>Created</th></tr></thead>
            <tbody>
              {practices.map((p) => (
                <tr key={p.id} className="border-t">
                  <td className="p-3">{p.name}</td><td>{p.state}</td><td>{p._count.memberships}</td>
                  <td>{p.poolOptIn ? "Contributing" : "Not opted in"}</td><td>{p.isSynthetic ? "Synthetic" : "Live"}</td>
                  <td>{p.createdAt.toLocaleDateString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}

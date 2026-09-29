import Link from "next/link";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth/rbac";
import { automatedChecks, MANUAL_ITEMS } from "@/lib/readiness";

/** Staff: is this deployment ready for real patient data? */
export default async function Readiness() {
  const s = await requireAdmin();
  const checks = await automatedChecks();
  const passed = checks.filter((c) => c.ok).length;
  await audit({ action: "admin.view", actorUserId: s.userId, actorEmail: s.user.email, details: { page: "readiness", passed, total: checks.length } });
  return (
    <div className="min-h-screen">
      <nav className="flex items-center gap-4 border-b bg-white px-5 py-3">
        <span className="font-bold text-brand">ClaimHive admin</span>
        <Link href="/admin" className="font-medium">Practices</Link>
        <Link href="/admin/billing" className="font-medium">Billing</Link>
        <Link href="/admin/readiness" className="font-medium">Readiness</Link>
      </nav>
      <main className="mx-auto max-w-4xl space-y-5 p-5">
        <h1 className="text-2xl font-bold">Ready for real patient data?</h1>
        <p className={`card font-semibold ${passed === checks.length ? "border-green-300 bg-green-50 text-green-900" : "border-red-300 bg-red-50 text-red-900"}`}>
          {passed === checks.length ? "Every automated check passes. Confirm the manual items below before loading real data." : `${checks.length - passed} of ${checks.length} automated checks fail. Don't load real patient data yet.`}
        </p>
        <section className="card space-y-2">
          <h2 className="text-lg font-bold">Checked automatically</h2>
          <ul className="space-y-2">{checks.map((c) => (
            <li key={c.key} className="flex gap-3">
              <span className={`mt-0.5 h-5 w-5 shrink-0 rounded-full text-center text-xs font-bold leading-5 text-white ${c.ok ? "bg-green-600" : "bg-red-600"}`}>{c.ok ? "✓" : "!"}</span>
              <div><p className="font-medium">{c.title}</p><p className="text-sm text-stone-600">{c.detail}</p></div>
            </li>))}</ul>
        </section>
        <section className="card space-y-2">
          <h2 className="text-lg font-bold">Confirm by hand</h2>
          <p className="text-sm text-stone-600">Record who confirmed each item, and when, in docs/PILOT_CHECKLIST.md.</p>
          <ul className="list-disc space-y-1 pl-5 text-sm">{MANUAL_ITEMS.map((m) => <li key={m}>{m}</li>)}</ul>
        </section>
      </main>
    </div>
  );
}

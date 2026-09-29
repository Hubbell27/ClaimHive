import Link from "next/link";
import { logoutAction } from "@/lib/actions/auth";
import { can, requirePractice } from "@/lib/auth/rbac";
import { prisma, withPractice } from "@/lib/db";
import { redirect } from "next/navigation";
import { needsConsentUpdate } from "@/lib/pool/sync";
import { setupSteps } from "@/lib/setup";

export default async function PracticeLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePractice("dashboard.view");
  const owner = can(ctx.role, "members.manage");
  // Owners decide about the pool once, before anything else (billers are never asked).
  if (can(ctx.role, "pool.opt_in")) {
    const p = await prisma().practice.findUniqueOrThrow({ where: { id: ctx.practiceId },
      select: { poolDecidedAt: true, poolOptIn: true, poolConsentVersion: true, poolConsentOffered: true } });
    if (!p.poolDecidedAt) redirect("/onboarding/pool");
    if (needsConsentUpdate(p)) redirect("/onboarding/pool-update");
  }
  const setup = await setupSteps(ctx.practiceId);
  const toReview = await withPractice(ctx.practiceId, (tx) => tx.reviewItem.count({ where: { status: "open" } }));
  return (
    <div className="min-h-screen">
      <nav className="flex flex-wrap items-center gap-4 border-b bg-white px-5 py-3">
        <span className="font-bold text-brand">ClaimHive</span>
        <Link href="/app" className="font-medium">Money</Link>
        {!setup.complete && <Link href="/app/setup" className="font-medium">Setup<span className="ml-1 rounded-full bg-brand px-1.5 text-xs text-white">{setup.left}</span></Link>}
        <Link href="/app/report" className="font-medium">12-month report</Link>
        <Link href="/app/results" className="font-medium">Results</Link>
        <Link href="/app/billing" className="font-medium">Billing</Link>
        <Link href="/app/check" className="font-medium">Check a claim</Link>
        <Link href="/app/claims" className="font-medium">Claims</Link>
        <Link href="/app/appeals" className="font-medium">Appeals</Link>
        <Link href="/app/imports" className="font-medium">Imports</Link>
        <Link href="/app/review" className="font-medium">
          Review{toReview > 0 && <span className="ml-1 rounded-full bg-amber-500 px-1.5 text-xs text-white">{toReview}</span>}
        </Link>
        <Link href="/app/pool" className="font-medium">Insurer patterns</Link>
        <Link href="/app/patients" className="font-medium">Patients</Link>
        {owner && <Link href="/app/members" className="font-medium">Team</Link>}
        {owner && <Link href="/app/audit" className="font-medium">Audit log</Link>}
        {owner && <Link href="/app/settings" className="font-medium">Settings</Link>}
        <span className="ml-auto text-sm text-stone-500">{ctx.practiceName} · {ctx.role}</span>
        <Link href="/choose-practice" className="text-sm underline">Switch</Link>
        <form action={logoutAction}><button className="text-sm underline">Sign out</button></form>
      </nav>
      <main className="mx-auto max-w-6xl p-5">{children}</main>
    </div>
  );
}

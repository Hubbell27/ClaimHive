import Link from "next/link";
import { logoutAction } from "@/lib/actions/auth";
import { can, requirePractice } from "@/lib/auth/rbac";

export default async function PracticeLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePractice("dashboard.view");
  const owner = can(ctx.role, "members.manage");
  return (
    <div className="min-h-screen">
      <nav className="flex flex-wrap items-center gap-4 border-b bg-white px-5 py-3">
        <span className="font-bold text-brand">ClaimHive</span>
        <Link href="/app" className="font-medium">Money</Link>
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

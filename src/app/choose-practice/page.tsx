import Link from "next/link";
import { AuthShell } from "@/components/AuthForm";
import { choosePracticeAction, logoutAction } from "@/lib/actions/auth";
import { requireUser } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";

export default async function ChoosePracticePage() {
  const s = await requireUser();
  const memberships = await prisma().membership.findMany({
    where: { userId: s.userId }, include: { practice: true }, orderBy: { practice: { name: "asc" } },
  });
  return (
    <AuthShell title="Choose a practice">
      <div className="space-y-2">
        {memberships.map((m) => (
          <form key={m.id} action={choosePracticeAction}>
            <input type="hidden" name="practiceId" value={m.practiceId} />
            <button className="btn-secondary w-full justify-between">
              <span>{m.practice.name}</span>
              <span className="text-xs uppercase text-stone-500">{m.role}</span>
            </button>
          </form>
        ))}
        {memberships.length === 0 && !s.user.isPlatformAdmin && (
          <p className="text-sm text-stone-600">You aren&apos;t a member of any practice yet. Ask the practice owner to invite you.</p>
        )}
        {s.user.isPlatformAdmin && <Link className="btn-primary w-full" href="/admin">ClaimHive admin console</Link>}
      </div>
      <form action={logoutAction} className="mt-4"><button className="text-sm underline">Sign out</button></form>
    </AuthShell>
  );
}

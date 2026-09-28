import { InviteForm } from "@/components/InviteForm";
import { removeMemberAction, resetMemberAction } from "@/lib/actions/practice";
import { requirePractice } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";

export default async function MembersPage() {
  const ctx = await requirePractice("members.manage");
  const members = await prisma().membership.findMany({ where: { practiceId: ctx.practiceId }, include: { user: true } });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Team</h1>
      <InviteForm />
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-stone-500"><th className="p-3">Name</th><th>Email</th><th>Role</th><th>MFA</th><th /></tr></thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-t">
                <td className="p-3">{m.user.name}</td><td>{m.user.email}</td><td className="capitalize">{m.role}</td>
                <td>{m.user.totpEnabled ? "On" : "Not set up"}</td>
                <td className="space-x-3 text-right pr-3">
                  {m.userId !== ctx.userId && (<>
                    <form action={resetMemberAction} className="inline"><input type="hidden" name="userId" value={m.userId} /><button className="underline">Reset MFA</button></form>
                    <form action={removeMemberAction} className="inline"><input type="hidden" name="userId" value={m.userId} /><button className="text-money-lost underline">Remove</button></form>
                  </>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

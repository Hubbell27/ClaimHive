import { audit } from "@/lib/audit";
import { requirePractice } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";

export default async function AuditPage() {
  const ctx = await requirePractice("audit.view");
  const events = await prisma().auditEvent.findMany({ where: { practiceId: ctx.practiceId }, orderBy: { id: "desc" }, take: 200 });
  await audit({ action: "audit.view", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Audit log</h1>
      <p className="text-sm text-stone-500">Every view, edit and export of patient data. Entries cannot be changed or deleted.</p>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-stone-500"><th className="p-3">When</th><th>Who</th><th>Action</th><th>Outcome</th><th>Details</th></tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id.toString()} className="border-t align-top">
                <td className="p-3 whitespace-nowrap">{e.occurredAt.toLocaleString("en-US")}</td>
                <td>{e.actorEmail}</td><td><code>{e.action}</code></td><td>{e.outcome}</td>
                <td className="text-xs text-stone-500"><code>{JSON.stringify(e.details)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

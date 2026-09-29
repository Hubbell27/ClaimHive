import Link from "next/link";
import { requirePractice } from "@/lib/auth/rbac";
import { withPractice } from "@/lib/db";

export default async function ReviewQueue() {
  const ctx = await requirePractice("phi.view");
  const items = await withPractice(ctx.practiceId, (tx) => tx.reviewItem.findMany({
    where: { status: "open" }, orderBy: { createdAt: "asc" }, select: { id: true, flags: true, minConfidence: true, createdAt: true },
  }));
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Needs a check</h1>
      <p className="text-sm text-stone-600">ClaimHive wasn&apos;t sure about these. Nothing counts until a person confirms it.</p>
      <div className="space-y-2">
        {items.map((i) => (
          <Link key={i.id} href={`/app/review/${i.id}`} className="card block hover:bg-stone-50">
            <p className="font-semibold">EOB from {i.createdAt.toLocaleDateString("en-US")}</p>
            <ul className="mt-1 list-disc pl-5 text-sm text-stone-600">{i.flags.map((f) => <li key={f}>{f}</li>)}</ul>
          </Link>
        ))}
        {!items.length && <p className="card text-sm text-stone-500">All caught up.</p>}
      </div>
    </div>
  );
}

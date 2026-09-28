import { poolOptInAction } from "@/lib/actions/practice";
import { requirePractice } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";

export default async function SettingsPage() {
  const ctx = await requirePractice("pool.opt_in");
  const p = await prisma().practice.findUniqueOrThrow({ where: { id: ctx.practiceId } });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Settings</h1>
      <form action={poolOptInAction} className="card space-y-3">
        <h2 className="text-lg font-bold">Share de-identified denial data with the ClaimHive pool</h2>
        <p className="text-sm text-stone-600">
          Only these fields ever leave your practice: payer, plan type, your state, procedure codes, which attachments were
          sent, denial codes, the outcome, and days to payment. No names, dates of birth, member IDs, claim numbers, exact dates
          or anything else that could identify a patient. A pattern is only shown to anyone once it comes from at least 5 practices.
        </p>
        <label className="flex items-center gap-2 font-semibold">
          <input type="checkbox" name="optIn" defaultChecked={p.poolOptIn} className="h-5 w-5" />
          Contribute our de-identified data to the pool
        </label>
        {p.poolOptInAt && <p className="text-xs text-stone-500">Opted in on {p.poolOptInAt.toLocaleDateString("en-US")}.</p>}
        <button className="btn-primary">Save</button>
      </form>
    </div>
  );
}

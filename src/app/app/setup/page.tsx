import Link from "next/link";
import { skipSetupStepAction } from "@/lib/actions/practice";
import { can, requirePractice } from "@/lib/auth/rbac";
import { setupSteps } from "@/lib/setup";

export default async function SetupPage() {
  const ctx = await requirePractice("dashboard.view");
  const { steps, left, complete } = await setupSteps(ctx.practiceId);
  const owner = can(ctx.role, "members.manage");
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Set up {ctx.practiceName}</h1>
      <p className="text-sm text-stone-600">{complete ? "All done. ClaimHive is watching your claims." : `${left} step${left === 1 ? "" : "s"} left. Most offices finish in under an hour.`}</p>
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={s.key} className={`card flex flex-wrap items-center gap-3 ${s.done ? "opacity-70" : ""}`}>
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${s.done ? "bg-green-600 text-white" : s.skipped ? "bg-stone-200 text-stone-600" : "bg-brand text-white"}`} aria-hidden>{s.done ? "✓" : i + 1}</span>
            <div className="min-w-0 grow">
              <p className="font-semibold">{s.title}{s.optional && <span className="ml-2 text-xs font-normal text-stone-500">optional</span>}</p>
              <p className="text-sm text-stone-600">{s.detail}</p>
            </div>
            {s.done ? <span className="text-sm text-green-800">Done</span> : s.skipped ? <span className="text-sm text-stone-500">Skipped</span> : (
              <div className="flex items-center gap-3">
                {owner && s.optional && <form action={skipSetupStepAction}><input type="hidden" name="step" value={s.key} /><button className="text-sm underline">Skip</button></form>}
                <Link href={s.href} className="btn-primary">{s.key === "report" ? "Open the report" : "Do this"}</Link>
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

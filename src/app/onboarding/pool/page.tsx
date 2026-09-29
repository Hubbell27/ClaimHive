import { AuthShell } from "@/components/AuthForm";
import { PoolExplainer } from "@/components/PoolExplainer";
import { poolDecisionAction } from "@/lib/actions/practice";
import { requirePractice } from "@/lib/auth/rbac";

/** Asked once of a practice owner, before they start using ClaimHive. The choice can be changed later in Settings. */
export default async function PoolOnboarding() {
  const ctx = await requirePractice("pool.opt_in");
  return (
    <AuthShell title={`Welcome, ${ctx.practiceName}`}>
      <h2 className="mb-2 text-lg font-bold">Share de-identified denial data?</h2>
      <PoolExplainer />
      <form action={poolDecisionAction} className="mt-5 flex flex-wrap gap-3">
        <input type="hidden" name="next" value="app" />
        <button type="submit" name="share" value="yes" className="btn-primary">Yes, share de-identified data</button>
        <button type="submit" name="share" value="no" className="btn-secondary">No, not now</button>
      </form>
    </AuthShell>
  );
}

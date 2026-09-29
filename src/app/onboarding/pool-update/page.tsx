import { AuthShell } from "@/components/AuthForm";
import { poolUpdateAction } from "@/lib/actions/practice";
import { requirePractice } from "@/lib/auth/rbac";

/** Shown once to owners who share under the original terms, when new fields are proposed. */
export default async function PoolUpdate() {
  await requirePractice("pool.opt_in");
  return (
    <AuthShell title="Updated sharing terms">
      <div className="space-y-3 text-sm">
        <p>ClaimHive can now learn <b>which appeal fixes win</b> and spot <b>frequency limits</b> (like a third cleaning in a year).
          To do that, it would add two things to what your practice shares, de-identified like everything else:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>what an appeal included: attachments added, and what it argued</li>
          <li>whether a procedure was the 1st, 2nd or 3rd+ time for that patient in 12 months. Never dates, and never who.</li>
        </ul>
        <p>If you say no, you keep sharing exactly what you agreed to before. You can stop sharing at any time in Settings,
          and everything you shared is deleted from the pool.</p>
      </div>
      <form action={poolUpdateAction} className="mt-5 flex flex-wrap gap-3">
        <button type="submit" name="accept" value="yes" className="btn-primary">Yes, add these</button>
        <button type="submit" name="accept" value="no" className="btn-secondary">No, keep what I agreed to</button>
      </form>
    </AuthShell>
  );
}

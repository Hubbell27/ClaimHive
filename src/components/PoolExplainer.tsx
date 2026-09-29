import { MIN_PRACTICES } from "@/lib/pool/store";

/** The consent text an owner sees (versioned as POOL_CONSENT_VERSION). Keep it plain and exact. */
export function PoolExplainer() {
  return (
    <div className="space-y-3 text-sm">
      <p>
        ClaimHive gets smarter when practices pool what they learn about denials. If you share, ClaimHive removes everything
        that could identify a patient (HIPAA Safe Harbor) and adds only these details from each claim to a shared pool:
      </p>
      <ul className="grid list-disc gap-x-6 pl-5 sm:grid-cols-2">
        <li>the insurer and plan type</li>
        <li>your state (nothing more specific)</li>
        <li>the procedure codes</li>
        <li>which attachments were sent</li>
        <li>the denial and remark codes</li>
        <li>the outcome (paid, denied, appeal won or lost)</li>
        <li>how many days the insurer took to pay</li>
      </ul>
      <p><b>Never shared:</b> names, dates of birth, member IDs, claim numbers, any dates, tooth numbers, addresses, or your practice&apos;s name.
        The pool doesn&apos;t even know which practice a claim came from, only a random code.</p>
      <p>A pattern is shown to anyone only once it comes from at least <b>{MIN_PRACTICES} different practices</b>.</p>
      <p>Pooled insights (for example, &quot;this insurer denies crowns without an X-ray 70% of the time&quot;) are available to practices that share.
        Your own claims, denials and results are always yours to see either way.</p>
      <p>If you share, your last 12 months of claims are added now, and new claims as you import them.
        You can stop at any time in Settings, and <b>everything you shared is deleted from the pool</b>.</p>
    </div>
  );
}

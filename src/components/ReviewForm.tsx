"use client";
import { useActionState } from "react";
import { resolveReviewAction } from "@/lib/actions/imports";

export interface ReviewFormData {
  reviewId: string;
  fields: { name: string; label: string; value: string; unsure: boolean }[];
  lines: { cdtCode: string; tooth?: string; fee: string; paid: string; reasons: string; unsure: boolean }[];
}

export function ReviewForm({ data }: { data: ReviewFormData }) {
  const [state, action, pending] = useActionState(resolveReviewAction, undefined);
  const ring = (u: boolean) => (u ? "ring-2 ring-amber-400 bg-amber-50" : "");
  return (
    <form action={action} className="card space-y-4">
      <input type="hidden" name="reviewId" value={data.reviewId} />
      <p className="text-sm text-stone-600">Highlighted fields are the ones ClaimHive wasn&apos;t sure about. Check them against the EOB.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {data.fields.map((f) => (
          <label key={f.name}><span className="label">{f.label}{f.unsure ? " (check this)" : ""}</span>
            <input name={f.name} defaultValue={f.value} className={`field ${ring(f.unsure)}`} /></label>
        ))}
      </div>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-stone-500"><th>Procedure</th><th>Tooth</th><th>Billed</th><th>Paid</th><th>Reason codes</th></tr></thead>
        <tbody>
          {data.lines.map((l, i) => (
            <tr key={i} className="border-t">
              <td className="py-2 font-mono">{l.cdtCode}</td><td>{l.tooth}</td>
              <td><input name={`fee_${i}`} defaultValue={l.fee} className={`field ${ring(l.unsure)}`} /></td>
              <td><input name={`paid_${i}`} defaultValue={l.paid} className={`field ${ring(l.unsure)}`} /></td>
              <td><input name={`reason_${i}`} defaultValue={l.reasons} placeholder="e.g. CO-16" className="field" aria-describedby="code-help" /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p id="code-help" className="text-xs text-stone-500">Not sure what a code means? <a className="underline" href="/app/codes" target="_blank" rel="noopener">Look it up in Reason codes</a> (opens in a new tab).</p>
      {state?.error && <p role="alert" className="text-sm font-medium text-money-lost">{state.error}</p>}
      <div className="flex gap-3">
        <button type="submit" name="decision" value="accept" className="btn-primary" disabled={pending}>Looks right, save it</button>
        <button type="submit" name="decision" value="dismiss" className="btn-secondary" disabled={pending}>Not a claim, discard</button>
      </div>
    </form>
  );
}

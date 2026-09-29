"use client";
import { useActionState } from "react";
import { updateAppealAction } from "@/lib/actions/claims";

const ATT = [["xray", "X-ray"], ["narrative", "Narrative"], ["perio_chart", "Periodontal chart"], ["photo", "Photo"]] as const;
const ARG = [
  ["", "—"], ["documentation", "Sent missing documentation"], ["medical_necessity", "Medical necessity"],
  ["coding_correction", "Coding correction / separate service"], ["frequency_exception", "Frequency exception"],
  ["coverage_dispute", "Coverage dispute"], ["other", "Other"],
] as const;

export function AppealForm({ claimId, current, suggestions, savedAt }: {
  claimId: string;
  savedAt?: string;
  current: { status: string; attachments: string[]; argument: string | null; ruleKey: string | null };
  suggestions: { key: string; title: string }[];
}) {
  const [state, action, pending] = useActionState(updateAppealAction, undefined);
  return (
    <form action={action} className="card space-y-3">
      <input type="hidden" name="claimId" value={claimId} />
      <h2 className="text-lg font-bold">Appeal</h2>
      <p className="text-sm text-stone-600">Recording what each appeal included is how ClaimHive learns which fixes win.</p>
      {savedAt && <p className="text-xs text-stone-500">Last updated {savedAt}</p>}
      <label className="block max-w-xs"><span className="label">Status</span>
        <select name="status" defaultValue={current.status} className="field">
          <option value="none">Not appealed</option><option value="drafted">Drafted</option><option value="sent">Sent</option>
          <option value="won">Won</option><option value="lost">Lost</option>
        </select>
      </label>
      <fieldset>
        <legend className="label">The appeal included</legend>
        <div className="flex flex-wrap gap-4">
          {ATT.map(([v, l]) => (
            <label key={v} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="attachments" value={v} defaultChecked={current.attachments.includes(v)} className="h-4 w-4" />{l}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block max-w-md"><span className="label">It argued</span>
        <select name="argument" defaultValue={current.argument ?? ""} className="field">
          {ARG.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      {suggestions.length > 0 && (
        <label className="block max-w-xl"><span className="label">Did you use ClaimHive&apos;s suggested fix?</span>
          <select name="ruleKey" defaultValue={current.ruleKey ?? ""} className="field">
            <option value="">No</option>
            {suggestions.map((s) => <option key={s.key} value={s.key}>Yes: {s.title}</option>)}
          </select>
        </label>
      )}
      {state?.error && <p role="alert" className="text-sm font-medium text-money-lost">{state.error}</p>}

      <button type="submit" className="btn-primary" disabled={pending}>Save appeal</button>
    </form>
  );
}

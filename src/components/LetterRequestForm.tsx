"use client";
import { useActionState } from "react";
import { requestLetterAction } from "@/lib/actions/appeals";

const ATT = [["xray", "X-ray"], ["narrative", "Narrative"], ["perio_chart", "Periodontal chart"], ["photo", "Photo"]] as const;
const ARG = [
  ["", "—"], ["documentation", "Sent missing documentation"], ["medical_necessity", "Medical necessity"],
  ["coding_correction", "Coding correction / separate service"], ["frequency_exception", "Frequency exception"],
  ["coverage_dispute", "Coverage dispute"], ["other", "Other"],
] as const;

/** Start an appeal letter for a denied claim. Nothing is sent to the insurer. */
export function LetterRequestForm({ claimId, suggestions, defaultAttachment, ai }: {
  claimId: string; suggestions: { key: string; title: string; attachment?: string }[]; defaultAttachment?: string; ai: boolean;
}) {
  const [state, action, pending] = useActionState(requestLetterAction, undefined);
  return (
    <form action={action} className="card space-y-3">
      <input type="hidden" name="claimId" value={claimId} />
      <h2 className="text-lg font-bold">Draft an appeal letter</h2>
      <p className="text-sm text-stone-600">
        {ai
          ? "The AI writer sees only the insurer, procedure codes, fees and denial reasons, never the patient's name, dates or IDs. Those are filled in here afterwards."
          : "ClaimHive writes the letter from its standard wording."}
        {" "}You review, edit and approve every letter. Nothing is sent to the insurer.
      </p>
      <fieldset>
        <legend className="label">You&apos;re enclosing</legend>
        <div className="flex flex-wrap gap-4">
          {ATT.map(([v, l]) => (
            <label key={v} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="enclosures" value={v} defaultChecked={v === defaultAttachment} className="h-4 w-4" />{l}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block"><span className="label">The appeal argues</span>
          <select name="argument" defaultValue={defaultAttachment ? "documentation" : ""} className="field">
            {ARG.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        {suggestions.length > 0 && (
          <label className="block"><span className="label">Based on ClaimHive&apos;s finding</span>
            <select name="ruleKey" defaultValue={suggestions[0].key} className="field">
              <option value="">None</option>
              {suggestions.map((s) => <option key={s.key} value={s.key}>{s.title}</option>)}
            </select>
          </label>
        )}
      </div>
      <label className="block"><span className="label">Anything else the letter should say (optional)</span>
        <textarea name="notes" rows={3} maxLength={1500} className="field" placeholder="e.g. Bone loss of 5 mm is documented on the enclosed chart." />
        <span className="text-xs text-stone-500">Don&apos;t include names, dates or ID numbers here; ClaimHive stops if it finds any.</span>
      </label>
      {ai && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="useTemplate" className="h-4 w-4" />Use ClaimHive&apos;s standard letter instead of the AI writer</label>}
      {state?.error && <p role="alert" className="text-sm font-medium text-money-lost">{state.error}</p>}
      <button type="submit" className="btn-primary" disabled={pending}>{pending ? "Starting…" : "Draft the letter"}</button>
    </form>
  );
}

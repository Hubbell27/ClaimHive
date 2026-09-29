"use client";
import { useActionState } from "react";
import { confirmMappingAction } from "@/lib/actions/imports";

type Field = { key: string; label: string; required: boolean };

export function MappingForm({ batchId, fields, headers, suggested, sample }: {
  batchId: string; fields: Field[]; headers: string[]; suggested: Record<string, string | undefined>; sample: Record<string, string>[];
}) {
  const [state, action, pending] = useActionState(confirmMappingAction, undefined);
  return (
    <form action={action} className="card space-y-4">
      <input type="hidden" name="batchId" value={batchId} />
      <div>
        <h2 className="text-lg font-bold">Which column is which?</h2>
        <p className="text-sm text-stone-600">
          ClaimHive guessed where it could. Check each one, then import. You only do this once for each report layout.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) => (
          <label key={f.key} className="block">
            <span className="label">{f.label}{f.required ? " *" : ""}</span>
            <select name={`map_${f.key}`} defaultValue={suggested[f.key] ?? ""} className="field">
              <option value="">Not in this report</option>
              {headers.map((h) => <option key={h} value={h}>{h}{sample[0]?.[h] ? ` (e.g. ${String(sample[0][h]).slice(0, 24)})` : ""}</option>)}
            </select>
          </label>
        ))}
      </div>
      <p className="text-xs text-stone-500">* required. For the patient, choose either the full name column or the last name column.</p>
      {state?.error && <p role="alert" className="text-sm font-medium text-money-lost">{state.error}</p>}
      <button type="submit" className="btn-primary" disabled={pending}>{pending ? "Starting…" : "Import with these columns"}</button>
    </form>
  );
}

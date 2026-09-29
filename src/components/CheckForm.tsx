"use client";
import { useActionState, useState } from "react";
import { checkClaimAction } from "@/lib/actions/precheck";

const ATT = [["xray", "X-ray"], ["narrative", "Narrative"], ["perio_chart", "Periodontal chart"], ["photo", "Photo"]] as const;
const PLANS = [["PPO", "PPO"], ["DHMO", "DHMO"], ["INDEMNITY", "Indemnity"], ["MEDICAID", "Medicaid"], ["MEDICARE_ADVANTAGE", "Medicare Advantage"], ["UNKNOWN", "Not sure"]] as const;

/** The quick form: one claim, checked before it's sent. Nothing is sent from ClaimHive. */
export function CheckForm({ payers, today }: { payers: string[]; today: string }) {
  const [state, action, pending] = useActionState(checkClaimAction, undefined);
  const [rows, setRows] = useState(2);
  return (
    <form action={action} className="card space-y-5">
      <fieldset className="grid gap-3 sm:grid-cols-4">
        <legend className="mb-2 text-lg font-bold">Patient</legend>
        <label><span className="label">First name</span><input name="firstName" className="field" required /></label>
        <label><span className="label">Last name</span><input name="lastName" className="field" required /></label>
        <label><span className="label">Date of birth</span><input name="dob" type="date" className="field" required /></label>
        <label><span className="label">Member ID</span><input name="memberId" className="field" /></label>
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-4">
        <legend className="mb-2 text-lg font-bold">Claim</legend>
        <label className="sm:col-span-2"><span className="label">Insurer</span>
          <select name="payer" className="field" required defaultValue="">
            <option value="" disabled>Choose…</option>
            {payers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select></label>
        <label><span className="label">Plan type</span>
          <select name="planType" className="field" defaultValue="PPO">{PLANS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label><span className="label">Date of service</span><input name="serviceDate" type="date" className="field" defaultValue={today} required /></label>
        <label className="sm:col-span-2"><span className="label">Claim number (optional)</span><input name="claimNumber" className="field" /></label>
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-lg font-bold">Procedures</legend>
        <div className="space-y-2">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="grid grid-cols-4 gap-2">
              <input name={`cdt_${i}`} placeholder="CDT code (D2740)" className="field" aria-label={`Procedure ${i + 1} code`} />
              <input name={`tooth_${i}`} placeholder="Tooth" className="field" aria-label={`Procedure ${i + 1} tooth`} />
              <input name={`surf_${i}`} placeholder="Surfaces (MOD)" className="field" aria-label={`Procedure ${i + 1} surfaces`} />
              <input name={`fee_${i}`} placeholder="Fee ($)" inputMode="decimal" className="field" aria-label={`Procedure ${i + 1} fee`} />
            </div>
          ))}
        </div>
        {rows < 8 && <button type="button" className="mt-2 text-sm underline" onClick={() => setRows(rows + 1)}>+ Add a procedure</button>}
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-lg font-bold">Attachments you&apos;re sending</legend>
        <div className="flex flex-wrap gap-4">
          {ATT.map(([v, l]) => <label key={v} className="flex items-center gap-2"><input type="checkbox" name="attachments" value={v} className="h-5 w-5" />{l}</label>)}
        </div>
      </fieldset>
      {state?.error && <p role="alert" className="text-sm font-medium text-money-lost">{state.error}</p>}
      <button type="submit" className="btn-primary" disabled={pending}>{pending ? "Checking…" : "Check this claim"}</button>
    </form>
  );
}

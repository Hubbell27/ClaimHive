"use client";
import { useActionState } from "react";
import { createPracticeAction } from "@/lib/actions/admin";

export function CreatePracticeForm() {
  const [state, action, pending] = useActionState(createPracticeAction, undefined);
  return (
    <form action={action} className="card space-y-3">
      <h2 className="text-lg font-bold">Onboard a practice</h2>
      <div className="grid gap-3 sm:grid-cols-4">
        <label><span className="label">Practice name</span><input name="name" className="field" required /></label>
        <label><span className="label">State</span><input name="state" maxLength={2} placeholder="TX" className="field" required /></label>
        <label><span className="label">Owner name</span><input name="ownerName" className="field" required /></label>
        <label><span className="label">Owner email</span><input name="ownerEmail" type="email" className="field" required /></label>
      </div>
      {state?.error && <p className="text-sm text-money-lost">{state.error}</p>}
      {state?.message && <p className="text-sm text-money-saved">{state.message}</p>}
      {state?.tempPassword && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm">Owner&apos;s temporary password (shown once): <code className="text-base">{state.tempPassword}</code></p>}
      <button className="btn-primary" disabled={pending}>Create practice</button>
    </form>
  );
}

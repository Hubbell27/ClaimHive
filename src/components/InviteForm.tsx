"use client";
import { useActionState } from "react";
import { inviteMemberAction } from "@/lib/actions/practice";

export function InviteForm() {
  const [state, action, pending] = useActionState(inviteMemberAction, undefined);
  return (
    <form action={action} className="card space-y-3">
      <h2 className="text-lg font-bold">Add a team member</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <label><span className="label">Full name</span><input name="name" className="field" required /></label>
        <label><span className="label">Work email</span><input name="email" type="email" className="field" required /></label>
        <label><span className="label">Role</span>
          <select name="role" className="field"><option value="biller">Biller / office manager</option><option value="owner">Owner / dentist</option></select></label>
      </div>
      {state?.error && <p className="text-sm text-money-lost">{state.error}</p>}
      {state?.tempPassword && (
        <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm">
          Temporary password for <b>{state.email}</b> (shown once, hand it over in person): <code className="text-base">{state.tempPassword}</code>
        </p>
      )}
      {state && !state.error && !state.tempPassword && <p className="text-sm text-money-saved">Added {state.email}.</p>}
      <button className="btn-primary" disabled={pending}>Add member</button>
    </form>
  );
}

"use client";
import { useActionState } from "react";
import type { FormState } from "@/lib/actions/auth";

type Field = { name: string; label: string; type?: string; autoComplete?: string; inputMode?: "numeric"; autoFocus?: boolean };

export function AuthForm({ action, fields, submit }: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  fields: Field[];
  submit: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="space-y-4">
      {fields.map((f) => (
        <label key={f.name} className="block">
          <span className="label">{f.label}</span>
          <input className="field" name={f.name} type={f.type ?? "text"} autoComplete={f.autoComplete}
            inputMode={f.inputMode} autoFocus={f.autoFocus} required />
        </label>
      ))}
      {state?.error && <p role="alert" className="text-sm font-medium text-money-lost">{state.error}</p>}
      <button type="submit" className="btn-primary w-full" disabled={pending}>{pending ? "Please wait…" : submit}</button>
    </form>
  );
}

export function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-md">
        <p className="mb-1 text-sm font-bold tracking-wide text-brand">ClaimHive</p>
        <h1 className="mb-4 text-2xl font-bold">{title}</h1>
        {children}
      </div>
    </main>
  );
}

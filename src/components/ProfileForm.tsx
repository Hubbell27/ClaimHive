"use client";
import { useActionState } from "react";
import { updateProfileAction } from "@/lib/actions/appeals";

type Profile = Record<"letterName" | "addressLine1" | "addressLine2" | "city" | "zip" | "phone" | "fax" | "npi" | "taxId" | "signerName" | "signerTitle", string>;
const FIELDS: [keyof Profile, string, string?][] = [
  ["letterName", "Practice name on letters"], ["addressLine1", "Street address"], ["addressLine2", "Suite / unit (optional)"],
  ["city", "City"], ["zip", "ZIP code"], ["phone", "Phone"], ["fax", "Fax (optional)"],
  ["npi", "Billing NPI", "10 digits"], ["taxId", "Tax ID (optional)", "12-3456789"], ["signerName", "Letters are signed by"], ["signerTitle", "Their title (optional)"],
];

export function ProfileForm({ profile, state, practiceName }: { profile: Profile; state: string; practiceName: string }) {
  const [res, action, pending] = useActionState(updateProfileAction, undefined);
  return (
    <form action={action} className="card space-y-3">
      <h2 className="text-lg font-bold">Letterhead for appeal letters</h2>
      <p className="text-sm text-stone-600">Printed on every appeal letter and merged in on ClaimHive&apos;s servers. None of it is sent to the AI writer.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map(([k, label, ph]) => (
          <label key={k} className="block"><span className="label">{label}</span>
            <input name={k} defaultValue={profile[k]} placeholder={k === "letterName" ? practiceName : ph} className="field" />
          </label>
        ))}
        <p className="text-sm text-stone-500 sm:col-span-2">State: {state} (from the practice record)</p>
      </div>
      {res?.error && <p role="alert" className="text-sm font-medium text-money-lost">{res.error}</p>}
      {res?.saved && <p role="status" className="text-sm text-green-800">Saved.</p>}
      <button type="submit" className="btn-primary" disabled={pending}>{pending ? "Saving…" : "Save letterhead"}</button>
    </form>
  );
}

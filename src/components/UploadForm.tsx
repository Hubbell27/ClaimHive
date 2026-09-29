"use client";
import { useActionState } from "react";
import { uploadImportAction } from "@/lib/actions/imports";

export function UploadForm({ precheck }: { precheck?: boolean } = {}) {
  const [state, action, pending] = useActionState(uploadImportAction, undefined);
  return (
    <form action={action} className="card space-y-3">
      {precheck && <input type="hidden" name="purpose" value="precheck" />}
      <h2 className="text-lg font-bold">{precheck ? "Check an 837D before sending" : "Import a file"}</h2>
      <p className="text-sm text-stone-600">
        {precheck
          ? "Upload the 837D file you're about to send (from your practice software or clearinghouse). ClaimHive checks every claim and lists the fixes. Nothing is sent."
          : "Insurance aging reports (CSV or Excel) from any practice software, 835 remittances, 837D claim files, or EOB PDFs. ClaimHive works out which kind it is."}
      </p>
      <input type="file" name="file" required className="field" accept=".csv,.txt,.xlsx,.835,.837,.edi,.x12,.pdf" />
      {state?.error && <p role="alert" className="text-sm font-medium text-money-lost">{state.error}</p>}
      <button type="submit" className="btn-primary" disabled={pending}>{pending ? "Uploading…" : precheck ? "Check these claims" : "Import"}</button>
    </form>
  );
}

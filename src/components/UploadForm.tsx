"use client";
import { useActionState } from "react";
import { uploadImportAction } from "@/lib/actions/imports";

export function UploadForm() {
  const [state, action, pending] = useActionState(uploadImportAction, undefined);
  return (
    <form action={action} className="card space-y-3">
      <h2 className="text-lg font-bold">Import a file</h2>
      <p className="text-sm text-stone-600">
        Insurance aging reports (CSV or Excel) from any practice software, 835 remittances, 837D claim files, or EOB PDFs.
        ClaimHive works out which kind it is.
      </p>
      <input type="file" name="file" required className="field" accept=".csv,.txt,.xlsx,.835,.837,.edi,.x12,.pdf" />
      {state?.error && <p role="alert" className="text-sm font-medium text-money-lost">{state.error}</p>}
      <button type="submit" className="btn-primary" disabled={pending}>{pending ? "Uploading…" : "Import"}</button>
    </form>
  );
}

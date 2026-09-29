/** Plain-English labels for import kinds, statuses and problem codes. */
export const KIND_LABEL: Record<string, string> = {
  aging: "Aging report", era835: "835 remittance", claim837: "837D claims", eob_pdf: "EOB PDF", synthetic: "Synthetic data", precheck: "Entered for a check",
};
export const STATUS_LABEL: Record<string, { text: string; tone: string }> = {
  mapping_needed: { text: "Choose columns", tone: "bg-amber-100 text-amber-900" },
  queued: { text: "Waiting", tone: "bg-stone-100 text-stone-700" },
  processing: { text: "Processing", tone: "bg-stone-100 text-stone-700" },
  needs_review: { text: "Needs a check", tone: "bg-amber-100 text-amber-900" },
  done: { text: "Done", tone: "bg-green-100 text-green-900" },
  failed: { text: "Couldn't read", tone: "bg-red-100 text-red-900" },
};
export const PROBLEM_LABEL: Record<string, string> = {
  missing_patient: "No patient name",
  missing_carrier: "No insurance carrier",
  missing_service_date: "No valid date of service",
  bad_amount: "Amount isn't a number",
  unknown_procedure_code: "A procedure code isn't a CDT code",
  no_procedures: "No procedures on the claim",
  no_claims_found: "No claims found in the file",
  reversal_skipped: "Payment reversal (skipped; the corrected claim that follows is used)",
  older_than_current_remittance: "Older than a remittance already imported (kept the newer one)",
  unreadable_file: "The file couldn't be read",
  processing_error: "Something went wrong while processing; ClaimHive will retry",
};

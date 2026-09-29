/** Sample files offered on the Imports page in development (served by /api/dev/samples/[file]). */
export const SAMPLE_FILES = [
  { file: "1-claims.837", label: "Claims sent (837D)" },
  { file: "2-remittance.835", label: "Insurer payments & denials (835)" },
  { file: "3-appeal-payments.835", label: "Later payments on appealed claims (835)" },
  { file: "aging-dentrix-style.csv", label: "Aging report, Dentrix-style (CSV)" },
  { file: "aging-opendental-style.xlsx", label: "Aging report, Open Dental-style (Excel)" },
  { file: "aging-unusual-columns.csv", label: "Aging report with unusual columns (needs mapping)" },
  { file: "eob-clear.pdf", label: "EOB PDF, clear" },
  { file: "eob-hard-to-read.pdf", label: "EOB PDF, hard to read (goes to review)" },
] as const;

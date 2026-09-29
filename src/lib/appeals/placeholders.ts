/**
 * Letters are written with placeholders; patient and practice details are
 * filled in here, on ClaimHive's servers, after the text comes back.
 */
export const PLACEHOLDERS = {
  PATIENT_NAME: "the patient's full name",
  PATIENT_DOB: "the patient's date of birth",
  MEMBER_ID: "the patient's member ID",
  CLAIM_NUMBER: "the claim number",
  SERVICE_DATE: "the date of service",
  DENIAL_DATE: "the date the claim was denied",
  PRACTICE_NAME: "the dental practice's name",
  PROVIDER_NPI: "the practice's NPI",
  SIGNER_NAME: "the name of the person signing",
  SIGNER_TITLE: "that person's title",
} as const;

export type Placeholder = keyof typeof PLACEHOLDERS;
export type MergeValues = Record<Placeholder, string>;

const TOKEN = /\{\{\s*([A-Z_]+)\s*\}\}/g;

/** Placeholders in the text that ClaimHive doesn't know (the writer invented them). */
export function unknownPlaceholders(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN)].map((m) => m[1]).filter((k) => !(k in PLACEHOLDERS)))];
}

export function merge(text: string, values: MergeValues): string {
  return text.replace(TOKEN, (whole, key: string) => (key in values ? values[key as Placeholder] : whole));
}

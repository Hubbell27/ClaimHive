/**
 * Reference code subsets for development.
 *
 * LICENSING: CDT codes and their official descriptors are copyrighted by the
 * American Dental Association; production use of the descriptor text requires
 * an ADA license. The labels below are ClaimHive's own short paraphrases for
 * development only. CARC/RARC codes are maintained by X12; the descriptions
 * here are likewise short paraphrases, not the official text.
 */

export interface CdtCode {
  code: string;
  label: string;
  category: "diagnostic" | "preventive" | "restorative" | "endodontic" | "periodontic" | "prosthodontic" | "implant" | "oral_surgery" | "adjunctive";
  feeCents: [number, number]; // typical fee range for synthetic data
  tooth?: boolean;
  surfaces?: boolean;
}

export const CDT: CdtCode[] = [
  { code: "D0120", label: "Periodic exam", category: "diagnostic", feeCents: [5500, 7500] },
  { code: "D0140", label: "Limited problem-focused exam", category: "diagnostic", feeCents: [7000, 9500] },
  { code: "D0150", label: "Comprehensive exam", category: "diagnostic", feeCents: [9000, 13000] },
  { code: "D0210", label: "Full-mouth X-ray series", category: "diagnostic", feeCents: [13000, 18000] },
  { code: "D0220", label: "Single periapical X-ray", category: "diagnostic", feeCents: [2800, 4000] },
  { code: "D0274", label: "Four bitewing X-rays", category: "diagnostic", feeCents: [6500, 9000] },
  { code: "D0330", label: "Panoramic X-ray", category: "diagnostic", feeCents: [11000, 15000] },
  { code: "D1110", label: "Adult cleaning", category: "preventive", feeCents: [9500, 13500] },
  { code: "D1120", label: "Child cleaning", category: "preventive", feeCents: [6500, 9000] },
  { code: "D1206", label: "Fluoride varnish", category: "preventive", feeCents: [3500, 5500] },
  { code: "D1351", label: "Sealant, per tooth", category: "preventive", feeCents: [4500, 6500], tooth: true },
  { code: "D2140", label: "Amalgam filling, one surface", category: "restorative", feeCents: [13000, 17000], tooth: true, surfaces: true },
  { code: "D2391", label: "Composite filling, one surface, back tooth", category: "restorative", feeCents: [16000, 22000], tooth: true, surfaces: true },
  { code: "D2392", label: "Composite filling, two surfaces, back tooth", category: "restorative", feeCents: [20000, 27000], tooth: true, surfaces: true },
  { code: "D2740", label: "Ceramic crown", category: "restorative", feeCents: [110000, 155000], tooth: true },
  { code: "D2750", label: "Porcelain-fused-to-metal crown", category: "restorative", feeCents: [105000, 145000], tooth: true },
  { code: "D2950", label: "Core buildup", category: "restorative", feeCents: [22000, 32000], tooth: true },
  { code: "D3310", label: "Root canal, front tooth", category: "endodontic", feeCents: [80000, 110000], tooth: true },
  { code: "D3330", label: "Root canal, molar", category: "endodontic", feeCents: [110000, 150000], tooth: true },
  { code: "D4341", label: "Deep cleaning, 4+ teeth per quadrant", category: "periodontic", feeCents: [22000, 30000] },
  { code: "D4342", label: "Deep cleaning, 1-3 teeth per quadrant", category: "periodontic", feeCents: [16000, 22000] },
  { code: "D4910", label: "Periodontal maintenance", category: "periodontic", feeCents: [14000, 19000] },
  { code: "D5110", label: "Complete upper denture", category: "prosthodontic", feeCents: [160000, 230000] },
  { code: "D6010", label: "Implant body placement", category: "implant", feeCents: [180000, 260000], tooth: true },
  { code: "D7140", label: "Simple extraction", category: "oral_surgery", feeCents: [15000, 22000], tooth: true },
  { code: "D7210", label: "Surgical extraction", category: "oral_surgery", feeCents: [26000, 38000], tooth: true },
  { code: "D7240", label: "Impacted tooth removal, full bony", category: "oral_surgery", feeCents: [42000, 60000], tooth: true },
  { code: "D9110", label: "Palliative (emergency) treatment", category: "adjunctive", feeCents: [9000, 14000] },
  { code: "D9230", label: "Nitrous oxide", category: "adjunctive", feeCents: [6500, 9500] },
];

export const CDT_BY_CODE = new Map(CDT.map((c) => [c.code, c]));

export interface ReasonCode {
  code: string;
  label: string;
}

/** Claim Adjustment Reason Codes (subset, paraphrased). */
export const CARC: ReasonCode[] = [
  { code: "4", label: "Procedure code inconsistent with modifier or missing modifier" },
  { code: "16", label: "Claim lacks information or has submission/billing errors" },
  { code: "18", label: "Exact duplicate claim or service" },
  { code: "27", label: "Service after coverage ended" },
  { code: "29", label: "Filing deadline passed" },
  { code: "50", label: "Payer does not consider it medically necessary" },
  { code: "96", label: "Non-covered charge" },
  { code: "97", label: "Included in payment for another service (bundled)" },
  { code: "119", label: "Benefit maximum reached" },
  { code: "151", label: "Information does not support this many services (frequency)" },
  { code: "197", label: "Prior authorization absent" },
  { code: "204", label: "Not covered under the patient's current plan" },
  { code: "252", label: "An attachment or other documentation is required" },
];

/** Remittance Advice Remark Codes (subset, paraphrased). */
export const RARC: ReasonCode[] = [
  { code: "N706", label: "Missing documentation" },
  { code: "N705", label: "Incomplete or invalid documentation" },
  { code: "M127", label: "Missing patient medical/dental record for this service" },
  { code: "N130", label: "Check plan benefit documents for limits" },
  { code: "N362", label: "Number of services exceeds what the plan allows" },
  { code: "N30", label: "Patient ineligible for this service" },
  { code: "N20", label: "Service not payable with other service on the same date" },
  { code: "MA130", label: "Claim has incomplete or invalid information" },
];

export const CARC_CODES = new Set(CARC.map((c) => c.code));
export const RARC_CODES = new Set(RARC.map((c) => c.code));

export const ATTACHMENTS = ["xray", "narrative", "perio_chart", "photo"] as const;
export type Attachment = (typeof ATTACHMENTS)[number];

export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
  "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA",
  "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

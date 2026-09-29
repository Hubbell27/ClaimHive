/** Tolerant parsers for the values found in PM exports, remittances and EOBs. */
import { CDT_BY_CODE } from "../reference/codes";
import type { PlanType } from "./types";

/** "$1,234.56", "1234.5", "(12.00)", "-12" → cents. Undefined when it isn't a number. */
export function parseMoney(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 100);
  if (typeof v !== "string") return undefined;
  let s = v.trim();
  if (!s) return undefined;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$,\s]/g, "");
  if (s.startsWith("-")) { neg = !neg; s = s.slice(1); }
  if (!/^\d+(\.\d{1,2})?$|^\.\d{1,2}$/.test(s)) return undefined;
  const cents = Math.round(parseFloat(s) * 100);
  return neg ? -cents : cents;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Dates as YYYY-MM-DD from: Date objects, Excel serial numbers, ISO, MM/DD/YYYY,
 * M/D/YY, CCYYMMDD (X12). Two-digit years: <= current year's last two digits → 20xx.
 */
export function parseDate(v: unknown, now = new Date()): string | undefined {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === "number" && v > 20000 && v < 80000) {
    // Excel serial date (1900 system).
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  let y: number, m: number, d: number;
  let r: RegExpMatchArray | null;
  if ((r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [y, m, d] = [+r[1], +r[2], +r[3]];
  else if ((r = s.match(/^(\d{4})(\d{2})(\d{2})$/))) [y, m, d] = [+r[1], +r[2], +r[3]];
  else if ((r = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/))) {
    [m, d, y] = [+r[1], +r[2], +r[3]];
    if (r[3].length === 2) y += y <= now.getUTCFullYear() % 100 ? 2000 : 1900;
  } else return undefined;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return undefined; // e.g. 02/31
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** "Doe, Jane A" / "Jane Doe" / "DOE JANE" → parts. */
export function parseName(v: string): { firstName?: string; lastName: string } | undefined {
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  if (s.includes(",")) {
    const [last, rest] = s.split(",", 2).map((x) => x.trim());
    const first = rest?.split(" ")[0];
    return last ? { lastName: last, firstName: first || undefined } : undefined;
  }
  const parts = s.split(" ");
  if (parts.length === 1) return { lastName: parts[0] };
  return { firstName: parts[0], lastName: parts[parts.length - 1] };
}

/** Every CDT code in a cell like "D0120, D1110" or "D2740-#14". */
export function parseCdtCodes(v: unknown): string[] {
  if (typeof v !== "string") return [];
  return [...v.toUpperCase().matchAll(/\bD\d{4}\b/g)].map((m) => m[0]);
}

export function isKnownCdt(code: string): boolean {
  return CDT_BY_CODE.has(code);
}

/** Universal tooth numbers 1–32 or primary A–T. */
export function parseTooth(v: unknown): string | undefined {
  const s = String(v ?? "").trim().toUpperCase().replace(/^#/, "");
  if (/^([1-9]|[12]\d|3[0-2])$/.test(s)) return s;
  if (/^[A-T]$/.test(s)) return s;
  return undefined;
}

export function parseSurfaces(v: unknown): string | undefined {
  const s = String(v ?? "").toUpperCase().replace(/[^MODBLFI]/g, "");
  return s ? [...new Set(s)].join("").slice(0, 5) : undefined;
}

/** X12 claim filing indicator (SBR09 / CLP06) → plan type. */
export function planFromFilingIndicator(code: string | undefined): PlanType | undefined {
  switch ((code ?? "").toUpperCase()) {
    case "12": case "13": case "14": return "PPO";
    case "17": case "HM": return "DHMO";
    case "15": case "CI": return "INDEMNITY";
    case "MC": return "MEDICAID";
    case "16": case "MA": case "MB": return "MEDICARE_ADVANTAGE";
    case "": return undefined;
    default: return "UNKNOWN";
  }
}

/** Plan type from free text in an aging report ("PPO", "DMO", "Medicaid"...). */
export function planFromText(v: unknown): PlanType | undefined {
  const s = String(v ?? "").toUpperCase();
  if (!s.trim()) return undefined;
  if (/MEDICAID|CHIP|DENTI-?CAL/.test(s)) return "MEDICAID";
  if (/MEDICARE/.test(s)) return "MEDICARE_ADVANTAGE";
  if (/DHMO|DMO|HMO|CAPITATION/.test(s)) return "DHMO";
  if (/INDEMNITY|TRADITIONAL|FEE FOR SERVICE/.test(s)) return "INDEMNITY";
  if (/PPO|EPO|PREMIER|NETWORK/.test(s)) return "PPO";
  return "UNKNOWN";
}

/** Normalizes a header / label for matching: lower-case letters and digits only. */
export function normHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

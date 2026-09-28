/**
 * Application logging that never carries PHI.
 *
 * Rules enforced here (and tested in tests/logging.test.ts):
 *  - Only allow-listed, structured fields are logged; everything else is dropped.
 *  - String values are scrubbed of anything shaped like PHI (names are never
 *    passed in; emails, phone numbers, SSNs, dates, member IDs are masked).
 *  - Errors are logged by class and a scrubbed message only: no stack frames with
 *    arguments, no request bodies.
 */
import pino from "pino";

const ALLOWED_FIELDS = new Set([
  "event", "requestId", "route", "method", "status", "durationMs", "practiceId", "userId",
  "job", "jobId", "count", "errorClass", "errorMessage", "outcome",
]);

const PATTERNS: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]"],
  [/\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b/g, "[phone]"],
  [/\b\d{4}-\d{2}-\d{2}\b/g, "[date]"],
  [/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "[date]"],
  [/\b[A-Z]{0,3}\d{6,}\b/g, "[id]"],
];

export function scrub(value: string): string {
  let out = value;
  for (const [re, mask] of PATTERNS) out = out.replace(re, mask);
  return out.slice(0, 500);
}

type Fields = Record<string, unknown>;

function sanitize(fields: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(k)) continue;
    if (typeof v === "string") out[k] = k === "practiceId" || k === "userId" || k === "requestId" ? v : scrub(v);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

const base = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
  base: { service: "claimhive" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export const log = {
  info(fields: Fields) {
    base.info(sanitize(fields));
  },
  warn(fields: Fields) {
    base.warn(sanitize(fields));
  },
  error(fields: Fields, err?: unknown) {
    const e = err instanceof Error ? { errorClass: err.name, errorMessage: err.message } : {};
    base.error(sanitize({ ...fields, ...e }));
  },
  /** Exposed for tests: what would actually be written. */
  sanitize,
};

/** The only error text a client ever sees. */
export const GENERIC_ERROR = "Something went wrong. Please try again, or contact support with the request ID.";

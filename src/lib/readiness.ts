/**
 * Pre-real-data readiness (Phase 8). Automated checks of the running deployment,
 * plus the items a person must confirm (agreements, reviews, drills). Real
 * patient data may only be loaded once every automated check passes and every
 * manual item is signed off (docs/PILOT_CHECKLIST.md).
 */
import { prisma } from "./db";
import { isRealDeployment } from "./env";

export interface Check { key: string; title: string; ok: boolean; detail: string }

/** Tenant tables that must have row-level security forced on. */
const RLS_TABLES = ["patients", "claims", "claim_lines", "denials", "import_batches", "review_items", "result_events",
  "check_findings", "appeal_letters", "statements", "statement_lines", "billing_rates"];

export async function automatedChecks(): Promise<Check[]> {
  const env = process.env;
  const url = env.DATABASE_URL ?? "";
  const out: Check[] = [];
  const add = (key: string, title: string, ok: boolean, detail: string) => out.push({ key, title, ok, detail });

  add("env", "Running as a real deployment", isRealDeployment(), `APP_ENV=${env.APP_ENV ?? "(unset)"}; synthetic seeding and local keys are refused only in a real deployment.`);
  add("kms", "Encryption keys come from AWS KMS", env.KEY_PROVIDER === "kms" && !!env.KMS_KEY_ID && !!env.PLATFORM_KEY_WRAPPED && !env.MASTER_KEY,
    env.KEY_PROVIDER === "kms" ? (env.MASTER_KEY ? "MASTER_KEY is still set: remove it." : "KEY_PROVIDER=kms") : `KEY_PROVIDER=${env.KEY_PROVIDER ?? "local"}`);
  add("db_tls", "Database connections use TLS", /sslmode=(require|verify-ca|verify-full)/.test(url), "DATABASE_URL must include sslmode=verify-full (or require) with the RDS CA bundle.");
  add("cookies", "Session cookies are Secure", env.NODE_ENV === "production", `NODE_ENV=${env.NODE_ENV}`);

  const [{ owner }] = await prisma().$queryRaw<{ owner: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owner`;
  add("db_role", "The app connects as the restricted role", !owner, owner ? "The app's database user owns tables, so row-level security can be bypassed. Use claimhive_app." : "Connected as a non-owner role.");
  const rls = await prisma().$queryRaw<{ relname: string; forced: boolean }[]>`
    SELECT relname, relrowsecurity AND relforcerowsecurity AS forced FROM pg_class WHERE relname = ANY(${RLS_TABLES}) AND relkind = 'r'`;
  const missing = RLS_TABLES.filter((t) => !rls.find((r) => r.relname === t && r.forced));
  add("rls", "Row-level security is forced on every tenant table", missing.length === 0, missing.length ? `Missing: ${missing.join(", ")}` : `${RLS_TABLES.length} tables checked.`);
  const [{ n: audits }] = await prisma().$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_trigger WHERE tgname IN ('audit_no_update_delete', 'audit_no_truncate')`;
  add("audit", "The audit log is append-only", Number(audits) === 2, "Database triggers reject updates, deletes and truncation.");

  const synthetic = await prisma().practice.count({ where: { isSynthetic: true } });
  add("synthetic", "No synthetic data in this database", synthetic === 0, synthetic ? `${synthetic} synthetic practices: use a fresh database for real data.` : "None found.");
  const rate = await prisma().billingRate.findFirst({ where: { practiceId: null }, orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }] });
  add("rate", "A real default contingency rate is set", !!rate && rate.note !== "development default", rate ? `${rate.rateBps / 100}%${rate.note ? ` (${rate.note})` : ""}` : "Not set (Admin → Billing).");
  add("issuer", "ClaimHive's billing details are set", !!env.BILLING_ISSUER_NAME && !!env.BILLING_ISSUER_ADDRESS, "BILLING_ISSUER_NAME and BILLING_ISSUER_ADDRESS appear on statements.");
  add("ai", "AI letters only under a signed BAA", !env.ANTHROPIC_API_KEY || env.ANTHROPIC_BAA === "signed",
    env.ANTHROPIC_API_KEY ? `ANTHROPIC_BAA=${env.ANTHROPIC_BAA ?? "(unset)"}` : "No API key: ClaimHive's standard letters only.");
  return out;
}

/** Things no code can check. Each needs a named person and a date in docs/PILOT_CHECKLIST.md. */
export const MANUAL_ITEMS = [
  "AWS Business Associate Addendum accepted in AWS Artifact, and only HIPAA-eligible services used",
  "Business associate agreement signed with each pilot practice (ClaimHive is their business associate)",
  "Anthropic: BAA signed (and zero data retention enabled) before setting ANTHROPIC_BAA=signed",
  "ADA license for CDT code descriptors, or labels reviewed as ClaimHive's own paraphrases",
  "Risk analysis (HIPAA Security Rule) written and reviewed",
  "Penetration test or independent security review, findings fixed",
  "Backup restore drill done (RDS point-in-time restore into a scratch instance)",
  "Incident response and breach notification runbook, with named contacts",
  "Workforce HIPAA training for everyone with access; quarterly access review scheduled",
  "Content-Security-Policy tightened (nonce-based scripts instead of 'unsafe-inline')",
  "Terms of service and privacy notice published; pool consent text reviewed by counsel",
] as const;

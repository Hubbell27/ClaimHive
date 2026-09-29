/**
 * Audit trail: every view, edit and export of patient data, plus every sign-in,
 * permission change and admin action.
 *
 * Events are written in their own statement outside the caller's transaction,
 * so a denied or failed action is still recorded when the request rolls back.
 * The table is append-only (database trigger + revoked privileges).
 * `details` must never contain PHI: ids, counts, field names and reasons only.
 */
import { headers } from "next/headers";
import { prisma } from "./db";
import { log } from "./logger";

export type AuditAction =
  | "auth.login" | "auth.logout" | "auth.mfa" | "auth.mfa_enrolled" | "auth.password_change" | "auth.denied"
  | "phi.view" | "phi.list" | "phi.edit" | "phi.create" | "phi.export"
  | "practice.create" | "practice.switch" | "practice.pool_opt_in" | "member.invite" | "member.role_change"
  | "member.remove" | "admin.view" | "synthetic.generate" | "audit.view"
  | "import.upload" | "import.map" | "import.process" | "report.export";

export interface AuditInput {
  action: AuditAction;
  actorUserId?: string | null;
  actorEmail?: string | null;
  practiceId?: string | null;
  resourceType?: string;
  resourceId?: string;
  outcome?: "success" | "failure" | "denied";
  details?: Record<string, string | number | boolean | null | string[]>;
}

async function requestMeta() {
  try {
    const h = await headers();
    // Behind the AWS ALB the client address is the right-most X-Forwarded-For entry.
    const xff = h.get("x-forwarded-for");
    return {
      ip: xff ? xff.split(",").at(-1)!.trim().slice(0, 64) : null,
      userAgent: h.get("user-agent")?.slice(0, 300) ?? null,
      requestId: h.get("x-request-id")?.slice(0, 64) ?? null,
    };
  } catch {
    return { ip: null, userAgent: null, requestId: null }; // outside a request (worker, scripts)
  }
}

export async function audit(e: AuditInput): Promise<void> {
  const meta = await requestMeta();
  await prisma().auditEvent.create({
    data: {
      action: e.action,
      actorUserId: e.actorUserId ?? null,
      actorEmail: e.actorEmail ?? null,
      practiceId: e.practiceId ?? null,
      resourceType: e.resourceType ?? null,
      resourceId: e.resourceId ?? null,
      outcome: e.outcome ?? "success",
      details: e.details ?? {},
      ...meta,
    },
  });
  log.info({ event: "audit", outcome: e.outcome ?? "success", practiceId: e.practiceId ?? undefined, route: e.action });
}

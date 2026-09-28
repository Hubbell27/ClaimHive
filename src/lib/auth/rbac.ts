/**
 * Who may do what. Practice roles come from memberships; ClaimHive staff are
 * platform admins. Admins manage practices, the de-identified pool and billing,
 * and deliberately have NO access to any practice's PHI.
 */
import { notFound, redirect } from "next/navigation";
import { prisma } from "../db";
import type { Role } from "@/generated/prisma/enums";
import { audit } from "../audit";
import { currentSession } from "./session";

export type Permission =
  | "phi.view" | "phi.edit" | "phi.export" | "dashboard.view" | "members.manage" | "audit.view" | "pool.opt_in";

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ["phi.view", "phi.edit", "phi.export", "dashboard.view", "members.manage", "audit.view", "pool.opt_in"],
  biller: ["phi.view", "phi.edit", "phi.export", "dashboard.view"],
};

export function can(role: Role, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(perm);
}

export class AccessDenied extends Error {
  constructor(msg = "access denied") {
    super(msg);
    this.name = "AccessDenied";
  }
}

/** Signed in, MFA completed, password current. Redirects to the right step otherwise. */
export async function requireUser() {
  const s = await currentSession();
  if (!s) redirect("/login");
  if (!s.mfaVerified) redirect("/mfa");
  if (s.user.mustChangePassword) redirect("/change-password");
  return s;
}

export async function requireAdmin() {
  const s = await requireUser();
  if (!s.user.isPlatformAdmin) {
    await audit({ action: "auth.denied", actorUserId: s.user.id, actorEmail: s.user.email, outcome: "denied",
      details: { need: "platform_admin" } });
    notFound(); // don't reveal that an admin area exists
  }
  return s;
}

export interface PracticeContext {
  userId: string;
  email: string;
  sessionId: string;
  practiceId: string;
  practiceName: string;
  role: Role;
}

/** The signed-in user's active practice and role, checked against `perm`. */
export async function requirePractice(perm: Permission): Promise<PracticeContext> {
  const s = await requireUser();
  // Defense in depth: platform admins never get practice (PHI) access, even if a membership exists.
  if (s.user.isPlatformAdmin) redirect("/admin");
  if (!s.activePracticeId) redirect("/choose-practice");
  const m = await prisma().membership.findUnique({
    where: { userId_practiceId: { userId: s.userId, practiceId: s.activePracticeId } },
    include: { practice: true },
  });
  if (!m) redirect("/choose-practice");
  if (!can(m.role, perm)) {
    await audit({ action: "auth.denied", actorUserId: s.user.id, actorEmail: s.user.email, practiceId: m.practiceId,
      outcome: "denied", details: { need: perm, role: m.role } });
    redirect("/app/no-access");
  }
  return { userId: s.userId, email: s.user.email, sessionId: s.id, practiceId: m.practiceId,
    practiceName: m.practice.name, role: m.role };
}

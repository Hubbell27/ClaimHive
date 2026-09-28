"use server";
import { revalidatePath } from "next/cache";
import { audit } from "../audit";
import { requirePractice } from "../auth/rbac";
import { hashPassword, temporaryPassword } from "../auth/password";
import { revokeAllForUser } from "../auth/session";
import { prisma } from "../db";
import type { Role } from "@/generated/prisma/enums";

export type InviteState = { error?: string; tempPassword?: string; email?: string } | undefined;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function inviteMemberAction(_prev: InviteState, form: FormData): Promise<InviteState> {
  const ctx = await requirePractice("members.manage");
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const name = String(form.get("name") ?? "").trim();
  const role = String(form.get("role") ?? "biller") as Role;
  if (!EMAIL.test(email) || !name || !["owner", "biller"].includes(role)) return { error: "Enter a name, a valid email and a role." };
  let user = await prisma().user.findUnique({ where: { email } });
  if (user?.isPlatformAdmin) return { error: "That email can't be added to a practice. Use a different email." };
  let tempPassword: string | undefined;
  if (!user) {
    tempPassword = temporaryPassword();
    user = await prisma().user.create({ data: { email, name, passwordHash: await hashPassword(tempPassword), mustChangePassword: true } });
  }
  await prisma().membership.upsert({
    where: { userId_practiceId: { userId: user.id, practiceId: ctx.practiceId } },
    create: { userId: user.id, practiceId: ctx.practiceId, role },
    update: { role },
  });
  await audit({ action: "member.invite", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "user", resourceId: user.id, details: { role, newAccount: !!tempPassword } });
  revalidatePath("/app/members");
  return { tempPassword, email };
}

export async function removeMemberAction(form: FormData) {
  const ctx = await requirePractice("members.manage");
  const userId = String(form.get("userId") ?? "");
  if (userId === ctx.userId) return;
  await prisma().membership.deleteMany({ where: { userId, practiceId: ctx.practiceId } });
  await prisma().session.updateMany({ where: { userId, activePracticeId: ctx.practiceId }, data: { revokedAt: new Date() } });
  await audit({ action: "member.remove", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "user", resourceId: userId });
  revalidatePath("/app/members");
}

export async function resetMemberAction(form: FormData): Promise<void> {
  const ctx = await requirePractice("members.manage");
  const userId = String(form.get("userId") ?? "");
  const member = await prisma().membership.findUnique({ where: { userId_practiceId: { userId, practiceId: ctx.practiceId } } });
  if (!member) return;
  // A shared account (member of several practices) can only be reset by ClaimHive support,
  // so one practice's owner can never affect another practice's access.
  const memberships = await prisma().membership.count({ where: { userId } });
  if (memberships > 1) {
    await audit({ action: "auth.denied", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
      outcome: "denied", resourceType: "user", resourceId: userId, details: { reason: "shared_account_reset" } });
    return;
  }
  // Resets MFA and unlocks; the member signs in again and re-enrolls an authenticator.
  await prisma().user.update({ where: { id: userId }, data: { totpEnabled: false, totpSecretEnc: null, totpLastStep: null, failedLogins: 0, lockedUntil: null } });
  await revokeAllForUser(userId);
  await audit({ action: "member.role_change", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "user", resourceId: userId, details: { mfa_reset: true } });
  revalidatePath("/app/members");
}

export async function poolOptInAction(form: FormData) {
  const ctx = await requirePractice("pool.opt_in");
  const optIn = form.get("optIn") === "on";
  await prisma().practice.update({
    where: { id: ctx.practiceId },
    data: { poolOptIn: optIn, poolOptInAt: optIn ? new Date() : null, poolOptInBy: optIn ? ctx.userId : null },
  });
  await audit({ action: "practice.pool_opt_in", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    details: { optIn } });
  revalidatePath("/app/settings");
}

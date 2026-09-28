"use server";
/**
 * Sign-in flow: password -> authenticator code (enrolling on first sign-in)
 * -> forced password change for new accounts -> choose practice.
 * Lockout: 5 failures (password or code) lock the account for 15 minutes.
 */
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { audit } from "../audit";
import { openPlatform, sealPlatform } from "../crypto";
import { prisma } from "../db";
import { hashPassword, passwordProblem, verifyPassword } from "../auth/password";
import { createSession, currentSession, revokeAllForUser, revokeCurrent } from "../auth/session";
import { newSecret, otpauthUri, verifyCode } from "../auth/totp";

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const BAD_LOGIN = "Email or password is incorrect.";

export type FormState = { error?: string; ok?: boolean } | undefined;

async function registerFailure(userId: string) {
  // Atomic increment so parallel requests cannot bypass the lockout.
  const u = await prisma().user.update({ where: { id: userId }, data: { failedLogins: { increment: 1 } } });
  if (u.failedLogins >= MAX_FAILURES) {
    await prisma().user.update({ where: { id: userId }, data: { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MS) } });
  }
}

export async function loginAction(_prev: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const user = await prisma().user.findUnique({ where: { email } });
  const ok = await verifyPassword(password, user?.passwordHash);
  if (!user || user.disabledAt) {
    await audit({ action: "auth.login", actorEmail: email.slice(0, 200), outcome: "failure", details: { reason: "unknown_or_disabled" } });
    return { error: BAD_LOGIN };
  }
  const locked = user.lockedUntil && user.lockedUntil > new Date();
  if (!ok) {
    if (!locked) await registerFailure(user.id);
    await audit({ action: "auth.login", actorUserId: user.id, actorEmail: user.email, outcome: "failure", details: { reason: "bad_password" } });
    return { error: BAD_LOGIN };
  }
  if (locked) {
    await audit({ action: "auth.login", actorUserId: user.id, actorEmail: user.email, outcome: "denied", details: { reason: "locked" } });
    return { error: "Too many attempts. Try again in 15 minutes or ask your practice owner to reset your access." };
  }
  await createSession(user.id);
  redirect("/mfa");
}

export async function mfaSetupData(): Promise<{ qr: string; secret: string } | null> {
  const s = await currentSession();
  if (!s || s.user.totpEnabled) return null;
  let secret: string;
  if (s.user.totpSecretEnc) secret = await openPlatform(s.user.totpSecretEnc, `totp:${s.userId}`);
  else {
    secret = newSecret();
    await prisma().user.update({ where: { id: s.userId }, data: { totpSecretEnc: await sealPlatform(secret, `totp:${s.userId}`) } });
  }
  const qr = await QRCode.toDataURL(otpauthUri(secret, s.user.email), { margin: 1, width: 220 });
  return { qr, secret };
}

export async function mfaAction(_prev: FormState, form: FormData): Promise<FormState> {
  const s = await currentSession();
  if (!s) redirect("/login");
  const u = s.user;
  if (u.lockedUntil && u.lockedUntil > new Date()) return { error: "Too many attempts. Try again in 15 minutes." };
  if (!u.totpSecretEnc) return { error: "Start sign-in again." };
  const secret = await openPlatform(u.totpSecretEnc, `totp:${u.id}`);
  const step = verifyCode(secret, String(form.get("code") ?? ""), u.totpLastStep);
  if (step === null) {
    await registerFailure(u.id);
    await audit({ action: "auth.mfa", actorUserId: u.id, actorEmail: u.email, outcome: "failure" });
    return { error: "That code didn't work. Check your authenticator app and try again." };
  }
  // Claim the time step atomically: the same code can never be used twice.
  const claimed = await prisma().user.updateMany({
    where: { id: u.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: BigInt(step) } }] },
    data: { totpLastStep: BigInt(step), totpEnabled: true, failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  if (claimed.count === 0) return { error: "That code was already used. Wait for the next one." };
  await prisma().session.update({ where: { id: s.id }, data: { mfaVerified: true } });
  if (!u.totpEnabled) await audit({ action: "auth.mfa_enrolled", actorUserId: u.id, actorEmail: u.email });
  await audit({ action: "auth.login", actorUserId: u.id, actorEmail: u.email, details: { mfa: true } });
  redirect(u.mustChangePassword ? "/change-password" : "/choose-practice");
}

export async function changePasswordAction(_prev: FormState, form: FormData): Promise<FormState> {
  const s = await currentSession();
  if (!s || !s.mfaVerified) redirect("/login");
  const current = String(form.get("current") ?? "");
  const next = String(form.get("next") ?? "");
  if (next !== String(form.get("confirm") ?? "")) return { error: "The new passwords don't match." };
  if (!(await verifyPassword(current, s.user.passwordHash))) {
    await registerFailure(s.userId);
    return { error: "Current password is incorrect." };
  }
  const problem = passwordProblem(next);
  if (problem) return { error: problem };
  await prisma().user.update({ where: { id: s.userId }, data: { passwordHash: await hashPassword(next), mustChangePassword: false } });
  await revokeAllForUser(s.userId, s.id);
  await audit({ action: "auth.password_change", actorUserId: s.userId, actorEmail: s.user.email });
  redirect("/choose-practice");
}

export async function logoutAction() {
  const s = await currentSession();
  if (s) await audit({ action: "auth.logout", actorUserId: s.userId, actorEmail: s.user.email });
  await revokeCurrent();
  redirect("/login");
}

export async function choosePracticeAction(form: FormData) {
  const s = await currentSession();
  if (!s || !s.mfaVerified) redirect("/login");
  const practiceId = String(form.get("practiceId") ?? "");
  const m = await prisma().membership.findUnique({ where: { userId_practiceId: { userId: s.userId, practiceId } } });
  if (!m) {
    await audit({ action: "auth.denied", actorUserId: s.userId, actorEmail: s.user.email, outcome: "denied", details: { reason: "not_member" } });
    redirect("/choose-practice");
  }
  await prisma().session.update({ where: { id: s.id }, data: { activePracticeId: practiceId } });
  await audit({ action: "practice.switch", actorUserId: s.userId, actorEmail: s.user.email, practiceId });
  redirect("/app");
}

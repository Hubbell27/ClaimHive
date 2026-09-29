"use server";
import { isRealDeployment } from "../env";
import { revalidatePath } from "next/cache";
import { audit } from "../audit";
import { requireAdmin } from "../auth/rbac";
import { hashPassword, temporaryPassword } from "../auth/password";
import { prisma } from "../db";
import { boss, QUEUES } from "../jobs";
import { createPractice } from "../practices";
import { US_STATES } from "../reference/codes";

export type AdminState = { error?: string; message?: string; tempPassword?: string } | undefined;

export async function createPracticeAction(_prev: AdminState, form: FormData): Promise<AdminState> {
  const s = await requireAdmin();
  const name = String(form.get("name") ?? "").trim();
  const state = String(form.get("state") ?? "").trim().toUpperCase();
  const ownerEmail = String(form.get("ownerEmail") ?? "").trim().toLowerCase();
  const ownerName = String(form.get("ownerName") ?? "").trim();
  if (!name || !US_STATES.includes(state) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail) || !ownerName) {
    return { error: "Enter the practice name, a US state code, and the owner's name and email." };
  }
  let owner = await prisma().user.findUnique({ where: { email: ownerEmail } });
  if (owner?.isPlatformAdmin) return { error: "ClaimHive staff accounts can't own a practice. Use the owner's own email." };
  const practice = await createPractice({ name, state });
  let tempPassword: string | undefined;
  if (!owner) {
    tempPassword = temporaryPassword();
    owner = await prisma().user.create({ data: { email: ownerEmail, name: ownerName, passwordHash: await hashPassword(tempPassword) } });
  }
  await prisma().membership.create({ data: { userId: owner.id, practiceId: practice.id, role: "owner" } });
  await audit({ action: "practice.create", actorUserId: s.userId, actorEmail: s.user.email, practiceId: practice.id,
    details: { state, ownerNewAccount: !!tempPassword } });
  revalidatePath("/admin");
  return { message: `Created ${name}.`, tempPassword };
}

export async function generateSyntheticAction(form: FormData) {
  const s = await requireAdmin();
  const practices = Math.min(Math.max(Number(form.get("practices") ?? 8), 1), 40);
  const patientsPerPractice = Math.min(Math.max(Number(form.get("patients") ?? 150), 10), 2000);
  await (await boss()).send(QUEUES.syntheticGenerate, {
    practices, patientsPerPractice, seed: Math.floor(Math.random() * 1e9), requestedBy: s.userId,
  });
  await audit({ action: "synthetic.generate", actorUserId: s.userId, actorEmail: s.user.email,
    details: { queued: true, practices, patientsPerPractice } });
  revalidatePath("/admin");
}

/** Recompute denial rules now (normally after syncs and nightly). */
export async function rebuildRulesAction() {
  const s = await requireAdmin();
  const synthetic = !isRealDeployment();
  await (await boss()).send(QUEUES.intelRebuild, { synthetic });
  await audit({ action: "admin.view", actorUserId: s.userId, actorEmail: s.user.email, details: { action: "rules_rebuild", synthetic } });
  revalidatePath("/admin");
}

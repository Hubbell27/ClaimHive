"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "../audit";
import { requirePractice } from "../auth/rbac";
import { withPractice } from "../db";
import { GENERIC_ERROR, log } from "../logger";
import { dismissFinding, markFixed } from "../precheck/check";
import { checkEnteredClaim, EntryError } from "../precheck/entry";

export type CheckFormState = { error?: string } | undefined;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

export async function checkClaimAction(_prev: CheckFormState, form: FormData): Promise<CheckFormState> {
  const ctx = await requirePractice("phi.edit");
  const lines = [];
  for (let i = 0; i < 8; i++) {
    if (str(form, `cdt_${i}`)) lines.push({ cdt: str(form, `cdt_${i}`), tooth: str(form, `tooth_${i}`), surfaces: str(form, `surf_${i}`), fee: str(form, `fee_${i}`) });
  }
  let claimId: string;
  try {
    ({ claimId } = await checkEnteredClaim(ctx, {
      firstName: str(form, "firstName"), lastName: str(form, "lastName"), dob: str(form, "dob"), memberId: str(form, "memberId"),
      payer: str(form, "payer"), planType: str(form, "planType"), serviceDate: str(form, "serviceDate"), claimNumber: str(form, "claimNumber"),
      attachments: form.getAll("attachments").map(String), lines,
    }));
  } catch (e) {
    if (e instanceof EntryError) return { error: e.message };
    log.error({ event: "precheck.failed", practiceId: ctx.practiceId }, e);
    return { error: GENERIC_ERROR };
  }
  redirect(`/app/check/${claimId}`);
}

export async function fixFindingAction(form: FormData) {
  const ctx = await requirePractice("phi.edit");
  const claimId = await markFixed(ctx, str(form, "findingId"), { tooth: str(form, "tooth") || undefined, surfaces: str(form, "surfaces").toUpperCase() || undefined });
  revalidatePath(`/app/check/${claimId}`);
}

export async function dismissFindingAction(form: FormData) {
  const ctx = await requirePractice("phi.edit");
  const claimId = await dismissFinding(ctx, str(form, "findingId"));
  revalidatePath(`/app/check/${claimId}`);
}

/** The biller sent it from their own software (ClaimHive never sends claims). */
export async function markSentAction(form: FormData) {
  const ctx = await requirePractice("phi.edit");
  const claimId = str(form, "claimId");
  await withPractice(ctx.practiceId, (tx) => tx.claim.updateMany({ where: { id: claimId, status: "draft" }, data: { status: "submitted", submittedAt: new Date() } }));
  await audit({ action: "claim.precheck", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId, resourceType: "claim", resourceId: claimId, details: { markedSent: true } });
  revalidatePath(`/app/check/${claimId}`);
}

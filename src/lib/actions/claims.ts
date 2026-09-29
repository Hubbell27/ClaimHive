"use server";
import { revalidatePath } from "next/cache";
import { audit } from "../audit";
import { requirePractice } from "../auth/rbac";
import { withPractice } from "../db";
import { APPEAL_ARGUMENTS } from "../pool/deidentify";
import { enqueuePoolSync } from "../pool/sync";
import { ATTACHMENTS } from "../reference/codes";

export type AppealState = { error?: string; saved?: boolean } | undefined;
const STATUSES = ["none", "drafted", "sent", "won", "lost"] as const;

/** Records what an appeal included. This is the data that teaches ClaimHive which fixes win. */
export async function updateAppealAction(_prev: AppealState, form: FormData): Promise<AppealState> {
  const ctx = await requirePractice("phi.edit");
  const claimId = String(form.get("claimId") ?? "");
  const status = String(form.get("status") ?? "");
  const argument = String(form.get("argument") ?? "");
  const ruleKey = String(form.get("ruleKey") ?? "");
  const attachments = form.getAll("attachments").map(String).filter((a) => (ATTACHMENTS as readonly string[]).includes(a));
  if (!(STATUSES as readonly string[]).includes(status)) return { error: "Choose the appeal status." };
  if (argument && !(APPEAL_ARGUMENTS as readonly string[]).includes(argument)) return { error: "Choose what the appeal argued." };
  if (status !== "none" && !argument && !attachments.length) return { error: "Tick what the appeal included, or choose what it argued." };
  const updated = await withPractice(ctx.practiceId, async (tx) => {
    const c = await tx.claim.findUnique({ where: { id: claimId }, select: { id: true, appealSentAt: true } });
    if (!c) return false;
    await tx.claim.update({
      where: { id: claimId },
      data: {
        appealStatus: status as (typeof STATUSES)[number],
        appealAttachments: status === "none" ? [] : attachments,
        appealArgument: status === "none" ? null : argument || null,
        appealRuleKey: status === "none" ? null : ruleKey.slice(0, 200) || null,
        appealSentAt: status === "none" ? null : c.appealSentAt ?? (status !== "drafted" ? new Date() : null),
      },
    });
    return true;
  });
  if (!updated) return { error: "That claim wasn't found." };
  await audit({ action: "claim.appeal_update", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "claim", resourceId: claimId, details: { status, attachments, argument: argument || null, usedClaimHiveFix: !!ruleKey } });
  await enqueuePoolSync(ctx.practiceId);
  revalidatePath(`/app/claims/${claimId}`);
  return { saved: true };
}

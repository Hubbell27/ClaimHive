"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "../audit";
import { requirePractice } from "../auth/rbac";
import { prisma, withPractice } from "../db";
import { approveLetter, LetterError, markLetterSent, requestLetter, saveLetter } from "../appeals/letters";
import { GENERIC_ERROR, log } from "../logger";

export type LetterFormState = { error?: string; saved?: boolean } | undefined;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

export async function requestLetterAction(_prev: LetterFormState, form: FormData): Promise<LetterFormState> {
  const ctx = await requirePractice("phi.edit");
  let id: string;
  try {
    id = await requestLetter(ctx, str(form, "claimId"), {
      enclosures: form.getAll("enclosures").map(String), argument: str(form, "argument") || undefined,
      ruleKey: str(form, "ruleKey") || undefined, notes: str(form, "notes") || undefined, useTemplate: form.get("useTemplate") === "on",
    });
  } catch (e) {
    if (e instanceof LetterError) return { error: e.message };
    log.error({ event: "appeal.request_failed", practiceId: ctx.practiceId }, e);
    return { error: GENERIC_ERROR };
  }
  redirect(`/app/appeals/${id}`);
}

/** Try again after a failure: same choices, optionally with ClaimHive's standard letter. */
export async function retryLetterAction(form: FormData) {
  const ctx = await requirePractice("phi.edit");
  const old = await withPractice(ctx.practiceId, (tx) => tx.appealLetter.findUniqueOrThrow({ where: { id: str(form, "letterId") } }));
  const id = await requestLetter(ctx, old.claimId, {
    enclosures: old.enclosures, argument: old.argument ?? undefined, ruleKey: old.ruleKey ?? undefined, useTemplate: form.get("useTemplate") === "yes",
  });
  redirect(`/app/appeals/${id}`);
}

export async function saveLetterAction(_prev: LetterFormState, form: FormData): Promise<LetterFormState> {
  const ctx = await requirePractice("phi.edit");
  const id = str(form, "letterId");
  try {
    await saveLetter(ctx, id, { body: String(form.get("body") ?? ""), recipient: String(form.get("recipient") ?? ""), enclosures: form.getAll("enclosures").map(String) });
  } catch (e) {
    if (e instanceof LetterError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/app/appeals/${id}`);
  return { saved: true };
}

export async function approveLetterAction(_prev: LetterFormState, form: FormData): Promise<LetterFormState> {
  const ctx = await requirePractice("phi.edit");
  const id = str(form, "letterId");
  try {
    await approveLetter(ctx, id, Number(str(form, "version")));
  } catch (e) {
    if (e instanceof LetterError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/app/appeals/${id}`);
  return undefined;
}

export async function markLetterSentAction(form: FormData) {
  const ctx = await requirePractice("phi.edit");
  const id = str(form, "letterId");
  await markLetterSent(ctx, id);
  revalidatePath(`/app/appeals/${id}`);
  revalidatePath("/app/appeals");
}

/** The insurer upheld the denial. (Wins are recorded automatically when the 835 shows the payment.) */
export async function markLostAction(form: FormData) {
  const ctx = await requirePractice("phi.edit");
  const claimId = str(form, "claimId");
  await withPractice(ctx.practiceId, (tx) => tx.claim.updateMany({ where: { id: claimId, appealStatus: "sent" }, data: { appealStatus: "lost" } }));
  await audit({ action: "claim.appeal_update", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "claim", resourceId: claimId, details: { status: "lost" } });
  revalidatePath("/app/appeals");
}

const clean = (f: FormData, k: string, max = 120) => str(f, k).slice(0, max) || null;

export async function updateProfileAction(_prev: LetterFormState, form: FormData): Promise<LetterFormState> {
  const ctx = await requirePractice("members.manage");
  const npi = str(form, "npi").replace(/\D/g, "");
  const taxId = str(form, "taxId");
  const zip = str(form, "zip");
  if (npi && !validNpi(npi)) return { error: "The NPI should be 10 digits (check the number)." };
  if (taxId && !/^\d{2}-?\d{7}$/.test(taxId)) return { error: "The tax ID should look like 12-3456789." };
  if (zip && !/^\d{5}(-\d{4})?$/.test(zip)) return { error: "Enter a 5-digit ZIP code." };
  await prisma().practice.update({ where: { id: ctx.practiceId }, data: {
    letterName: clean(form, "letterName"), addressLine1: clean(form, "addressLine1"), addressLine2: clean(form, "addressLine2"),
    city: clean(form, "city", 60), zip: zip || null, phone: clean(form, "phone", 20), fax: clean(form, "fax", 20),
    npi: npi || null, taxId: taxId || null, signerName: clean(form, "signerName"), signerTitle: clean(form, "signerTitle"),
  } });
  await audit({ action: "practice.profile_update", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId, resourceType: "practice", resourceId: ctx.practiceId });
  revalidatePath("/app/settings");
  return { saved: true };
}

/** NPI check digit (Luhn over "80840" + the first 9 digits). */
function validNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = `80840${npi.slice(0, 9)}`.split("").map(Number);
  let sum = 0;
  for (let i = digits.length - 1, dbl = true; i >= 0; i--, dbl = !dbl) {
    let d = digits[i];
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(npi[9]);
}

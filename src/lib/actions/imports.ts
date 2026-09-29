"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePractice } from "../auth/rbac";
import { AGING_FIELDS, type AgingMapping } from "../ingest/aging";
import { acceptReview, confirmMapping, createImport, dismissReview, ImportError, reviewDetail } from "../ingest/pipeline";
import type { NormalizedClaim, NormalizedDenial } from "../ingest/types";
import { parseDate, parseMoney } from "../ingest/values";
import { GENERIC_ERROR, log } from "../logger";

export type FormState = { error?: string } | undefined;

export async function uploadImportAction(_prev: FormState, form: FormData): Promise<FormState> {
  const ctx = await requirePractice("phi.edit");
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) return { error: "Choose a file to import." };
  let batchId: string;
  try {
    ({ batchId } = await createImport(ctx, file.name, new Uint8Array(await file.arrayBuffer())));
  } catch (e) {
    if (e instanceof ImportError) return { error: e.message };
    log.error({ event: "import.upload_failed", practiceId: ctx.practiceId }, e);
    return { error: GENERIC_ERROR };
  }
  revalidatePath("/app/imports");
  redirect(`/app/imports/${batchId}`);
}

export async function confirmMappingAction(_prev: FormState, form: FormData): Promise<FormState> {
  const ctx = await requirePractice("phi.edit");
  const batchId = String(form.get("batchId") ?? "");
  const mapping: AgingMapping = {};
  for (const f of AGING_FIELDS) {
    const v = String(form.get(`map_${f.key}`) ?? "");
    if (v) mapping[f.key] = v;
  }
  const problem = await confirmMapping(ctx, batchId, mapping);
  if (problem) return { error: problem };
  revalidatePath(`/app/imports/${batchId}`);
  redirect(`/app/imports/${batchId}`);
}

const str = (form: FormData, k: string) => String(form.get(k) ?? "").trim();

/** Rebuilds the reviewed claim from the form, starting from the extracted one. */
export async function resolveReviewAction(_prev: FormState, form: FormData): Promise<FormState> {
  const ctx = await requirePractice("phi.edit");
  const id = str(form, "reviewId");
  if (form.get("decision") === "dismiss") {
    await dismissReview(ctx, id);
    revalidatePath("/app/review");
    redirect("/app/review");
  }
  const { item, payload } = await reviewDetail(ctx, id);
  if (item.status !== "open") return { error: "This item was already reviewed." };
  const c: NormalizedClaim = structuredClone(payload.claim);
  c.patient.lastName = str(form, "lastName");
  c.patient.firstName = str(form, "firstName") || undefined;
  c.patient.memberId = str(form, "memberId") || undefined;
  c.claimNumber = str(form, "claimNumber") || undefined;
  c.payer.name = str(form, "payer");
  c.serviceDate = parseDate(str(form, "serviceDate"));
  const paid = parseMoney(str(form, "paid"));
  if (!c.patient.lastName || !c.payer.name || !c.serviceDate || paid === undefined) {
    return { error: "Enter the patient's last name, the insurer, the date of service and the amount paid." };
  }
  c.lines = c.lines.map((l, i) => {
    const fee = parseMoney(str(form, `fee_${i}`));
    const linePaid = parseMoney(str(form, `paid_${i}`));
    const codes = str(form, `reason_${i}`).toUpperCase().match(/\b(CO|PR|OA|PI)[\s-]?(\d{1,3})\b/g) ?? [];
    const denials: NormalizedDenial[] = codes.map((code) => {
      const m = code.match(/(CO|PR|OA|PI)[\s-]?(\d{1,3})/)!;
      return { groupCode: m[1], carc: m[2], amountCents: Math.max(0, (fee ?? 0) - (linePaid ?? 0)) };
    });
    return { ...l, feeCents: fee ?? l.feeCents, paidCents: linePaid ?? l.paidCents, denials };
  });
  c.paidCents = paid;
  const denied = c.lines.some((l) => l.denials.length);
  c.status = denied ? (paid > 0 ? "partially_paid" : "denied") : "paid";
  try {
    await acceptReview(ctx, id, c);
  } catch (e) {
    if (e instanceof ImportError) return { error: e.message };
    throw e;
  }
  revalidatePath("/app/review");
  redirect("/app/review");
}

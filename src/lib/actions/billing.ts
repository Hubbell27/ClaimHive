"use server";
import { redirect } from "next/navigation";
import { requireAdmin } from "../auth/rbac";
import { BillingError, buildAllDrafts, buildDraft, issueStatement, monthKey, parseMonth, setRate } from "../billing/statements";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const UUID = /^[0-9a-f-]{36}$/i;
const back = (month: string, msg: string, path = "/admin/billing") => redirect(`${path}?month=${month}&msg=${encodeURIComponent(msg)}`);

/** Rate changes: ClaimHive staff only. practiceId empty = the default rate. */
export async function setRateAction(form: FormData) {
  const s = await requireAdmin();
  const month = str(form, "month");
  const pct = Number(str(form, "rate").replace("%", ""));
  const from = new Date(`${str(form, "effectiveFrom")}T00:00:00Z`);
  const practiceId = str(form, "practiceId") || null;
  if (practiceId && !UUID.test(practiceId)) back(month, "Unknown practice.");
  if (!Number.isFinite(pct) || isNaN(from.getTime())) back(month, "Enter a rate (e.g. 20) and the date it starts.");
  try {
    await setRate({ userId: s.userId, email: s.user.email }, { practiceId, rateBps: Math.round(pct * 100), effectiveFrom: from, note: str(form, "note") });
  } catch (e) {
    if (e instanceof BillingError) back(month, e.message);
    throw e;
  }
  back(month, practiceId ? "Practice rate saved." : "Default rate saved.");
}

export async function buildDraftsAction(form: FormData) {
  const s = await requireAdmin();
  const m = parseMonth(str(form, "month"));
  if (!m) back("", "Choose a month.");
  const r = await buildAllDrafts(m!, { userId: s.userId, email: s.user.email });
  back(monthKey(m!), `Drafts built: ${r.built}. Nothing to bill: ${r.empty}. Already issued: ${r.issued}.${r.failed.length ? ` Failed: ${r.failed.length} (is a default rate set?)` : ""}`);
}

export async function rebuildDraftAction(form: FormData) {
  const s = await requireAdmin();
  const practiceId = str(form, "practiceId");
  const m = parseMonth(str(form, "month"));
  if (!UUID.test(practiceId) || !m) back("", "Unknown statement.");
  let id: string | undefined;
  try {
    id = (await buildDraft(practiceId, m!, { userId: s.userId, email: s.user.email }))?.id;
  } catch (e) {
    if (e instanceof BillingError) back(monthKey(m!), e.message);
    throw e;
  }
  if (!id) back(monthKey(m!), "Nothing left to bill for that practice; the draft was removed.");
  redirect(`/admin/billing/${practiceId}/${id}?msg=${encodeURIComponent("Draft rebuilt.")}`);
}

export async function issueStatementAction(form: FormData) {
  const s = await requireAdmin();
  const practiceId = str(form, "practiceId"), statementId = str(form, "statementId");
  if (!UUID.test(practiceId) || !UUID.test(statementId)) back("", "Unknown statement.");
  let msg = "Issued. The practice can now see and download it.";
  try {
    await issueStatement({ userId: s.userId, email: s.user.email }, practiceId, statementId, str(form, "seen"));
  } catch (e) {
    if (!(e instanceof BillingError)) throw e;
    msg = e.message;
  }
  redirect(`/admin/billing/${practiceId}/${statementId}?msg=${encodeURIComponent(msg)}`);
}

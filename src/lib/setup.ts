/**
 * Guided setup for a new practice (Phase 8). ClaimHive staff create the practice
 * and invite the owner; the owner then works through these steps. Progress is
 * worked out from what's actually been done (no separate checklist to keep in sync).
 */
import { profileGaps } from "./appeals/letters";
import { prisma, withPractice } from "./db";

export interface SetupStep { key: string; title: string; detail: string; href: string; done: boolean; optional: boolean; skipped: boolean }

export async function setupSteps(practiceId: string): Promise<{ steps: SetupStep[]; left: number; complete: boolean }> {
  const p = await prisma().practice.findUniqueOrThrow({ where: { id: practiceId }, include: { _count: { select: { memberships: true } } } });
  const imports = await withPractice(practiceId, (tx) => tx.importBatch.groupBy({ by: ["kind"], where: { status: { in: ["done", "needs_review"] }, purpose: "record" }, _count: true }));
  const has = (k: string) => imports.some((i) => i.kind === k);
  const steps: Omit<SetupStep, "skipped">[] = [
    { key: "account", title: "Secure your account", detail: "Password changed and two-step sign-in (authenticator app) turned on.", href: "/app", done: true, optional: false },
    { key: "pool", title: "Decide about sharing", detail: "Choose whether to share de-identified denial data. Sharing unlocks ClaimHive's pooled rules.", href: "/app/settings", done: !!p.poolDecidedAt, optional: false },
    { key: "letterhead", title: "Add your letterhead", detail: "Address, phone, NPI and who signs appeal letters.", href: "/app/settings", done: profileGaps(p).length === 0, optional: false },
    { key: "team", title: "Invite your billers", detail: "Everyone gets their own login; no shared passwords.", href: "/app/members", done: p._count.memberships > 1, optional: true },
    { key: "aging", title: "Import 12 months of insurance aging", detail: "Export the insurance aging report from your practice software (CSV or Excel) and upload it.", href: "/app/imports", done: has("aging"), optional: false },
    { key: "era835", title: "Import your 835 remittances", detail: "Download the last 12 months of 835 files from your clearinghouse. They carry the denial reasons.", href: "/app/imports", done: has("era835"), optional: false },
    { key: "claim837", title: "Import your 837 claim files", detail: "Optional but useful: they show what was sent, including attachments.", href: "/app/imports", done: has("claim837"), optional: true },
    { key: "report", title: "Open your \"money left on the table\" report", detail: "What's still recoverable from the last 12 months, and which denials a check before sending would have prevented.", href: "/app/report", done: !!p.reportViewedAt, optional: false },
  ];
  const out = steps.map((s) => ({ ...s, skipped: !s.done && s.optional && p.setupSkipped.includes(s.key) }));
  const left = out.filter((s) => !s.done && !s.skipped).length;
  return { steps: out, left, complete: left === 0 };
}

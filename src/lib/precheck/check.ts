/**
 * Pre-submission claim check (Phase 5).
 *
 * For each procedure line, the risk comes from:
 *   - pooled rules that match the claim (practices that share only), at the rule's measured rate;
 *   - the insurer's typical denial rate for that procedure (pool, practices that share only);
 *   - basic checks (everyone): missing tooth/surfaces, duplicates, filing deadline,
 *     typical frequency limits from the practice's own history.
 * Independent risks combine as 1 − Π(1 − p). "At risk" is the expected loss: fee × line risk.
 *
 * Findings are kept per claim. Re-running the check (after a fix, or when a later
 * 837/835 arrives) closes open findings whose problem is gone ("fixed_detected"),
 * never re-opens ones the biller fixed or dismissed, and adds new ones.
 * When a claim with a fixed finding is paid, the paid amount on those lines is
 * credited to the results ledger as "protected" (shown, never billed).
 */
import { audit } from "../audit";
import type { PracticeContext } from "../auth/rbac";
import { prisma, withPractice } from "../db";
import { listRules } from "../intel/engine";
import { explainRule, pct, range } from "../intel/explain";
import { ruleApplies } from "../intel/match";
import { frequencyOf } from "../pool/sync";
import { denialRatesByPayerCode } from "../pool/store";
import { recordResults, type ResultInput } from "../results/ledger";
import { basicChecks, combine } from "./basic";

type Actor = Pick<PracticeContext, "practiceId" | "userId" | "email">;

export interface CheckResult {
  claimId: string;
  risk: number;
  atRiskCents: number;
  billedCents: number;
  lines: { id: string; cdtCode: string; feeCents: number; risk: number; typicalRate?: number }[];
  pooled: boolean; // pooled rules were used (the practice shares)
}

interface Computed {
  key: string; lineId: string; kind: string; source: "pool" | "basic"; ruleKey?: string; cdtCode: string;
  fixType: "attachment" | "code" | "data" | "verify"; attachment?: string; title: string; detail: string; fix: string; probability: number;
}

const findingKey = (f: { kind: string; cdtCode: string; ruleKey?: string | null; attachment?: string | null }) =>
  `${f.kind}|${f.cdtCode}|${f.ruleKey ?? ""}|${f.attachment ?? ""}`;

export async function runCheck(practiceId: string, claimId: string, now = new Date()): Promise<CheckResult> {
  const practice = await prisma().practice.findUniqueOrThrow({ where: { id: practiceId }, select: { poolOptIn: true, isSynthetic: true } });
  const claim = await withPractice(practiceId, (tx) => tx.claim.findUniqueOrThrow({
    where: { id: claimId }, include: { lines: true, payer: { select: { name: true } }, findings: true },
  }));
  const computed: Computed[] = [];

  // Basic checks (everyone).
  const history = await withPractice(practiceId, (tx) => tx.claim.findMany({
    where: { patientId: claim.patientId, id: { not: claim.id }, status: { not: "draft" } },
    select: { id: true, serviceDate: true, status: true, lines: { select: { cdtCode: true, tooth: true } } },
  }));
  const items = history.flatMap((h) => h.lines.map((l) => ({ claimId: h.id, serviceDate: h.serviceDate, cdtCode: l.cdtCode, tooth: l.tooth, status: h.status })));
  for (const b of basicChecks(claim, items, now)) {
    const line = claim.lines.find((l) => l.id === b.lineId)!;
    computed.push({ key: "", lineId: b.lineId, kind: b.kind, source: "basic", cdtCode: line.cdtCode, fixType: b.fixType,
      title: b.title, detail: b.detail, fix: b.fix, probability: b.probability });
  }

  // Pooled rules and typical rates (practices that share).
  const typical = new Map<string, number>();
  const liveRules = new Set<string>();
  const safeSide = new Map<string, number>();
  if (practice.poolOptIn) {
    const rules = await listRules({ synthetic: practice.isSynthetic, payers: [claim.payer.name] });
    for (const r of rules) liveRules.add(r.key);
    const freq = await withPractice(practiceId, (tx) => frequencyOf(tx, [claim]));
    for (const r of rules) {
      if (!ruleApplies(r, claim, freq)) {
        // The claim is on the rule's safe side (e.g. the attachment is there): that measured
        // rate is a better estimate for these lines than the insurer's overall rate. With several
        // such rules, the lowest wins: a looser rule's safe side (e.g. "fewer than 3 this year")
        // still includes the claims that break the stricter one (no perio chart).
        if (r.stats.base && claim.lines.some((l) => l.cdtCode === r.cdt) && (!r.planType || r.planType === claim.planType)
          && r.payer === claim.payer.name) {
          const prev = safeSide.get(r.cdt);
          safeSide.set(r.cdt, prev === undefined ? r.stats.base.rate : Math.min(prev, r.stats.base.rate));
        }
        continue;
      }
      const t = explainRule(r);
      const s = r.stats;
      const fixType = r.kind === "missing_attachment" ? "attachment" : r.kind === "billed_with" ? "code" : "verify";
      for (const l of claim.lines.filter((x) => x.cdtCode === r.cdt)) {
        // A pooled frequency rule replaces the typical-limit guess for the same line.
        if (r.kind === "frequency") {
          const i = computed.findIndex((c) => c.lineId === l.id && c.kind === "frequency" && c.source === "basic");
          if (i >= 0) computed.splice(i, 1);
        }
        computed.push({ key: "", lineId: l.id, kind: "pool_rule", source: "pool", ruleKey: r.key, cdtCode: r.cdt, fixType,
          attachment: s.condition.attachment, title: t.title, fix: t.fix,
          detail: `${t.headline} Evidence: ${s.cond.n} procedures from ${s.cond.practices} practices, 95% range ${range(s.cond)}.${t.appeal ? ` ${t.appeal}` : ""}`,
          probability: s.cond.rate });
      }
    }
    const rates = await denialRatesByPayerCode({ synthetic: practice.isSynthetic, payers: [claim.payer.name], cdts: [...new Set(claim.lines.map((l) => l.cdtCode))], limit: 100 });
    for (const x of rates) typical.set(x.cdt, x.rate);
    for (const [cdt, rate] of safeSide) typical.set(cdt, rate);
  }
  for (const c of computed) c.key = findingKey(c);

  // Score.
  const lines = claim.lines.map((l) => {
    const ps = computed.filter((c) => c.lineId === l.id).map((c) => c.probability);
    const base = typical.get(l.cdtCode);
    // The typical rate already includes claims that break these rules, so it's only used when no finding applies.
    const risk = ps.length ? combine(ps) : base ?? 0;
    return { id: l.id, cdtCode: l.cdtCode, feeCents: l.feeCents, risk, typicalRate: base };
  });
  const atRiskCents = Math.round(lines.reduce((s, l) => s + l.feeCents * l.risk, 0));
  const risk = combine(lines.map((l) => l.risk));

  // Persist: close open findings that no longer apply, keep fixed/dismissed ones, add new ones.
  await withPractice(practiceId, async (tx) => {
    const byKey = new Map(claim.findings.map((f) => [findingKey(f), f]));
    const nowKeys = new Set(computed.map((c) => c.key));
    for (const f of claim.findings) {
      if (f.status === "open" && !nowKeys.has(findingKey(f))) {
        // The problem is gone: fixed. But if a pooled rule itself no longer exists (rules are
        // rebuilt as data grows), close the finding without counting it as a fix.
        const ruleGone = f.source === "pool" && !liveRules.has(f.ruleKey ?? "");
        await tx.checkFinding.update({ where: { id: f.id }, data: { status: ruleGone ? "dismissed" : "fixed_detected", fixedAt: now } });
      }
    }
    // One finding per problem, even when it affects several lines (e.g. two quadrants of D4341).
    const grouped = new Map<string, Computed & { fee: number }>();
    for (const c of computed) {
      const fee = claim.lines.find((l) => l.id === c.lineId)!.feeCents;
      const g = grouped.get(c.key);
      if (g) g.fee += fee; else grouped.set(c.key, { ...c, fee });
    }
    for (const c of grouped.values()) {
      const existing = byKey.get(c.key);
      const data = { title: c.title, detail: c.detail, fix: c.fix, probability: c.probability, atRiskCents: Math.round(c.fee * c.probability) };
      if (!existing) {
        await tx.checkFinding.create({ data: { practiceId, claimId, kind: c.kind, source: c.source, ruleKey: c.ruleKey ?? null, cdtCode: c.cdtCode,
          fixType: c.fixType, attachment: c.attachment ?? null, ...data } });
      } else if (existing.status === "open") {
        await tx.checkFinding.update({ where: { id: existing.id }, data });
      }
    }
    // Raw SQL keeps updated_at unchanged (it drives the pool sync).
    await tx.$executeRaw`UPDATE claims SET risk_score = ${risk}, at_risk_cents = ${atRiskCents}, prechecked_at = ${now} WHERE id = ${claimId}::uuid`;
  });
  return { claimId, risk, atRiskCents, billedCents: claim.billedCents, lines, pooled: practice.poolOptIn };
}

/** The biller fixed it. An attachment fix also records the attachment on the claim. */
export async function markFixed(ctx: Actor, findingId: string, extra: { tooth?: string; surfaces?: string } = {}): Promise<string> {
  const claimId = await withPractice(ctx.practiceId, async (tx) => {
    const f = await tx.checkFinding.findUniqueOrThrow({ where: { id: findingId } });
    await tx.checkFinding.update({ where: { id: f.id }, data: { status: "fixed_by_user", fixedAt: new Date(), fixedBy: ctx.userId } });
    const claim = await tx.claim.findUniqueOrThrow({ where: { id: f.claimId }, include: { lines: true } });
    if (f.fixType === "attachment" && f.attachment && !claim.attachments.includes(f.attachment)) {
      await tx.claim.update({ where: { id: claim.id }, data: { attachments: [...claim.attachments, f.attachment] } });
    }
    if (f.fixType === "data" && (extra.tooth || extra.surfaces)) {
      for (const l of claim.lines.filter((x) => x.cdtCode === f.cdtCode && (!x.tooth || !x.surfaces))) {
        await tx.claimLine.update({ where: { id: l.id }, data: { tooth: l.tooth ?? extra.tooth ?? null, surfaces: l.surfaces ?? extra.surfaces ?? null } });
      }
    }
    return claim.id;
  });
  await audit({ action: "claim.precheck_fix", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "check_finding", resourceId: findingId });
  await runCheck(ctx.practiceId, claimId);
  return claimId;
}

export async function dismissFinding(ctx: Actor, findingId: string): Promise<string> {
  const f = await withPractice(ctx.practiceId, (tx) => tx.checkFinding.update({ where: { id: findingId }, data: { status: "dismissed", fixedBy: ctx.userId, fixedAt: new Date() } }));
  await audit({ action: "claim.precheck_fix", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "check_finding", resourceId: findingId, details: { dismissed: true } });
  await runCheck(ctx.practiceId, f.claimId);
  return f.claimId;
}

/**
 * After an import: re-check claims that have findings (auto-detects fixes from a
 * resubmitted 837), and credit "protected" money for fixed claims that got paid.
 */
export async function afterImport(practiceId: string, claimIds: string[], batchId?: string): Promise<void> {
  if (!claimIds.length) return;
  const claims = await withPractice(practiceId, (tx) => tx.claim.findMany({
    where: { id: { in: claimIds }, findings: { some: {} } },
    include: { findings: true, lines: true, payer: { select: { name: true } } },
  }));
  const credits: ResultInput[] = [];
  for (const c of claims) {
    if (c.findings.some((f) => f.status === "open")) await runCheck(practiceId, c.id);
    if (c.status !== "paid" && c.status !== "partially_paid") continue;
    const fixed = (await withPractice(practiceId, (tx) => tx.checkFinding.findMany({
      where: { claimId: c.id, status: { in: ["fixed_by_user", "fixed_detected"] }, fixType: { in: ["attachment", "code", "data"] } },
    })));
    for (const method of ["attachment_added_before_sending", "code_fixed_before_sending"] as const) {
      const fs = fixed.filter((f) => (method === "attachment_added_before_sending") === (f.fixType === "attachment"));
      if (!fs.length) continue;
      const codes = [...new Set(fs.map((f) => f.cdtCode))];
      const paid = c.lines.filter((l) => codes.includes(l.cdtCode)).reduce((s, l) => s + l.paidCents, 0);
      credits.push({
        practiceId, claimId: c.id, kind: "protected", amountCents: paid, attributed: true, method,
        evidence: { payer: c.payer.name, cdtCodes: codes, attachment: fs.find((f) => f.attachment)?.attachment as never, ruleId: fs.find((f) => f.ruleKey)?.ruleKey ?? undefined },
        occurredAt: c.adjudicatedAt ?? new Date(), sourceBatchId: batchId, isSynthetic: c.isSynthetic,
      });
    }
  }
  if (credits.length) await withPractice(practiceId, (tx) => recordResults(tx, credits));
}

export function riskLevel(risk: number): { label: string; tone: string } {
  if (risk >= 0.5) return { label: "High risk", tone: "bg-red-100 text-red-900" };
  if (risk >= 0.2) return { label: "Some risk", tone: "bg-amber-100 text-amber-900" };
  return { label: "Low risk", tone: "bg-green-100 text-green-900" };
}

export { pct };

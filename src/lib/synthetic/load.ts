/** Persist a synthetic dataset. Refuses to write into non-synthetic practices. */
import { randomUUID } from "node:crypto";
import { isRealDeployment } from "../env";
import { prisma, withPractice } from "../db";
import { createPractice, keysFor } from "../practices";
import { explain, type Evidence, type Method } from "../results/ledger";
import { generateDataset, HIDDEN_RULES, SYNTHETIC_PAYERS, type GenClaim, type GenerateOptions } from "./generator";

const DAY = 86_400_000;

/**
 * Demo ledger rows for synthetic practices. In real use these come from Phase 5
 * (pre-submission fixes) and Phase 6 (ClaimHive appeals); here they show what the
 * results page and monthly report will look like. Always marked is_synthetic.
 */
function demoResults(c: GenClaim, practiceId: string, claimId: string, now: number) {
  const payer = SYNTHETIC_PAYERS.find((p) => p.payerCode === c.payerCode)!.name;
  const out: object[] = [];
  const add = (kind: "recovered" | "protected", method: Method, amountCents: number, evidence: Evidence, at: Date) => {
    if (amountCents > 0) out.push({ practiceId, claimId, kind, amountCents, attributed: true, method, explanation: explain(method, evidence),
      evidence, occurredAt: at, isSynthetic: true });
  };
  if (c.appealStatus === "won" && c.denials.length) {
    const rule = HIDDEN_RULES.find((r) => r.id === c.appealRuleId);
    const d = c.denials[0];
    const method: Method = rule?.attachment && c.appealWithFix ? "appeal_with_attachment" : "appeal_with_argument";
    add("recovered", method, c.recoveredCents, {
      payer, cdtCodes: [...new Set(c.denials.map((x) => c.lines[x.lineIndex].cdtCode))], carc: d.carc, rarc: d.rarc,
      attachment: method === "appeal_with_attachment" ? rule?.attachment : undefined, ruleId: rule?.id,
    }, new Date(Math.min(now, c.adjudicatedAt.getTime() + 45 * DAY)));
  }
  if (c.protectedRuleId) {
    const rule = HIDDEN_RULES.find((r) => r.id === c.protectedRuleId)!;
    const cents = c.lines.filter((l) => l.cdtCode === rule.cdt).reduce((s, l) => s + l.paidCents, 0);
    add("protected", "attachment_added_before_sending", cents, { payer, cdtCodes: [rule.cdt], attachment: rule.attachment, ruleId: rule.id }, c.adjudicatedAt);
  }
  return out;
}

export interface LoadResult {
  practices: { id: string; name: string; state: string }[];
  patients: number;
  claims: number;
  denials: number;
}

export async function ensureSyntheticPayers(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const p of SYNTHETIC_PAYERS) {
    const row = await prisma().payer.upsert({
      where: { payerCode: p.payerCode },
      create: { name: p.name, payerCode: p.payerCode, isSynthetic: true, verified: true },
      update: { verified: true },
    });
    ids.set(p.payerCode, row.id);
  }
  return ids;
}

export async function loadSyntheticDataset(opts: GenerateOptions = {}): Promise<LoadResult> {
  if (isRealDeployment()) throw new Error("synthetic data is disabled in a real deployment");
  const data = generateDataset(opts);
  const payerIds = await ensureSyntheticPayers();
  const result: LoadResult = { practices: [], patients: 0, claims: 0, denials: 0 };

  for (const gp of data) {
    const practice = await createPractice({ name: gp.name, state: gp.state, isSynthetic: true });
    const keys = await keysFor(practice.id);
    result.practices.push({ id: practice.id, name: practice.name, state: practice.state });

    const patients: object[] = [];
    const claims: object[] = [];
    const lines: object[] = [];
    const denials: object[] = [];
    const results: object[] = [];
    const now = (opts.endDate ?? new Date()).getTime();
    for (const pt of gp.patients) {
      const patientId = randomUUID();
      patients.push({
        id: patientId, practiceId: practice.id,
        firstNameEnc: keys.encrypt("patients", "first_name", patientId, pt.firstName),
        lastNameEnc: keys.encrypt("patients", "last_name", patientId, pt.lastName),
        dobEnc: keys.encrypt("patients", "dob", patientId, pt.dob),
        memberIdEnc: keys.encrypt("patients", "member_id", patientId, pt.memberId),
        lookupIndex: keys.lookupIndex(pt.lastName, pt.dob),
        memberLookup: keys.lookupIndex(pt.memberId, pt.lastName),
      });
      for (const c of pt.claims) {
        const claimId = randomUUID();
        const billed = c.lines.reduce((s, l) => s + l.feeCents, 0);
        claims.push({
          id: claimId, practiceId: practice.id, patientId, payerId: payerIds.get(c.payerCode)!, planType: c.planType,
          claimNumberEnc: keys.encrypt("claims", "claim_number", claimId, c.claimNumber),
          claimKey: keys.lookupIndex("claim", c.claimNumber), sources: ["synthetic"],
          serviceDate: c.serviceDate, submittedAt: c.submittedAt, adjudicatedAt: c.adjudicatedAt, status: c.status,
          billedCents: billed, paidCents: c.lines.reduce((s, l) => s + l.paidCents, 0), attachments: c.attachments,
          appealStatus: c.appealStatus, recoveredCents: c.recoveredCents, isSynthetic: true,
        });
        const lineIds = c.lines.map(() => randomUUID());
        c.lines.forEach((l, i) => lines.push({
          id: lineIds[i], practiceId: practice.id, claimId, cdtCode: l.cdtCode, tooth: l.tooth ?? null,
          surfaces: l.surfaces ?? null, feeCents: l.feeCents, paidCents: l.paidCents,
        }));
        results.push(...demoResults(c, practice.id, claimId, now));
        c.denials.forEach((d) => denials.push({
          practiceId: practice.id, claimId, claimLineId: lineIds[d.lineIndex], groupCode: d.groupCode, carc: d.carc,
          rarc: d.rarc ?? null, amountCents: d.amountCents, deniedAt: c.adjudicatedAt,
        }));
      }
    }
    await withPractice(practice.id, async (tx) => {
      await tx.patient.createMany({ data: patients as never });
      await tx.claim.createMany({ data: claims as never });
      await tx.claimLine.createMany({ data: lines as never });
      await tx.denial.createMany({ data: denials as never });
      await tx.resultEvent.createMany({ data: results as never });
    });
    result.patients += patients.length;
    result.claims += claims.length;
    result.denials += denials.length;
  }
  return result;
}

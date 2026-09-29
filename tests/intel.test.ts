import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, withPractice } from "@/lib/db";
import { findRules, listRules, rebuildRules, type Rule } from "@/lib/intel/engine";
import { explainRule } from "@/lib/intel/explain";
import { matchClaims } from "@/lib/intel/match";
import { newcombe, RULE_BAR, wilson } from "@/lib/intel/stats";
import { mergeClaims } from "@/lib/ingest/merge";
import { boss } from "@/lib/jobs";
import { keysFor } from "@/lib/practices";
import { POOL_CONSENT_VERSION } from "@/lib/pool/deidentify";
import { poolDb } from "@/lib/pool/store";
import { answerConsentUpdate, decidePool, needsConsentUpdate, syncPractice } from "@/lib/pool/sync";
import { resultsSummary } from "@/lib/results/ledger";
import { HIDDEN_RULES } from "@/lib/synthetic/generator";
import { loadSyntheticDataset } from "@/lib/synthetic/load";

const ctx = (practiceId: string) => ({ practiceId, userId: "00000000-0000-0000-0000-0000000000cc", email: "owner@test.invalid" });
let practices: { id: string }[] = [];
let rules: Rule[] = [];

beforeAll(async () => {
  const r = await loadSyntheticDataset({ seed: 2026, practices: 12, patientsPerPractice: 450 });
  practices = r.practices;
  for (const p of practices.slice(1)) await decidePool(ctx(p.id), true, { runNow: true });
  await rebuildRules(true);
  rules = await listRules({ synthetic: true });
}, 240_000);

afterAll(async () => {
  // Leave the shared pool as we found it for other test files.
  for (const p of practices) await decidePool(ctx(p.id), false).catch(() => undefined);
  await poolDb().query("DELETE FROM pool.rules WHERE is_synthetic");
  await (await boss()).stop({ graceful: false });
}, 120_000);

describe("statistics", () => {
  it("Wilson intervals match published values", () => {
    const a = wilson(5, 10);
    expect(a.lo).toBeCloseTo(0.2366, 3);
    expect(a.hi).toBeCloseTo(0.7634, 3);
    expect(wilson(0, 10).hi).toBeCloseTo(0.2775, 3);
    expect(wilson(0, 10).lo).toBe(0);
  });
  it("Newcombe's difference interval matches the paper's example (56/70 vs 48/80)", () => {
    const d = newcombe(wilson(56, 70), wilson(48, 80));
    expect(d.diff).toBeCloseTo(0.2, 6);
    expect(d.lo).toBeCloseTo(0.0524, 3);
    expect(d.hi).toBeCloseTo(0.3339, 3);
  });
});

describe("denial intelligence engine", () => {
  const find = (kind: string, payer: string, cdt: string) => rules.find((r) => r.kind === kind && r.payer === payer && r.cdt === cdt);

  it("rediscovers the planted rules from de-identified data alone", () => {
    const r1 = find("missing_attachment", "Summit Dental Mutual", "D4341");
    expect(r1?.stats.condition.attachment).toBe("perio_chart");
    const r2 = find("missing_attachment", "BlueHarbor Dental", "D2740");
    expect(r2?.stats.condition.attachment).toBe("xray");
    const r3 = rules.find((r) => r.kind === "billed_with" && r.payer === "Keystone Smile Plans" && r.cdt === "D2950");
    expect(r3?.stats.condition.withCdt).toBe("D2740");
    expect(r3?.planType).toBe("DHMO"); // the policy is DHMO-only, and the engine says so
    const r5 = rules.filter((r) => r.kind === "frequency" && r.cdt === "D1110" && r.stats.condition.freqAtLeast === 3);
    expect(r5.length).toBeGreaterThanOrEqual(5); // "all payers" rule shows up insurer by insurer
    expect(find("usually_denied", "Pioneer DentalCare", "D6010")).toBeTruthy();
  });

  it("finds no rule that wasn't planted (no false alarms)", () => {
    for (const r of rules) {
      const planted = HIDDEN_RULES.some((h) => h.cdt === r.cdt && (h.payer === "*" || h.payer === r.payer));
      expect(planted, `${r.key}`).toBe(true);
    }
  });

  it("every rule clears the strict bar", () => {
    for (const r of rules) {
      const s = r.stats;
      expect(s.cond.n).toBeGreaterThanOrEqual(RULE_BAR.minProcedures);
      expect(s.cond.practices).toBeGreaterThanOrEqual(RULE_BAR.minPractices);
      if (s.base) {
        expect(s.base.n).toBeGreaterThanOrEqual(RULE_BAR.minProcedures);
        expect(s.base.practices).toBeGreaterThanOrEqual(RULE_BAR.minPractices);
        expect(s.gap!.lo).toBeGreaterThanOrEqual(RULE_BAR.minGapLowerBound);
      } else {
        expect(s.cond.lo).toBeGreaterThanOrEqual(RULE_BAR.usuallyDeniedLowerBound);
      }
    }
  });

  it("measures which appeal fix wins, and explains every rule with its evidence", () => {
    const r1 = find("missing_attachment", "Summit Dental Mutual", "D4341")!;
    const a = r1.stats.appeal;
    expect(a.withFix && a.withoutFix).toBeTruthy();
    expect(a.withFix!.rate).toBeGreaterThan(a.withoutFix!.rate);
    for (const r of rules) {
      const t = explainRule(r);
      expect(t.headline).toMatch(/\d+% of the time/);
      expect(t.evidence).toMatch(/n=\d[\d,]* procedures, \d+ practices/);
      expect(t.evidence).toMatch(/95% range \d+–\d+%/);
    }
  });

  it("the stored rules match a fresh computation", async () => {
    const fresh = await findRules(true);
    expect(fresh.map((r) => r.key).sort()).toEqual(rules.map((r) => r.key).sort());
  });
});

describe("consent v2: appeal details and frequency", () => {
  it("a practice on the original terms shares none of the new fields until the owner accepts", async () => {
    const p = practices[1];
    await prisma().practice.update({ where: { id: p.id }, data: { poolConsentVersion: "2026-09-v1", poolConsentOffered: null } });
    expect(needsConsentUpdate(await prisma().practice.findUniqueOrThrow({ where: { id: p.id } }))).toBe(true);
    await syncPractice(p.id, { full: true });
    const token = (await prisma().practice.findUniqueOrThrow({ where: { id: p.id } })).poolToken!;
    const v1 = (await poolDb().query(
      `SELECT bool_or(c.extended) ext, bool_or(cardinality(c.appeal_attachments) > 0 OR c.appeal_argument IS NOT NULL) appeal,
              bool_or(l.freq_bucket IS NOT NULL) freq
         FROM pool.claims c JOIN pool.claim_lines l ON l.claim_id = c.id WHERE c.contributor = $1`, [token])).rows[0];
    expect(v1).toEqual({ ext: false, appeal: false, freq: false });

    await answerConsentUpdate(ctx(p.id), true, { runNow: true });
    const after = await prisma().practice.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.poolConsentVersion).toBe(POOL_CONSENT_VERSION);
    expect(needsConsentUpdate(after)).toBe(false);
    const v2 = (await poolDb().query(
      `SELECT bool_and(c.extended) ext, bool_or(c.appeal_argument IS NOT NULL) appeal, bool_and(l.freq_bucket IS NOT NULL) freq
         FROM pool.claims c JOIN pool.claim_lines l ON l.claim_id = c.id WHERE c.contributor = $1`, [token])).rows[0];
    expect(v2).toEqual({ ext: true, appeal: true, freq: true });
  }, 120_000);

  it("declining the update is remembered, so the owner is asked once", async () => {
    const p = practices[2];
    await prisma().practice.update({ where: { id: p.id }, data: { poolConsentVersion: "2026-09-v1", poolConsentOffered: null } });
    await answerConsentUpdate(ctx(p.id), false);
    const after = await prisma().practice.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.poolConsentVersion).toBe("2026-09-v1");
    expect(needsConsentUpdate(after)).toBe(false);
    await answerConsentUpdate(ctx(p.id), true, { runNow: true }); // restore for the tests below
  }, 120_000);
});

describe("rules applied to a practice's own claims", () => {
  it("a denied claim that fits a rule shows the likely cause; non-sharers see nothing", async () => {
    const p = practices[3];
    const claims = await withPractice(p.id, (tx) => tx.claim.findMany({
      where: { payer: { name: "Summit Dental Mutual" }, lines: { some: { cdtCode: "D4341" } }, NOT: { attachments: { has: "perio_chart" } }, denials: { some: {} } },
      include: { payer: { select: { name: true } }, lines: { select: { id: true, cdtCode: true } } }, take: 3,
    }));
    expect(claims.length).toBeGreaterThan(0);
    const m = await matchClaims(p.id, claims);
    expect(m.get(claims[0].id)?.some((x) => x.rule.kind === "missing_attachment" && x.rule.stats.condition.attachment === "perio_chart")).toBe(true);
    // Practice 0 never opted in: no pooled rules for it.
    const own = await withPractice(practices[0].id, (tx) => tx.claim.findMany({ include: { payer: { select: { name: true } }, lines: { select: { id: true, cdtCode: true } } }, take: 50 }));
    expect((await matchClaims(practices[0].id, own)).size).toBe(0);
  });

  it("money recovered with ClaimHive's suggested fix counts as ClaimHive's; without it, it doesn't", async () => {
    const p = practices[4];
    const keys = await keysFor(p.id);
    const r1 = rules.find((r) => r.kind === "missing_attachment" && r.payer === "Summit Dental Mutual" && r.cdt === "D4341")!;
    const denied = await withPractice(p.id, (tx) => tx.claim.findMany({
      where: { status: "denied", appealStatus: { in: ["none", "sent", "lost"] } }, include: { lines: true, payer: true }, take: 2,
    }));
    expect(denied.length).toBe(2);
    const [withFix, without] = denied;
    await withPractice(p.id, (tx) => tx.claim.update({ where: { id: withFix.id }, data: { appealStatus: "sent", appealAttachments: ["perio_chart"], appealRuleKey: r1.key } }));
    const later = (c: typeof withFix) => ({
      source: "era835" as const, claimNumber: keys.decrypt("claims", "claim_number", c.id, c.claimNumberEnc!),
      patient: { lastName: "x" }, payer: { name: c.payer.name, payerId: c.payer.payerCode }, status: "paid" as const,
      adjudicatedAt: "2031-01-15", paidCents: c.billedCents, billedCents: c.billedCents, lines: [], claimDenials: [], ref: "t",
    });
    await withPractice(p.id, (tx) => mergeClaims(tx, keys, [later(withFix), later(without)], { isSynthetic: true }));
    const s = await resultsSummary(p.id, new Date("2031-01-01"), new Date("2031-12-31"));
    const mine = s.rows.filter((r) => r.occurredAt === "2031-01-15");
    expect(mine.find((r) => r.attributed)?.method).toBe("appeal_with_attachment");
    expect(mine.filter((r) => !r.attributed)).toHaveLength(1);
  });
});

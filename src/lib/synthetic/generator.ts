/**
 * Synthetic data generator (development and demos only).
 *
 * Produces realistic but entirely fictional practices, patients, payers, claims,
 * claim lines, denials (CARC/RARC) and appeal outcomes. Deterministic for a
 * given seed. Payer names are invented so no real insurer's behaviour is implied.
 *
 * The generator plants known "hidden payer rules" (HIDDEN_RULES). Later phases
 * are tested on whether the denial-intelligence engine rediscovers them.
 */
import { Faker, en } from "@faker-js/faker";
import { CDT_BY_CODE, type Attachment } from "../reference/codes";

export type PlanType = "PPO" | "DHMO" | "INDEMNITY" | "MEDICAID" | "MEDICARE_ADVANTAGE";

export interface SyntheticPayer {
  name: string;
  payerCode: string;
  planTypes: PlanType[];
  allowedRatio: [number, number]; // share of billed fee typically allowed/paid
}

export const SYNTHETIC_PAYERS: SyntheticPayer[] = [
  { name: "Summit Dental Mutual", payerCode: "SYN01", planTypes: ["PPO", "INDEMNITY"], allowedRatio: [0.62, 0.8] },
  { name: "BlueHarbor Dental", payerCode: "SYN02", planTypes: ["PPO"], allowedRatio: [0.58, 0.75] },
  { name: "Keystone Smile Plans", payerCode: "SYN03", planTypes: ["DHMO", "PPO"], allowedRatio: [0.5, 0.68] },
  { name: "Evergreen Dental Benefits", payerCode: "SYN04", planTypes: ["PPO", "INDEMNITY"], allowedRatio: [0.6, 0.78] },
  { name: "Pioneer DentalCare", payerCode: "SYN05", planTypes: ["MEDICAID"], allowedRatio: [0.4, 0.55] },
  { name: "Coastal Dental Alliance", payerCode: "SYN06", planTypes: ["PPO", "MEDICARE_ADVANTAGE"], allowedRatio: [0.55, 0.72] },
  { name: "Heartland Dental Assurance", payerCode: "SYN07", planTypes: ["PPO", "DHMO"], allowedRatio: [0.6, 0.76] },
];

export interface HiddenRule {
  id: string;
  description: string;
  payer: string | "*";
  planType?: PlanType;
  cdt: string;
  /** Condition under which the rule fires. */
  when: "missing_attachment" | "billed_with" | "frequency" | "always";
  attachment?: Attachment;
  withCdt?: string;
  maxPer12Months?: number;
  denyRate: number;
  carc: string;
  rarc?: string;
  /** Appeal win rate when the fix (e.g. the attachment) is supplied with the appeal. */
  appealWinWithFix: number;
  appealWinWithoutFix: number;
}

export const HIDDEN_RULES: HiddenRule[] = [
  { id: "R1", description: "Summit denies deep cleanings without a perio chart", payer: "Summit Dental Mutual",
    cdt: "D4341", when: "missing_attachment", attachment: "perio_chart", denyRate: 0.78, carc: "16", rarc: "N706",
    appealWinWithFix: 0.82, appealWinWithoutFix: 0.12 },
  { id: "R2", description: "BlueHarbor denies ceramic crowns without an X-ray", payer: "BlueHarbor Dental",
    cdt: "D2740", when: "missing_attachment", attachment: "xray", denyRate: 0.7, carc: "252", rarc: "N706",
    appealWinWithFix: 0.85, appealWinWithoutFix: 0.1 },
  { id: "R3", description: "Keystone DHMO bundles core buildups billed with a crown", payer: "Keystone Smile Plans",
    planType: "DHMO", cdt: "D2950", when: "billed_with", withCdt: "D2740", denyRate: 0.85, carc: "97", rarc: "N20",
    appealWinWithFix: 0.45, appealWinWithoutFix: 0.08 },
  { id: "R4", description: "Evergreen denies surgical extractions without a narrative", payer: "Evergreen Dental Benefits",
    cdt: "D7210", when: "missing_attachment", attachment: "narrative", denyRate: 0.65, carc: "16", rarc: "N705",
    appealWinWithFix: 0.75, appealWinWithoutFix: 0.15 },
  { id: "R5", description: "All payers deny a third adult cleaning within 12 months", payer: "*",
    cdt: "D1110", when: "frequency", maxPer12Months: 2, denyRate: 0.95, carc: "119", rarc: "N362",
    appealWinWithFix: 0.05, appealWinWithoutFix: 0.03 },
  { id: "R6", description: "Pioneer (Medicaid) does not cover implants", payer: "Pioneer DentalCare",
    cdt: "D6010", when: "always", denyRate: 0.92, carc: "204", appealWinWithFix: 0.05, appealWinWithoutFix: 0.03 },
  { id: "R7", description: "Coastal denies molar root canals without an X-ray", payer: "Coastal Dental Alliance",
    cdt: "D3330", when: "missing_attachment", attachment: "xray", denyRate: 0.6, carc: "252", rarc: "N706",
    appealWinWithFix: 0.8, appealWinWithoutFix: 0.1 },
];

/** Visit templates: which procedures show up together, and how often. */
const VISITS: { weight: number; lines: string[][]; attach?: Partial<Record<Attachment, number>> }[] = [
  { weight: 40, lines: [["D0120"], ["D1110"], ["D0274"]] },
  { weight: 8, lines: [["D0150"], ["D0210"], ["D1110"]] },
  { weight: 12, lines: [["D2391", "D2392", "D2140"]], attach: { xray: 0.3 } },
  { weight: 9, lines: [["D2740", "D2750"], ["D2950"]], attach: { xray: 0.72, photo: 0.2 } },
  { weight: 7, lines: [["D4341"], ["D4341"]], attach: { perio_chart: 0.6, xray: 0.5 } },
  { weight: 6, lines: [["D4910"]], attach: { perio_chart: 0.4 } },
  { weight: 4, lines: [["D3330", "D3310"]], attach: { xray: 0.7 } },
  { weight: 5, lines: [["D7140", "D7210"]], attach: { xray: 0.5, narrative: 0.55 } },
  { weight: 2, lines: [["D7240"], ["D9230"]], attach: { xray: 0.8, narrative: 0.6 } },
  { weight: 4, lines: [["D0140"], ["D9110"], ["D0220"]] },
  { weight: 2, lines: [["D6010"]], attach: { xray: 0.8, narrative: 0.5 } },
  { weight: 1, lines: [["D5110"]] },
];

export interface GenLine { cdtCode: string; tooth?: string; surfaces?: string; feeCents: number; paidCents: number }
export interface GenDenial { lineIndex: number; groupCode: string; carc: string; rarc?: string; amountCents: number; ruleId?: string }
export interface GenClaim {
  payerCode: string;
  planType: PlanType;
  claimNumber: string;
  serviceDate: Date;
  submittedAt: Date;
  adjudicatedAt: Date;
  status: "paid" | "partially_paid" | "denied";
  attachments: Attachment[];
  lines: GenLine[];
  denials: GenDenial[];
  appealStatus: "none" | "sent" | "won" | "lost";
  recoveredCents: number;
  /** Won appeals: the hidden rule behind the denial, and whether the appeal supplied the fix. */
  appealRuleId?: string;
  appealWithFix?: boolean;
  /** Demo of a pre-submission catch: a rule that would have fired, fixed before sending (Phase 5 does this for real). */
  protectedRuleId?: string;
}
export interface GenPatient { firstName: string; lastName: string; dob: string; memberId: string; claims: GenClaim[] }
export interface GenPractice { name: string; state: string; patients: GenPatient[] }

export interface GenerateOptions {
  seed?: number;
  practices?: number;
  patientsPerPractice?: number;
  months?: number;
  endDate?: Date;
  /** Claim-number prefix (3 letters). Separate prefixes keep independent datasets from matching each other's claims. */
  claimPrefix?: string;
}

const DAY = 86_400_000;
const STATES = ["TX", "CA", "FL", "OH", "NC", "AZ", "GA", "PA", "MI", "WA", "CO", "TN"];
const TEETH = Array.from({ length: 32 }, (_, i) => String(i + 1));
const SURFACES = ["O", "M", "D", "B", "L", "MO", "DO", "MOD"];

export function generateDataset(opts: GenerateOptions = {}): GenPractice[] {
  const f = new Faker({ locale: [en] });
  f.seed(opts.seed ?? 42);
  const nPractices = opts.practices ?? 8;
  const nPatients = opts.patientsPerPractice ?? 150;
  const months = opts.months ?? 12;
  const end = (opts.endDate ?? new Date()).getTime();
  const start = end - months * 30 * DAY;
  const rand = () => f.number.float({ min: 0, max: 1 });
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const weighted = <T extends { weight: number }>(xs: T[]) => {
    let r = rand() * xs.reduce((s, x) => s + x.weight, 0);
    for (const x of xs) if ((r -= x.weight) <= 0) return x;
    return xs[xs.length - 1];
  };
  let claimSeq = 100000;

  const practices: GenPractice[] = [];
  for (let p = 0; p < nPractices; p++) {
    const practice: GenPractice = {
      name: `${f.location.city()} ${pick(["Family Dental", "Dental Care", "Smiles", "Dentistry", "Dental Group"])}`,
      state: STATES[p % STATES.length],
      patients: [],
    };
    for (let i = 0; i < nPatients; i++) {
      const payer = pick(SYNTHETIC_PAYERS);
      const planType = pick(payer.planTypes);
      const patient: GenPatient = {
        firstName: f.person.firstName(),
        lastName: f.person.lastName(),
        dob: f.date.birthdate({ min: 5, max: 88, mode: "age" }).toISOString().slice(0, 10),
        memberId: `SYN${f.string.numeric(9)}`,
        claims: [],
      };
      const visits = 1 + Math.floor(rand() * 4);
      const cleaningDates: number[] = [];
      const dates = Array.from({ length: visits }, () => start + rand() * (end - start - 20 * DAY)).sort((a, b) => a - b);
      for (const d of dates) {
        const visit = weighted(VISITS);
        const attachments = Object.entries(visit.attach ?? {})
          .filter(([, prob]) => rand() < (prob as number))
          .map(([a]) => a as Attachment);
        const lines: GenLine[] = visit.lines.map((options) => {
          const code = pick(options);
          const ref = CDT_BY_CODE.get(code)!;
          const fee = Math.round(f.number.int({ min: ref.feeCents[0], max: ref.feeCents[1] }) / 100) * 100;
          return {
            cdtCode: code,
            tooth: ref.tooth ? pick(TEETH) : undefined,
            surfaces: ref.surfaces ? pick(SURFACES) : undefined,
            feeCents: fee,
            paidCents: 0,
          };
        });
        const codes = lines.map((l) => l.cdtCode);
        const denials: GenDenial[] = [];
        const ratio = payer.allowedRatio[0] + rand() * (payer.allowedRatio[1] - payer.allowedRatio[0]);
        lines.forEach((line, idx) => {
          let denied: GenDenial | undefined;
          for (const r of HIDDEN_RULES) {
            if (r.cdt !== line.cdtCode || (r.payer !== "*" && r.payer !== payer.name)) continue;
            if (r.planType && r.planType !== planType) continue;
            let applies = false;
            if (r.when === "always") applies = true;
            if (r.when === "missing_attachment") applies = !attachments.includes(r.attachment!);
            if (r.when === "billed_with") applies = codes.includes(r.withCdt!);
            if (r.when === "frequency") {
              const recent = cleaningDates.filter((c) => d - c < 365 * DAY).length;
              applies = recent >= r.maxPer12Months!;
            }
            if (applies && rand() < r.denyRate) {
              denied = { lineIndex: idx, groupCode: "CO", carc: r.carc, rarc: r.rarc, amountCents: line.feeCents, ruleId: r.id };
              break;
            }
          }
          // Background noise: occasional duplicates, eligibility and paperwork denials.
          if (!denied && rand() < 0.035) {
            const noise = pick([
              { carc: "18", rarc: undefined }, { carc: "27", rarc: "N30" }, { carc: "16", rarc: "MA130" },
              { carc: "29", rarc: undefined }, { carc: "96", rarc: "N130" },
            ]);
            denied = { lineIndex: idx, groupCode: noise.carc === "27" ? "PR" : "CO", ...noise, amountCents: line.feeCents };
          }
          if (denied) denials.push(denied);
          else line.paidCents = Math.round(line.feeCents * ratio);
          if (line.cdtCode === "D1110") cleaningDates.push(d);
        });

        const serviceDate = new Date(Math.floor(d / DAY) * DAY);
        const submittedAt = new Date(serviceDate.getTime() + f.number.int({ min: 0, max: 6 }) * DAY);
        const adjudicatedAt = new Date(submittedAt.getTime() + f.number.int({ min: denials.length ? 18 : 10, max: denials.length ? 55 : 35 }) * DAY);
        const paid = lines.reduce((s, l) => s + l.paidCents, 0);
        const status = denials.length === 0 ? "paid" : paid > 0 ? "partially_paid" : "denied";

        // Appeals: some denials get appealed; winning is much likelier when the fix is supplied.
        let appealStatus: GenClaim["appealStatus"] = "none";
        let recovered = 0;
        let appealRuleId: string | undefined;
        let appealWithFix: boolean | undefined;
        if (denials.length && rand() < 0.4) {
          const rule = HIDDEN_RULES.find((r) => r.id === denials[0].ruleId);
          const withFix = rand() < 0.6;
          const winRate = rule ? (withFix ? rule.appealWinWithFix : rule.appealWinWithoutFix) : 0.35;
          const decided = adjudicatedAt.getTime() + 60 * DAY < end;
          if (!decided) appealStatus = "sent";
          else if (rand() < winRate) {
            appealStatus = "won";
            appealRuleId = rule?.id;
            appealWithFix = rule ? withFix : undefined;
            recovered = denials.reduce((s, dn) => s + Math.round(dn.amountCents * ratio), 0);
          } else appealStatus = "lost";
        }

        // Claims that carried the attachment a payer rule demands: "caught before sending" (demo of Phase 5).
        const caught = denials.length === 0 ? HIDDEN_RULES.find((r) => r.when === "missing_attachment" && codes.includes(r.cdt)
          && (r.payer === "*" || r.payer === payer.name) && attachments.includes(r.attachment!)) : undefined;
        const protectedRuleId = caught?.id;

        patient.claims.push({
          payerCode: payer.payerCode, planType, claimNumber: `${opts.claimPrefix ?? "SYN"}-${claimSeq++}`, serviceDate, submittedAt, adjudicatedAt,
          status, attachments, lines, denials, appealStatus, recoveredCents: recovered, appealRuleId, appealWithFix, protectedRuleId,
        });
      }
      practice.patients.push(patient);
    }
    practices.push(practice);
  }
  return practices;
}

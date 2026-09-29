import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, withPractice } from "@/lib/db";
import { assertNoIdentifiers, buildAppealRequest, IdentifierFound } from "@/lib/appeals/deidentify";
import { aiAllowed, approveLetter, draftLetter, letterDetail, LetterError, markLetterSent, profileGaps, requestLetter, saveLetter } from "@/lib/appeals/letters";
import { buildLetterPdf } from "@/lib/appeals/pdf";
import { merge, unknownPlaceholders } from "@/lib/appeals/placeholders";
import { anthropicWriter } from "@/lib/appeals/writers";
import { mergeClaims } from "@/lib/ingest/merge";
import { boss } from "@/lib/jobs";
import { keysFor } from "@/lib/practices";
import { resultsSummary } from "@/lib/results/ledger";
import { loadSyntheticDataset } from "@/lib/synthetic/load";

const ctx = (practiceId: string) => ({ practiceId, userId: "00000000-0000-0000-0000-0000000000ee", email: "biller@test.invalid" });
let practices: { id: string }[] = [];

/** A stand-in for the Anthropic client that records exactly what would have been sent. */
function fakeClient(reply: { text?: string; stop_reason?: string }) {
  const sent: unknown[] = [];
  const client = { beta: { messages: { create: async (params: unknown) => {
    sent.push(params);
    return { model: "claude-opus-5-5", stop_reason: reply.stop_reason ?? "end_turn", content: reply.text ? [{ type: "text", text: reply.text }] : [] };
  } } } };
  return { client: client as never, sent };
}
const AI_BODY = "To the Appeals Department:\n\nWe ask you to reconsider the denial for {{PATIENT_NAME}} (member {{MEMBER_ID}}), claim {{CLAIM_NUMBER}}, date of service {{SERVICE_DATE}}. The enclosed documentation addresses the reason for denial.\n\nPlease reprocess the claim.\n\nSincerely,";

async function deniedClaim(practiceId: string, skip = 0) {
  return withPractice(practiceId, (tx) => tx.claim.findFirstOrThrow({
    where: { status: "denied", appealStatus: "none", claimNumberEnc: { not: null }, patient: { memberIdEnc: { not: null } }, letters: { none: {} } },
    include: { patient: true, payer: true, lines: true, denials: true }, orderBy: { id: "asc" }, skip,
  }));
}
async function identity(practiceId: string, c: Awaited<ReturnType<typeof deniedClaim>>) {
  const keys = await keysFor(practiceId);
  return {
    first: keys.decrypt("patients", "first_name", c.patient.id, c.patient.firstNameEnc),
    last: keys.decrypt("patients", "last_name", c.patient.id, c.patient.lastNameEnc),
    dob: keys.decrypt("patients", "dob", c.patient.id, c.patient.dobEnc!),
    memberId: keys.decrypt("patients", "member_id", c.patient.id, c.patient.memberIdEnc!),
    claimNumber: keys.decrypt("claims", "claim_number", c.id, c.claimNumberEnc!),
  };
}
const PROFILE = { letterName: "Seaside Family Dental (Synthetic)", addressLine1: "100 Harbor Way", city: "Portland", zip: "97201",
  phone: "503-555-0100", npi: "1234567893", taxId: "12-3456789", signerName: "Morgan Reyes", signerTitle: "Billing Manager" };

beforeAll(async () => {
  const r = await loadSyntheticDataset({ seed: 314, practices: 2, patientsPerPractice: 150 });
  practices = r.practices;
}, 120_000);

afterAll(async () => {
  await (await boss()).stop({ graceful: false }).catch(() => undefined);
});

describe("de-identified requests", () => {
  const known = { names: ["Jordan", "Pellegrino", "Seaside Dental"], numbers: ["W123456789", "CLM-77881"], dates: [new Date("2026-03-04T00:00:00Z")] };
  it("rejects names, ID numbers, dates, phones and emails", () => {
    for (const bad of ["for Pellegrino", "member W123456789", "claim CLM-77881", "on 3/4/2026", "on 2026-03-04", "on March 4th", "call 503-555-0100", "a@b.co", "id 99887766"]) {
      expect(() => assertNoIdentifiers(bad, known), bad).toThrow(IdentifierFound);
    }
    expect(() => assertNoIdentifiers("D4341 denied CO-16 (missing information); fee $250.00, tooth 14 MOD", known)).not.toThrow();
  });

  it("carries codes, fees and denial reasons only, with placeholders for everything else", async () => {
    const c = await deniedClaim(practices[0].id);
    const r = buildAppealRequest({ ...c, payer: { name: c.payer.name, verified: c.payer.verified } }, { enclosures: ["xray"], argument: "documentation" });
    expect(Object.keys(r).sort()).toEqual(["argument", "claimLevelReasons", "enclosures", "evidence", "insurer", "notes", "placeholders", "planType", "procedures"]);
    expect(r.procedures.length).toBeGreaterThan(0);
    expect(r.procedures[0].denialReasons[0]).toMatch(/^[A-Z]{2}-\d+/);
    const unverified = buildAppealRequest({ ...c, payer: { name: "Typed In Payer", verified: false } }, { enclosures: ["xray"] });
    expect(unverified.insurer).toBe("the insurer");
  });

  it("merges placeholders locally and spots invented ones", () => {
    expect(unknownPlaceholders("Hi {{PATIENT_NAME}} {{FAVORITE_COLOR}}")).toEqual(["FAVORITE_COLOR"]);
    expect(merge("Re {{ PATIENT_NAME }}", { PATIENT_NAME: "A B" } as never)).toBe("Re A B");
  });

  it("only lets synthetic practices use the API in development, and real ones only with a BAA in production", () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, env: process.env.APP_ENV, baa: process.env.ANTHROPIC_BAA };
    try {
      delete process.env.ANTHROPIC_API_KEY;
      expect(aiAllowed({ isSynthetic: true })).toBe(false);
      process.env.ANTHROPIC_API_KEY = "test-key";
      process.env.APP_ENV = "local";
      expect(aiAllowed({ isSynthetic: true })).toBe(true);
      expect(aiAllowed({ isSynthetic: false })).toBe(false);
      process.env.APP_ENV = "production";
      expect(aiAllowed({ isSynthetic: false })).toBe(false);
      process.env.ANTHROPIC_BAA = "signed";
      expect(aiAllowed({ isSynthetic: false })).toBe(true);
    } finally {
      for (const [k, v] of [["ANTHROPIC_API_KEY", saved.key], ["APP_ENV", saved.env], ["ANTHROPIC_BAA", saved.baa]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});

describe("writing a letter", () => {
  it("sends only de-identified content to the API, then merges patient details locally", async () => {
    const p = practices[0].id;
    await prisma().practice.update({ where: { id: p }, data: PROFILE });
    const c = await deniedClaim(p);
    const who = await identity(p, c);
    const fake = fakeClient({ text: AI_BODY });
    const id = await requestLetter(ctx(p), c.id, { enclosures: ["xray"], argument: "documentation" });
    await draftLetter(p, id, anthropicWriter(fake.client));

    expect(fake.sent).toHaveLength(1);
    const wire = JSON.stringify(fake.sent[0]);
    for (const secret of [who.first, who.last, who.memberId, who.claimNumber, who.dob, c.serviceDate.toISOString().slice(0, 10),
      PROFILE.letterName, PROFILE.npi, PROFILE.phone, PROFILE.signerName, PROFILE.addressLine1]) {
      expect(wire.includes(secret), `request contains ${secret.length}-char identifier`).toBe(false);
    }
    expect(wire).toContain("{{PATIENT_NAME}}");
    expect(wire).toContain(c.payer.name);
    expect((fake.sent[0] as { fallbacks: string }).fallbacks).toBe("default");

    const d = (await letterDetail(ctx(p), id))!;
    expect(d.letter.status).toBe("draft");
    expect(d.letter.writer).toBe("ai");
    expect(d.body).toContain(`${who.first} ${who.last}`);
    expect(d.body).toContain(who.memberId);
    expect(d.template).toContain("{{PATIENT_NAME}}");
    // Stored encrypted: the patient's name isn't in the row's bytes.
    expect(Buffer.from(d.letter.bodyEnc!).includes(Buffer.from(who.last))).toBe(false);
    const claim = await withPractice(p, (tx) => tx.claim.findUniqueOrThrow({ where: { id: c.id } }));
    expect(claim.appealStatus).toBe("drafted");
  });

  it("stops before sending anything when the biller's notes contain an identifier", async () => {
    const p = practices[0].id;
    const c = await deniedClaim(p);
    const who = await identity(p, c);
    const fake = fakeClient({ text: AI_BODY });
    const id = await requestLetter(ctx(p), c.id, { enclosures: ["narrative"], notes: `Patient ${who.last} had severe pain.` });
    await draftLetter(p, id, anthropicWriter(fake.client));
    expect(fake.sent).toHaveLength(0);
    const l = await withPractice(p, (tx) => tx.appealLetter.findUniqueOrThrow({ where: { id } }));
    expect(l.status).toBe("failed");
    expect(l.errorCode).toBe("identifier_in_request");
  });

  it("handles a refusal and a letter with an invented placeholder", async () => {
    const p = practices[0].id;
    const c = await deniedClaim(p, 1);
    const refused = await requestLetter(ctx(p), c.id, { enclosures: ["xray"] });
    await draftLetter(p, refused, anthropicWriter(fakeClient({ stop_reason: "refusal" }).client));
    const invented = await requestLetter(ctx(p), c.id, { enclosures: ["xray"] });
    await draftLetter(p, invented, anthropicWriter(fakeClient({ text: "Dear {{ADJUSTER_NAME}},\n\nSincerely," }).client));
    const rows = await withPractice(p, (tx) => tx.appealLetter.findMany({ where: { id: { in: [refused, invented] } } }));
    expect(rows.find((r) => r.id === refused)?.status).toBe("superseded"); // replaced by the second request
    expect(rows.find((r) => r.id === invented)?.errorCode).toBe("unknown_placeholder");
  });

  it("uses ClaimHive's standard letter when there's no API key", async () => {
    const p = practices[1].id;
    const c = await deniedClaim(p);
    const who = await identity(p, c);
    const id = await requestLetter(ctx(p), c.id, { enclosures: ["perio_chart"], argument: "documentation", runNow: true });
    const d = (await letterDetail(ctx(p), id))!;
    expect(d.letter.writer).toBe("template");
    expect(d.body).toContain(`${who.first} ${who.last}`);
    expect(d.body).toContain("periodontal chart");
    expect(d.body).toMatch(/Sincerely,$/);
  });
});

describe("review and approval", () => {
  it("needs the letterhead, every [add …] filled, and the exact version the biller saw", async () => {
    const p = practices[1].id;
    const letter = await withPractice(p, (tx) => tx.appealLetter.findFirstOrThrow({ where: { status: "draft" } }));
    await expect(approveLetter(ctx(p), letter.id, letter.version)).rejects.toThrow(/Settings/);
    const practice = await prisma().practice.findUniqueOrThrow({ where: { id: p } });
    expect(profileGaps(practice)).toContain("NPI");
    await prisma().practice.update({ where: { id: p }, data: { ...PROFILE, letterName: null } });

    const d = (await letterDetail(ctx(p), letter.id))!;
    let v = await saveLetter(ctx(p), letter.id, { body: `${d.body}\n\n[add tooth chart note]`, recipient: "", enclosures: d.letter.enclosures });
    await expect(approveLetter(ctx(p), letter.id, v)).rejects.toThrow(/\[add/);
    v = await saveLetter(ctx(p), letter.id, { body: `${d.body.replace("Sincerely,", "Thank you for your review.\n\nSincerely,")}`, recipient: "", enclosures: d.letter.enclosures });
    await expect(approveLetter(ctx(p), letter.id, v)).rejects.toThrow(/address/);
    v = await saveLetter(ctx(p), letter.id, { body: (await letterDetail(ctx(p), letter.id))!.body, recipient: "Appeals Unit\nPO Box 100\nSpringfield, IL 62701", enclosures: d.letter.enclosures });
    await expect(approveLetter(ctx(p), letter.id, v - 1)).rejects.toThrow(/changed/);
    await expect(markLetterSent(ctx(p), letter.id)).rejects.toThrow(LetterError);
    await approveLetter(ctx(p), letter.id, v);
    const approved = await withPractice(p, (tx) => tx.appealLetter.findUniqueOrThrow({ where: { id: letter.id } }));
    expect(approved.status).toBe("approved");
    expect(approved.approvedVersion).toBe(v);
    expect(approved.approvedHash).toMatch(/^[0-9a-f]{64}$/);

    // Any edit after approval needs a new approval.
    const v2 = await saveLetter(ctx(p), letter.id, { body: `${(await letterDetail(ctx(p), letter.id))!.body} `, recipient: approved.recipient!, enclosures: approved.enclosures });
    const edited = await withPractice(p, (tx) => tx.appealLetter.findUniqueOrThrow({ where: { id: letter.id } }));
    expect(edited.status).toBe("draft");
    expect(edited.approvedHash).toBeNull();
    await approveLetter(ctx(p), letter.id, v2);
  });

  it("the database refuses an approval that doesn't match the current version", async () => {
    const p = practices[1].id;
    const letter = await withPractice(p, (tx) => tx.appealLetter.findFirstOrThrow({ where: { status: "approved" } }));
    await expect(withPractice(p, (tx) => tx.appealLetter.update({ where: { id: letter.id }, data: { version: letter.version + 1 } }))).rejects.toThrow();
  });

  it("builds the PDF on letterhead", async () => {
    const p = practices[1].id;
    const letter = await withPractice(p, (tx) => tx.appealLetter.findFirstOrThrow({ where: { status: "approved" } }));
    const d = (await letterDetail(ctx(p), letter.id))!;
    const practice = await prisma().practice.findUniqueOrThrow({ where: { id: p } });
    const pdf = await buildLetterPdf({ practice: { ...practice, name: practice.letterName || practice.name }, date: new Date(), recipient: letter.recipient!,
      re: [["Patient", d.patient.name], ["Claim number", d.claimNumber]], body: d.body, enclosures: letter.enclosures });
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1500);
  });

  it("marking it sent records the appeal, and a later payment is credited to the ClaimHive letter", async () => {
    const p = practices[1].id;
    const letter = await withPractice(p, (tx) => tx.appealLetter.findFirstOrThrow({ where: { status: "approved" } }));
    await markLetterSent(ctx(p), letter.id);
    const c = await withPractice(p, (tx) => tx.claim.findUniqueOrThrow({ where: { id: letter.claimId }, include: { payer: true, lines: true } }));
    expect(c.appealStatus).toBe("sent");
    expect(c.appealLetterId).toBe(letter.id);
    expect(c.appealAttachments).toEqual(letter.enclosures);

    const keys = await keysFor(p);
    const claimNumber = keys.decrypt("claims", "claim_number", c.id, c.claimNumberEnc!);
    const last = (await identity(p, { ...c, patient: await withPractice(p, (tx) => tx.patient.findUniqueOrThrow({ where: { id: c.patientId } })) } as never)).last;
    const today = new Date().toISOString().slice(0, 10);
    await withPractice(p, (tx) => mergeClaims(tx, keys, [{
      source: "era835", claimNumber, patient: { lastName: last }, payer: { name: c.payer.name, payerId: c.payer.payerCode },
      adjudicatedAt: today, status: "paid", paidCents: c.billedCents, billedCents: c.billedCents, claimDenials: [], ref: "t",
      lines: c.lines.map((l) => ({ cdtCode: l.cdtCode, tooth: l.tooth ?? undefined, feeCents: l.feeCents, paidCents: l.feeCents, denials: [] })),
    }], { isSynthetic: true }));
    const after = await withPractice(p, (tx) => tx.claim.findUniqueOrThrow({ where: { id: c.id } }));
    expect(after.appealStatus).toBe("won");
    const res = await resultsSummary(p, new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000));
    const row = res.rows.find((r) => r.method === "appeal_letter");
    expect(row?.attributed).toBe(true);
    expect(row?.explanation).toMatch(/letter ClaimHive drafted/);
  });

  it("letters are invisible to other practices, and can't be deleted", async () => {
    const mine = await withPractice(practices[1].id, (tx) => tx.appealLetter.findMany({ select: { id: true } }));
    expect(mine.length).toBeGreaterThan(0);
    const seen = await withPractice(practices[0].id, (tx) => tx.appealLetter.count({ where: { id: { in: mine.map((m) => m.id) } } }));
    expect(seen).toBe(0);
    await expect(withPractice(practices[1].id, (tx) => tx.appealLetter.delete({ where: { id: mine[0].id } }))).rejects.toThrow();
  });
});

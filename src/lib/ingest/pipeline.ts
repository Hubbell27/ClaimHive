/**
 * Import pipeline: upload → (mapping, for aging reports) → background parse →
 * merge → review queue for anything uncertain.
 *
 * The original file is stored encrypted under the practice key (for review and
 * re-processing) and purged after RAW_FILE_RETENTION_DAYS. Job payloads carry
 * ids only. Problems are recorded as row numbers + codes, never cell contents.
 */
import { audit } from "../audit";
import type { PracticeContext } from "../auth/rbac";
import { prisma, withPractice } from "../db";
import { boss, QUEUES } from "../jobs";
import { log } from "../logger";
import { keysFor } from "../practices";
import { headerSignature, parseAging, readTable, suggestMapping, validateMapping, type AgingMapping } from "./aging";
import { extractEob, minConfidence, pdfText, REVIEW_THRESHOLD, type EobExtraction } from "./eob";
import { mergeClaims } from "./merge";
import { enqueuePoolSync } from "../pool/sync";
import { afterImport, runCheck } from "../precheck/check";
import type { NormalizedClaim, ParseProblem, ParseResult } from "./types";
import { parse835, parse837, parseX12, X12Error } from "./x12";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const RAW_FILE_RETENTION_DAYS = 90;
type Kind = "aging" | "era835" | "claim837" | "eob_pdf";
type Actor = Pick<PracticeContext, "practiceId" | "userId" | "email">;

export class ImportError extends Error {}

/** Decide what a file is from its contents (not its name or the browser's claim). */
export function detectKind(bytes: Uint8Array, fileName: string): Kind {
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 2048));
  if (head.startsWith("%PDF-")) return "eob_pdf";
  if (/^\s*ISA/.test(head)) {
    try {
      const t = parseX12(new TextDecoder("latin1").decode(bytes)).transaction;
      if (t === "835") return "era835";
      if (t === "837") return "claim837";
    } catch (e) {
      if (e instanceof X12Error) throw new ImportError("This X12 file couldn't be read. Check that it's an 835 or 837D.");
      throw e;
    }
    throw new ImportError("This X12 file isn't an 835 remittance or an 837D claim.");
  }
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const lower = fileName.toLowerCase();
  if (isZip && lower.endsWith(".xlsx")) return "aging";
  if (/\.(csv|txt|tsv)$/.test(lower) && !bytes.slice(0, 2048).some((b) => b === 0)) return "aging";
  throw new ImportError("ClaimHive reads aging reports (CSV or Excel .xlsx), 835 and 837D files, and EOB PDFs.");
}

export interface UploadOutcome {
  batchId: string;
  kind: Kind;
  needsMapping: boolean;
}

export async function createImport(ctx: Actor, fileName: string, bytes: Uint8Array, opts: { purpose?: "record" | "precheck" } = {}): Promise<UploadOutcome> {
  if (bytes.byteLength === 0) throw new ImportError("That file is empty.");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new ImportError("Files can be up to 10 MB. Split larger exports by date range.");
  const kind = detectKind(bytes, fileName);
  const purpose = opts.purpose ?? "record";
  if (purpose === "precheck" && kind !== "claim837") throw new ImportError("To check claims before sending, upload the 837D file you're about to send.");
  const keys = await keysFor(ctx.practiceId);
  const fileKey = keys.fingerprint("import-file", bytes);
  const id = crypto.randomUUID();

  let mapping: AgingMapping | undefined;
  let detectedSystem: string | undefined;
  if (kind === "aging") {
    const table = await readTable(bytes, fileName).catch(() => { throw new ImportError("This spreadsheet couldn't be read."); });
    if (!table.rows.length) throw new ImportError("No rows were found in this report.");
    const sig = headerSignature(table.headers);
    const saved = await withPractice(ctx.practiceId, (tx) => tx.importMapping.findUnique({ where: { practiceId_headerSignature: { practiceId: ctx.practiceId, headerSignature: sig } } }));
    const suggestion = suggestMapping(table.headers);
    detectedSystem = suggestion.detectedSystem;
    // A layout this practice already confirmed is imported straight away; a new layout is confirmed once by a person.
    if (saved && !validateMapping(saved.mapping as AgingMapping, table.headers)) mapping = saved.mapping as AgingMapping;
  }
  const needsMapping = kind === "aging" && !mapping;

  const existing = await withPractice(ctx.practiceId, (tx) => tx.importBatch.findUnique({ where: { practiceId_fileKey: { practiceId: ctx.practiceId, fileKey } }, select: { id: true, createdAt: true } }));
  if (existing) throw new ImportError(`This exact file was already imported on ${existing.createdAt.toLocaleDateString("en-US")}.`);

  await withPractice(ctx.practiceId, (tx) => tx.importBatch.create({
    data: {
      id, practiceId: ctx.practiceId, kind, status: needsMapping ? "mapping_needed" : "queued",
      fileNameEnc: keys.encrypt("import_batches", "file_name", id, fileName.slice(0, 200)),
      fileKey, fileEnc: keys.encrypt("import_batches", "file", id, Buffer.from(bytes).toString("base64")),
      sizeBytes: bytes.byteLength, mapping: mapping ?? undefined, detectedSystem: detectedSystem ?? null, createdBy: ctx.userId, purpose,
    },
  }));
  await audit({ action: "import.upload", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "import_batch", resourceId: id, details: { kind, bytes: bytes.byteLength, needsMapping } });
  if (!needsMapping) await enqueue(ctx.practiceId, id);
  return { batchId: id, kind, needsMapping };
}

async function enqueue(practiceId: string, batchId: string) {
  await (await boss()).send(QUEUES.importProcess, { practiceId, batchId }, { retryLimit: 2, retryDelay: 30 });
}

async function loadFile(practiceId: string, batchId: string) {
  const keys = await keysFor(practiceId);
  const b = await withPractice(practiceId, (tx) => tx.importBatch.findUniqueOrThrow({ where: { id: batchId } }));
  if (!b.fileEnc) throw new ImportError("The original file has been purged.");
  const bytes = new Uint8Array(Buffer.from(keys.decrypt("import_batches", "file", batchId, b.fileEnc), "base64"));
  const fileName = keys.decrypt("import_batches", "file_name", batchId, b.fileNameEnc);
  return { batch: b, bytes, fileName, keys };
}

/** Headers and a few sample rows, for the mapping screen. Audited: sample rows are PHI. */
export async function mappingPreview(ctx: Actor, batchId: string) {
  const { batch, bytes, fileName } = await loadFile(ctx.practiceId, batchId);
  const table = await readTable(bytes, fileName);
  await audit({ action: "phi.view", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "import_batch", resourceId: batchId, details: { preview_rows: Math.min(3, table.rows.length) } });
  return { batch, headers: table.headers, sample: table.rows.slice(0, 3), suggestion: suggestMapping(table.headers), rows: table.rows.length };
}

export async function confirmMapping(ctx: Actor, batchId: string, mapping: AgingMapping): Promise<string | undefined> {
  const { batch, bytes, fileName } = await loadFile(ctx.practiceId, batchId);
  if (batch.status !== "mapping_needed") return "This import is already being processed.";
  const table = await readTable(bytes, fileName);
  const problem = validateMapping(mapping, table.headers);
  if (problem) return problem;
  const sig = headerSignature(table.headers);
  await withPractice(ctx.practiceId, async (tx) => {
    await tx.importBatch.update({ where: { id: batchId }, data: { mapping, status: "queued" } });
    await tx.importMapping.upsert({
      where: { practiceId_headerSignature: { practiceId: ctx.practiceId, headerSignature: sig } },
      create: { practiceId: ctx.practiceId, headerSignature: sig, mapping }, update: { mapping },
    });
  });
  await audit({ action: "import.map", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "import_batch", resourceId: batchId, details: { fields: Object.keys(mapping) } });
  await enqueue(ctx.practiceId, batchId);
}

export interface ReviewPayload {
  claim: NormalizedClaim;
  confidence: EobExtraction["confidence"];
}

/** Worker entry point. Idempotent per batch: a batch that is done is not processed again. */
export async function processBatch(practiceId: string, batchId: string): Promise<void> {
  const started = Date.now();
  const { batch, bytes, fileName, keys } = await loadFile(practiceId, batchId);
  if (batch.status === "done" || batch.status === "needs_review") return;
  await withPractice(practiceId, (tx) => tx.importBatch.update({ where: { id: batchId }, data: { status: "processing" } }));
  const practice = await prisma().practice.findUniqueOrThrow({ where: { id: practiceId }, select: { isSynthetic: true } });

  try {
    let parsed: ParseResult;
    let review: EobExtraction | undefined;
    const text = () => new TextDecoder("latin1").decode(bytes);
    if (batch.kind === "era835") parsed = parse835(text());
    else if (batch.kind === "claim837") parsed = parse837(text());
    else if (batch.kind === "aging") parsed = parseAging(await readTable(bytes, fileName), batch.mapping as AgingMapping);
    else {
      const payers = (await prisma().payer.findMany({ select: { name: true } })).map((p) => p.name);
      const extraction = extractEob(await pdfText(bytes).catch(() => ""), payers);
      if (minConfidence(extraction.confidence) < REVIEW_THRESHOLD) { review = extraction; parsed = { claims: [], problems: [], rows: 1 }; }
      else parsed = { claims: [extraction.claim], problems: [], rows: 1 };
    }

    const stats = await withPractice(practiceId, async (tx) => {
      const s = await mergeClaims(tx, keys, parsed.claims, { batchId, isSynthetic: practice.isSynthetic, asDraft: batch.purpose === "precheck" });
      const problems: ParseProblem[] = [...parsed.problems, ...s.problems].slice(0, 200);
      if (review) {
        const id = crypto.randomUUID();
        const payload: ReviewPayload = { claim: review.claim, confidence: review.confidence };
        await tx.reviewItem.create({
          data: { id, practiceId, batchId, payloadEnc: keys.encrypt("review_items", "payload", id, JSON.stringify(payload)),
            flags: review.flags.slice(0, 20), minConfidence: minConfidence(review.confidence) },
        });
      }
      // A pre-send batch stays "processing" until every claim is scored (the page shows the totals when it's done).
      const scoring = batch.purpose === "precheck" && !review;
      await tx.importBatch.update({
        where: { id: batchId },
        data: {
          status: review ? "needs_review" : scoring ? "processing" : "done", rowsTotal: parsed.rows, claimsCreated: s.created, claimsUpdated: s.updated,
          rowsSkipped: s.skipped + parsed.problems.length, reviewCount: review ? 1 : 0, deniedCents: s.deniedCents, paidCents: s.paidCents,
          problems: problems as never, finishedAt: review || scoring ? null : new Date(),
        },
      });
      return s;
    });
    await audit({ action: "import.process", actorUserId: batch.createdBy, practiceId, resourceType: "import_batch", resourceId: batchId,
      details: { kind: batch.kind, created: stats.created, updated: stats.updated, skipped: stats.skipped, review: !!review } });
    log.info({ event: "import.done", practiceId, jobId: batchId, count: stats.created + stats.updated, durationMs: Date.now() - started });
    if (batch.purpose === "precheck") {
      // Claims about to be sent: score each one.
      let atRisk = 0, risky = 0;
      for (const id of stats.claimIds) {
        const r = await runCheck(practiceId, id);
        atRisk += r.atRiskCents;
        if (r.risk >= 0.2) risky++;
      }
      await withPractice(practiceId, (tx) => tx.importBatch.update({ where: { id: batchId }, data: { atRiskCents: atRisk, riskyClaims: risky, checkedClaimIds: stats.claimIds, status: "done", finishedAt: new Date() } }));
    } else {
      // Re-check claims with open findings (a resubmitted 837 may carry the fix) and credit protected money.
      await afterImport(practiceId, stats.claimIds, batchId);
    }
    await enqueuePoolSync(practiceId);
  } catch (e) {
    const code = e instanceof X12Error || e instanceof ImportError ? "unreadable_file" : "processing_error";
    await withPractice(practiceId, (tx) => tx.importBatch.update({
      where: { id: batchId }, data: { status: "failed", problems: [{ ref: "file", code }] as never, finishedAt: new Date() },
    }));
    log.error({ event: "import.failed", practiceId, jobId: batchId }, e);
    if (code === "processing_error") throw e; // let the queue retry unexpected failures
  }
}

export async function reviewDetail(ctx: Actor, reviewId: string) {
  const keys = await keysFor(ctx.practiceId);
  const item = await withPractice(ctx.practiceId, (tx) => tx.reviewItem.findUniqueOrThrow({ where: { id: reviewId } }));
  const payload = JSON.parse(keys.decrypt("review_items", "payload", reviewId, item.payloadEnc)) as ReviewPayload;
  await audit({ action: "phi.view", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId, resourceType: "review_item", resourceId: reviewId });
  return { item, payload };
}

/** A person confirmed (and possibly corrected) an extracted EOB: merge it like any other remittance. */
export async function acceptReview(ctx: Actor, reviewId: string, corrected: NormalizedClaim): Promise<void> {
  let touched: string[] = [];
  const keys = await keysFor(ctx.practiceId);
  const practice = await prisma().practice.findUniqueOrThrow({ where: { id: ctx.practiceId }, select: { isSynthetic: true } });
  await withPractice(ctx.practiceId, async (tx) => {
    const item = await tx.reviewItem.findUniqueOrThrow({ where: { id: reviewId } });
    if (item.status !== "open") throw new ImportError("This item was already reviewed.");
    const s = await mergeClaims(tx, keys, [{ ...corrected, source: "eob_pdf" }], { batchId: item.batchId, isSynthetic: practice.isSynthetic });
    touched = s.claimIds;
    await tx.reviewItem.update({ where: { id: reviewId }, data: { status: "accepted", resolvedBy: ctx.userId, resolvedAt: new Date() } });
    const open = await tx.reviewItem.count({ where: { batchId: item.batchId, status: "open" } });
    await tx.importBatch.update({
      where: { id: item.batchId },
      data: { claimsCreated: { increment: s.created }, claimsUpdated: { increment: s.updated }, deniedCents: { increment: s.deniedCents },
        paidCents: { increment: s.paidCents }, ...(open === 0 ? { status: "done", finishedAt: new Date() } : {}) },
    });
  });
  await audit({ action: "phi.edit", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "review_item", resourceId: reviewId, details: { outcome: "accepted" } });
  await afterImport(ctx.practiceId, touched);
  await enqueuePoolSync(ctx.practiceId);
}

export async function dismissReview(ctx: Actor, reviewId: string): Promise<void> {
  await withPractice(ctx.practiceId, async (tx) => {
    const item = await tx.reviewItem.update({ where: { id: reviewId }, data: { status: "dismissed", resolvedBy: ctx.userId, resolvedAt: new Date() } });
    const open = await tx.reviewItem.count({ where: { batchId: item.batchId, status: "open" } });
    if (open === 0) await tx.importBatch.update({ where: { id: item.batchId }, data: { status: "done", finishedAt: new Date() } });
  });
  await audit({ action: "phi.edit", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    resourceType: "review_item", resourceId: reviewId, details: { outcome: "dismissed" } });
}

/** Drops stored originals after the retention window (the parsed data stays). */
export async function purgeOldFiles(practiceId: string, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RAW_FILE_RETENTION_DAYS * 86_400_000);
  const r = await withPractice(practiceId, (tx) => tx.importBatch.updateMany({
    where: { createdAt: { lt: cutoff }, fileEnc: { not: null }, status: { in: ["done", "failed"] } }, data: { fileEnc: null },
  }));
  return r.count;
}

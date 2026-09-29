-- CreateEnum
CREATE TYPE "ImportKind" AS ENUM ('aging', 'era835', 'claim837', 'eob_pdf');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('mapping_needed', 'queued', 'processing', 'needs_review', 'done', 'failed');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('open', 'accepted', 'dismissed');

-- CreateEnum
CREATE TYPE "ResultKind" AS ENUM ('recovered', 'protected');

-- AlterEnum
ALTER TYPE "PlanType" ADD VALUE 'UNKNOWN';

-- AlterTable
ALTER TABLE "claims" ADD COLUMN     "claim_key" TEXT,
ADD COLUMN     "sources" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "member_lookup" TEXT,
ALTER COLUMN "dob_enc" DROP NOT NULL,
ALTER COLUMN "lookup_index" DROP NOT NULL;

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "kind" "ImportKind" NOT NULL,
    "status" "ImportStatus" NOT NULL,
    "file_name_enc" BYTEA NOT NULL,
    "file_key" TEXT NOT NULL,
    "file_enc" BYTEA,
    "size_bytes" INTEGER NOT NULL,
    "mapping" JSONB,
    "detected_system" TEXT,
    "rows_total" INTEGER NOT NULL DEFAULT 0,
    "claims_created" INTEGER NOT NULL DEFAULT 0,
    "claims_updated" INTEGER NOT NULL DEFAULT 0,
    "rows_skipped" INTEGER NOT NULL DEFAULT 0,
    "review_count" INTEGER NOT NULL DEFAULT 0,
    "denied_cents" INTEGER NOT NULL DEFAULT 0,
    "paid_cents" INTEGER NOT NULL DEFAULT 0,
    "problems" JSONB NOT NULL DEFAULT '[]',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_mappings" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "header_signature" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_items" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "claim_id" UUID,
    "status" "ReviewStatus" NOT NULL DEFAULT 'open',
    "payload_enc" BYTEA NOT NULL,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "min_confidence" DOUBLE PRECISION NOT NULL,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "result_events" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "kind" "ResultKind" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "attributed" BOOLEAN NOT NULL,
    "method" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" DATE NOT NULL,
    "source_batch_id" UUID,
    "is_synthetic" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "result_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_batches_practice_id_created_at_idx" ON "import_batches"("practice_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "import_batches_practice_id_file_key_key" ON "import_batches"("practice_id", "file_key");

-- CreateIndex
CREATE UNIQUE INDEX "import_mappings_practice_id_header_signature_key" ON "import_mappings"("practice_id", "header_signature");

-- CreateIndex
CREATE INDEX "review_items_practice_id_status_idx" ON "review_items"("practice_id", "status");

-- CreateIndex
CREATE INDEX "result_events_practice_id_occurred_at_idx" ON "result_events"("practice_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "result_events_claim_id_kind_method_key" ON "result_events"("claim_id", "kind", "method");

-- CreateIndex
CREATE INDEX "claims_practice_id_claim_key_idx" ON "claims"("practice_id", "claim_key");

-- CreateIndex
CREATE INDEX "patients_practice_id_member_lookup_idx" ON "patients"("practice_id", "member_lookup");

-- AddForeignKey
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_events" ADD CONSTRAINT "result_events_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_events" ADD CONSTRAINT "result_events_source_batch_id_fkey" FOREIGN KEY ("source_batch_id") REFERENCES "import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ================================================================ security (Phase 2)
GRANT SELECT, INSERT, UPDATE, DELETE ON import_batches, import_mappings, review_items TO claimhive_app;
-- The results ledger feeds contingency invoices: the app may add to it and read it, never rewrite it.
-- (Explicit REVOKE: Phase 1's default privileges would otherwise grant UPDATE/DELETE on new tables.)
GRANT SELECT, INSERT ON result_events TO claimhive_app;
REVOKE UPDATE, DELETE, TRUNCATE ON result_events FROM claimhive_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['import_batches', 'import_mappings', 'review_items', 'result_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (practice_id = app_practice_id()) '
                   'WITH CHECK (practice_id = app_practice_id())', t);
  END LOOP;
END $$;

-- Cross-practice references are rejected (parents are invisible across practices under RLS).
-- (Nested IFs: PL/pgSQL doesn't short-circuit AND, and each table has different columns.)
CREATE OR REPLACE FUNCTION enforce_ref_practice() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p uuid;
BEGIN
  IF NEW.claim_id IS NOT NULL THEN
    SELECT practice_id INTO p FROM claims WHERE id = NEW.claim_id;
    IF p IS DISTINCT FROM NEW.practice_id THEN RAISE EXCEPTION 'cross-practice reference rejected'; END IF;
  END IF;
  IF TG_TABLE_NAME = 'review_items' THEN
    SELECT practice_id INTO p FROM import_batches WHERE id = NEW.batch_id;
    IF p IS DISTINCT FROM NEW.practice_id THEN RAISE EXCEPTION 'cross-practice reference rejected'; END IF;
  ELSIF TG_TABLE_NAME = 'result_events' THEN
    IF NEW.source_batch_id IS NOT NULL THEN
      SELECT practice_id INTO p FROM import_batches WHERE id = NEW.source_batch_id;
      IF p IS DISTINCT FROM NEW.practice_id THEN RAISE EXCEPTION 'cross-practice reference rejected'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_items_same_practice BEFORE INSERT OR UPDATE ON review_items
  FOR EACH ROW EXECUTE FUNCTION enforce_ref_practice();
CREATE TRIGGER result_events_same_practice BEFORE INSERT ON result_events
  FOR EACH ROW EXECUTE FUNCTION enforce_ref_practice();

-- Ledger rows are immutable for every role; they only disappear with their claim (FK cascade).
CREATE OR REPLACE FUNCTION result_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'result_events is append-only';
END $$;
CREATE TRIGGER result_events_no_update BEFORE UPDATE ON result_events
  FOR EACH ROW EXECUTE FUNCTION result_events_immutable();

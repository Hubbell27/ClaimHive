-- CreateEnum
CREATE TYPE "StatementStatus" AS ENUM ('draft', 'issued');

-- AlterEnum
ALTER TYPE "ResultKind" ADD VALUE 'reversed';

-- DropIndex
DROP INDEX "result_events_claim_id_kind_method_key";

-- AlterTable
ALTER TABLE "result_events" ADD COLUMN     "seq_key" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "billing_rates" (
    "id" UUID NOT NULL,
    "practice_id" UUID,
    "rate_bps" INTEGER NOT NULL,
    "effective_from" DATE NOT NULL,
    "note" TEXT,
    "set_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "statements" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "number" TEXT,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "status" "StatementStatus" NOT NULL DEFAULT 'draft',
    "recovered_cents" INTEGER NOT NULL DEFAULT 0,
    "fee_cents" INTEGER NOT NULL DEFAULT 0,
    "credit_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL DEFAULT 0,
    "issued_at" TIMESTAMPTZ,
    "issued_by" UUID,
    "due_date" DATE,
    "is_synthetic" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "statement_lines" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "statement_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "result_event_id" UUID NOT NULL,
    "recovered_cents" INTEGER NOT NULL,
    "rate_bps" INTEGER NOT NULL,
    "fee_cents" INTEGER NOT NULL,
    "occurred_at" DATE NOT NULL,
    "claim_ref" TEXT NOT NULL,
    "claim_id" UUID NOT NULL,
    "payer" TEXT NOT NULL,
    "cdt_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "method" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_rates_practice_id_effective_from_idx" ON "billing_rates"("practice_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "statements_number_key" ON "statements"("number");

-- CreateIndex
CREATE INDEX "statements_status_period_start_idx" ON "statements"("status", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "statements_practice_id_period_start_key" ON "statements"("practice_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "statement_lines_result_event_id_key" ON "statement_lines"("result_event_id");

-- CreateIndex
CREATE INDEX "statement_lines_practice_id_statement_id_idx" ON "statement_lines"("practice_id", "statement_id");

-- CreateIndex
CREATE UNIQUE INDEX "result_events_claim_id_kind_method_seq_key_key" ON "result_events"("claim_id", "kind", "method", "seq_key");

-- AddForeignKey
ALTER TABLE "billing_rates" ADD CONSTRAINT "billing_rates_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_statement_id_fkey" FOREIGN KEY ("statement_id") REFERENCES "statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_result_event_id_fkey" FOREIGN KEY ("result_event_id") REFERENCES "result_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ================================================================ security (Phase 7)
-- Rates: append-only history. Practices can read the default (practice_id NULL) and their own.
REVOKE UPDATE, DELETE, TRUNCATE ON billing_rates FROM claimhive_app;
ALTER TABLE billing_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY rate_visibility ON billing_rates
  USING (practice_id IS NULL OR practice_id = app_practice_id())
  WITH CHECK (practice_id IS NULL OR practice_id = app_practice_id());
ALTER TABLE billing_rates ADD CONSTRAINT billing_rates_values CHECK (rate_bps BETWEEN 0 AND 10000);

ALTER TABLE statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE statements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON statements USING (practice_id = app_practice_id()) WITH CHECK (practice_id = app_practice_id());
ALTER TABLE statements ADD CONSTRAINT statements_values CHECK (
  period_end > period_start AND fee_cents >= 0 AND credit_cents >= 0 AND total_cents = fee_cents - credit_cents
  AND (status <> 'issued' OR (number IS NOT NULL AND issued_at IS NOT NULL AND issued_by IS NOT NULL AND due_date IS NOT NULL)));

ALTER TABLE statement_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE statement_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON statement_lines USING (practice_id = app_practice_id()) WITH CHECK (practice_id = app_practice_id());
ALTER TABLE statement_lines ADD CONSTRAINT statement_lines_values CHECK (
  kind IN ('charge', 'credit') AND recovered_cents > 0 AND fee_cents >= 0 AND rate_bps BETWEEN 0 AND 10000);
CREATE TRIGGER statement_lines_same_practice BEFORE INSERT OR UPDATE ON statement_lines
  FOR EACH ROW EXECUTE FUNCTION enforce_ref_practice();

-- An issued statement is locked: no edits, no deletion, and its lines can't change.
CREATE OR REPLACE FUNCTION statements_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'issued' THEN RAISE EXCEPTION 'issued statements are locked'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER statements_locked BEFORE UPDATE OR DELETE ON statements FOR EACH ROW EXECUTE FUNCTION statements_lock();

CREATE OR REPLACE FUNCTION statement_lines_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text; p uuid;
BEGIN
  SELECT status::text, practice_id INTO st, p FROM statements WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.statement_id ELSE NEW.statement_id END;
  IF st = 'issued' THEN RAISE EXCEPTION 'issued statements are locked'; END IF;
  IF TG_OP <> 'DELETE' AND p IS DISTINCT FROM NEW.practice_id THEN RAISE EXCEPTION 'cross-practice reference rejected'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER statement_lines_locked BEFORE INSERT OR UPDATE OR DELETE ON statement_lines FOR EACH ROW EXECUTE FUNCTION statement_lines_lock();

CREATE SEQUENCE statement_number_seq;
GRANT USAGE, SELECT ON SEQUENCE statement_number_seq TO claimhive_app;

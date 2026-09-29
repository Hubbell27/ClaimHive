-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('open', 'fixed_by_user', 'fixed_detected', 'dismissed');

-- AlterTable
ALTER TABLE "claims" ADD COLUMN     "at_risk_cents" INTEGER,
ADD COLUMN     "prechecked_at" TIMESTAMPTZ,
ADD COLUMN     "risk_score" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "import_batches" ADD COLUMN     "at_risk_cents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'record',
ADD COLUMN     "risky_claims" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "checked_claim_ids" UUID[] DEFAULT ARRAY[]::UUID[];

-- CreateTable
CREATE TABLE "check_findings" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "rule_key" TEXT,
    "cdt_code" VARCHAR(5) NOT NULL,
    "fix_type" TEXT NOT NULL,
    "attachment" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "fix" TEXT NOT NULL,
    "probability" DOUBLE PRECISION NOT NULL,
    "at_risk_cents" INTEGER NOT NULL,
    "status" "FindingStatus" NOT NULL DEFAULT 'open',
    "fixed_at" TIMESTAMPTZ,
    "fixed_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "check_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "check_findings_practice_id_claim_id_idx" ON "check_findings"("practice_id", "claim_id");

-- CreateIndex
CREATE INDEX "check_findings_practice_id_status_idx" ON "check_findings"("practice_id", "status");

-- AddForeignKey
ALTER TABLE "check_findings" ADD CONSTRAINT "check_findings_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ================================================================

-- ================================================================ security (Phase 5)
GRANT SELECT, INSERT, UPDATE, DELETE ON check_findings TO claimhive_app;
ALTER TABLE check_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE check_findings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON check_findings USING (practice_id = app_practice_id()) WITH CHECK (practice_id = app_practice_id());
CREATE TRIGGER check_findings_same_practice BEFORE INSERT OR UPDATE ON check_findings
  FOR EACH ROW EXECUTE FUNCTION enforce_ref_practice();
ALTER TABLE import_batches ADD CONSTRAINT import_batches_purpose_check CHECK (purpose IN ('record', 'precheck'));
ALTER TABLE check_findings ADD CONSTRAINT check_findings_values CHECK (
  source IN ('pool', 'basic') AND fix_type IN ('attachment', 'code', 'data', 'verify')
  AND probability >= 0 AND probability <= 1 AND at_risk_cents >= 0);

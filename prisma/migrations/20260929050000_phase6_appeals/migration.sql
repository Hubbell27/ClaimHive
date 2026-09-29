-- CreateEnum
CREATE TYPE "LetterStatus" AS ENUM ('generating', 'draft', 'approved', 'failed', 'superseded');

-- AlterTable
ALTER TABLE "claims" ADD COLUMN     "appeal_letter_id" UUID;

-- AlterTable
ALTER TABLE "practices" ADD COLUMN     "address_line1" TEXT,
ADD COLUMN     "address_line2" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "fax" VARCHAR(20),
ADD COLUMN     "letter_name" TEXT,
ADD COLUMN     "npi" VARCHAR(10),
ADD COLUMN     "phone" VARCHAR(20),
ADD COLUMN     "signer_name" TEXT,
ADD COLUMN     "signer_title" TEXT,
ADD COLUMN     "tax_id" VARCHAR(10),
ADD COLUMN     "zip" VARCHAR(10);

-- CreateTable
CREATE TABLE "appeal_letters" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "status" "LetterStatus" NOT NULL DEFAULT 'generating',
    "writer" TEXT,
    "model" TEXT,
    "enclosures" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "argument" TEXT,
    "rule_key" TEXT,
    "notes_enc" BYTEA,
    "template_enc" BYTEA,
    "body_enc" BYTEA,
    "recipient" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "approved_version" INTEGER,
    "approved_hash" TEXT,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ,
    "sent_at" TIMESTAMPTZ,
    "error_code" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appeal_letters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "appeal_letters_practice_id_claim_id_idx" ON "appeal_letters"("practice_id", "claim_id");

-- CreateIndex
CREATE INDEX "appeal_letters_practice_id_status_idx" ON "appeal_letters"("practice_id", "status");

-- AddForeignKey
ALTER TABLE "appeal_letters" ADD CONSTRAINT "appeal_letters_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ================================================================ security (Phase 6)
-- Letters are kept (superseded, never removed); a claim deletion still cascades (FK actions run as the owner).
REVOKE DELETE ON appeal_letters FROM claimhive_app;
ALTER TABLE appeal_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE appeal_letters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON appeal_letters USING (practice_id = app_practice_id()) WITH CHECK (practice_id = app_practice_id());
CREATE TRIGGER appeal_letters_same_practice BEFORE INSERT OR UPDATE ON appeal_letters
  FOR EACH ROW EXECUTE FUNCTION enforce_ref_practice();
ALTER TABLE appeal_letters ADD CONSTRAINT appeal_letters_values CHECK (
  (writer IS NULL OR writer IN ('ai', 'template')) AND version >= 0
  AND (status <> 'approved' OR (approved_version = version AND approved_hash IS NOT NULL AND approved_by IS NOT NULL)));
ALTER TABLE practices ADD CONSTRAINT practices_letterhead_values CHECK (
  (npi IS NULL OR npi ~ '^[0-9]{10}$') AND (tax_id IS NULL OR tax_id ~ '^[0-9]{2}-?[0-9]{7}$')
  AND (zip IS NULL OR zip ~ '^[0-9]{5}(-[0-9]{4})?$'));

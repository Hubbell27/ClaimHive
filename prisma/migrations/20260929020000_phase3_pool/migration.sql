-- AlterTable
ALTER TABLE "claims" ADD COLUMN     "pool_record_id" UUID,
ADD COLUMN     "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "payers" ADD COLUMN     "verified" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "practices" ADD COLUMN     "pool_consent_version" TEXT,
ADD COLUMN     "pool_decided_at" TIMESTAMPTZ,
ADD COLUMN     "pool_shared" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pool_skipped" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pool_synced_at" TIMESTAMPTZ,
ADD COLUMN     "pool_token" UUID;

-- CreateIndex
CREATE INDEX "claims_practice_id_updated_at_idx" ON "claims"("practice_id", "updated_at");


-- Insurers named by an X12 payer ID, and the fictional synthetic payers, are trusted names.
UPDATE payers SET verified = true WHERE is_synthetic OR payer_code NOT LIKE 'NAME:%';

-- ================================================================ the de-identified pool
-- A separate schema with its own role. It holds no practice ids, patient data or dates:
-- only the fields listed in ARCHITECTURE.md (HIPAA Safe Harbor). The application role
-- has no access to it at all, and the pool role has no access to anything else, so the
-- two can't be joined in SQL.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'claimhive_pool') THEN
    CREATE ROLE claimhive_pool LOGIN;
  END IF;
END $$;

CREATE SCHEMA pool;
REVOKE ALL ON SCHEMA pool FROM PUBLIC;

CREATE TABLE pool.claims (
  id              uuid PRIMARY KEY,               -- random; the only link back is claims.pool_record_id inside the practice
  contributor     uuid NOT NULL,                  -- random per-practice token (rotated on opt-out), not the practice id
  payer           text NOT NULL CHECK (length(payer) BETWEEN 2 AND 80),
  plan_type       text NOT NULL CHECK (plan_type IN ('PPO','DHMO','INDEMNITY','MEDICAID','MEDICARE_ADVANTAGE','UNKNOWN')),
  region          char(2) NOT NULL CHECK (region ~ '^[A-Z]{2}$'),
  attachments     text[] NOT NULL DEFAULT '{}' CHECK (attachments <@ ARRAY['xray','narrative','perio_chart','photo']),
  outcome         text NOT NULL CHECK (outcome IN ('pending','paid','partially_paid','denied','appeal_won','appeal_lost')),
  days_to_payment integer CHECK (days_to_payment BETWEEN 0 AND 730),
  is_synthetic    boolean NOT NULL DEFAULT false
);
CREATE INDEX pool_claims_payer ON pool.claims (payer, plan_type);
CREATE INDEX pool_claims_contributor ON pool.claims (contributor);

CREATE TABLE pool.claim_lines (
  id       bigserial PRIMARY KEY,
  claim_id uuid NOT NULL REFERENCES pool.claims (id) ON DELETE CASCADE,
  cdt      varchar(5) NOT NULL CHECK (cdt ~ '^D[0-9]{4}$'),
  denied   boolean NOT NULL,
  carcs    text[] NOT NULL DEFAULT '{}' CHECK (array_to_string(carcs, ',') ~ '^([A-Z]{2}-[A-Z0-9]{1,5}(,|$))*$'),
  rarcs    text[] NOT NULL DEFAULT '{}' CHECK (array_to_string(rarcs, ',') ~ '^([A-Z]{1,2}[0-9]{1,4}(,|$))*$')
);
CREATE INDEX pool_lines_cdt ON pool.claim_lines (cdt);
CREATE INDEX pool_lines_claim ON pool.claim_lines (claim_id);

GRANT USAGE ON SCHEMA pool TO claimhive_pool;
-- No UPDATE: a changed claim is replaced (delete + insert), so rows are never edited in place.
GRANT SELECT, INSERT, DELETE ON pool.claims, pool.claim_lines TO claimhive_pool;
GRANT USAGE, SELECT ON SEQUENCE pool.claim_lines_id_seq TO claimhive_pool;

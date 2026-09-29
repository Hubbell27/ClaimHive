-- AlterTable
ALTER TABLE "claims" ADD COLUMN     "appeal_argument" TEXT,
ADD COLUMN     "appeal_attachments" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "appeal_rule_key" TEXT,
ADD COLUMN     "appeal_sent_at" DATE;

-- AlterTable
ALTER TABLE "practices" ADD COLUMN     "pool_consent_offered" TEXT;


ALTER TABLE claims ADD CONSTRAINT claims_appeal_argument_check CHECK (appeal_argument IS NULL OR appeal_argument IN
  ('documentation','medical_necessity','coding_correction','frequency_exception','coverage_dispute','other'));

-- ================================================================ pool: consent v2 fields
-- Shared only by practices that accepted consent version 2026-09-v2 (see deidentify.ts).
ALTER TABLE pool.claims
  ADD COLUMN appeal_attachments text[] NOT NULL DEFAULT '{}' CHECK (appeal_attachments <@ ARRAY['xray','narrative','perio_chart','photo']),
  ADD COLUMN appeal_argument text CHECK (appeal_argument IS NULL OR appeal_argument IN
    ('documentation','medical_necessity','coding_correction','frequency_exception','coverage_dispute','other'));
-- 1 = first time this procedure was billed for the patient in 12 months, 2 = second, 3 = third or more.
ALTER TABLE pool.claim_lines ADD COLUMN freq_bucket smallint CHECK (freq_bucket IS NULL OR freq_bucket BETWEEN 1 AND 3);

-- ================================================================ pool: rules found by the intelligence engine
-- Aggregates only (every number behind a rule meets the 5-practice minimum). Rebuilt as a whole.
CREATE TABLE pool.rules (
  id          bigserial PRIMARY KEY,
  rule_key    text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('missing_attachment','billed_with','frequency','usually_denied')),
  payer       text NOT NULL,
  plan_type   text,
  cdt         varchar(5) NOT NULL,
  stats       jsonb NOT NULL,
  is_synthetic boolean NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (is_synthetic, rule_key)
);
CREATE INDEX pool_rules_lookup ON pool.rules (is_synthetic, payer, cdt);
GRANT SELECT, INSERT, DELETE ON pool.rules TO claimhive_pool;
GRANT USAGE, SELECT ON SEQUENCE pool.rules_id_seq TO claimhive_pool;

-- Whether a pool record carries the v2 fields (its practice accepted consent 2026-09-v2).
-- Appeal-fix statistics use only these records, so "no fix recorded" is never mistaken for "no fix made".
ALTER TABLE pool.claims ADD COLUMN extended boolean NOT NULL DEFAULT false;

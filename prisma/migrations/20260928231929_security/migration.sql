-- ClaimHive security layer: privileges, row-level security, append-only audit.
--
-- The application connects as the NON-OWNER role `claimhive_app`. Tables are
-- owned by the migration role. RLS is FORCED on PHI tables so the policies
-- apply to every role, including the owner.

-- 1. Privileges for the app role ------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'claimhive_app') THEN
    CREATE ROLE claimhive_app LOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO claimhive_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO claimhive_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO claimhive_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO claimhive_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO claimhive_app;
-- The app may only append to and read the audit trail.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM claimhive_app;
REVOKE ALL ON _prisma_migrations FROM claimhive_app;

-- 2. Tenant context helpers ------------------------------------------------------
-- Set per transaction by the app: SELECT set_config('app.practice_id', '<uuid>', true)
CREATE OR REPLACE FUNCTION app_practice_id() RETURNS uuid
  LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.practice_id', true), '')::uuid $$;

-- 3. Row-level security on PHI tables -------------------------------------------
-- No context => no rows. There is deliberately NO admin bypass: ClaimHive
-- staff never see a practice's PHI through the application.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['patients', 'claims', 'claim_lines', 'denials'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (practice_id = app_practice_id()) '
                   'WITH CHECK (practice_id = app_practice_id())', t);
  END LOOP;
END $$;

-- Child rows must belong to the same practice as their parent claim.
CREATE OR REPLACE FUNCTION enforce_same_practice() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_practice uuid;
BEGIN
  SELECT practice_id INTO parent_practice FROM claims WHERE id = NEW.claim_id;
  IF parent_practice IS DISTINCT FROM NEW.practice_id THEN
    RAISE EXCEPTION 'cross-practice reference rejected';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER claim_lines_same_practice BEFORE INSERT OR UPDATE ON claim_lines
  FOR EACH ROW EXECUTE FUNCTION enforce_same_practice();
CREATE TRIGGER denials_same_practice BEFORE INSERT OR UPDATE ON denials
  FOR EACH ROW EXECUTE FUNCTION enforce_same_practice();

CREATE OR REPLACE FUNCTION enforce_claim_patient_practice() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p uuid;
BEGIN
  SELECT practice_id INTO p FROM patients WHERE id = NEW.patient_id;
  IF p IS DISTINCT FROM NEW.practice_id THEN
    RAISE EXCEPTION 'cross-practice reference rejected';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER claims_same_practice BEFORE INSERT OR UPDATE ON claims
  FOR EACH ROW EXECUTE FUNCTION enforce_claim_patient_practice();

-- 4. Append-only audit trail -----------------------------------------------------
CREATE OR REPLACE FUNCTION audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END $$;
CREATE TRIGGER audit_no_update_delete BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();

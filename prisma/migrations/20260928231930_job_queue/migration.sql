-- Background job queue (pg-boss) lives in its own schema owned by the app role.
-- Job payloads must carry ids only, never PHI.
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION claimhive_app;

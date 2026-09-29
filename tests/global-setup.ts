/**
 * Recreate the dedicated TEST database before the suite: drop its schemas and
 * re-apply every migration with `prisma migrate deploy` (a non-destructive command).
 * Hard safety check: refuses to run against any database whose name does not end
 * in "_test", so it can never wipe a development or production database.
 */
import { execSync } from "node:child_process";
import pg from "pg";

const DEFAULT = "postgresql://intake@localhost:5433/claimhive_test?host=/var/tmp/intake-pg";

export default async function setup() {
  const url = process.env.TEST_MIGRATION_DATABASE_URL ?? DEFAULT;
  const dbName = new URL(url.replace(/^postgresql:/, "http:")).pathname.slice(1);
  if (!dbName.endsWith("_test")) throw new Error(`refusing to reset non-test database "${dbName}"`);

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; DROP SCHEMA IF EXISTS pool CASCADE; CREATE SCHEMA public;");
  await client.end();
  execSync("npx prisma migrate deploy", { env: { ...process.env, MIGRATION_DATABASE_URL: url }, stdio: "pipe" });
}

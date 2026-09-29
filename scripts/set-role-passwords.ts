/**
 * Deployment: gives the app and pool database roles their passwords (the
 * migrations create them without one). Runs as the owner, after migrations:
 *   APP_DB_PASSWORD=... POOL_DB_PASSWORD=... npx tsx scripts/set-role-passwords.ts
 * Values come from Secrets Manager; nothing is printed.
 */
import "dotenv/config";
import pg from "pg";

const url = process.env.MIGRATION_DATABASE_URL;
const app = process.env.APP_DB_PASSWORD, pool = process.env.POOL_DB_PASSWORD;
if (!url || !app || !pool || app.length < 24 || pool.length < 24) {
  console.error("Set MIGRATION_DATABASE_URL, APP_DB_PASSWORD and POOL_DB_PASSWORD (24+ characters).");
  process.exit(1);
}
const c = new pg.Client({ connectionString: url });
await c.connect();
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`; // ALTER ROLE takes no bind parameters
await c.query(`ALTER ROLE claimhive_app WITH LOGIN PASSWORD ${lit(app)}`);
await c.query(`ALTER ROLE claimhive_pool WITH LOGIN PASSWORD ${lit(pool)}`);
await c.end();
console.log("Role passwords set.");

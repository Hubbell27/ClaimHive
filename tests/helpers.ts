import pg from "pg";

/** Superuser/owner connection for assertions the app role must NOT be able to make. */
export async function ownerQuery(sql: string, params: unknown[] = []) {
  const client = new pg.Client({
    connectionString: process.env.TEST_MIGRATION_DATABASE_URL ??
      "postgresql://intake@localhost:5433/claimhive_test?host=/var/tmp/intake-pg",
  });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

/** Raw connection as the application role, outside any tenant context. */
export async function appQuery(sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

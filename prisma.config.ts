import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Migrations run as the database OWNER role; the app connects as a
  // non-owner role (DATABASE_URL) so row-level security always applies.
  datasource: { url: env("MIGRATION_DATABASE_URL") },
});

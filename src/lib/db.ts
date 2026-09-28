/**
 * Database access with tenant isolation.
 *
 * PHI tables are protected by PostgreSQL row-level security. Every query that
 * touches them must run inside `withPractice(practiceId, tx => ...)`, which
 * opens a transaction and sets `app.practice_id` for that transaction only
 * (SET LOCAL semantics). Outside that context the policies return no rows and
 * reject writes, so a forgotten filter fails closed instead of leaking data.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;
export type TenantTx = Tx & { readonly practiceId: string };

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function prisma(): PrismaClient {
  if (!globalForPrisma.prisma) {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    globalForPrisma.prisma = new PrismaClient({ adapter, log: [] });
  }
  return globalForPrisma.prisma;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withPractice<T>(practiceId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  if (!UUID.test(practiceId)) throw new Error("invalid practice id");
  return prisma().$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.practice_id', ${practiceId}, true)`;
      return fn(Object.assign(tx, { practiceId }) as TenantTx);
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}

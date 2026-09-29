import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/** Load balancer health check: the app is up and can reach the database. No details returned. */
export async function GET() {
  try {
    await prisma().$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}

/**
 * Server-side sessions. The browser holds only a random token in an httpOnly,
 * Secure, SameSite=Lax cookie; the database stores its SHA-256.
 *
 * Idle timeout 15 minutes, absolute lifetime 12 hours, revocable per session or
 * per user (password change, disable, admin reset).
 */
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "../db";

export const COOKIE = "ch_session";
export const IDLE_MS = 15 * 60 * 1000;
export const ABSOLUTE_MS = 12 * 60 * 60 * 1000;

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await prisma().session.create({
    data: { tokenHash: sha256(token), userId, expiresAt: new Date(Date.now() + ABSOLUTE_MS) },
  });
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ABSOLUTE_MS / 1000,
  });
  return token;
}

export async function findSession(token: string | undefined) {
  if (!token) return null;
  const s = await prisma().session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!s || s.revokedAt || s.expiresAt < new Date()) return null;
  if (Date.now() - s.lastSeenAt.getTime() > IDLE_MS) return null;
  if (s.user.disabledAt) return null;
  return s;
}

export async function currentSession() {
  const token = (await cookies()).get(COOKIE)?.value;
  const s = await findSession(token);
  if (s && Date.now() - s.lastSeenAt.getTime() > 60_000) {
    await prisma().session.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } });
  }
  return s;
}

export async function revokeCurrent(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) {
    await prisma().session.updateMany({ where: { tokenHash: sha256(token) }, data: { revokedAt: new Date() } });
  }
  jar.delete(COOKIE);
}

export async function revokeAllForUser(userId: string, exceptSessionId?: string): Promise<void> {
  await prisma().session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { NOT: { id: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
}

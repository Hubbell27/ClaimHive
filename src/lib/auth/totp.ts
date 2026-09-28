/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) with one step of clock drift and replay protection. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const STEP = 30;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newSecret(): string {
  const bytes = randomBytes(20);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function decode(secret: string): Buffer {
  let bits = "";
  for (const c of secret.replace(/=+$/, "").toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, "0");
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const value = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return value.toString().padStart(6, "0");
}

export function currentStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / STEP);
}

/** Returns the matched step (store it to block reuse), or null. */
export function verifyCode(secret: string, code: string, lastStep: bigint | null, nowMs = Date.now()): number | null {
  const digits = code.replace(/\D/g, "");
  if (digits.length !== 6) return null;
  const now = currentStep(nowMs);
  for (const step of [now - 1, now, now + 1]) {
    if (lastStep !== null && BigInt(step) <= lastStep) continue;
    const expected = Buffer.from(codeAt(secret, step));
    if (timingSafeEqual(expected, Buffer.from(digits))) return step;
  }
  return null;
}

export function otpauthUri(secret: string, account: string): string {
  const issuer = "ClaimHive";
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}` +
    `&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;
}

import { hash, verify } from "@node-rs/argon2";

// OWASP-recommended argon2id parameters.
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
// A valid hash of a random value, used to equalize timing for unknown accounts.
let dummy: string | null = null;

export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, OPTS);
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    dummy ??= await hash(crypto.randomUUID(), OPTS);
    await verify(dummy, password).catch(() => false);
    return false;
  }
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

export function passwordProblem(pw: string): string | null {
  if (pw.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) return "Use at least three of: lowercase, uppercase, numbers, symbols.";
  return null;
}

export function temporaryPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const s = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}!`;
}

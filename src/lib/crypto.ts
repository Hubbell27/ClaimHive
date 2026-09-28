/**
 * Field-level encryption for PHI.
 *
 * Each practice has its own 256-bit data-encryption key (DEK), stored only in
 * wrapped form (practices.data_key_wrapped). The master key that wraps DEKs
 * comes from a KeyProvider: a local key in development, AWS KMS in production.
 *
 * Ciphertext format (bytes): version(1) | nonce(12) | AES-256-GCM ciphertext+tag.
 * Associated data binds each value to its practice, table, column and row, so a
 * ciphertext copied to another row or practice fails to decrypt.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { isRealDeployment } from "./env";

const VERSION = 1;

export interface KeyProvider {
  wrap(dek: Buffer): Promise<Sealed>;
  unwrap(wrapped: Uint8Array): Promise<Buffer>;
  /** Key for platform-level secrets (e.g. staff TOTP seeds), never a practice's PHI. */
  platformKey(): Promise<Buffer>;
}

/** Development/test only: wraps DEKs with a static master key from MASTER_KEY. */
export class LocalKeyProvider implements KeyProvider {
  private readonly master: Buffer;
  constructor(masterKeyB64: string) {
    this.master = Buffer.from(masterKeyB64, "base64");
    if (this.master.length !== 32) throw new Error("MASTER_KEY must be base64 of 32 bytes");
  }
  async wrap(dek: Buffer) {
    return seal(this.master, dek, "dek-wrap");
  }
  async unwrap(wrapped: Uint8Array) {
    return open(this.master, Buffer.from(wrapped), "dek-wrap");
  }
  async platformKey() {
    return Buffer.from(hkdfSync("sha256", this.master, "claimhive", "claimhive/platform", 32));
  }
}

let provider: KeyProvider | null = null;

export function keyProvider(): KeyProvider {
  if (provider) return provider;
  const mode = process.env.KEY_PROVIDER ?? "local";
  if (mode === "local") {
    if (isRealDeployment()) throw new Error("KEY_PROVIDER=local is not allowed in a real deployment");
    provider = new LocalKeyProvider(process.env.MASTER_KEY ?? "");
  } else {
    // AWS KMS provider is added with the deployment work (Phase 8).
    throw new Error(`key provider "${mode}" not configured`);
  }
  return provider;
}

export function setKeyProviderForTests(p: KeyProvider | null) {
  provider = p;
}

/** Ciphertext as stored in Prisma `Bytes` columns (a plain, non-shared ArrayBuffer). */
export type Sealed = Uint8Array<ArrayBuffer>;

function seal(key: Buffer, plaintext: Buffer, aad: string): Sealed {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const out = new Uint8Array(1 + nonce.length + ct.length);
  out[0] = VERSION;
  out.set(nonce, 1);
  out.set(ct, 1 + nonce.length);
  return out;
}

function open(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (blob[0] !== VERSION) throw new Error("unsupported ciphertext version");
  const nonce = blob.subarray(1, 13);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(13, blob.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export async function newPracticeKey(): Promise<{ dek: Buffer; wrapped: Sealed }> {
  const dek = randomBytes(32);
  return { dek, wrapped: await keyProvider().wrap(dek) };
}

/** A practice's unwrapped keys, derived per purpose from the DEK. */
export class PracticeKeys {
  private readonly encKey: Buffer;
  private readonly indexKey: Buffer;
  constructor(readonly practiceId: string, dek: Buffer) {
    this.encKey = Buffer.from(hkdfSync("sha256", dek, practiceId, "claimhive/field-encryption", 32));
    this.indexKey = Buffer.from(hkdfSync("sha256", dek, practiceId, "claimhive/lookup-index", 32));
  }

  private aad(table: string, column: string, rowId: string) {
    return `${this.practiceId}:${table}:${column}:${rowId}`;
  }

  encrypt(table: string, column: string, rowId: string, value: string): Sealed {
    return seal(this.encKey, Buffer.from(value, "utf8"), this.aad(table, column, rowId));
  }

  decrypt(table: string, column: string, rowId: string, blob: Uint8Array): string {
    return open(this.encKey, Buffer.from(blob), this.aad(table, column, rowId)).toString("utf8");
  }

  /** Deterministic keyed hash for exact-match lookup (e.g. last name + DOB). */
  lookupIndex(...parts: string[]): string {
    const norm = parts.map((p) => p.normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase()).join("|");
    return createHmac("sha256", this.indexKey).update(norm).digest("hex");
  }
}

const cache = new Map<string, { keys: PracticeKeys; at: number }>();
const CACHE_MS = 5 * 60 * 1000;

export async function practiceKeys(practiceId: string, wrapped: Uint8Array): Promise<PracticeKeys> {
  const hit = cache.get(practiceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.keys;
  const dek = await keyProvider().unwrap(Buffer.from(wrapped));
  const keys = new PracticeKeys(practiceId, dek);
  dek.fill(0);
  cache.set(practiceId, { keys, at: Date.now() });
  return keys;
}

export function clearKeyCache() {
  cache.clear();
}

/** Platform-level secrets (e.g. TOTP secrets) sealed with a key derived from the master key. */
export async function sealPlatform(value: string, purpose: string): Promise<Sealed> {
  const key = await platformKey();
  return seal(key, Buffer.from(value, "utf8"), `platform:${purpose}`);
}

export async function openPlatform(blob: Uint8Array, purpose: string): Promise<string> {
  const key = await platformKey();
  return open(key, Buffer.from(blob), `platform:${purpose}`).toString("utf8");
}

let platformKeyCache: Buffer | null = null;
async function platformKey(): Promise<Buffer> {
  platformKeyCache ??= await keyProvider().platformKey();
  return platformKeyCache;
}

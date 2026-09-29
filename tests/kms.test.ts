import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DecryptCommand, EncryptCommand } from "@aws-sdk/client-kms";
import { describe, expect, it } from "vitest";
import { KmsKeyProvider, LocalKeyProvider, type KmsLike } from "@/lib/crypto";

/** Behaves like KMS for these calls: ciphertext is bound to the key and the encryption context. */
function fakeKms() {
  const master = randomBytes(32);
  const calls: string[] = [];
  const kms: KmsLike = {
    async send(cmd) {
      const input = cmd.input as { KeyId?: string; Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array; EncryptionContext?: Record<string, string> };
      const aad = Buffer.from(`${input.KeyId}|${JSON.stringify(input.EncryptionContext)}`);
      if (cmd instanceof EncryptCommand) {
        calls.push("encrypt");
        const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", master, iv).setAAD(aad);
        const ct = Buffer.concat([c.update(input.Plaintext!), c.final()]);
        return { CiphertextBlob: new Uint8Array(Buffer.concat([iv, c.getAuthTag(), ct])) };
      }
      if (cmd instanceof DecryptCommand) {
        calls.push("decrypt");
        const b = Buffer.from(input.CiphertextBlob!);
        const d = createDecipheriv("aes-256-gcm", master, b.subarray(0, 12)).setAAD(aad);
        d.setAuthTag(b.subarray(12, 28));
        return { Plaintext: new Uint8Array(Buffer.concat([d.update(b.subarray(28)), d.final()])) };
      }
      throw new Error("unexpected command");
    },
  };
  // A platform key "generated" by KMS, as scripts/generate-platform-key.ts would.
  const makePlatform = async () => {
    const r = await kms.send(new EncryptCommand({ KeyId: "k1", Plaintext: randomBytes(32), EncryptionContext: { app: "claimhive", purpose: "platform-key" } }));
    return Buffer.from(r.CiphertextBlob!).toString("base64");
  };
  return { kms, calls, makePlatform };
}

describe("AWS KMS key provider", () => {
  it("wraps and unwraps practice keys through KMS", async () => {
    const f = fakeKms();
    const p = new KmsKeyProvider(f.kms, "k1", await f.makePlatform());
    const dek = randomBytes(32);
    const wrapped = await p.wrap(dek);
    expect(wrapped[0]).toBe(0x4b);
    expect(Buffer.from(wrapped).includes(dek)).toBe(false);
    expect((await p.unwrap(wrapped)).equals(dek)).toBe(true);
    expect(f.calls).toContain("decrypt");
  });

  it("the platform key is stable and comes from the KMS-encrypted value", async () => {
    const f = fakeKms();
    const platform = await f.makePlatform();
    const a = await new KmsKeyProvider(f.kms, "k1", platform).platformKey();
    const b = await new KmsKeyProvider(f.kms, "k1", platform).platformKey();
    expect(a.equals(b)).toBe(true);
    expect(a).toHaveLength(32);
  });

  it("refuses keys wrapped for another purpose, another KMS key, or by the local provider", async () => {
    const f = fakeKms();
    const p = new KmsKeyProvider(f.kms, "k1", await f.makePlatform());
    const wrapped = await p.wrap(randomBytes(32));
    await expect(new KmsKeyProvider(f.kms, "k2", "").unwrap(wrapped)).rejects.toThrow();
    const local = await new LocalKeyProvider(randomBytes(32).toString("base64")).wrap(randomBytes(32));
    await expect(p.unwrap(local)).rejects.toThrow(/not wrapped by KMS/);
    // A practice key presented as the platform key fails the encryption-context check.
    await expect(new KmsKeyProvider(f.kms, "k1", Buffer.from(wrapped.subarray(1)).toString("base64")).platformKey()).rejects.toThrow();
  });
});

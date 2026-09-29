/**
 * One-time setup for KEY_PROVIDER=kms: asks KMS for a new 256-bit platform key
 * and prints only its KMS-encrypted form. Store the output as the
 * PLATFORM_KEY_WRAPPED secret. The plaintext is never printed or stored.
 *
 *   KMS_KEY_ID=arn:aws:kms:... npx tsx scripts/generate-platform-key.ts
 */
import { GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";

const keyId = process.env.KMS_KEY_ID;
if (!keyId) { console.error("Set KMS_KEY_ID to the ClaimHive app key's ARN."); process.exit(1); }
const r = await new KMSClient({}).send(new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: "AES_256", EncryptionContext: { app: "claimhive", purpose: "platform-key" } }));
r.Plaintext?.fill(0);
console.log(Buffer.from(r.CiphertextBlob!).toString("base64"));

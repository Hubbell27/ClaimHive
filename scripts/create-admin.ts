/** npm run create-admin -- you@claimhive.example "Your Name"  (prints a one-time temporary password) */
import "dotenv/config";
import { hashPassword, temporaryPassword } from "../src/lib/auth/password";
import { prisma } from "../src/lib/db";

const [email, name] = process.argv.slice(2);
if (!email || !name) {
  console.error('usage: npm run create-admin -- email@example.com "Full Name"');
  process.exit(2);
}
// Platform admins must never have practice access (and so never see PHI).
const existing = await prisma().user.findUnique({ where: { email: email.toLowerCase() }, include: { memberships: true } });
if (existing && existing.memberships.length > 0) {
  console.error("refusing: this account belongs to a practice. Platform admins must use a separate account.");
  process.exit(1);
}
const temp = temporaryPassword();
await prisma().user.upsert({
  where: { email: email.toLowerCase() },
  create: { email: email.toLowerCase(), name, passwordHash: await hashPassword(temp), isPlatformAdmin: true },
  update: { isPlatformAdmin: true, passwordHash: await hashPassword(temp), mustChangePassword: true, totpEnabled: false, totpSecretEnc: null, totpLastStep: null },
});
console.log(`ClaimHive admin ${email} ready. Temporary password (shown once): ${temp}`);
process.exit(0);

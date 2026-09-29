/**
 * npm run seed:synthetic -- [practices=8] [patientsPerPractice=150]
 * Loads a synthetic dataset and creates demo owner + biller logins for the
 * first practice (temporary passwords printed once). Development only.
 */
import "dotenv/config";
import { hashPassword, temporaryPassword } from "../src/lib/auth/password";
import { prisma } from "../src/lib/db";
import { loadSyntheticDataset } from "../src/lib/synthetic/load";
import { decidePool } from "../src/lib/pool/sync";
import { rebuildRules } from "../src/lib/intel/engine";
import { isRealDeployment } from "../src/lib/env";

if (isRealDeployment()) throw new Error("synthetic seeding is disabled in a real deployment");
const practices = Number(process.argv[2] ?? 12);
const patientsPerPractice = Number(process.argv[3] ?? 450);
const r = await loadSyntheticDataset({ practices, patientsPerPractice, seed: 2026 });
console.log(`Loaded ${r.practices.length} practices, ${r.patients} patients, ${r.claims} claims, ${r.denials} denials.`);
const first = r.practices[0];
// A made-up letterhead for the demo practice so appeal letters can be approved (555 numbers; valid-format NPI).
await prisma().practice.update({ where: { id: first.id }, data: {
  addressLine1: "100 Example Street", city: "Example City", zip: "00000", phone: "555-010-0100",
  npi: "1234567893", signerName: "Demo Biller", signerTitle: "Billing Coordinator",
} });
// Other synthetic practices share with the pool, so patterns clear the 5-practice minimum.
// The demo practice is left undecided: its owner sees the onboarding consent screen.
const system = { userId: "00000000-0000-0000-0000-000000000000", email: "seed-script" };
for (const p of r.practices.slice(1)) await decidePool({ ...system, practiceId: p.id }, true, { runNow: true });
console.log(`${r.practices.length - 1} synthetic practices are sharing with the pool.`);
console.log(`Denial intelligence: ${await rebuildRules(true)} rules found in the synthetic pool.`);
for (const [role, email] of [["owner", "owner@demo.claimhive.test"], ["biller", "biller@demo.claimhive.test"]] as const) {
  const temp = temporaryPassword();
  const user = await prisma().user.upsert({
    where: { email },
    create: { email, name: role === "owner" ? "Demo Owner" : "Demo Biller", passwordHash: await hashPassword(temp) },
    // Re-seeding fully resets the demo logins (password and MFA enrolment).
    update: { passwordHash: await hashPassword(temp), mustChangePassword: true, totpEnabled: false, totpSecretEnc: null, totpLastStep: null, failedLogins: 0, lockedUntil: null },
  });
  await prisma().membership.upsert({
    where: { userId_practiceId: { userId: user.id, practiceId: first.id } },
    create: { userId: user.id, practiceId: first.id, role }, update: { role },
  });
  // Re-seeding: the demo logins only see the newest demo practice.
  await prisma().membership.deleteMany({ where: { userId: user.id, practiceId: { not: first.id } } });
  console.log(`${role}: ${email}  temporary password: ${temp}  (practice: ${first.name})`);
}
process.exit(0);

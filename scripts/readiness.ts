/**
 * Pre-real-data checks for a deployment (run in the migrate task or by hand):
 *   npm run readiness
 * Exits non-zero if any automated check fails.
 */
import "dotenv/config";
import { automatedChecks, MANUAL_ITEMS } from "../src/lib/readiness";

const checks = await automatedChecks();
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.title}: ${c.detail}`);
console.log("\nConfirm by hand (docs/PILOT_CHECKLIST.md):");
for (const m of MANUAL_ITEMS) console.log(`  [ ] ${m}`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);

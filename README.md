# ClaimHive

Dental insurance denial intelligence for small practices, by ClaimHive Inc.
ClaimHive learns from pooled, de-identified denial data across practices,
catches likely denials before a claim is submitted, drafts appeals for staff to
review, and is paid on a contingency of money recovered.

> **Development status:** Phase 7 (recovery tracking and billing). **Synthetic data
> only.** No real patient data exists in, or may be loaded into, any development
> or test environment.

## What Phase 1 includes

- Multi-tenant practices with isolation enforced by PostgreSQL row-level security
- Built-in accounts: argon2id passwords, mandatory TOTP MFA, lockout, forced password change
- Roles: **owner** (dentist), **biller** (office manager) and **platform admin** (ClaimHive staff, with no access to patient data)
- Field-level encryption of patient data with a separate key for each practice
- Append-only audit log of every view, edit and export of patient data
- Logs and error messages that never contain patient data
- Synthetic data generator: fictional payers with hidden denial rules for later phases to discover
- Money dashboard: amount denied, still recoverable, recovered, lost, and the biggest causes

## What Phase 2 adds

- **Imports:** insurance aging reports (CSV or Excel) from any practice management system, with a column-mapping screen that's remembered per layout; 835 remittances; 837D claim files; and EOB PDFs, read locally with uncertain fields sent to a review queue
- Everything is merged into one claim model: payer, plan type, CDT codes, tooth/surface, attachments, billed, paid, denial codes (CARC/RARC), dates and appeal status
- **Results page:** dollars recovered and protected, how each was won (with evidence), by insurer, and a monthly PDF with no patient details. Only recovered money through ClaimHive is billable; protected money is shown, never billed
- **Sample files:** in development, the Imports page offers synthetic sample files to try every importer end to end

## What Phase 3 adds

- **A de-identified pool** (HIPAA Safe Harbor): only the payer, plan type, state, CDT codes, attachments, denial codes, outcome and days to payment are shared, with no names, IDs or dates; it lives in its own schema, reached by its own database role
- **Consent at onboarding:** each practice owner decides once, before using the app, and can change the decision in Settings. Opting in shares the last 12 months plus new claims; opting out deletes everything shared
- **5-practice minimum:** a pattern is shown only when at least 5 practices contributed to it
- **Insurer patterns page:** denial rates by insurer and procedure, with the evidence behind each, for practices that share
- **Admin pool health:** record counts per payer and per code

## What Phase 4 adds

- **Rules found in the pool, with evidence:** for example, "BlueHarbor Dental denies D2740 73% of the time without an X-ray (n=41, 11 practices), vs 0% with one." It covers missing attachments, bundling, frequency limits and "usually denied" procedures, with 95% ranges and sample sizes, using transparent statistics only
- **A strict bar:** ≥30 procedures from ≥5 practices on each side, and a gap of ≥15 points even at the cautious end of the range
- **Which appeal fixes win:** for example, "Appeals that sent the missing periodontal chart won 60% vs 14% without"
- **On your own claims:** denied claims show the likely cause and the winning fix; the claim page records what each appeal included, and recoveries made with ClaimHive's suggested fix are credited to ClaimHive
- **Consent update:** practices already sharing are asked once before appeal details and 1/2/3+ frequency buckets are shared

## What Phase 5 adds

- **Check a claim before sending** (Check a claim): type in one claim, or upload the 837D file you're about to send. ClaimHive never sends claims
- **Risk and money at stake:** each claim shows "$421 of $500 at risk", the chance of a denial, and one card per problem with the evidence and the fix
- **Pooled rules for practices that share**, e.g. "Summit Dental Mutual denies D4341 84% of the time without a periodontal chart, vs 2% with one"
- **Basic checks for every practice:** missing tooth numbers or surfaces, duplicates, typical frequency limits, and the filing deadline
- **Fixes are tracked two ways:** the biller ticks "I've attached the perio chart" (the risk is recalculated at once), or ClaimHive notices when the 837 that was actually sent carries the fix
- **Protected money:** when a fixed claim is paid, the paid amount shows on Results as "protected" (shown, never billed)

## What Phase 6 adds

- **Draft an appeal letter from any denied claim:** tick what you're enclosing, pick the argument (ClaimHive pre-fills both from its finding), and add optional notes
- **Only de-identified content goes to the Anthropic API:** the insurer, procedure codes, tooth numbers, fees and denial reasons. The writer uses placeholders such as `{{PATIENT_NAME}}`; patient and practice details are filled in on ClaimHive's servers afterwards. A final check stops the request if a name, date or ID number slipped in (for example in the notes)
- **Without an API key** (and in tests), ClaimHive writes the letter from its own standard wording
- **Human review is mandatory:** the biller edits the letter and approves an exact version. Any later edit needs a new approval. Only an approved letter can be downloaded as a PDF on the practice's letterhead or marked as sent. **ClaimHive never sends anything**
- **Appeals page:** drafted / sent / won / lost, the amount recovered and the win rate. Wins come from 835 payments; recoveries after a ClaimHive letter are credited to ClaimHive
- **Letterhead in Settings** (owners): address, phone, NPI, tax ID and signer

## What Phase 7 adds

- **Contingency billing on recovered money only:** cash an insurer paid after a denial, following a ClaimHive fix or appeal letter. Protected money and recoveries the office made on its own are never billed
- **Rates:** ClaimHive staff set a default rate and optional per-practice rates (e.g. a pilot discount) in the admin console (Billing). Every change is dated and kept, and a recovery is billed at the rate in force the day the money came in
- **Monthly statements:** drafts are built automatically on the 1st. Staff review and issue them, and issued statements are locked by the database. Practices see their rate, what's accruing this month, and every issued statement (Billing)
- **Clawbacks:** when a corrected 835 pays less than money ClaimHive recorded as recovered, the reversal is recorded, and the fee on it is credited on the next statement at the original rate
- **Exports:** PDF invoice and CSV line items for each statement; a QuickBooks Online invoice import file for each month (staff). None contain patient details
- **Ledger fixes:** a second partial payment on the same claim is now its own recovery (it used to be dropped), and Results shows money taken back

## Quick start (local, synthetic data)

Requirements: Node 22+ and PostgreSQL 15+.

```bash
npm install                      # also runs `prisma generate`
cp .env.example .env             # then set MASTER_KEY: openssl rand -base64 32
createdb claimhive
npm run db:migrate               # as the owner role (MIGRATION_DATABASE_URL)
npm run seed:synthetic           # 12 fictional practices; prints demo logins once; builds rules
npm run dev                      # http://localhost:3000
npm run worker                   # background jobs (pg-boss), in a second terminal
```

Sign in with a printed demo login. You'll set up an authenticator app, then
choose a new password.

To create a ClaimHive staff (platform admin) account:
`npm run create-admin -- you@claimhive.example "Your Name"`.

### Two database roles

| Variable | Role | Used by |
|---|---|---|
| `MIGRATION_DATABASE_URL` | Owns the tables | `prisma migrate` only |
| `DATABASE_URL` | `claimhive_app`: not the owner, not a superuser, no `BYPASSRLS` | the app and the worker |
| `POOL_DATABASE_URL` | `claimhive_pool`: the `pool` schema only, with no access to practice data | pool sync, pool queries |

The migrations create `claimhive_app` and `claimhive_pool`. In AWS, give each a password or
IAM authentication.

## Tests

```bash
createdb claimhive_test
npm test          # typecheck with `npm run lint`
```

Tests run against a real PostgreSQL database. Global setup rebuilds the test
database from migrations, and it refuses to touch any database whose name
doesn't end in `_test`. Override the connections with `TEST_MIGRATION_DATABASE_URL`
and `TEST_DATABASE_URL`.

To smoke-test a production build in a browser with synthetic data:

```bash
npm run build && APP_ENV=local npm start
SMOKE_EMAIL=owner@demo.claimhive.test SMOKE_PASSWORD='<temp password>' npm run smoke
```

The smoke test signs in and enrolls MFA, so each demo login can be used for one
smoke run (re-running `npm run seed:synthetic` resets them). Add `SMOKE_BILLING=1` to view the practice's Billing page and download a statement, or `SMOKE_ADMIN=1 SMOKE_BILLING=1` with a staff login (`npm run create-admin`) to build, review and issue statements and export for QuickBooks. Add `SMOKE_APPEALS=1` (worker running) to draft, edit, approve and download an appeal letter and mark it sent. Add `SMOKE_PRECHECK=1` (with `SMOKE_POOL=yes` on a fresh seed and the worker running) to check a claim by hand, tick the fix and check an 837D before sending. Add `SMOKE_INTEL=1` to check rules, rule matches on denied claims and recording an appeal. Add `SMOKE_POOL=1` to walk through the consent screen, the Insurer patterns page and opting out. Add `SMOKE_IMPORTS=1` to import every sample file through the UI,
confirm the mapping, clear the review queue and download the monthly PDF, with
the worker running (`npm run worker`).

## Environment

| Variable | Meaning |
|---|---|
| `APP_ENV` | `local`, `test`, `staging` or `production`. If it isn't set, a production Node build counts as a real deployment. Real deployments refuse local keys and synthetic seeding. |
| `KEY_PROVIDER` | `local` (development, uses `MASTER_KEY`) or `kms` (AWS KMS, arrives with the deployment phase) |
| `MASTER_KEY` | Development only: base64 of 32 random bytes |
| `LOG_LEVEL` | pino level (default `info`; tests are silent) |
| `BILLING_ISSUER_NAME`, `BILLING_ISSUER_ADDRESS`, `BILLING_ISSUER_EMAIL` | ClaimHive's details at the top of statements (default name: ClaimHive Inc.) |
| `ANTHROPIC_API_KEY` | Optional. Turns on the AI letter writer; without it ClaimHive uses its standard letter |
| `ANTHROPIC_MODEL` | Optional. Defaults to `claude-opus-5-5` |
| `ANTHROPIC_BAA` | Production only: set to `signed` once the agreement with Anthropic is in place. Until then, real practices get the standard letter. In development, only synthetic practices use the API |

## Before a real pilot (tracked, not yet done)

- [ ] AWS deployment under a signed HIPAA BAA; KMS key provider; RDS encryption and TLS enforced
- [ ] ADA license for CDT code descriptors (the labels here are ClaimHive's own paraphrases)
- [ ] Nonce-based Content-Security-Policy, replacing `'unsafe-inline'` scripts
- [ ] Anthropic API use under a signed BAA (and zero data retention if available) before setting `ANTHROPIC_BAA=signed`. The code already sends de-identified content only
- [ ] Real contingency terms in the admin console (the seed's 20% is a development default) and ClaimHive's billing details (`BILLING_ISSUER_*`)
- [ ] Security review / penetration test; backup and restore drill; incident response runbook

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): system design, the security model and the reasoning behind the main decisions

# ClaimHive

Dental insurance denial intelligence for small practices, by ClaimHive Inc.
ClaimHive learns from pooled, de-identified denial data across practices,
catches likely denials before a claim is submitted, drafts appeals for staff to
review, and is paid on a contingency of money recovered.

> **Development status:** Phase 3 (de-identification and the shared pool). **Synthetic data
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

## Quick start (local, synthetic data)

Requirements: Node 22+ and PostgreSQL 15+.

```bash
npm install                      # also runs `prisma generate`
cp .env.example .env             # then set MASTER_KEY: openssl rand -base64 32
createdb claimhive
npm run db:migrate               # as the owner role (MIGRATION_DATABASE_URL)
npm run seed:synthetic           # prints demo owner/biller temporary passwords once
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
smoke run. Add `SMOKE_POOL=1` to walk through the consent screen, the Insurer patterns page and opting out. Add `SMOKE_IMPORTS=1` to import every sample file through the UI,
confirm the mapping, clear the review queue and download the monthly PDF, with
the worker running (`npm run worker`).

## Environment

| Variable | Meaning |
|---|---|
| `APP_ENV` | `local`, `test`, `staging` or `production`. If it isn't set, a production Node build counts as a real deployment. Real deployments refuse local keys and synthetic seeding. |
| `KEY_PROVIDER` | `local` (development, uses `MASTER_KEY`) or `kms` (AWS KMS, arrives with the deployment phase) |
| `MASTER_KEY` | Development only: base64 of 32 random bytes |
| `LOG_LEVEL` | pino level (default `info`; tests are silent) |

## Before a real pilot (tracked, not yet done)

- [ ] AWS deployment under a signed HIPAA BAA; KMS key provider; RDS encryption and TLS enforced
- [ ] ADA license for CDT code descriptors (the labels here are ClaimHive's own paraphrases)
- [ ] Nonce-based Content-Security-Policy, replacing `'unsafe-inline'` scripts
- [ ] Anthropic API use under an appropriate agreement, sending de-identified content only (Phase 6)
- [ ] Security review / penetration test; backup and restore drill; incident response runbook

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): system design, the security model and the reasoning behind the main decisions

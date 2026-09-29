# ClaimHive architecture

This document describes what exists (Phases 1–4) and the reasoning behind it.
It is updated at the end of every phase.

## System overview

```
 Browser ──HTTPS──▶ Next.js (App Router, server components + server actions)
                      │  session cookie → user → membership → role → permission
                      │  withPractice(practiceId): one transaction, app.practice_id set
                      ▼
                 PostgreSQL ◀── pg-boss worker (same DB, schema "pgboss")
                   • row-level security on every PHI table
                   • PHI columns stored as AES-256-GCM ciphertext
                   • append-only audit_events
```

- **One Next.js app** serves the practice UI (`/app/*`), the ClaimHive staff
  console (`/admin`) and a few route handlers (`/api/*`). Mutations are server
  actions, so there's no separate public API to secure yet.
- **One worker process** (`npm run worker`) handles background jobs from
  pg-boss. Job payloads hold ids and options only, never PHI.
- **One PostgreSQL database.** It holds the jobs too, so there's no Redis to run,
  and jobs can be enqueued inside the same transaction as the data they refer to.

Source layout:

| Path | Purpose |
|---|---|
| `prisma/schema.prisma`, `prisma/migrations/` | Data model; security migration (RLS, grants, triggers) |
| `src/lib/crypto.ts` | Key hierarchy, field encryption, lookup index |
| `src/lib/db.ts` | Prisma client; `withPractice` tenant context |
| `src/lib/auth/*` | Passwords, TOTP, sessions, RBAC |
| `src/lib/audit.ts`, `src/lib/logger.ts` | Audit trail; PHI-free logging |
| `src/lib/phi.ts` | The only module that reads or writes patient identifiers (always audited) |
| `src/lib/money.ts` | Dollar figures shown on the dashboard |
| `src/lib/ingest/*` | Importers (aging, 835, 837D, EOB PDF), merge, pipeline |
| `src/lib/results/*` | Results ledger, reporting periods, monthly PDF |
| `src/lib/intel/*` | Denial intelligence: statistics, rule engine, plain-English explanations, matching rules to claims |
| `src/lib/pool/*` | De-identification, the pool store (own role), sync/opt-in/opt-out, contributor-only insights |
| `src/lib/synthetic/*` | Synthetic data generator and loader |
| `src/lib/actions/*` | Server actions (auth, practice, admin, imports) |
| `src/worker/` | Background job worker |
| `tests/` | Vitest suites that run against a real PostgreSQL |

## Tenancy: one database with row-level security

Every PHI table (`patients`, `claims`, `claim_lines`, `denials`) has a
`practice_id` and a `FORCE`d RLS policy:

```sql
USING (practice_id = app_practice_id()) WITH CHECK (practice_id = app_practice_id())
```

- `app_practice_id()` reads the transaction-local setting `app.practice_id`.
  `withPractice()` sets it with `set_config(..., true)` at the start of a
  transaction, so the setting can't leak to another request that reuses the
  pooled connection.
- **No context means no rows.** Forgetting `withPractice` fails closed.
- The app connects as `claimhive_app`, which isn't the table owner, isn't a
  superuser and doesn't have `BYPASSRLS`. The migration role owns the tables,
  and `FORCE` applies the policies to it as well.
- **There's no admin bypass.** ClaimHive staff manage practices, and later the
  de-identified pool and billing. No application path lets them read a
  practice's PHI. Platform admin accounts can't hold memberships:
  `create-admin`, invites and practice creation all refuse, and
  `requirePractice` redirects any admin as a last line of defense.
- Triggers reject a child row whose `practice_id` differs from its parent's
  (claim line or denial vs. claim, claim vs. patient). Under RLS, another
  practice's parent row is invisible, so the check can't be fooled.
- Tests assert all of this against a real database (`tests/tenancy.test.ts`).

**Why not a schema or database per practice?** Small practices mean thousands of
tenants. RLS keeps migrations and pooled analytics simple, and the database
enforces isolation even when the application code has a bug.

## Users, memberships and roles

- A **user** is a person. A **membership** links a user to a practice with a
  role, so one biller can serve several practices. After sign-in, the user
  chooses the active practice, which is stored on the server-side session.
- Roles: **owner** has every practice permission (team, audit log, pool
  opt-in, patients, dashboard). **biller** can work with patients, claims and
  the dashboard, but can't manage the team, see the audit log or change pool
  settings. Permissions are checked on the server in `requirePractice(permission)`;
  the UI hiding links is only a convenience. A denial is audited and shows a
  plain "for practice owners" page.
- **Platform admin** is a flag on the user (ClaimHive staff), kept separate
  from practice roles.

## Authentication

- **Passwords:** argon2id (OWASP parameters, `@node-rs/argon2`). New accounts
  get a one-time temporary password and must change it after MFA. Unknown
  emails still hash against a dummy value so response timing matches.
- **MFA is mandatory:** RFC 6238 TOTP, enrolled at first sign-in with a QR code
  and a manual key. The secret is sealed with a platform key bound to the user
  id. Each 30-second step can be used only once, enforced by an atomic
  conditional update, so a replayed code fails even under concurrency.
- **Lockout:** 5 failures (password or code) lock the account for 15 minutes.
  The counter is incremented atomically.
- **Sessions:** a random 256-bit token is kept in an `HttpOnly`, `SameSite=Lax`
  cookie (`Secure` in production); the database stores only its SHA-256.
  Sessions time out after 15 minutes idle and 12 hours absolute. Changing a
  password revokes the user's other sessions.
- **CSRF:** server actions check `Origin` against `Host`. `Referrer-Policy` is
  `same-origin`, because `no-referrer` makes browsers send `Origin: null` and
  that breaks the check.

## Encryption

Key hierarchy:

```
master key (KeyProvider: local in development, AWS KMS in production)
 ├── wraps each practice's 256-bit DEK   (practices.data_key_wrapped)
 │     ├── HKDF → field-encryption key   (AES-256-GCM)
 │     └── HKDF → lookup-index key       (HMAC-SHA-256)
 └── HKDF → platform key                 (TOTP secrets, other platform secrets)
```

- **Field-level:** patient names, date of birth, member ID and claim number are
  stored as `version | nonce | ciphertext+tag`. The associated data
  `practice:table:column:row` binds each value to its exact place, so a value
  copied to another row, column or practice fails to decrypt.
- **Lookup without decrypting:** `lookup_index` is an HMAC of normalized
  last name + DOB under the practice's own index key. The same patient gets
  unrelated index values at different practices.
- **At rest:** RDS storage encryption (deployment phase), on top of the field
  encryption. **In transit:** TLS everywhere, HSTS, and TLS required on the
  database connection in AWS.
- `KEY_PROVIDER=local` is refused whenever `isRealDeployment()` is true.
  `APP_ENV=local` is the only way to run a production build with local keys.
- Unwrapped DEKs are cached in memory for up to 5 minutes.

## Audit log

- `audit_events` records every patient view, list, create, edit and export; every
  sign-in step (success and failure); every permission denial; and every
  practice, member and admin action. Each event has the actor, practice,
  resource, outcome, IP (the rightmost `X-Forwarded-For` entry behind the ALB),
  user agent and request id.
- It is **append-only**: `UPDATE`/`DELETE`/`TRUNCATE` are revoked from the app
  role, and triggers reject them for every role, owner included.
- Events are written outside the caller's transaction, so a failed or denied
  action is still recorded.
- `details` holds ids, counts, field names and reasons only, never PHI.

## Logs and errors without PHI

- `src/lib/logger.ts` keeps only an allowlist of structured fields. String
  values are scrubbed of anything shaped like an email, phone number, SSN, date
  or long ID. Errors are logged by class and a scrubbed message, never with
  request bodies or arguments.
- Users see a generic error with a reference (Next.js error digest), never
  internal details.
- Tested in `tests/logging.test.ts`.

## Synthetic data

Only synthetic data is used in development and tests. `src/lib/synthetic/generator.ts`
is deterministic for a given seed and produces:

- 7 **fictional** payers, clearly marked `is_synthetic` and using `SYN` ids
- practices, patients (Faker, `SYN`-prefixed member IDs), claims, claim lines
  and denials over a configurable window
- **Hidden denial rules** (R1–R7), for example "Summit Dental Mutual denies
  D4341 without a perio chart 78% of the time (CARC 16 / N706)". Each rule has
  appeal win rates with and without the fix. They give later phases (pattern
  detection, pre-submission checks) a known ground truth to recover.

Synthetic loading refuses to run in a real deployment. The guard is inside
`loadSyntheticDataset`, so every path (seed script, admin button, worker) is
covered.

## Money figures

`src/lib/money.ts` computes, for the last 12 months: dollars denied, still
recoverable (denied, no appeal decision yet, within 180 days), recovered on
appeal, lost for good, and the biggest causes by payer and reason code. The
dashboard leads with these numbers ("always show the money").

## Data ingestion (Phase 2)

```
upload ──▶ detectKind (by content) ──▶ import_batches (file encrypted, keyed fingerprint)
              │ aging report: new layout → mapping screen (confirmed once, remembered)
              ▼
         pg-boss "import.process" ──▶ parser ──▶ NormalizedClaim[] ──▶ mergeClaims ──▶ claims / lines / denials
                                        │ EOB below confidence threshold            └▶ result_events (ledger)
                                        ▼
                                   review_items ──▶ a person confirms/corrects ──▶ mergeClaims
```

**Parsers** (`src/lib/ingest/`) are pure functions that produce one claim shape
(`types.ts`). A field a source doesn't carry stays undefined and is never guessed.

- **835 / 837D** (`x12.ts`) read the delimiters from the ISA segment, so any
  clearinghouse's files parse. 835: CLP/SVC/CAS/LQ/MOA give payment, denials
  and remark codes. Routine adjustments (contractual CO-45, deductible,
  co-insurance, co-pay) are not denials. 837D: CLM/SV3/TOO/PWK give procedures,
  teeth, surfaces and attachments (PWK report types map to X-ray, perio chart,
  narrative, photo). Claim filing indicators map to plan types.
- **Aging reports** (`aging.ts`) accept CSV or Excel from any PM system. A
  synonym list covers how Dentrix, Eaglesoft, Open Dental, Curve, Denticon and
  others label columns. It is a best guess until checked against real exports,
  so a new layout is always confirmed once on the mapping screen, then
  remembered by header signature. Title blocks and totals rows are skipped.
  Rows group into claims by claim number, or by patient + date + carrier.
- **EOB PDFs** (`eob.ts`) are read locally with pdf.js. That build contains no
  `eval`/`new Function` path. The table header tells which money column is
  which. Each field gets a confidence score; below 0.85 the claim goes to the
  review queue, and nothing counts until a person confirms it. Scanned PDFs
  (no text) go straight to review. AWS Textract (under the BAA) will read them
  at deployment.

**Merging** (`merge.ts`) matches on claim number (a keyed hash, since 837 CLM01
equals 835 CLP01). Failing that, it matches on patient + carrier + date of
service. Patients match on last name + DOB, or member ID + last name. Aging
reports without either compare decrypted names only among that carrier's claims
on that date, and an ambiguous match creates a new claim rather than guessing.
Two claims with different claim numbers never merge. Each source owns what it
knows best: the 837 owns procedures and attachments, the 835/EOB owns payment
and denials, and the aging report only fills gaps. A remittance older than the
current one is ignored.

**Security:**
- Uploads are capped at 10 MB and identified by content, not name.
- Excel files are checked for zip bombs (100 MB unpacked limit) before parsing.
- File names and contents are encrypted under the practice key, and the same
  file twice is refused via a keyed fingerprint.
- Stored originals are purged after 90 days by a daily job.
- Problems are recorded as row numbers + codes, never cell contents.
- Viewing file names, mapping samples, review items or claims is audited.

## Results ledger: what ClaimHive recovered and protected

`result_events` records every dollar with its **kind**, **method**, a
PHI-free **explanation** and **evidence** (payer, CDT codes, CARC/RARC, rule,
dates). The results page, the monthly PDF and, in Phase 7, contingency
invoices all read this one table, so they can't disagree.

- **recovered**: money that arrived after a denial. It's billable only when
  `attributed`, meaning it came through a ClaimHive-flagged fix or a ClaimHive
  appeal (`isClaimHiveAttributed`). Phase 2 can only observe payments, so money
  an office recovers on its own is shown as "Recovered by your team" and never
  billed. Phases 5 and 6 supply the attribution links.
- **protected**: a claim flagged before sending, fixed, then paid. It's shown,
  never billed (per the owner's decision).
- A claim paid after a denial keeps its denials as history. The difference is
  credited once per claim and method, so re-importing a remittance can't
  double-count.
- The ledger is append-only: the app role has only SELECT and INSERT (the
  migration explicitly revokes the UPDATE/DELETE that default privileges would
  grant), and a trigger rejects UPDATE for every role. Rows go away only with
  their claim.
- Synthetic practices get demo ledger rows, flagged `is_synthetic` and labeled
  on the page, so the office sees what Phases 5–6 will produce.

The **Results** page and the **monthly PDF** show no patient details
(claim references are ClaimHive's own ids), so an office can share them.

## The de-identified pool (Phase 3)

```
practice data (public schema, RLS)                       pool schema (no practice or patient data)
  claims ──▶ toPoolRecord (allowlist) ──▶ assertSafeHarbor ──▶ pool.claims / pool.claim_lines
     ▲ claims.pool_record_id (random)                           contributor = random practice token
  app role: no access to pool.*                                 pool role: no access to public.*
```

**What's shared** (and nothing else): the payer, the plan type, the region (the
practice's state), CDT codes, attachments present, denial codes (group-CARC and
RARC, per procedure), the outcome (pending, paid, partially paid, denied, appeal
won, appeal lost), and days to payment. Days to payment is a whole-day interval,
capped at 730; no date of any kind is kept.

**Safe Harbor, identifier by identifier** (`src/lib/pool/deidentify.ts`):
- Names, contact details, SSNs, record/plan/account numbers and every other
  direct identifier are never read into a pool record. Records are *built*
  from an allowlist, never copied and filtered.
- Geography goes no smaller than the state. Dates and ages aren't included.
- The pool record id and the contributor token are random UUIDs, not derived
  from any patient or practice data (164.514(c)). Only the practice's own RLS
  tenant row (`claims.pool_record_id`) links back, which is what lets a changed
  claim replace its record and an opt-out remove everything.
- An insurer is named only if **verified**: it arrived with an X12 payer ID
  (835/837) or is curated. A spreadsheet's carrier column never verifies one,
  so a mis-mapped column can't put a person's name in the pool. Claims with
  unverified insurers are held back and counted on the Settings page.
- `assertSafeHarbor` re-checks the exact key set and every value (UUIDs, a US
  state, CDT/CARC/RARC formats, the payer-name shape, the day range) before
  any write. The pool tables repeat the same rules as CHECK constraints.

**Isolation:**
- The pool lives in its own schema, reached only as `claimhive_pool`
  (`POOL_DATABASE_URL`). That role can read, insert and delete pool rows and
  can touch nothing in `public`. The app role has no access to `pool`, so the
  two can't be joined in SQL.
- Rows are never updated in place: a changed claim is deleted and re-inserted.
- The pool can move to a separate database or account at deployment without
  code changes.
- A future hardening step is to split the role into a read-only one for the
  web app and a writer for the worker.

**Consent and lifecycle** (`sync.ts`):
- **Onboarding:** a practice owner is asked once, before using the app, with
  the exact text in `PoolExplainer`. Their yes or no is recorded with the time
  and the consent version (`POOL_CONSENT_VERSION`). Billers are never asked.
  The choice can be changed in Settings.
- **Opt in:** a random contributor token is issued and the last 12 months are
  shared (by date of service, counted from the opt-in date). After every
  import or review, a `pool.sync` job re-shares changed claims. Linking a claim
  uses raw SQL, so it doesn't bump `updated_at`.
- **Opt out:** sharing stops first. Every record under the token is then
  deleted and the deletion verified, the claim links are cleared, and the token
  is discarded. Sync and opt-out take the same per-contributor advisory lock,
  and a sync re-checks consent once it holds that lock, so an in-flight sync
  can't write records back after an opt-out.

**Who sees what:**
- Every query that returns a pattern includes
  `HAVING count(DISTINCT contributor) >= 5` (`MIN_PRACTICES`), so no code path
  can return a pattern from fewer than 5 practices.
- Insurer patterns can be filtered by insurer (or "only insurers my practice
  bills"), procedure code or type, plan type and minimum sample size, and
  sorted. Filters apply before grouping and the 5-practice minimum is checked
  on the filtered group, so narrowing a filter can't expose a smaller group.
  Tested.
- Pooled patterns are shown only to contributing practices (`poolInsights`).
  Everyone always sees their own data.
- Synthetic and live data are never mixed in a query.
- The admin console shows pool health only: record counts per payer and per
  code, with contributor counts and a below-threshold marker.

## Denial intelligence engine (Phase 4)

Transparent statistics only, with no black-box models (`src/lib/intel/`).

**Statistics** (`stats.ts`):
- Rates come with Wilson score 95% intervals.
- Differences between two rates use Newcombe's hybrid score interval.
- Both are tested against published reference values.

**Kinds of rule**, evaluated per insurer × procedure, and per insurer ×
plan type × procedure:
- `missing_attachment`: denied more often when an X-ray, narrative, perio
  chart or photo is missing.
- `billed_with`: bundling. Denied more often when billed with a particular
  other procedure.
- `frequency`: the 2nd time in 12 months compared with the 1st, and the 3rd or
  later compared with earlier ones.
- `usually_denied`: denied most of the time regardless. Shown only where no
  more specific rule explains it.

**The strict bar** (owner's decision): both sides of a comparison need ≥30
procedures from ≥5 practices, and the gap must be ≥15 points at the *lower end
of its 95% interval*. A plan-type rule replaces the insurer-wide one when it's
at least 15 points sharper, so a DHMO-only policy is reported as a DHMO rule.
On synthetic data the engine rediscovers the planted rules and finds no false
ones (tested). Planted rules with too little data stay below the bar, as they
should.

**Which fixes win:** for each rule, the engine compares denied procedures that
were appealed with the fix (the missing attachment, a coding argument, a
frequency exception) against those appealed without it.
- It uses only records from practices that share appeal details (consent v2)
  and that recorded what the appeal included, so "not recorded" never counts
  as "no fix".
- Each side is shown only with ≥10 appeals from ≥5 practices.

**Storage and refresh:**
- Rules are stored in `pool.rules` (aggregates only).
- They're rebuilt after pool syncs (debounced to once per 5 minutes) and
  nightly, and an admin can trigger a rebuild.

**Explanations** (`explain.ts`): every rule states the finding, the evidence
(rate, 95% range, n, practices), the usual denial codes, what to do before
sending, and what wins on appeal. For example: "Summit Dental Mutual denies
D4341 87% of the time without a periodontal chart, vs 3% with one."

**On a practice's own claims** (`match.ts`):
- Denied claims that fit a rule show the likely cause and the winning fix, on
  the Claims list and the claim page. This is for contributing practices only,
  like all pooled insight.
- The claim page records what each appeal included (attachments and argument),
  and whether the office used ClaimHive's suggested fix. That feeds the pool
  (v2) and **attribution**: when a claim appealed with a ClaimHive-suggested
  fix is later paid, the recovery is credited to ClaimHive
  (`isClaimHiveAttributed`). Otherwise it's "recovered by your team".

**Consent v2:**
- It adds what an appeal included, plus a per-procedure frequency bucket
  (1 / 2 / 3+ in 12 months, computed inside the practice; no dates are
  shared).
- Practices that agreed to the original terms are asked once. Until they
  accept, their records carry none of the new fields (`extended = false`,
  validated in `assertSafeHarbor`).

## Pre-submission claim check (Phase 5)

`src/lib/precheck/`. Claims come in two ways: the quick form (`entry.ts`) or an
837D uploaded with purpose `precheck` (`pipeline.ts`). Both go through the
normal merge with `asDraft`, so the claim is stored as a **draft** and uses the
same patient matching and encryption as any import. Drafts are left out of the
money figures and the pool. A draft becomes `submitted` when the biller clicks
"Mark as sent", or when an ordinary 837 with the same claim arrives.

**Scoring** (`check.ts`, `runCheck`), per procedure line:

- **Basic checks** (`basic.ts`, every practice): a missing tooth or surface, a
  duplicate of the same procedure and date, typical frequency limits counted
  from the practice's own history, and the 12-month filing deadline (a warning
  after 300 days). Their probabilities are rough and labelled "typical".
- **Pooled rules** (practices that share only): every Phase 4 rule for the
  insurer that matches the claim, at its measured rate. A pooled frequency rule
  replaces the typical-limit guess for the same line.
- **When nothing matches**, the line gets the insurer's usual denial rate for
  that code. If the claim is on the safe side of a rule (for example, the chart
  is attached), that rule's safe-side rate is used instead. With several rules,
  the lowest rate wins: a looser rule's safe side still includes claims that
  break the stricter one.
- The line's risk is `1 − Π(1 − p)` over its findings; the claim's risk
  combines its lines the same way. **At risk** = Σ fee × line risk (the
  expected loss if it's sent as is).

**Findings** (`check_findings`, RLS like every tenant table) hold one row per
problem, even when it affects several lines. Re-running the check never
re-opens a finding that was fixed or dismissed. An open finding whose problem is
gone becomes `fixed_detected`; if its pooled rule was retired in a rebuild, it
is closed as `dismissed` instead, so it doesn't count as a fix. Ticking a fix
(`markFixed`) writes it to the claim (the attachment, or the tooth and
surfaces) and re-scores. After every ordinary import, `afterImport` re-checks
the claims that have open findings. When a claim with an attachment, code or
data fix is paid, the paid amount on those procedures goes to the results ledger
as `protected` (`attachment_added_before_sending` / `code_fixed_before_sending`,
attributed, never billed). Draft results pages are re-scored on every view,
because rules are rebuilt as the pool grows.

## Appeal letter generator (Phase 6)

`src/lib/appeals/`. The flow is: request → job (`appeal.draft`) → draft → biller edits → approve → PDF / mark sent.

**What a writer sees** (`deidentify.ts`, `buildAppealRequest`) is built from an allowlist: the insurer name (verified insurers only, otherwise "the insurer"), plan type, procedure codes and descriptions, tooth and surfaces, fees and denied amounts, CARC/RARC reasons, the enclosures, the argument, ClaimHive's pooled finding for the rule (numbers only), and the biller's optional notes. There are no names, dates, member IDs, claim numbers, addresses or practice details. The writer is told to use placeholders (`placeholders.ts`) wherever a letter needs them.

**Checked before sending:** `assertNoIdentifiers` runs on the serialized request, right before any writer is called. It looks for date, phone, email, SSN, URL and long-number patterns, and for this letter's own identifiers: the patient's name, member ID, claim number, date of birth, the service and denial dates, and the practice's name, NPI, tax ID, phone and address. If anything matches, the letter fails with `identifier_in_request` and nothing is sent. The error records only the kind of identifier, never the value.

**Writers** (`writers.ts`):
- `anthropicWriter` uses the Anthropic API (`claude-opus-5-5`, medium effort) with server-side refusal fallback (`fallbacks: "default"`). The system prompt is static so it can be cached. Refusal, `max_tokens` and API errors become a failed letter with a plain-English reason, and the biller can retry or switch to the standard letter.
- `templateWriter` is ClaimHive's own wording. It's used when there's no key, in tests, and for any practice whose data may not go to the API yet. `aiAllowed` permits the API for synthetic practices in development, and for real practices only in production with `ANTHROPIC_BAA=signed`.

A returned letter that uses a placeholder ClaimHive doesn't know fails as `unknown_placeholder`.

**Merged locally, stored encrypted:** placeholders are filled from the decrypted claim and the practice profile. Anything ClaimHive doesn't have becomes `[add member ID]` and the like, which blocks approval until the biller fills it in. The writer's text (`template_enc`), the merged letter (`body_enc`) and the notes (`notes_enc`) are AES-GCM encrypted under the practice key.

**Human review:**
- Every save is a new `version` and clears any approval.
- `approveLetter` requires: a complete letterhead, no `[add …]` or `{{…}}` left in the text, an insurer address, and the same version the biller had open. It stores who approved, when, and a SHA-256 of the approved address, text and enclosures.
- A database CHECK makes an approved letter's `approved_version` equal its current `version`.
- The PDF route serves approved letters only. The file name carries no patient details.

**Sending is the biller's job.** "I've sent it" copies the enclosures, argument and rule onto the claim (the same appeal fields Phase 4 learns from) and sets `appeal_letter_id`. When an 835 later shows the payment, the recovery is credited as `appeal_letter` (attributed to ClaimHive).

**Other data rules:**
- There is one live letter per claim; a new request supersedes unsent ones.
- The app role has no DELETE on `appeal_letters`.
- RLS applies as on every tenant table.
- Audit actions: `appeal.request`, `appeal.draft` (writer, model, request size), `appeal.edit` (version), `appeal.approve` (version, hash), `appeal.download` and `appeal.sent`.

## Reference codes

`src/lib/reference/codes.ts` has subsets of CDT, CARC and RARC with ClaimHive's
own short paraphrases. The official CDT descriptors are copyrighted by the ADA
and need a license before production use.

## Decisions log

| Decision | Choice | Why |
|---|---|---|
| Repository | Separate from the patient intake app | Different product, tenants and compliance surface. Integrate later over an API |
| Tenancy | Shared DB + Postgres RLS | Scales to many small practices; isolation enforced by the database |
| Auth | Built-in accounts + TOTP | No third-party identity provider holding user data; MFA required |
| Jobs | pg-boss on Postgres | No extra infrastructure; transactional enqueue |
| Multi-practice users | Memberships | Billing services work for several practices |
| De-identification (Phase 3) | HIPAA Safe Harbor | Clear, auditable rule set |
| Pooling | Explicit opt-in by the owner | Consent is clear and recorded (who, when) |
| PM systems (Phase 2) | Recognize every common system's headers; always confirm a new layout once | Exports vary by version and report; one confirmation beats silent mis-mapping |
| EOB reading (Phase 2) | Local text extraction first; AWS Textract for scans at deployment | Patient data stays on ClaimHive's servers; Textract is covered by the AWS BAA |
| Protected money | Shown, never billed | "Would it have been denied?" is hard to prove; only verified recovered cash is billed |
| Results report | Live page + monthly PDF, no patient details | Easy to show and share the benefit |
| Pool visibility (Phase 3) | Pooled insights only for contributing practices | Fair to those who share; a clear reason to opt in |
| Pool history (Phase 3) | Last 12 months on opt-in, then ongoing | Patterns reach the 5-practice minimum quickly |
| Opt-out (Phase 3) | Delete everything shared | The clearest promise to make at onboarding |
| Pool storage (Phase 3) | Separate schema + role, random contributor token | Can't be joined with practice data; can move to its own database later |
| Rule bar (Phase 4) | Strict: ≥30 from ≥5 practices per side, gap ≥15 points at the lower 95% bound | Fewer, solid rules; false alarms cost trust |
| Appeal-fix data (Phase 4) | New shared fields, re-ask consent | Real evidence for what wins; consent stays explicit |
| Frequency (Phase 4) | Share a 1/2/3+ bucket only | Detects frequency limits without sharing dates |
| Pre-send entry (Phase 5) | Quick form and an 837D upload before sending | The form suits one claim; the 837 checks a whole day's batch |
| Non-sharers (Phase 5) | Basic checks only | Pooled rules stay a reason to share; everyone still gets real value |
| Fix tracking (Phase 5) | The biller's tick plus auto-detection from the sent 837 | Instant feedback, and fixes made in the practice's own software still count |
| AI in development (Phase 6) | Real API when a key is set (synthetic practices only); standard letter otherwise | The whole flow works and is testable without a key; no real data can reach the API before the BAA |
| Letter output (Phase 6) | PDF on the practice's letterhead | Ready to print, fax or upload to a portal |
| Letterhead (Phase 6) | Practice profile in Settings | Entered once by the owner and merged locally, never sent to the AI |
| Approval (Phase 6) | Any biller or owner, of an exact version | Whoever edits approves; the audit log records who approved which version |
| Attribution (Phase 6) | Recoveries after a ClaimHive letter count as ClaimHive's | The letter is ClaimHive's work; this can be revisited when billing is set up in Phase 7 |
| AI drafting (Phase 6) | De-identified content only to the Anthropic API; patient details merged locally; human review required; nothing sent automatically | Keeps PHI out of third-party processing |

## Not yet built (by phase)

7. Recovery tracking and billing. 8. Pilot
readiness (AWS under a BAA, KMS, the pilot checklist in the README).

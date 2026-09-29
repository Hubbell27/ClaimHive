# Before real patient data: pilot checklist

ClaimHive has only ever held synthetic data. Nothing real goes in until every
line below is done. Record who confirmed each item, the date, and where the
evidence is kept.

## 1. Checked by the software

Run `npm run readiness` in the deployment (or open **Admin → Readiness**). Every
line must say PASS.

| Check | How it passes |
|---|---|
| Real deployment | `APP_ENV=production` (or `staging`) |
| Keys from AWS KMS | `KEY_PROVIDER=kms`, `KMS_KEY_ID` and `PLATFORM_KEY_WRAPPED` set, no `MASTER_KEY` |
| Database TLS | `DATABASE_URL` has `sslmode=verify-full` and the RDS CA bundle |
| Secure cookies | `NODE_ENV=production` |
| Restricted database role | The app connects as `claimhive_app`, which owns no tables |
| Row-level security | Forced on every tenant table |
| Append-only audit log | Its triggers are present |
| No synthetic data | A fresh production database (never a copy of development) |
| Real contingency rate | Set in Admin → Billing (not the 20% development default) |
| Billing details | `BILLING_ISSUER_NAME` and `BILLING_ISSUER_ADDRESS` set |
| AI letters | Off, or `ANTHROPIC_BAA=signed` |

## 2. Agreements

| Item | Confirmed by | Date | Evidence |
|---|---|---|---|
| AWS BAA accepted in AWS Artifact for the production account | | | |
| BAA signed with each pilot practice (ClaimHive is their business associate) | | | |
| Anthropic BAA signed, and zero data retention enabled, **before** turning on AI letters | | | |
| Pool consent text and data-sharing terms reviewed by counsel (Safe Harbor de-identification, opt-out deletes shared data) | | | |
| Terms of service and privacy notice published | | | |
| ADA license for CDT descriptors, or confirmation that ClaimHive's labels are its own paraphrases | | | |

## 3. Security

| Item | Confirmed by | Date | Evidence |
|---|---|---|---|
| HIPAA Security Rule risk analysis written, with remediation plan | | | |
| Penetration test or independent security review; high findings fixed | | | |
| Content-Security-Policy tightened to nonce-based scripts (no `'unsafe-inline'`) | | | |
| Staff admin accounts: named individuals only, MFA enrolled, no shared logins | | | |
| AWS root account locked (MFA, no access keys); IAM access via SSO with MFA | | | |
| CloudTrail on (Terraform creates it unless the organization already has one) and alerts reaching a monitored inbox | | | |
| Dependency and image scanning reviewed (ECR scan-on-push, `npm audit`) | | | |

## 4. Operations

| Item | Confirmed by | Date | Evidence |
|---|---|---|---|
| Restore drill: RDS point-in-time restore into a scratch instance, app pointed at it, data readable | | | |
| Incident response and breach-notification runbook, with named contacts and the 60-day HHS/individual notice rules | | | |
| Workforce HIPAA training for everyone with access; quarterly access review on the calendar | | | |
| On-call: who gets the CloudWatch alarms, and what they do | | | |
| Offboarding: removing a practice member or staff account (Team page / admin) is documented | | | |

## 5. The first pilot practice

| Item | Confirmed by | Date |
|---|---|---|
| Practice created by staff; owner invited, temporary password shared out of band | | |
| Owner enrolled MFA and finished Setup (letterhead, billers, imports) | | |
| Pool decision recorded (Settings shows the consent version) | | |
| Contingency rate for the practice agreed in writing and entered (Admin → Billing) | | |
| 12-month report reviewed with the owner | | |
| First monthly statement reviewed by staff before issuing | | |

When every row is filled in, the pilot can start.

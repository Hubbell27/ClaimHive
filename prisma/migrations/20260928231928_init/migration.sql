-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner', 'biller');

-- CreateEnum
CREATE TYPE "PlanType" AS ENUM ('PPO', 'DHMO', 'INDEMNITY', 'MEDICAID', 'MEDICARE_ADVANTAGE');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('draft', 'submitted', 'paid', 'partially_paid', 'denied');

-- CreateEnum
CREATE TYPE "AppealStatus" AS ENUM ('none', 'drafted', 'sent', 'won', 'lost');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "is_platform_admin" BOOLEAN NOT NULL DEFAULT false,
    "totp_secret_enc" BYTEA,
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "totp_last_step" BIGINT,
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ,
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "disabled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMPTZ,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practices" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "state" CHAR(2) NOT NULL,
    "data_key_wrapped" BYTEA NOT NULL,
    "pool_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "pool_opt_in_at" TIMESTAMPTZ,
    "pool_opt_in_by" UUID,
    "is_synthetic" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "practices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "mfa_verified" BOOLEAN NOT NULL DEFAULT false,
    "active_practice_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" UUID,
    "actor_email" TEXT,
    "practice_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'success',
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "payer_code" TEXT NOT NULL,
    "is_synthetic" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "payers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patients" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "first_name_enc" BYTEA NOT NULL,
    "last_name_enc" BYTEA NOT NULL,
    "dob_enc" BYTEA NOT NULL,
    "member_id_enc" BYTEA,
    "lookup_index" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claims" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "payer_id" UUID NOT NULL,
    "plan_type" "PlanType" NOT NULL,
    "claim_number_enc" BYTEA,
    "service_date" DATE NOT NULL,
    "submitted_at" DATE,
    "adjudicated_at" DATE,
    "status" "ClaimStatus" NOT NULL,
    "billed_cents" INTEGER NOT NULL,
    "paid_cents" INTEGER NOT NULL DEFAULT 0,
    "attachments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "appeal_status" "AppealStatus" NOT NULL DEFAULT 'none',
    "recovered_cents" INTEGER NOT NULL DEFAULT 0,
    "is_synthetic" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_lines" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "cdt_code" VARCHAR(5) NOT NULL,
    "tooth" VARCHAR(3),
    "surfaces" VARCHAR(5),
    "fee_cents" INTEGER NOT NULL,
    "paid_cents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "claim_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "denials" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "claim_line_id" UUID,
    "group_code" VARCHAR(2) NOT NULL,
    "carc" VARCHAR(5) NOT NULL,
    "rarc" VARCHAR(6),
    "amount_cents" INTEGER NOT NULL,
    "denied_at" DATE NOT NULL,

    CONSTRAINT "denials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_user_id_practice_id_key" ON "memberships"("user_id", "practice_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "audit_events_practice_id_occurred_at_idx" ON "audit_events"("practice_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_actor_user_id_occurred_at_idx" ON "audit_events"("actor_user_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "payers_name_key" ON "payers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "payers_payer_code_key" ON "payers"("payer_code");

-- CreateIndex
CREATE INDEX "patients_practice_id_lookup_index_idx" ON "patients"("practice_id", "lookup_index");

-- CreateIndex
CREATE INDEX "claims_practice_id_status_idx" ON "claims"("practice_id", "status");

-- CreateIndex
CREATE INDEX "claims_practice_id_service_date_idx" ON "claims"("practice_id", "service_date");

-- CreateIndex
CREATE INDEX "claim_lines_practice_id_cdt_code_idx" ON "claim_lines"("practice_id", "cdt_code");

-- CreateIndex
CREATE INDEX "denials_practice_id_carc_idx" ON "denials"("practice_id", "carc");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_lines" ADD CONSTRAINT "claim_lines_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "denials" ADD CONSTRAINT "denials_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "denials" ADD CONSTRAINT "denials_claim_line_id_fkey" FOREIGN KEY ("claim_line_id") REFERENCES "claim_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

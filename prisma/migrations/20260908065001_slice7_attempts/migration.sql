-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'SCORED', 'RELEASED', 'VOID');

-- CreateEnum
CREATE TYPE "SubmitReason" AS ENUM ('MANUAL', 'TIMEOUT', 'SWEEP');

-- CreateEnum
CREATE TYPE "GradeSource" AS ENUM ('AUTO', 'TEACHER', 'AI_ASSISTED');

-- CreateTable
CREATE TABLE "attempts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "student_user_id" UUID NOT NULL,
    "client_attempt_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL DEFAULT 1,
    "status" "AttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duration_ms" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "submitted_at" TIMESTAMP(3),
    "submit_reason" "SubmitReason",
    "scored_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "raw_score" DECIMAL(6,2),
    "max_score" DECIMAL(6,2),
    "percentage" DECIMAL(5,2),
    "tab_switches" INTEGER NOT NULL DEFAULT 0,
    "device" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attempt_answers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "assessment_question_id" UUID NOT NULL,
    "question_version_id" UUID,
    "response" JSONB,
    "is_correct" BOOLEAN,
    "awarded_marks" DECIMAL(5,2),
    "max_marks" DECIMAL(5,2) NOT NULL,
    "grade_source" "GradeSource",
    "time_spent_seconds" INTEGER NOT NULL DEFAULT 0,
    "visit_count" INTEGER NOT NULL DEFAULT 0,
    "marked_for_review" BOOLEAN NOT NULL DEFAULT false,
    "client_seq" INTEGER NOT NULL DEFAULT 0,
    "answered_at" TIMESTAMP(3),
    "graded_at" TIMESTAMP(3),

    CONSTRAINT "attempt_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_codes" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "code_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attempts_organization_id_assignment_id_status_idx" ON "attempts"("organization_id", "assignment_id", "status");

-- CreateIndex
CREATE INDEX "attempts_organization_id_student_user_id_idx" ON "attempts"("organization_id", "student_user_id");

-- CreateIndex
CREATE INDEX "attempts_status_expires_at_idx" ON "attempts"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "attempts_assignment_id_student_user_id_client_attempt_id_key" ON "attempts"("assignment_id", "student_user_id", "client_attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "attempts_assignment_id_student_user_id_attempt_number_key" ON "attempts"("assignment_id", "student_user_id", "attempt_number");

-- CreateIndex
CREATE INDEX "attempt_answers_organization_id_attempt_id_idx" ON "attempt_answers"("organization_id", "attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "attempt_answers_attempt_id_assessment_question_id_key" ON "attempt_answers"("attempt_id", "assessment_question_id");

-- CreateIndex
CREATE INDEX "login_codes_phone_created_at_idx" ON "login_codes"("phone", "created_at");

-- CreateIndex
CREATE INDEX "login_codes_expires_at_idx" ON "login_codes"("expires_at");

-- AddForeignKey
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

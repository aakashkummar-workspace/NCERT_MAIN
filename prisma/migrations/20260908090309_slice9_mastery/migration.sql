-- CreateEnum
CREATE TYPE "MasteryBand" AS ENUM ('CRITICAL', 'FRAGILE', 'DEVELOPING', 'SECURE', 'INSUFFICIENT');

-- CreateEnum
CREATE TYPE "MasteryTrend" AS ENUM ('IMPROVING', 'STABLE', 'DECLINING', 'UNKNOWN');

-- CreateTable
CREATE TABLE "concept_evidence" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "student_user_id" UUID NOT NULL,
    "concept_id" UUID NOT NULL,
    "attempt_answer_id" UUID NOT NULL,
    "score" DECIMAL(4,3) NOT NULL,
    "difficulty" "Difficulty" NOT NULL,
    "weight" DECIMAL(3,2) NOT NULL DEFAULT 1.0,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "concept_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_concept_mastery" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "student_user_id" UUID NOT NULL,
    "concept_id" UUID NOT NULL,
    "estimate" DECIMAL(4,3),
    "confidence" DECIMAL(4,3),
    "evidence_count" INTEGER NOT NULL,
    "effective_evidence" DECIMAL(6,3) NOT NULL,
    "band" "MasteryBand" NOT NULL,
    "previous_estimate" DECIMAL(4,3),
    "trend" "MasteryTrend" NOT NULL DEFAULT 'UNKNOWN',
    "last_evidence_at" TIMESTAMP(3),
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_concept_mastery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "concept_evidence_organization_id_student_user_id_concept_id_idx" ON "concept_evidence"("organization_id", "student_user_id", "concept_id", "observed_at");

-- CreateIndex
CREATE INDEX "concept_evidence_organization_id_concept_id_idx" ON "concept_evidence"("organization_id", "concept_id");

-- CreateIndex
CREATE UNIQUE INDEX "concept_evidence_attempt_answer_id_concept_id_key" ON "concept_evidence"("attempt_answer_id", "concept_id");

-- CreateIndex
CREATE INDEX "student_concept_mastery_organization_id_concept_id_band_idx" ON "student_concept_mastery"("organization_id", "concept_id", "band");

-- CreateIndex
CREATE INDEX "student_concept_mastery_organization_id_student_user_id_idx" ON "student_concept_mastery"("organization_id", "student_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_concept_mastery_student_user_id_concept_id_key" ON "student_concept_mastery"("student_user_id", "concept_id");

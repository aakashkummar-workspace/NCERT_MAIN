-- CreateEnum
CREATE TYPE "MistakeType" AS ENUM ('CONCEPTUAL', 'PROCEDURAL', 'CARELESS', 'UNATTEMPTED', 'MISREAD', 'TIME_PRESSURE', 'UNCLASSIFIED');

-- CreateEnum
CREATE TYPE "MistakeTypeSource" AS ENUM ('RULE', 'MODEL', 'PENDING');

-- CreateEnum
CREATE TYPE "MistakeStatus" AS ENUM ('UNRESOLVED', 'RETRIED', 'RESOLVED');

-- CreateTable
CREATE TABLE "student_mistakes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "student_user_id" UUID NOT NULL,
    "attempt_answer_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "question_version_id" UUID,
    "concept_id" UUID,
    "mistake_type" "MistakeType" NOT NULL,
    "type_source" "MistakeTypeSource" NOT NULL DEFAULT 'RULE',
    "type_reason" VARCHAR(400),
    "status" "MistakeStatus" NOT NULL DEFAULT 'UNRESOLVED',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_retried_at" TIMESTAMP(3),
    "last_retry_correct" BOOLEAN,
    "resolved_at" TIMESTAMP(3),
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_mistakes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "student_mistakes_attempt_answer_id_key" ON "student_mistakes"("attempt_answer_id");

-- CreateIndex
CREATE INDEX "student_mistakes_organization_id_student_user_id_status_idx" ON "student_mistakes"("organization_id", "student_user_id", "status");

-- CreateIndex
CREATE INDEX "student_mistakes_organization_id_student_user_id_concept_id_idx" ON "student_mistakes"("organization_id", "student_user_id", "concept_id");

-- CreateIndex
CREATE INDEX "student_mistakes_organization_id_mistake_type_type_source_idx" ON "student_mistakes"("organization_id", "mistake_type", "type_source");

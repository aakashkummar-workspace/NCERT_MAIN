-- CreateEnum
CREATE TYPE "QuestionVisibility" AS ENUM ('GLOBAL', 'ORGANIZATION', 'PRIVATE');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('MCQ', 'MULTI_SELECT', 'TRUE_FALSE', 'NUMERIC', 'FILL_BLANK', 'ASSERTION_REASON', 'VSA', 'SA', 'LA', 'CASE_STUDY');

-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');

-- CreateEnum
CREATE TYPE "QuestionStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "QuestionSource" AS ENUM ('MANUAL', 'AI_GENERATED', 'IMPORTED');

-- CreateTable
CREATE TABLE "questions" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "visibility" "QuestionVisibility" NOT NULL DEFAULT 'ORGANIZATION',
    "created_by_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "chapter_id" UUID,
    "primary_outcome_id" UUID,
    "type" "QuestionType" NOT NULL,
    "difficulty" "Difficulty" NOT NULL DEFAULT 'MEDIUM',
    "marks" INTEGER NOT NULL DEFAULT 1,
    "expected_time_seconds" INTEGER,
    "status" "QuestionStatus" NOT NULL DEFAULT 'DRAFT',
    "source" "QuestionSource" NOT NULL DEFAULT 'MANUAL',
    "current_version_id" UUID,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMP(3),
    "rejected_by_id" UUID,
    "rejected_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "content_hash" BYTEA,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_versions" (
    "id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "stem" TEXT NOT NULL,
    "options" JSONB,
    "answerKey" JSONB,
    "explanation" TEXT,
    "hint" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "question_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_outcomes" (
    "question_id" UUID NOT NULL,
    "learning_outcome_id" UUID NOT NULL,
    "weight" DECIMAL(3,2) NOT NULL DEFAULT 1.0,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "question_outcomes_pkey" PRIMARY KEY ("question_id","learning_outcome_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "questions_current_version_id_key" ON "questions"("current_version_id");

-- CreateIndex
CREATE INDEX "questions_organization_id_status_idx" ON "questions"("organization_id", "status");

-- CreateIndex
CREATE INDEX "questions_organization_id_subject_id_chapter_id_status_idx" ON "questions"("organization_id", "subject_id", "chapter_id", "status");

-- CreateIndex
CREATE INDEX "questions_organization_id_content_hash_idx" ON "questions"("organization_id", "content_hash");

-- CreateIndex
CREATE INDEX "questions_primary_outcome_id_idx" ON "questions"("primary_outcome_id");

-- CreateIndex
CREATE INDEX "question_versions_question_id_idx" ON "question_versions"("question_id");

-- CreateIndex
CREATE UNIQUE INDEX "question_versions_question_id_version_key" ON "question_versions"("question_id", "version");

-- CreateIndex
CREATE INDEX "question_outcomes_learning_outcome_id_idx" ON "question_outcomes"("learning_outcome_id");

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_outcomes" ADD CONSTRAINT "question_outcomes_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

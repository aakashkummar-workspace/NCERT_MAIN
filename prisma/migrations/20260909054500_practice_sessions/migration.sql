-- CreateEnum
CREATE TYPE "PracticeSource" AS ENUM ('RECOMMENDED', 'MISTAKE_REVIEW', 'SELF_SELECTED', 'ASSIGNED');

-- CreateEnum
CREATE TYPE "EvidenceSource" AS ENUM ('ASSESSMENT', 'PRACTICE');

-- AlterTable
ALTER TABLE "concept_evidence" ADD COLUMN     "practice_answer_id" UUID,
ADD COLUMN     "source" "EvidenceSource" NOT NULL DEFAULT 'ASSESSMENT',
ALTER COLUMN "attempt_answer_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "practice_sessions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "student_user_id" UUID NOT NULL,
    "source" "PracticeSource" NOT NULL,
    "concept_ids" UUID[],
    "question_count" INTEGER NOT NULL,
    "completed_at" TIMESTAMP(3),
    "score" DECIMAL(4,3),
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "practice_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practice_answers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "practice_session_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "question_version_id" UUID,
    "position" INTEGER NOT NULL,
    "response" JSONB,
    "is_correct" BOOLEAN,
    "time_spent_seconds" INTEGER NOT NULL DEFAULT 0,
    "answered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "practice_answers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "practice_sessions_organization_id_student_user_id_started_a_idx" ON "practice_sessions"("organization_id", "student_user_id", "started_at");

-- CreateIndex
CREATE INDEX "practice_answers_organization_id_question_id_idx" ON "practice_answers"("organization_id", "question_id");

-- CreateIndex
CREATE UNIQUE INDEX "practice_answers_practice_session_id_position_key" ON "practice_answers"("practice_session_id", "position");

-- CreateIndex
CREATE INDEX "concept_evidence_organization_id_student_user_id_source_idx" ON "concept_evidence"("organization_id", "student_user_id", "source");

-- CreateIndex
CREATE UNIQUE INDEX "concept_evidence_practice_answer_id_concept_id_key" ON "concept_evidence"("practice_answer_id", "concept_id");

-- AddForeignKey
ALTER TABLE "practice_answers" ADD CONSTRAINT "practice_answers_practice_session_id_fkey" FOREIGN KEY ("practice_session_id") REFERENCES "practice_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


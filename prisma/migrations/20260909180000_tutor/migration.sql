-- CreateEnum
CREATE TYPE "TutorLevel" AS ENUM ('HINT', 'STEPS', 'EXPLAIN');

-- CreateTable
CREATE TABLE "tutor_sessions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "student_user_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "question_version_id" UUID,
    "practice_answer_id" UUID,
    "student_mistake_id" UUID,
    "max_level" "TutorLevel" NOT NULL DEFAULT 'HINT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_asked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tutor_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tutor_turns" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "level" "TutorLevel" NOT NULL,
    "content" VARCHAR(4000) NOT NULL,
    "was_withheld" BOOLEAN NOT NULL DEFAULT false,
    "generation_id" UUID,
    "cost_micros" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tutor_turns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tutor_sessions_organization_id_student_user_id_last_asked_a_idx" ON "tutor_sessions"("organization_id", "student_user_id", "last_asked_at");

-- CreateIndex
CREATE UNIQUE INDEX "tutor_sessions_student_user_id_question_id_key" ON "tutor_sessions"("student_user_id", "question_id");

-- CreateIndex
CREATE INDEX "tutor_turns_organization_id_session_id_created_at_idx" ON "tutor_turns"("organization_id", "session_id", "created_at");

-- AddForeignKey
ALTER TABLE "tutor_turns" ADD CONSTRAINT "tutor_turns_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "tutor_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


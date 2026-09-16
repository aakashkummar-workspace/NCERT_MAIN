-- The student dashboard: class announcements, saved questions, and knowing
-- which teacher feedback a student has not seen yet.

ALTER TABLE "attempts" ADD COLUMN "feedback_seen_at" TIMESTAMP(3);

CREATE TABLE "announcements" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "announcements_organization_id_class_id_created_at_idx"
  ON "announcements"("organization_id", "class_id", "created_at");
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_class_id_fkey"
  FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "saved_questions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "student_user_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "saved_questions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "saved_questions_student_user_id_question_id_key"
  ON "saved_questions"("student_user_id", "question_id");
CREATE INDEX "saved_questions_organization_id_student_user_id_created_at_idx"
  ON "saved_questions"("organization_id", "student_user_id", "created_at");
ALTER TABLE "saved_questions" ADD CONSTRAINT "saved_questions_question_id_fkey"
  FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

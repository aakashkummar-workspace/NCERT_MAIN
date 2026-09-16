-- AlterTable
ALTER TABLE "attempt_answers" ADD COLUMN     "rubric_scores" JSONB;

-- AlterTable
ALTER TABLE "question_versions" ADD COLUMN     "rubric" JSONB;


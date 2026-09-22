-- AlterTable
ALTER TABLE "assessments" ADD COLUMN     "review_decision" TEXT,
ADD COLUMN     "review_note" VARCHAR(2000),
ADD COLUMN     "review_requested_at" TIMESTAMP(3),
ADD COLUMN     "review_requested_by_id" UUID,
ADD COLUMN     "reviewed_at" TIMESTAMP(3),
ADD COLUMN     "reviewed_by_id" UUID;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "paper_review_required" BOOLEAN NOT NULL DEFAULT false;

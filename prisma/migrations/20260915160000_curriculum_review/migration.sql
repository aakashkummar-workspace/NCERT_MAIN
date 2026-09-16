-- Review by a subject teacher. Every column is nullable and starts NULL:
-- nothing imported so far has been reviewed, and saying otherwise by default
-- would be the one claim this feature exists to make honestly.
ALTER TABLE "learning_outcomes" ADD COLUMN "reviewed_at" TIMESTAMP(3);
ALTER TABLE "learning_outcomes" ADD COLUMN "reviewed_by_id" UUID;
ALTER TABLE "concepts" ADD COLUMN "reviewed_at" TIMESTAMP(3);
ALTER TABLE "concepts" ADD COLUMN "reviewed_by_id" UUID;
ALTER TABLE "questions" ADD COLUMN "tag_reviewed_at" TIMESTAMP(3);
ALTER TABLE "questions" ADD COLUMN "tag_reviewed_by_id" UUID;

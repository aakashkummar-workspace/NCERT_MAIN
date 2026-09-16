-- The shared question library.
--
-- `library_requested_at` is added WITHOUT a default first, so every existing
-- organization stays unrequested — thousands of rows in a development database
-- are test tenants, and copying 3,000 questions into each would be millions of
-- rows nobody asked for. Only then does it get its default, so every
-- organization created from here on is requested by the insert itself and
-- signup does nothing extra.

CREATE TYPE "QuestionProvenance" AS ENUM ('ORIGINAL', 'NCERT_EXEMPLAR');

ALTER TABLE "questions" ADD COLUMN "provenance" "QuestionProvenance";
ALTER TABLE "questions" ADD COLUMN "library_origin_id" UUID;
CREATE INDEX "questions_organization_id_library_origin_id_idx"
  ON "questions"("organization_id", "library_origin_id");

ALTER TABLE "organizations" ADD COLUMN "library_requested_at" TIMESTAMP(3);
ALTER TABLE "organizations" ALTER COLUMN "library_requested_at" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "organizations" ADD COLUMN "library_synced_at" TIMESTAMP(3);
ALTER TABLE "organizations" ADD COLUMN "library_includes_exemplar" BOOLEAN NOT NULL DEFAULT false;

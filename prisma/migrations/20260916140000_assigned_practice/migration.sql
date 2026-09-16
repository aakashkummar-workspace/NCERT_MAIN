-- Teacher-assigned practice: "ten questions on ratio by Friday, no clock".
--
-- An ordinary tenant table; its policy is in prisma/rls.sql and `npm run db:rls`
-- must run after this migration or the RLS audit fails on it — which is the
-- audit doing its job.

-- AlterTable
ALTER TABLE "practice_sessions" ADD COLUMN     "assigned_practice_id" UUID;

-- CreateTable
CREATE TABLE "assigned_practice" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "concept_id" UUID NOT NULL,
    "concept_name" TEXT NOT NULL,
    "question_count" INTEGER NOT NULL,
    "due_at" TIMESTAMP(3),
    "note" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assigned_practice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assigned_practice_organization_id_class_id_created_at_idx" ON "assigned_practice"("organization_id", "class_id", "created_at");

-- AddForeignKey
ALTER TABLE "assigned_practice" ADD CONSTRAINT "assigned_practice_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practice_sessions" ADD CONSTRAINT "practice_sessions_assigned_practice_id_fkey" FOREIGN KEY ("assigned_practice_id") REFERENCES "assigned_practice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

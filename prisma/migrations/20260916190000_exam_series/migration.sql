-- Exam series: six papers that know they belong together.
--
-- A label and nothing else — no window, no marks, no status column. Its
-- policy is in prisma/rls.sql and `npm run db:rls` must run after this
-- migration, or the RLS audit fails on it, which is the audit doing its job.

-- CreateTable
CREATE TABLE "exam_series" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "academic_year" TEXT NOT NULL,
    "note" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_series_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exam_series_organization_id_academic_year_created_at_idx" ON "exam_series"("organization_id", "academic_year", "created_at");

-- AlterTable
ALTER TABLE "assignments" ADD COLUMN     "exam_series_id" UUID;

-- CreateIndex
CREATE INDEX "assignments_organization_id_exam_series_id_idx" ON "assignments"("organization_id", "exam_series_id");

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_exam_series_id_fkey" FOREIGN KEY ("exam_series_id") REFERENCES "exam_series"("id") ON DELETE SET NULL ON UPDATE CASCADE;

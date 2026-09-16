-- Cross-school concept benchmarks.
--
-- One row per school per concept: a mean and a count, computed by the school
-- itself inside its own tenant transaction. The cross-school read is
-- `app_concept_benchmark()` in prisma/rls.sql — a SECURITY DEFINER function
-- whose return shape has no column for a school — so `npm run db:rls` must run
-- after this migration.

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "benchmarks_opted_in_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "concept_benchmarks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "concept_id" UUID NOT NULL,
    "measured_students" INTEGER NOT NULL,
    "mean_estimate" DECIMAL(4,3) NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "concept_benchmarks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "concept_benchmarks_concept_id_idx" ON "concept_benchmarks"("concept_id");

-- CreateIndex
CREATE UNIQUE INDEX "concept_benchmarks_organization_id_concept_id_key" ON "concept_benchmarks"("organization_id", "concept_id");

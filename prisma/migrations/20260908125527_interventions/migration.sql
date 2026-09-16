-- CreateEnum
CREATE TYPE "InterventionKind" AS ENUM ('REMEDIAL_ASSESSMENT', 'PRACTICE_SET', 'LESSON_PLAN', 'MANUAL');

-- CreateEnum
CREATE TYPE "InterventionStatus" AS ENUM ('PLANNED', 'ACTIVE', 'MEASURED', 'ABANDONED');

-- CreateTable
CREATE TABLE "interventions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "learning_gap_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "kind" "InterventionKind" NOT NULL,
    "assessment_id" UUID,
    "assignment_id" UUID,
    "baseline_mastery" DECIMAL(4,3) NOT NULL,
    "baseline_student_count" INTEGER NOT NULL,
    "target_mastery" DECIMAL(4,3) NOT NULL,
    "outcome_mastery" DECIMAL(4,3),
    "outcome_student_count" INTEGER,
    "status" "InterventionStatus" NOT NULL DEFAULT 'PLANNED',
    "note" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "measured_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interventions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "interventions_organization_id_status_idx" ON "interventions"("organization_id", "status");

-- CreateIndex
CREATE INDEX "interventions_organization_id_learning_gap_id_idx" ON "interventions"("organization_id", "learning_gap_id");

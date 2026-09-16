-- CreateEnum
CREATE TYPE "ResultsPolicy" AS ENUM ('IMMEDIATE', 'AFTER_CLOSE', 'MANUAL');

-- CreateTable
CREATE TABLE "assignments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "assessment_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "assigned_by_id" UUID NOT NULL,
    "opens_at" TIMESTAMP(3) NOT NULL,
    "closes_at" TIMESTAMP(3) NOT NULL,
    "duration_override_minutes" INTEGER,
    "max_attempts" INTEGER NOT NULL DEFAULT 1,
    "results_policy" "ResultsPolicy" NOT NULL DEFAULT 'AFTER_CLOSE',
    "results_released_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_targets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "student_user_id" UUID NOT NULL,

    CONSTRAINT "assignment_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assignments_organization_id_class_id_idx" ON "assignments"("organization_id", "class_id");

-- CreateIndex
CREATE INDEX "assignments_organization_id_assessment_id_idx" ON "assignments"("organization_id", "assessment_id");

-- CreateIndex
CREATE INDEX "assignments_organization_id_opens_at_closes_at_idx" ON "assignments"("organization_id", "opens_at", "closes_at");

-- CreateIndex
CREATE INDEX "assignment_targets_organization_id_student_user_id_idx" ON "assignment_targets"("organization_id", "student_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_targets_assignment_id_student_user_id_key" ON "assignment_targets"("assignment_id", "student_user_id");

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_targets" ADD CONSTRAINT "assignment_targets_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

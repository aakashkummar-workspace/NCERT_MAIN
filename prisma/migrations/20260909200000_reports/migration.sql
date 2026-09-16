-- CreateEnum
CREATE TYPE "ReportKind" AS ENUM ('TERM');

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "student_user_id" UUID NOT NULL,
    "class_id" UUID,
    "kind" "ReportKind" NOT NULL DEFAULT 'TERM',
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "generated_by_id" UUID NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    "payload_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reports_organization_id_student_user_id_generated_at_idx" ON "reports"("organization_id", "student_user_id", "generated_at");

-- CreateIndex
CREATE INDEX "reports_organization_id_class_id_generated_at_idx" ON "reports"("organization_id", "class_id", "generated_at");


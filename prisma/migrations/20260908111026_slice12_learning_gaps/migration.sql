-- CreateEnum
CREATE TYPE "GapScope" AS ENUM ('STUDENT', 'CLASS');

-- CreateEnum
CREATE TYPE "GapSeverity" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "GapStatus" AS ENUM ('DETECTED', 'ACKNOWLEDGED', 'INTERVENING', 'RESOLVED', 'PERSISTING');

-- CreateTable
CREATE TABLE "learning_gaps" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "scope" "GapScope" NOT NULL,
    "scope_id" UUID NOT NULL,
    "concept_id" UUID NOT NULL,
    "severity" "GapSeverity" NOT NULL,
    "status" "GapStatus" NOT NULL DEFAULT 'DETECTED',
    "affected_student_count" INTEGER NOT NULL,
    "mean_estimate" DECIMAL(4,3) NOT NULL,
    "measured_student_count" INTEGER NOT NULL,
    "root_cause_concept_id" UUID,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_gaps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "learning_gaps_organization_id_status_severity_idx" ON "learning_gaps"("organization_id", "status", "severity");

-- CreateIndex
CREATE INDEX "learning_gaps_organization_id_scope_scope_id_idx" ON "learning_gaps"("organization_id", "scope", "scope_id");

-- CreateIndex
CREATE UNIQUE INDEX "learning_gaps_scope_scope_id_concept_id_key" ON "learning_gaps"("scope", "scope_id", "concept_id");

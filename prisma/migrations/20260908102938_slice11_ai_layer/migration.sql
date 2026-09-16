-- CreateEnum
CREATE TYPE "AIFeature" AS ENUM ('QUESTION_GENERATION', 'QUESTION_VALIDATION', 'PERFORMANCE_ANALYSIS', 'TEACHER_COPILOT', 'STUDENT_TUTOR', 'REPORT_GENERATION', 'RECOMMENDATION', 'CLASSIFICATION');

-- CreateEnum
CREATE TYPE "AIGenerationStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'REFUSED');

-- CreateEnum
CREATE TYPE "AICallStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'REFUSED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "BudgetPeriod" AS ENUM ('DAY', 'MONTH');

-- CreateEnum
CREATE TYPE "ModelTier" AS ENUM ('FAST', 'BALANCED', 'DEEP');

-- CreateTable
CREATE TABLE "ai_generations" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "requested_by_id" UUID,
    "feature" "AIFeature" NOT NULL,
    "status" "AIGenerationStatus" NOT NULL DEFAULT 'QUEUED',
    "input_summary" JSONB NOT NULL DEFAULT '{}',
    "output_ref" JSONB NOT NULL DEFAULT '{}',
    "requested_count" INTEGER NOT NULL DEFAULT 0,
    "produced_count" INTEGER NOT NULL DEFAULT 0,
    "accepted_count" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "ai_generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" UUID NOT NULL,
    "ai_generation_id" UUID,
    "organization_id" UUID,
    "feature" "AIFeature" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_version" TEXT,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "status" "AICallStatus" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_budgets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "period" "BudgetPeriod" NOT NULL,
    "feature" "AIFeature",
    "limit_micros" BIGINT NOT NULL,
    "spent_micros" BIGINT NOT NULL DEFAULT 0,
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_versions" (
    "id" UUID NOT NULL,
    "feature" "AIFeature" NOT NULL,
    "version" INTEGER NOT NULL,
    "template" TEXT NOT NULL,
    "model_tier" "ModelTier" NOT NULL,
    "schema" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_generations_organization_id_feature_started_at_idx" ON "ai_generations"("organization_id", "feature", "started_at");

-- CreateIndex
CREATE INDEX "ai_usage_organization_id_created_at_idx" ON "ai_usage"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_usage_feature_created_at_idx" ON "ai_usage"("feature", "created_at");

-- CreateIndex
CREATE INDEX "ai_budgets_organization_id_window_end_idx" ON "ai_budgets"("organization_id", "window_end");

-- CreateIndex
CREATE UNIQUE INDEX "ai_budgets_organization_id_period_feature_window_start_key" ON "ai_budgets"("organization_id", "period", "feature", "window_start");

-- CreateIndex
CREATE INDEX "prompt_versions_feature_active_idx" ON "prompt_versions"("feature", "active");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_versions_feature_version_key" ON "prompt_versions"("feature", "version");

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_ai_generation_id_fkey" FOREIGN KEY ("ai_generation_id") REFERENCES "ai_generations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterEnum
ALTER TYPE "AIFeature" ADD VALUE 'MARKING_ASSIST';

-- CreateTable
CREATE TABLE "answer_images" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "attempt_answer_id" UUID NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "answer_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marking_drafts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "attempt_answer_id" UUID NOT NULL,
    "generation_id" UUID,
    "readable" BOOLEAN NOT NULL,
    "transcript" TEXT,
    "total" DECIMAL(5,2),
    "criteria" JSONB,
    "reason" TEXT,
    "feedback" TEXT,
    "confidence" TEXT NOT NULL,
    "concerns" JSONB NOT NULL DEFAULT '[]',
    "requested_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMP(3),

    CONSTRAINT "marking_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "answer_images_organization_id_attempt_answer_id_idx" ON "answer_images"("organization_id", "attempt_answer_id");

-- CreateIndex
CREATE UNIQUE INDEX "marking_drafts_attempt_answer_id_key" ON "marking_drafts"("attempt_answer_id");

-- CreateIndex
CREATE INDEX "marking_drafts_organization_id_idx" ON "marking_drafts"("organization_id");

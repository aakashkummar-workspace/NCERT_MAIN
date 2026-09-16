-- CreateEnum
CREATE TYPE "Relationship" AS ENUM ('FATHER', 'MOTHER', 'GUARDIAN');

-- AlterTable
ALTER TABLE "invitations" ADD COLUMN     "relationship" "Relationship",
ADD COLUMN     "student_user_id" UUID;

-- CreateTable
CREATE TABLE "parent_student_links" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "parent_user_id" UUID NOT NULL,
    "student_user_id" UUID NOT NULL,
    "relationship" "Relationship" NOT NULL,
    "consent_granted_at" TIMESTAMP(3),
    "consent_granted_by" UUID,
    "scope" JSONB NOT NULL DEFAULT '{"performance": true}',
    "revoked_at" TIMESTAMP(3),
    "revoked_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parent_student_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "parent_student_links_organization_id_parent_user_id_idx" ON "parent_student_links"("organization_id", "parent_user_id");

-- CreateIndex
CREATE INDEX "parent_student_links_organization_id_student_user_id_idx" ON "parent_student_links"("organization_id", "student_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "parent_student_links_parent_user_id_student_user_id_key" ON "parent_student_links"("parent_user_id", "student_user_id");


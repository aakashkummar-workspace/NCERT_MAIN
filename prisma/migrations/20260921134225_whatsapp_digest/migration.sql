-- AlterTable
ALTER TABLE "parent_student_links" ADD COLUMN     "whatsapp_digest_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "parent_user_id" UUID NOT NULL,
    "student_user_id" UUID NOT NULL,
    "template" TEXT NOT NULL,
    "week_of" DATE NOT NULL,
    "provider" TEXT,
    "status" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatsapp_messages_organization_id_created_at_idx" ON "whatsapp_messages"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_parent_user_id_student_user_id_template_w_key" ON "whatsapp_messages"("parent_user_id", "student_user_id", "template", "week_of");

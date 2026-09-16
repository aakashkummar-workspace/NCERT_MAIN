-- CreateEnum
CREATE TYPE "SmsTemplate" AS ENUM ('LOGIN_CODE', 'PARENT_INVITE');

-- CreateEnum
CREATE TYPE "SmsStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "sms_messages" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "phone" TEXT NOT NULL,
    "template" "SmsTemplate" NOT NULL,
    "status" "SmsStatus" NOT NULL DEFAULT 'QUEUED',
    "provider_message_id" TEXT,
    "provider" TEXT,
    "cost_micros" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sms_messages_phone_created_at_idx" ON "sms_messages"("phone", "created_at");

-- CreateIndex
CREATE INDEX "sms_messages_organization_id_created_at_idx" ON "sms_messages"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "sms_messages_status_created_at_idx" ON "sms_messages"("status", "created_at");


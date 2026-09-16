-- CreateEnum
CREATE TYPE "CopilotRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateTable
CREATE TABLE "copilot_conversations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "teacher_user_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "class_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "copilot_messages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "role" "CopilotRole" NOT NULL,
    "content" VARCHAR(8000) NOT NULL,
    "citations" JSONB,
    "generation_id" UUID,
    "cost_micros" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "copilot_conversations_organization_id_teacher_user_id_last__idx" ON "copilot_conversations"("organization_id", "teacher_user_id", "last_message_at");

-- CreateIndex
CREATE INDEX "copilot_messages_organization_id_conversation_id_created_at_idx" ON "copilot_messages"("organization_id", "conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "copilot_messages" ADD CONSTRAINT "copilot_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "copilot_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


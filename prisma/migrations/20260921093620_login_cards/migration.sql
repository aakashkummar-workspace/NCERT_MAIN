-- CreateTable
CREATE TABLE "login_cards" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "student_user_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "code_hash" BYTEA NOT NULL,
    "hint" TEXT NOT NULL,
    "issued_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "login_cards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "login_cards_code_hash_key" ON "login_cards"("code_hash");

-- CreateIndex
CREATE INDEX "login_cards_organization_id_student_user_id_idx" ON "login_cards"("organization_id", "student_user_id");

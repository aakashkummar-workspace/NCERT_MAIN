-- CreateTable
CREATE TABLE "holistic_observations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "student_user_id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "note" VARCHAR(400),
    "observed_by_id" UUID NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holistic_observations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "holistic_observations_organization_id_student_user_id_obser_idx" ON "holistic_observations"("organization_id", "student_user_id", "observed_at");

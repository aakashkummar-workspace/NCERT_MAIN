-- APAAR ID on a student profile: twelve digits, unique within a school.

-- AlterTable
ALTER TABLE "student_profiles" ADD COLUMN     "apaar_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_organization_id_apaar_id_key" ON "student_profiles"("organization_id", "apaar_id");

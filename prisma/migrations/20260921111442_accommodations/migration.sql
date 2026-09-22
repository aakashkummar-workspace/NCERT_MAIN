-- AlterTable
ALTER TABLE "student_profiles" ADD COLUMN     "extra_time_percent" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "read_aloud" BOOLEAN NOT NULL DEFAULT false;

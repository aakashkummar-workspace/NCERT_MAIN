-- CreateEnum
CREATE TYPE "ClassStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "EnrolmentStatus" AS ENUM ('ACTIVE', 'LEFT', 'REMOVED');

-- CreateEnum
CREATE TYPE "ClassTeacherRole" AS ENUM ('PRIMARY', 'ASSISTANT');

-- CreateTable
CREATE TABLE "boards" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'IN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "boards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grades" (
    "id" UUID NOT NULL,
    "board_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "grades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subjects" (
    "id" UUID NOT NULL,
    "grade_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "grade_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "academic_year" TEXT NOT NULL,
    "owner_teacher_id" UUID NOT NULL,
    "status" "ClassStatus" NOT NULL DEFAULT 'ACTIVE',
    "join_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "class_teachers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "teacher_user_id" UUID NOT NULL,
    "role" "ClassTeacherRole" NOT NULL DEFAULT 'PRIMARY',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "class_teachers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "class_enrolments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "student_user_id" UUID NOT NULL,
    "status" "EnrolmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),

    CONSTRAINT "class_enrolments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_profiles" (
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "roll_number" TEXT,
    "guardian_phone" TEXT,
    "admission_year" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "teacher_profiles" (
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "qualification" TEXT,
    "bio" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teacher_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "boards_code_key" ON "boards"("code");

-- CreateIndex
CREATE UNIQUE INDEX "grades_board_id_number_key" ON "grades"("board_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "subjects_grade_id_code_key" ON "subjects"("grade_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "classes_join_code_key" ON "classes"("join_code");

-- CreateIndex
CREATE INDEX "classes_organization_id_status_idx" ON "classes"("organization_id", "status");

-- CreateIndex
CREATE INDEX "classes_organization_id_owner_teacher_id_idx" ON "classes"("organization_id", "owner_teacher_id");

-- CreateIndex
CREATE INDEX "class_teachers_organization_id_teacher_user_id_idx" ON "class_teachers"("organization_id", "teacher_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "class_teachers_class_id_teacher_user_id_key" ON "class_teachers"("class_id", "teacher_user_id");

-- CreateIndex
CREATE INDEX "class_enrolments_organization_id_class_id_status_idx" ON "class_enrolments"("organization_id", "class_id", "status");

-- CreateIndex
CREATE INDEX "class_enrolments_organization_id_student_user_id_idx" ON "class_enrolments"("organization_id", "student_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "class_enrolments_class_id_student_user_id_joined_at_key" ON "class_enrolments"("class_id", "student_user_id", "joined_at");

-- CreateIndex
CREATE INDEX "student_profiles_organization_id_idx" ON "student_profiles"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_organization_id_roll_number_key" ON "student_profiles"("organization_id", "roll_number");

-- CreateIndex
CREATE INDEX "teacher_profiles_organization_id_idx" ON "teacher_profiles"("organization_id");

-- AddForeignKey
ALTER TABLE "grades" ADD CONSTRAINT "grades_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_grade_id_fkey" FOREIGN KEY ("grade_id") REFERENCES "grades"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_grade_id_fkey" FOREIGN KEY ("grade_id") REFERENCES "grades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_teachers" ADD CONSTRAINT "class_teachers_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_enrolments" ADD CONSTRAINT "class_enrolments_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

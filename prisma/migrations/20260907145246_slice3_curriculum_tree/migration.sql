-- CreateEnum
CREATE TYPE "BloomLevel" AS ENUM ('REMEMBER', 'UNDERSTAND', 'APPLY', 'ANALYSE', 'EVALUATE', 'CREATE');

-- CreateEnum
CREATE TYPE "Competency" AS ENUM ('KNOWLEDGE', 'UNDERSTANDING', 'APPLICATION', 'PROBLEM_SOLVING', 'ANALYSIS', 'EVALUATION');

-- CreateTable
CREATE TABLE "chapters" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "chapters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topics" (
    "id" UUID NOT NULL,
    "chapter_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_outcomes" (
    "id" UUID NOT NULL,
    "topic_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "bloom_level" "BloomLevel" NOT NULL DEFAULT 'UNDERSTAND',
    "competency" "Competency" NOT NULL DEFAULT 'UNDERSTANDING',
    "typical_marks" INTEGER NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "concepts" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "concepts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "concept_outcomes" (
    "concept_id" UUID NOT NULL,
    "learning_outcome_id" UUID NOT NULL,
    "weight" DECIMAL(3,2) NOT NULL DEFAULT 1.0,

    CONSTRAINT "concept_outcomes_pkey" PRIMARY KEY ("concept_id","learning_outcome_id")
);

-- CreateTable
CREATE TABLE "concept_prerequisites" (
    "concept_id" UUID NOT NULL,
    "prerequisite_concept_id" UUID NOT NULL,
    "strength" DECIMAL(3,2) NOT NULL DEFAULT 1.0,

    CONSTRAINT "concept_prerequisites_pkey" PRIMARY KEY ("concept_id","prerequisite_concept_id")
);

-- CreateIndex
CREATE INDEX "chapters_subject_id_idx" ON "chapters"("subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "chapters_subject_id_number_key" ON "chapters"("subject_id", "number");

-- CreateIndex
CREATE INDEX "topics_chapter_id_idx" ON "topics"("chapter_id");

-- CreateIndex
CREATE INDEX "learning_outcomes_topic_id_idx" ON "learning_outcomes"("topic_id");

-- CreateIndex
CREATE UNIQUE INDEX "learning_outcomes_topic_id_code_key" ON "learning_outcomes"("topic_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "concepts_slug_key" ON "concepts"("slug");

-- AddForeignKey
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topics" ADD CONSTRAINT "topics_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_outcomes" ADD CONSTRAINT "learning_outcomes_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_outcomes" ADD CONSTRAINT "concept_outcomes_concept_id_fkey" FOREIGN KEY ("concept_id") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_outcomes" ADD CONSTRAINT "concept_outcomes_learning_outcome_id_fkey" FOREIGN KEY ("learning_outcome_id") REFERENCES "learning_outcomes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_prerequisites" ADD CONSTRAINT "concept_prerequisites_concept_id_fkey" FOREIGN KEY ("concept_id") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_prerequisites" ADD CONSTRAINT "concept_prerequisites_prerequisite_concept_id_fkey" FOREIGN KEY ("prerequisite_concept_id") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

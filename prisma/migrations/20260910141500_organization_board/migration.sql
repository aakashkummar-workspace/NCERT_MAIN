-- The board an organization teaches.
--
-- Three steps, and the order is the whole point: every existing customer must
-- land exactly where they already were. The column arrives nullable, every row
-- is backfilled with CBSE — which is what the product has silently assumed
-- since the first slice — and only then does it become NOT NULL.
--
-- There is deliberately NO column default. A default here would be a silent
-- fallback for every INSERT that forgot to name a board, which is the same
-- failure as the `boardCode = "CBSE"` default parameter this work removes: an
-- ICSE school shown the CBSE syllabus, with nothing looking wrong.

-- 1. Nullable, so the table can be altered while it holds rows.
ALTER TABLE "organizations" ADD COLUMN "board_id" UUID;

-- 2. The board every existing organization was already teaching.
--    Seeded by prisma/seed.ts; created here if a deployment somehow migrates
--    before it seeds, because step 3 must not fail on an empty boards table.
INSERT INTO "boards" (id, code, name, country)
SELECT gen_random_uuid(), 'CBSE', 'Central Board of Secondary Education', 'IN'
WHERE NOT EXISTS (SELECT 1 FROM "boards" WHERE code = 'CBSE');

UPDATE "organizations"
   SET "board_id" = (SELECT id FROM "boards" WHERE code = 'CBSE')
 WHERE "board_id" IS NULL;

-- 3. Now it can be required.
ALTER TABLE "organizations" ALTER COLUMN "board_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "organizations_board_id_idx" ON "organizations"("board_id");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

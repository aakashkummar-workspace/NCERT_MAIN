-- What a chapter contains, read from the NCERT book: its section headings,
-- key terms, results, activities and exercises (docs: prisma/chapter-contents).
-- Nullable: a chapter nobody has read against the book says so, rather than
-- carrying an empty object that looks like a chapter with nothing in it.
ALTER TABLE "chapters" ADD COLUMN "contents" JSONB;

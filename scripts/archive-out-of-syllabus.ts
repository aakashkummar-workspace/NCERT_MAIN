/**
 * Archive the imported NCERT questions that test content CBSE has removed.
 *
 *     npx tsx --conditions=react-server scripts/archive-out-of-syllabus.ts
 *     npx tsx --conditions=react-server scripts/archive-out-of-syllabus.ts --commit
 *
 * ---------------------------------------------------------------------------
 * Which questions
 * ---------------------------------------------------------------------------
 * The ones `tag-questions.ts` deliberately left without a learning outcome:
 * every mapping file marks a question `0` only when it tests content removed
 * from the rationalised syllabus — Euclid's division lemma, ogives, completing
 * the square, areas of similar triangles, the area of a triangle from its
 * vertices, complementary angles, the whole-circle area chapter, frustums and
 * conversion of solids, Evolution, the AC/DC generator, the mole concept.
 * Twenty-five carry the source's own "[Out of syllabus: …]" label; the rest
 * were identified by reading them.
 *
 * Untagged, they could not count towards mastery, but they were still APPROVED
 * — so a teacher could put a removed topic in a paper, and a student would sit
 * a question on something they were never taught. Archived, they stay in the
 * database, keep their history, and leave the bank.
 *
 * ---------------------------------------------------------------------------
 * The rules it holds
 * ---------------------------------------------------------------------------
 * - Only APPROVED, IMPORTED questions with no outcome at all. A draft is left
 *   alone — the sample-paper drafts are waiting for a teacher.
 * - A question already used in a paper is refused rather than archived: a
 *   paper keeps its frozen versions regardless, but pulling a question out
 *   from under a teacher's published paper is a decision for that teacher.
 * - Through `archiveQuestion`, the function a teacher's Archive button calls,
 *   so each one gets the same audit row.
 */
import { PrismaClient } from "@prisma/client";
import { archiveQuestion } from "../src/core/questions";

async function main() {
  const commit = process.argv.includes("--commit");
  const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });

  const candidates = await db.question.findMany({
    where: { source: "IMPORTED", status: "APPROVED", deletedAt: null, outcomes: { none: {} } },
    select: {
      id: true,
      organizationId: true,
      createdById: true,
      subject: { select: { name: true, grade: { select: { number: true } } } },
      chapter: { select: { number: true } },
      _count: { select: { assessments: true } },
    },
  });

  const inPapers = candidates.filter((q) => q._count.assessments > 0);
  const toArchive = candidates.filter((q) => q._count.assessments === 0);

  const bySubject: Record<string, number> = {};
  for (const q of toArchive) {
    const key = `Class ${q.subject.grade.number} ${q.subject.name} ch${q.chapter?.number ?? "?"}`;
    bySubject[key] = (bySubject[key] ?? 0) + 1;
  }

  let archived = 0;
  if (commit) {
    for (const q of toArchive) {
      const membership = await db.membership.findFirstOrThrow({
        where: { organizationId: q.organizationId!, userId: q.createdById },
        select: { role: true },
      });
      const ok = await archiveQuestion(
        { organizationId: q.organizationId!, userId: q.createdById, role: membership.role },
        q.id,
      );
      if (ok) archived++;
    }
  }
  await db.$disconnect();

  console.log(`\nArchive out-of-syllabus NCERT questions — ${commit ? "COMMIT" : "dry run"}`);
  for (const [k, v] of Object.entries(bySubject).sort()) console.log(`  ${k.padEnd(36)} ${v}`);
  console.log(`\n  candidates            ${candidates.length}`);
  console.log(`  used in a paper, left ${inPapers.length}`);
  console.log(`  ${commit ? "archived" : "to archive"}${" ".repeat(commit ? 14 : 12)}${commit ? archived : toArchive.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

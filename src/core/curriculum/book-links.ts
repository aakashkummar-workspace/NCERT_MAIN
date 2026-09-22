import "server-only";
import { prisma } from "@/db/client";
import { parseChapterContents } from "./chapter-contents";
import { bookLinkFor, describeBookLink, sectionAnchor, type BookLink } from "./book-link";

/**
 * Where in the NCERT book each concept is taught — the reader over
 * `book-link.ts`, for the Mistake Bank, the tutor and a gap's reteach brief.
 *
 * The curriculum plane is global and carries no student data, so this reads
 * it directly, the way `conceptContext` does.
 */

export type ConceptBookLink = BookLink & {
  chapterId: string;
  /** Opens the syllabus page at the section (or the chapter). */
  href: string;
  /** The line to print: "Mathematics, chapter 6 (Triangles), §6.4 …". */
  label: string;
};

export async function bookLinksForConcepts(
  conceptIds: string[],
  audience: "student" | "teacher",
): Promise<Map<string, ConceptBookLink>> {
  const unique = [...new Set(conceptIds)];
  if (unique.length === 0) return new Map();

  const concepts = await prisma.concept.findMany({
    where: { id: { in: unique } },
    select: {
      id: true,
      name: true,
      outcomes: {
        select: {
          outcome: {
            select: {
              statement: true,
              topic: { select: { chapter: { select: { id: true, title: true, contents: true } } } },
            },
          },
        },
      },
    },
  });

  const links = new Map<string, ConceptBookLink>();
  for (const concept of concepts) {
    // The chapter most of the concept's outcomes sit in. A concept spanning
    // two chapters is linked to the one it is mostly taught in.
    const tally = new Map<string, { chapter: { id: string; title: string; contents: unknown }; count: number; statements: string[] }>();
    for (const row of concept.outcomes) {
      const chapter = row.outcome.topic.chapter;
      const entry = tally.get(chapter.id) ?? { chapter, count: 0, statements: [] };
      entry.count++;
      entry.statements.push(row.outcome.statement);
      tally.set(chapter.id, entry);
    }
    const top = [...tally.values()].sort((a, b) => b.count - a.count)[0];
    if (!top) continue;
    const contents = parseChapterContents(top.chapter.contents);
    if (!contents) continue;

    const link = bookLinkFor(contents, top.chapter.title, concept.name, top.statements);
    links.set(concept.id, {
      ...link,
      chapterId: top.chapter.id,
      href: `/${audience}/syllabus#${sectionAnchor(top.chapter.id, link.section?.number ?? null)}`,
      label: describeBookLink(link),
    });
  }
  return links;
}

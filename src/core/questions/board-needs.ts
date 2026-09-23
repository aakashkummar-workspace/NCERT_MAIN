import "server-only";
import { withTenant } from "@/db/tenant";
import { patternForSubject, sectionNeeds, type SectionNeed } from "@/core/assessments/pattern";
import type { QuestionType } from "./validate";

export type SubjectNeeds = {
  subjectId: string;
  patternLabel: string;
  /** Every section is covered for one paper. */
  ready: boolean;
  sections: SectionNeed[];
};

/**
 * Per board-pattern subject, what one board paper still needs and what is
 * waiting in the review queue that would supply it.
 *
 * The imported bank is almost all approved multiple choice and almost all
 * DRAFT written questions, so a board-pattern paper fills Section A and
 * little else. The fix is a teacher reading drafts, and this is where they
 * should start: the sections a review would unlock, with the drafts that
 * would do it one link away. Reviewing is still one question at a time —
 * this changes where a reviewer begins, never how much they read.
 *
 * Only subjects the school actually holds questions in are listed.
 */
export async function boardPaperNeeds(organizationId: string): Promise<SubjectNeeds[]> {
  const { grouped, subjects } = await withTenant(organizationId, async (tx) => {
    const grouped = await tx.question.groupBy({
      by: ["subjectId", "type", "marks", "status"],
      where: { deletedAt: null, status: { in: ["APPROVED", "DRAFT"] } },
      _count: true,
    });
    const subjects = await tx.subject.findMany({
      where: { id: { in: [...new Set(grouped.map((row) => row.subjectId))] } },
      select: { id: true, code: true, name: true, grade: { select: { number: true, board: { select: { code: true } } } } },
    });
    return { grouped, subjects };
  });

  const result: (SubjectNeeds & { order: [number, string] })[] = [];
  for (const subject of subjects) {
    const pattern = patternForSubject(subject.grade.board.code, subject.code);
    if (!pattern) continue;
    const rows = grouped.filter((row) => row.subjectId === subject.id);
    const bank = (status: "APPROVED" | "DRAFT") =>
      rows
        .filter((row) => row.status === status)
        .map((row) => ({ type: row.type as QuestionType, marks: row.marks, count: row._count }));
    const sections = sectionNeeds(pattern.sections, bank("APPROVED"), bank("DRAFT"));
    result.push({
      subjectId: subject.id,
      patternLabel: pattern.label,
      ready: sections.every((row) => row.approved >= row.wanted),
      sections,
      order: [subject.grade.number, subject.name],
    });
  }
  // Stable, by class then subject name: a panel that reshuffles between
  // visits is one nobody can work down.
  result.sort((a, b) => b.order[0] - a.order[0] || a.order[1].localeCompare(b.order[1]));
  return result.map((row) => ({
    subjectId: row.subjectId,
    patternLabel: row.patternLabel,
    ready: row.ready,
    sections: row.sections,
  }));
}

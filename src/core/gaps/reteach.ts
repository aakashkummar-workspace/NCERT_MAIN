import "server-only";
import { withTenant } from "@/db/tenant";
import { conceptContext, outcomeIdsFor, outcomeStatementsFor } from "@/core/curriculum/concepts";
import { bookLinksForConcepts, type ConceptBookLink } from "@/core/curriculum/book-links";
import type { Option } from "@/core/questions/validate";
import { answerLabelFor } from "@/core/assessments/paper";
import { STUDENT_THRESHOLD } from "./rules";

/**
 * What a teacher needs before reteaching a gap — and a worksheet to do it with.
 *
 * A gap page said WHAT the class is weak on; the remedial paper measures
 * whether the reteaching worked. Between the two sat the lesson itself, with
 * nothing to help. This fills that: where it is in the book, what "secure"
 * looks like (the outcomes), what the class actually got wrong, who, and a
 * printable worksheet.
 *
 * ---------------------------------------------------------------------------
 * No model anywhere in it
 * ---------------------------------------------------------------------------
 * Every line is read or counted: the book's own section, the syllabus's own
 * outcome statements, the options this class chose. A model would write a
 * warmer lesson plan and would sometimes invent a misconception the class does
 * not have — and a teacher who reteaches the wrong misunderstanding loses a
 * lesson and a class's trust. The same refusal reports make.
 *
 * ---------------------------------------------------------------------------
 * "What they chose" is evidence, with its count
 * ---------------------------------------------------------------------------
 * A wrong option picked by several students names the specific wrong idea —
 * the most useful line here. One student picking it is one student, so a
 * wrong answer is listed only when at least MIN_SHARED chose it.
 */

export const MIN_SHARED = 2;
export const WORKSHEET_SIZE = 8;

export type Misconception = {
  stem: string;
  chosen: { key: string; text: string };
  correct: { key: string; text: string } | null;
  students: number;
  /** Of how many who answered it at all. */
  answered: number;
};

export type ReteachBrief = {
  gapId: string;
  classId: string;
  className: string;
  conceptId: string;
  conceptName: string;
  severity: string;
  meanEstimate: number;
  affected: number;
  measured: number;
  rootCause: { conceptId: string; name: string } | null;
  book: ConceptBookLink | null;
  outcomes: string[];
  misconceptions: Misconception[];
  /** Below the line now — not when the gap was found. Names, for the teacher. */
  struggling: { studentUserId: string; fullName: string; percent: number }[];
  /** Approved questions on the concept, easiest first, unseen first. */
  worksheetIds: string[];
};

export async function reteachBrief(
  organizationId: string,
  gapId: string,
): Promise<ReteachBrief | null> {
  const gap = await withTenant(organizationId, (tx) =>
    tx.learningGap.findFirst({ where: { id: gapId } }),
  );
  if (!gap || gap.scope !== "CLASS") return null;

  const klass = await withTenant(organizationId, (tx) =>
    tx.class.findFirst({
      where: { id: gap.scopeId, deletedAt: null },
      select: { id: true, name: true, subjectId: true },
    }),
  );
  if (!klass) return null;

  const [outcomeIds, outcomes, context, books] = await Promise.all([
    outcomeIdsFor(gap.conceptId),
    outcomeStatementsFor(gap.conceptId),
    conceptContext([gap.conceptId, ...(gap.rootCauseConceptId ? [gap.rootCauseConceptId] : [])]),
    bookLinksForConcepts([gap.conceptId], "teacher"),
  ]);

  const data = await withTenant(organizationId, async (tx) => {
    const enrolments = await tx.classEnrolment.findMany({
      where: { classId: klass.id, status: "ACTIVE" },
      select: { studentUserId: true },
    });
    const studentIds = enrolments.map((row) => row.studentUserId);

    const [readings, users, evidence, links] = await Promise.all([
      tx.studentConceptMastery.findMany({
        where: { conceptId: gap.conceptId, studentUserId: { in: studentIds } },
        select: { studentUserId: true, estimate: true },
      }),
      tx.user.findMany({ where: { id: { in: studentIds } }, select: { id: true, fullName: true } }),
      // The answers that bear on this concept, found through the ledger —
      // which already knows which answer counts towards which concept.
      tx.conceptEvidence.findMany({
        where: {
          conceptId: gap.conceptId,
          studentUserId: { in: studentIds },
          attemptAnswerId: { not: null },
        },
        select: { attemptAnswerId: true },
      }),
      outcomeIds.length === 0
        ? Promise.resolve([])
        : tx.questionOutcome.findMany({
            where: { learningOutcomeId: { in: outcomeIds } },
            select: { questionId: true },
          }),
    ]);

    const answers = await tx.attemptAnswer.findMany({
      where: { id: { in: evidence.flatMap((row) => (row.attemptAnswerId ? [row.attemptAnswerId] : [])) } },
      select: { questionVersionId: true, response: true, isCorrect: true },
    });
    const versionIds = [...new Set(answers.flatMap((a) => (a.questionVersionId ? [a.questionVersionId] : [])))];
    const versions = await tx.questionVersion.findMany({
      where: { id: { in: versionIds } },
      select: { id: true, stem: true, options: true },
    });

    const questionIds = [...new Set(links.map((link) => link.questionId))];
    const questions =
      questionIds.length === 0
        ? []
        : await tx.question.findMany({
            where: { id: { in: questionIds }, deletedAt: null, status: "APPROVED", subjectId: klass.subjectId },
            select: { id: true, difficulty: true },
            orderBy: { createdAt: "asc" },
          });
    // What this class has already met on a paper, so the worksheet prefers
    // questions they have not seen — the answer to a seen one is remembered.
    const seen = new Set(
      (
        await tx.assessmentQuestion.findMany({
          where: {
            questionId: { in: questions.map((q) => q.id) },
            assessment: { assignments: { some: { classId: klass.id } } },
          },
          select: { questionId: true },
        })
      ).map((row) => row.questionId),
    );

    return { readings, users, answers, versions, questions, seen };
  });

  // --- What they chose ------------------------------------------------------
  const versionOf = new Map(data.versions.map((v) => [v.id, v]));
  const tally = new Map<string, { versionId: string; key: string; count: number }>();
  const answeredPer = new Map<string, number>();
  for (const answer of data.answers) {
    if (!answer.questionVersionId) continue;
    const response = answer.response as { kind?: string; keys?: string[] } | null;
    if (response?.kind !== "choice" || !Array.isArray(response.keys) || response.keys.length !== 1) continue;
    answeredPer.set(answer.questionVersionId, (answeredPer.get(answer.questionVersionId) ?? 0) + 1);
    if (answer.isCorrect !== false) continue;
    const id = `${answer.questionVersionId}:${response.keys[0]}`;
    const entry = tally.get(id) ?? { versionId: answer.questionVersionId, key: response.keys[0]!, count: 0 };
    entry.count++;
    tally.set(id, entry);
  }
  const misconceptions: Misconception[] = [...tally.values()]
    .filter((entry) => entry.count >= MIN_SHARED)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .flatMap((entry) => {
      const version = versionOf.get(entry.versionId);
      const options = (version?.options ?? null) as Option[] | null;
      const chosen = options?.find((option) => option.key === entry.key);
      if (!version || !chosen) return [];
      const correct = options?.find((option) => option.isCorrect) ?? null;
      return [
        {
          stem: version.stem,
          chosen: { key: chosen.key, text: chosen.text },
          correct: correct ? { key: correct.key, text: correct.text } : null,
          students: entry.count,
          answered: answeredPer.get(entry.versionId) ?? entry.count,
        },
      ];
    });

  // --- Who --------------------------------------------------------------------
  const nameOf = new Map(data.users.map((u) => [u.id, u.fullName]));
  const struggling = data.readings
    .filter((row) => row.estimate !== null && Number(row.estimate) < STUDENT_THRESHOLD)
    .map((row) => ({
      studentUserId: row.studentUserId,
      fullName: nameOf.get(row.studentUserId) ?? "Student",
      percent: Math.round(Number(row.estimate) * 100),
    }))
    .sort((a, b) => a.percent - b.percent);

  return {
    gapId,
    classId: klass.id,
    className: klass.name,
    conceptId: gap.conceptId,
    conceptName: context.get(gap.conceptId)?.name ?? "This concept",
    severity: gap.severity,
    meanEstimate: Number(gap.meanEstimate),
    affected: gap.affectedStudentCount,
    measured: gap.measuredStudentCount,
    rootCause:
      gap.rootCauseConceptId && context.get(gap.rootCauseConceptId)
        ? { conceptId: gap.rootCauseConceptId, name: context.get(gap.rootCauseConceptId)!.name }
        : null,
    book: books.get(gap.conceptId) ?? null,
    outcomes,
    misconceptions,
    struggling,
    worksheetIds: pickWorksheet(data.questions, data.seen),
  };
}

const ORDER = { EASY: 0, MEDIUM: 1, HARD: 2 } as const;

/**
 * Easiest first — a worksheet for a group that is behind starts where they
 * can succeed — and unseen before seen. Pure and stable, so the sheet and its
 * key, built from the same list, cannot disagree.
 */
export function pickWorksheet(
  questions: { id: string; difficulty: "EASY" | "MEDIUM" | "HARD" }[],
  seen: Set<string>,
  size = WORKSHEET_SIZE,
): string[] {
  return questions
    .map((question, index) => ({ question, index }))
    .sort(
      (a, b) =>
        Number(seen.has(a.question.id)) - Number(seen.has(b.question.id)) ||
        ORDER[a.question.difficulty] - ORDER[b.question.difficulty] ||
        a.index - b.index,
    )
    .slice(0, size)
    .map(({ question }) => question)
    .sort((a, b) => ORDER[a.difficulty] - ORDER[b.difficulty])
    .map((question) => question.id);
}

export type WorksheetQuestion = {
  position: number;
  number: number;
  section: null;
  choiceGroup: null;
  marks: number;
  type: string;
  stem: string;
  options: { key: string; text: string }[] | null;
  /** Only on the key's copy — the sheet itself is built without it. */
  answerLabel: string | null;
  explanation: string | null;
  difficulty: string;
  rubric: { criteria: { label: string; marks: number }[] } | null;
};

/**
 * The worksheet's questions, in the order given, as the tenant's own current
 * APPROVED versions — and only those that really are on this concept, because
 * the list arrives in a URL and a URL is not trusted.
 */
export async function worksheetQuestions(
  organizationId: string,
  conceptId: string,
  questionIds: string[],
): Promise<WorksheetQuestion[]> {
  const outcomeIds = await outcomeIdsFor(conceptId);
  if (outcomeIds.length === 0 || questionIds.length === 0) return [];

  const rows = await withTenant(organizationId, async (tx) => {
    const onConcept = await tx.questionOutcome.findMany({
      where: { questionId: { in: questionIds }, learningOutcomeId: { in: outcomeIds } },
      select: { questionId: true },
    });
    const allowed = new Set(onConcept.map((row) => row.questionId));
    const questions = await tx.question.findMany({
      where: { id: { in: [...allowed] }, deletedAt: null, status: "APPROVED" },
      select: { id: true, type: true, marks: true, difficulty: true, currentVersionId: true },
    });
    const versions = await tx.questionVersion.findMany({
      where: { id: { in: questions.flatMap((q) => (q.currentVersionId ? [q.currentVersionId] : [])) } },
    });
    return { questions, versions };
  });

  const byId = new Map(rows.questions.map((q) => [q.id, q]));
  const versionOf = new Map(rows.versions.map((v) => [v.id, v]));
  const ordered = questionIds.flatMap((id) => {
    const question = byId.get(id);
    const version = question?.currentVersionId ? versionOf.get(question.currentVersionId) : undefined;
    return question && version ? [{ question, version }] : [];
  });

  return ordered.map(({ question, version }, index) => {
    const options = (version.options ?? null) as Option[] | null;
    const rubric = version.rubric as { criteria?: { label: string; marks: number }[] } | null;
    return {
      position: index + 1,
      number: index + 1,
      section: null,
      choiceGroup: null,
      marks: question.marks,
      type: question.type,
      stem: version.stem,
      // Rebuilt, never filtered: the sheet a class holds carries no answer.
      options: options ? options.map((option) => ({ key: option.key, text: option.text })) : null,
      answerLabel: answerLabelFor(
        question.type,
        options,
        (version.answerKey ?? null) as Parameters<typeof answerLabelFor>[2],
      ),
      explanation: version.explanation,
      difficulty: question.difficulty,
      rubric: rubric?.criteria ? { criteria: rubric.criteria } : null,
    };
  });
}

/** Just enough of a class gap to head a worksheet. */
export async function gapHeading(
  organizationId: string,
  gapId: string,
): Promise<{ conceptId: string; conceptName: string; className: string } | null> {
  const found = await withTenant(organizationId, async (tx) => {
    const gap = await tx.learningGap.findFirst({ where: { id: gapId, scope: "CLASS" } });
    if (!gap) return null;
    const klass = await tx.class.findFirst({ where: { id: gap.scopeId }, select: { name: true } });
    return klass ? { conceptId: gap.conceptId, className: klass.name } : null;
  });
  if (!found) return null;
  const context = await conceptContext([found.conceptId]);
  return { ...found, conceptName: context.get(found.conceptId)?.name ?? "Practice" };
}

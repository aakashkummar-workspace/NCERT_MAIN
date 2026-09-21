import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";
import type { QuestionType } from "@/core/questions/validate";
import {
  DEFAULT_BLUEPRINT,
  planSlots,
  validateBlueprint,
  type BankInventory,
  type Blueprint,
  type Feasibility,
} from "./blueprint";
import {
  answerableMarks,
  checkLayout,
  describeSectionShortfalls,
  orderBySection,
  patternForSubject,
  sectionFeasibility,
  sectionFor,
} from "./pattern";

/**
 * Assessments.
 *
 * The rules that matter, all of which exist to protect a paper a class has
 * already sat:
 *
 *   1. **Publishing freezes the question versions.** Each row records the
 *      version served, so an edit to the source question in December cannot
 *      change how an August paper marks.
 *   2. **Only APPROVED questions may be published.** A draft is somebody's
 *      unfinished thought.
 *   3. **Marks must add up.** Checked at publish, not hoped for.
 *   4. **A published assessment is not edited.** It is closed, or copied into a
 *      new draft.
 */

export type Actor = { organizationId: string; userId: string; role: string };

export type AssessmentSettings = {
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  allowReview: boolean;
};

export const DEFAULT_SETTINGS: AssessmentSettings = {
  shuffleQuestions: true,
  shuffleOptions: false,
  allowReview: true,
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listAssessments(organizationId: string) {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx.assessment.findMany({
      where: { deletedAt: null },
      include: {
        subject: true,
        grade: true,
        class: true,
        _count: { select: { questions: true } },
      },
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    });

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      subjectName: row.subject.name,
      gradeLabel: row.grade.label,
      className: row.class?.name ?? null,
      durationMinutes: row.durationMinutes,
      totalMarks: row.totalMarks,
      questionCount: row._count.questions,
      publishedAt: row.publishedAt,
      updatedAt: row.updatedAt,
    }));
  });
}

export async function getAssessment(organizationId: string, id: string) {
  return withTenant(organizationId, async (tx) => {
    const row = await tx.assessment.findFirst({
      where: { id, deletedAt: null },
      include: {
        subject: true,
        grade: { include: { board: { select: { code: true } } } },
        class: true,
        questions: {
          orderBy: { position: "asc" },
          include: {
            question: {
              include: {
                outcomes: true,
                versions: { orderBy: { version: "desc" }, take: 1 },
              },
            },
          },
        },
      },
    });
    if (!row) return null;

    const blueprint = { ...DEFAULT_BLUEPRINT, ...(row.blueprint as object) } as Blueprint;

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      subjectId: row.subjectId,
      subjectName: row.subject.name,
      subjectCode: row.subject.code,
      boardCode: row.grade.board.code,
      /** The board pattern this subject could follow, offered at step 3. */
      boardPattern: patternForSubject(row.grade.board.code, row.subject.code),
      gradeId: row.gradeId,
      gradeLabel: row.grade.label,
      classId: row.classId,
      className: row.class?.name ?? null,
      durationMinutes: row.durationMinutes,
      totalMarks: row.totalMarks,
      passingMarks: row.passingMarks,
      blueprint,
      settings: { ...DEFAULT_SETTINGS, ...(row.settings as object) } as AssessmentSettings,
      publishedAt: row.publishedAt,
      questions: row.questions.map((item) => ({
        id: item.id,
        questionId: item.questionId,
        position: item.position,
        marks: item.marks,
        section: item.section,
        choiceGroup: item.choiceGroup,
        frozenVersionId: item.questionVersionId,
        status: item.question.status,
        type: item.question.type as QuestionType,
        difficulty: item.question.difficulty,
        outcomeCount: item.question.outcomes.length,
        stem: item.question.versions[0]?.stem ?? "",
      })),
    };
  });
}

/**
 * What the bank holds, within the blueprint's curriculum scope.
 *
 * Only APPROVED questions count. A draft is somebody's unfinished thought and
 * counting it would make the feasibility check optimistic in exactly the way
 * that wastes a teacher's evening.
 */
export async function bankInventory(
  organizationId: string,
  subjectId: string,
  outcomeIds: string[],
): Promise<BankInventory[]> {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx.question.findMany({
      where: {
        deletedAt: null,
        status: "APPROVED",
        subjectId,
        ...(outcomeIds.length > 0
          ? { outcomes: { some: { learningOutcomeId: { in: outcomeIds } } } }
          : {}),
      },
      select: { difficulty: true, type: true },
    });

    const counts = new Map<string, BankInventory>();
    for (const row of rows) {
      const key = `${row.difficulty}:${row.type}`;
      const existing = counts.get(key);
      if (existing) {
        existing.count++;
      } else {
        counts.set(key, {
          difficulty: row.difficulty,
          type: row.type as QuestionType,
          count: 1,
        });
      }
    }
    return [...counts.values()];
  });
}

/**
 * What the bank holds by type and marks, the two things a section asks for.
 * Same scope and the same APPROVED-only rule as `bankInventory`.
 */
export async function bankByTypeAndMarks(
  organizationId: string,
  subjectId: string,
  outcomeIds: string[],
): Promise<{ type: QuestionType; marks: number; count: number }[]> {
  const rows = await withTenant(organizationId, (tx) =>
    tx.question.groupBy({
      by: ["type", "marks"],
      where: {
        deletedAt: null,
        status: "APPROVED",
        subjectId,
        ...(outcomeIds.length > 0
          ? { outcomes: { some: { learningOutcomeId: { in: outcomeIds } } } }
          : {}),
      },
      _count: { _all: true },
    }),
  );
  return rows.map((row) => ({
    type: row.type as QuestionType,
    marks: row.marks,
    count: row._count._all,
  }));
}

/**
 * Feasibility of a sectioned pattern: per section, not per difficulty, because
 * "Section D needs six long answers and the bank has one" is the sentence a
 * teacher can act on.
 */
export async function checkPatternFeasibility(
  organizationId: string,
  subjectId: string,
  blueprint: Blueprint,
): Promise<{ supplied: number; wanted: number; messages: string[] }> {
  const sections = blueprint.pattern?.sections ?? [];
  const supply = sectionFeasibility(
    sections,
    await bankByTypeAndMarks(organizationId, subjectId, blueprint.outcomeIds),
  );
  return {
    supplied: supply.reduce((sum, row) => sum + Math.min(row.wanted, row.available), 0),
    wanted: supply.reduce((sum, row) => sum + row.wanted, 0),
    messages: describeSectionShortfalls(supply),
  };
}

export async function checkFeasibility(
  organizationId: string,
  subjectId: string,
  blueprint: Blueprint,
): Promise<Feasibility> {
  const inventory = await bankInventory(
    organizationId,
    subjectId,
    blueprint.outcomeIds,
  );
  return planSlots(blueprint, inventory);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type CreateInput = {
  title: string;
  subjectId: string;
  gradeId: string;
  classId?: string | null;
  durationMinutes: number;
  totalMarks: number;
};

export async function createAssessment(
  actor: Actor,
  input: CreateInput,
): Promise<{ id: string } | { error: string }> {
  const fit = await withTenant(actor.organizationId, async (tx) => {
    const subject = await tx.subject.findUnique({
      where: { id: input.subjectId },
      select: { gradeId: true },
    });
    if (!subject) return "That subject does not exist.";
    if (subject.gradeId !== input.gradeId) {
      // The same mis-filing guard as questions and classes: a paper filed
      // against the wrong year measures the wrong syllabus, and nothing
      // downstream looks wrong.
      return "That subject is not taught in that class year.";
    }
    if (input.classId) {
      const klass = await tx.class.findFirst({
        where: { id: input.classId, deletedAt: null },
        select: { subjectId: true },
      });
      if (!klass) return "That class does not exist.";
      if (klass.subjectId !== input.subjectId) {
        return "That class does not study that subject.";
      }
    }
    return null;
  });

  if (fit) return { error: fit };

  const id = randomUUID();
  await withTenant(actor.organizationId, (tx) =>
    tx.assessment.create({
      data: {
        id,
        organizationId: actor.organizationId,
        createdById: actor.userId,
        classId: input.classId ?? null,
        title: input.title.trim(),
        subjectId: input.subjectId,
        gradeId: input.gradeId,
        durationMinutes: input.durationMinutes,
        totalMarks: input.totalMarks,
        // Seeded from what the teacher just typed, not from a constant.
        // Opening step 3 with "20 questions" under a paper they set to 4 marks
        // is the builder contradicting itself on first sight.
        blueprint: {
          ...DEFAULT_BLUEPRINT,
          totalMarks: input.totalMarks,
          totalQuestions: input.totalMarks,
        } as unknown as Prisma.InputJsonValue,
        settings: DEFAULT_SETTINGS as unknown as Prisma.InputJsonValue,
      },
    }),
  );

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "assessment.created",
    entityType: "assessment",
    entityId: id,
    after: { title: input.title },
  });

  return { id };
}

export async function updateDraft(
  actor: Actor,
  id: string,
  patch: {
    title?: string;
    durationMinutes?: number;
    totalMarks?: number;
    classId?: string | null;
    blueprint?: Blueprint;
    settings?: AssessmentSettings;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await withTenant(actor.organizationId, async (tx) => {
    const assessment = await tx.assessment.findFirst({
      where: { id, deletedAt: null },
    });
    if (!assessment) return "NOT_FOUND";
    if (assessment.status !== "DRAFT") {
      // A published paper is not edited. It is closed, or copied.
      return "A published assessment cannot be changed. Duplicate it instead.";
    }

    await tx.assessment.update({
      where: { id },
      data: {
        ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
        ...(patch.durationMinutes !== undefined
          ? { durationMinutes: patch.durationMinutes }
          : {}),
        ...(patch.totalMarks !== undefined ? { totalMarks: patch.totalMarks } : {}),
        ...(patch.classId !== undefined ? { classId: patch.classId } : {}),
        ...(patch.blueprint
          ? { blueprint: patch.blueprint as unknown as Prisma.InputJsonValue }
          : {}),
        ...(patch.settings
          ? { settings: patch.settings as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
    return null;
  });

  if (result === "NOT_FOUND") return { ok: false, error: "NOT_FOUND" };
  if (result) return { ok: false, error: result };
  return { ok: true };
}

export type LayoutInput = {
  questionId: string;
  /** Omitted: placed by the pattern, when the paper has one. */
  section?: string | null;
  choiceGroup?: number | null;
};

/**
 * Set the paper's questions, in order, optionally with sections and "OR"
 * pairs.
 *
 * A bare list of ids is still accepted, and under a pattern each question is
 * placed in its section by type and marks. The rows are then ordered section
 * by section, so Section B can never print between two Section A questions
 * because of the order somebody ticked the boxes in.
 */
export async function setQuestions(
  actor: Actor,
  id: string,
  input: string[] | LayoutInput[],
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const items: LayoutInput[] = input.map((entry) =>
    typeof entry === "string" ? { questionId: entry } : entry,
  );
  const questionIds = items.map((item) => item.questionId);
  const result = await withTenant(actor.organizationId, async (tx) => {
    const assessment = await tx.assessment.findFirst({
      where: { id, deletedAt: null },
    });
    if (!assessment) return "NOT_FOUND";
    if (assessment.status !== "DRAFT") {
      return "A published assessment cannot be changed. Duplicate it instead.";
    }

    const unique = [...new Set(questionIds)];
    const questions = await tx.question.findMany({
      where: { id: { in: unique }, deletedAt: null },
      select: { id: true, marks: true, subjectId: true, status: true, type: true },
    });

    if (questions.length !== unique.length) {
      return "One of those questions no longer exists.";
    }

    const strayer = questions.find((q) => q.subjectId !== assessment.subjectId);
    if (strayer) {
      return "One of those questions belongs to a different subject.";
    }

    const byId = new Map(questions.map((q) => [q.id, q]));
    const blueprint = { ...DEFAULT_BLUEPRINT, ...(assessment.blueprint as object) } as Blueprint;
    const sections = blueprint.pattern?.sections ?? null;
    const sectionNames = new Set((sections ?? []).map((section) => section.name));
    const seen = new Set<string>();

    const placed = items
      .filter((item) => {
        if (seen.has(item.questionId)) return false;
        seen.add(item.questionId);
        return true;
      })
      .map((item) => {
        const question = byId.get(item.questionId)!;
        // A section is taken from the request only when the pattern has one
        // by that name; otherwise it is placed by type and marks. Nothing is
        // sectioned on a paper with no pattern.
        const section = sections
          ? item.section && sectionNames.has(item.section)
            ? item.section
            : sectionFor(sections, question.type as QuestionType, question.marks)
          : null;
        return {
          questionId: item.questionId,
          marks: question.marks,
          section,
          choiceGroup: item.choiceGroup ?? null,
        };
      });

    const ordered = sections ? orderBySection(sections, placed) : placed;
    const layout = checkLayout(sections, ordered);
    if (layout.errors.length > 0) return layout.errors[0]!;

    await tx.assessmentQuestion.deleteMany({ where: { assessmentId: id } });

    await tx.assessmentQuestion.createMany({
      data: ordered.map((item, index) => ({
        id: randomUUID(),
        organizationId: actor.organizationId,
        assessmentId: id,
        questionId: item.questionId,
        position: index + 1,
        marks: item.marks,
        section: item.section,
        choiceGroup: item.choiceGroup,
      })),
    });

    return null;
  });

  if (result === "NOT_FOUND") return { ok: false, error: "NOT_FOUND" };
  if (result) return { ok: false, error: result };

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "assessment.questions_set",
    entityType: "assessment",
    entityId: id,
    after: { count: questionIds.length },
  });

  return { ok: true, count: questionIds.length };
}

export type PublishCheck = {
  ready: boolean;
  problems: string[];
  questionCount: number;
  marksTotal: number;
};

/**
 * Everything that must be true before a class sees this paper.
 *
 * Run continuously in the builder so the teacher never presses Publish and
 * meets a refusal, and run again at publish because the bank can change
 * underneath a draft.
 */
export async function publishCheck(
  organizationId: string,
  id: string,
): Promise<PublishCheck | null> {
  const assessment = await getAssessment(organizationId, id);
  if (!assessment) return null;

  const problems: string[] = [];
  // An "OR" pair counts once: a student answers one of the two.
  const marksTotal = answerableMarks(assessment.questions);

  if (assessment.questions.length === 0) {
    problems.push("The paper has no questions yet.");
  }

  const unapproved = assessment.questions.filter((q) => q.status !== "APPROVED");
  if (unapproved.length > 0) {
    problems.push(
      `${unapproved.length} ${unapproved.length === 1 ? "question is" : "questions are"} not approved yet. A draft is somebody's unfinished thought, so it cannot go into a paper.`,
    );
  }

  if (assessment.questions.length > 0 && marksTotal !== assessment.totalMarks) {
    problems.push(
      `The questions add up to ${marksTotal} marks, but the paper is set to ${assessment.totalMarks}. Change one or the other.`,
    );
  }

  // The layout is checked at save, and again here, because a paper saved
  // before a rule existed must not publish past it.
  problems.push(
    ...checkLayout(assessment.blueprint.pattern?.sections ?? null, assessment.questions).errors,
  );

  const unmapped = assessment.questions.filter((q) => q.outcomeCount === 0);
  if (unmapped.length > 0) {
    problems.push(
      `${unmapped.length} ${unmapped.length === 1 ? "question is" : "questions are"} not linked to a learning outcome, so the results will not show what the class has secured.`,
    );
  }

  return {
    ready: problems.length === 0,
    problems,
    questionCount: assessment.questions.length,
    marksTotal,
  };
}

export async function publishAssessment(
  actor: Actor,
  id: string,
): Promise<{ ok: true } | { ok: false; problems: string[] }> {
  const check = await publishCheck(actor.organizationId, id);
  if (!check) return { ok: false, problems: ["We could not find that assessment."] };
  if (!check.ready) return { ok: false, problems: check.problems };

  await withTenant(actor.organizationId, async (tx) => {
    const rows = await tx.assessmentQuestion.findMany({
      where: { assessmentId: id },
      include: { question: { select: { currentVersionId: true } } },
    });

    // Freeze the version each question is at RIGHT NOW. This is what makes a
    // paper written in August keep marking the way it did in August after the
    // source question is edited in December.
    for (const row of rows) {
      await tx.assessmentQuestion.update({
        where: { id: row.id },
        data: { questionVersionId: row.question.currentVersionId },
      });
    }

    await tx.assessment.updateMany({
      where: { id, status: "DRAFT" },
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });
  });

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "assessment.published",
    entityType: "assessment",
    entityId: id,
    after: { questions: check.questionCount, marks: check.marksTotal },
  });

  return { ok: true };
}

export async function duplicateAssessment(
  actor: Actor,
  id: string,
): Promise<{ id: string } | null> {
  const source = await getAssessment(actor.organizationId, id);
  if (!source) return null;

  const newId = randomUUID();
  await withTenant(actor.organizationId, async (tx) => {
    await tx.assessment.create({
      data: {
        id: newId,
        organizationId: actor.organizationId,
        createdById: actor.userId,
        classId: source.classId,
        title: `${source.title} (copy)`,
        subjectId: source.subjectId,
        gradeId: source.gradeId,
        durationMinutes: source.durationMinutes,
        totalMarks: source.totalMarks,
        blueprint: source.blueprint as unknown as Prisma.InputJsonValue,
        settings: source.settings as unknown as Prisma.InputJsonValue,
      },
    });

    if (source.questions.length > 0) {
      await tx.assessmentQuestion.createMany({
        data: source.questions.map((q, index) => ({
          id: randomUUID(),
          organizationId: actor.organizationId,
          assessmentId: newId,
          questionId: q.questionId,
          position: index + 1,
          marks: q.marks,
          section: q.section,
          choiceGroup: q.choiceGroup,
          // Deliberately NOT copying the frozen version: a copy is a new draft
          // and will freeze afresh when it is published.
        })),
      });
    }
  });

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "assessment.duplicated",
    entityType: "assessment",
    entityId: newId,
    after: { from: id },
  });

  return { id: newId };
}

export async function closeAssessment(
  actor: Actor,
  id: string,
): Promise<boolean> {
  const result = await withTenant(actor.organizationId, (tx) =>
    tx.assessment.updateMany({
      where: { id, status: "PUBLISHED", deletedAt: null },
      data: { status: "CLOSED", closedAt: new Date() },
    }),
  );
  if (result.count === 0) return false;

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "assessment.closed",
    entityType: "assessment",
    entityId: id,
  });
  return true;
}

export { validateBlueprint, planSlots, DEFAULT_BLUEPRINT };
export type { Blueprint, Feasibility };

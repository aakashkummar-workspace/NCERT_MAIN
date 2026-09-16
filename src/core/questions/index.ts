import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { parseRubric, validateRubric, type Rubric } from "./rubric";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";
import {
  hasOptions,
  validateQuestion,
  type AnswerKey,
  type Option,
  type QuestionDraft,
  type QuestionType,
} from "./validate";

/**
 * The question bank.
 *
 * Two rules shape everything here:
 *
 *   1. **An approved question is immutable.** An attempt records the version it
 *      was served, so a paper written in August still marks the way it did in
 *      August after the question is edited in December. Editing an approved
 *      question creates version n+1; it never rewrites version n.
 *
 *   2. **Approval is a human act with a name on it.** Nothing reaches APPROVED
 *      without a user id and a timestamp. When AI generation arrives it will
 *      create DRAFT rows and will not be able to do otherwise.
 */

export type Actor = { organizationId: string; userId: string; role: string };

export type QuestionInput = {
  type: QuestionType;
  subjectId: string;
  chapterId?: string | null;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  marks: number;
  expectedTimeSeconds?: number | null;
  stem: string;
  options?: Option[] | null;
  answerKey?: AnswerKey;
  /**
   * The mark scheme, for the types a person marks.
   *
   * Validated against the question's marks at save: a rubric whose parts add
   * to 5 on a six-mark question cannot award full marks, and nobody finds that
   * out until the twentieth paper.
   */
  rubric?: Rubric | null;
  explanation?: string | null;
  hint?: string | null;
  outcomeIds?: string[];
  visibility?: "ORGANIZATION" | "PRIVATE";
  /**
   * Where the question came from. Defaults to MANUAL — a teacher typing.
   *
   * AI_GENERATED changes nothing about the gate it has to pass: the same
   * validator, the same curriculum-fit check, the same duplicate hash, and the
   * same DRAFT status waiting for a person. It is recorded so a teacher
   * reviewing a queue knows what they are reading, and so "are the generated
   * ones being approved?" is a question the product can answer.
   */
  source?: "MANUAL" | "AI_GENERATED" | "IMPORTED";
  /**
   * What the AI validator warned about. Advice on the card, never a block —
   * anything it rejected was dropped before this point.
   */
  aiFlags?: { code: string; note: string }[] | null;
};

/**
 * Exact-duplicate detection. Normalises whitespace and case so that the same
 * question pasted twice with different spacing is still recognised as the same
 * question. Near-duplicates need embeddings, which arrive with AI generation.
 */
export function contentHash(
  type: QuestionType,
  stem: string,
  options?: Option[] | null,
): Buffer {
  const normalise = (value: string) =>
    value.trim().toLowerCase().replace(/\s+/g, " ");

  const parts = [type, normalise(stem)];
  if (options && hasOptions(type)) {
    // Sorted, because reordering the choices does not make it a new question.
    parts.push(
      ...options
        .map((option) => normalise(option.text))
        .sort()
        .map((text, index) => `${index}:${text}`),
    );
  }

  // JSON rather than a joined string: a separator cannot be spoofed by text
  // inside an option, and unlike a NUL delimiter it stays visible in the
  // source. A raw NUL here is what npm run check:encoding caught.
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type BankFilters = {
  subjectId?: string;
  chapterId?: string;
  type?: QuestionType;
  difficulty?: "EASY" | "MEDIUM" | "HARD";
  status?: "DRAFT" | "IN_REVIEW" | "APPROVED" | "REJECTED" | "ARCHIVED";
  search?: string;
  limit?: number;
  offset?: number;
};

/**
 * Every filter goes into the WHERE clause — search included.
 *
 * The bank used to load the newest 500 rows and filter them in the browser,
 * which was instant at a few hundred questions and silently wrong at 3,880:
 * choosing "Class 10 · Social Science" searched only the 500 most recent rows,
 * found one draft, and presented that as the subject's whole bank. Search had
 * the same flaw one layer down — it ran after `take`. A filter applied to a
 * truncated set is a flattering denominator in list form.
 */
function bankWhere(filters: BankFilters, opts: { status: boolean }): Prisma.QuestionWhereInput {
  const search = filters.search?.trim();
  return {
    deletedAt: null,
    ...(filters.subjectId ? { subjectId: filters.subjectId } : {}),
    ...(filters.chapterId ? { chapterId: filters.chapterId } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.difficulty ? { difficulty: filters.difficulty } : {}),
    ...(opts.status && filters.status ? { status: filters.status } : {}),
    // Any version's stem: Prisma cannot say "the latest version" inside a
    // relation filter. Rows and count use the same clause, so the list and
    // its "Showing X of Y" can never disagree.
    //
    // Every word must appear, in any order: "similar triangles" should find
    // "triangles are similar when…", which one phrase match does not.
    ...(search
      ? {
          AND: searchWords(search).map((word) => ({
            versions: {
              some: { stem: { contains: escapeLike(word), mode: "insensitive" as const } },
            },
          })),
        }
      : {}),
  };
}

/**
 * Prisma's `contains` becomes ILIKE '%…%' WITHOUT escaping what it was given,
 * so a search for "%" matched every question and "_" matched any character.
 * Checked against the database, not assumed. Backslash is Postgres's default
 * LIKE escape.
 */
function escapeLike(word: string): string {
  return word.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** At most eight words — past that a search is a paste, not a query. */
export function searchWords(search: string): string[] {
  return [...new Set(search.trim().split(/\s+/).filter(Boolean))].slice(0, 8);
}

/** One page of the bank, with the total that matched, so a list can say it is truncated. */
export async function searchQuestions(organizationId: string, filters: BankFilters = {}) {
  const [rows, total] = await Promise.all([
    listQuestions(organizationId, filters),
    withTenant(organizationId, (tx) =>
      tx.question.count({ where: bankWhere(filters, { status: true }) }),
    ),
  ]);
  return { rows, total };
}

export async function listQuestions(
  organizationId: string,
  filters: BankFilters = {},
) {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx.question.findMany({
      where: bankWhere(filters, { status: true }),
      include: {
        subject: true,
        chapter: true,
        versions: { orderBy: { version: "desc" }, take: 1 },
        outcomes: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: Math.max(filters.offset ?? 0, 0),
      take: Math.min(filters.limit ?? 500, 2000),
    });

    return rows
      .map((row) => {
        const current = row.versions[0];
        return {
          id: row.id,
          subjectId: row.subjectId,
          type: row.type as QuestionType,
          difficulty: row.difficulty,
          marks: row.marks,
          status: row.status,
          source: row.source,
          subjectName: row.subject.name,
          chapterId: row.chapterId,
          chapterTitle: row.chapter?.title ?? null,
          chapterNumber: row.chapter?.number ?? null,
          outcomeIds: row.outcomes.map((o) => o.learningOutcomeId),
          outcomeCount: row.outcomes.length,
          version: current?.version ?? 1,
          stem: current?.stem ?? "",
          // The bank is a teacher's surface, and a teacher choosing questions
          // for a paper reads the answer with the question. The student-facing
          // player builds its own payload and never sees these.
          options: (current?.options as Option[] | null) ?? null,
          answerKey: (current?.answerKey as AnswerKey) ?? null,
          explanation: current?.explanation ?? null,
          createdAt: row.createdAt,
        };
      });
  });
}

export async function getQuestion(organizationId: string, questionId: string) {
  return withTenant(organizationId, async (tx) => {
    const row = await tx.question.findFirst({
      where: { id: questionId, deletedAt: null },
      include: {
        subject: true,
        chapter: true,
        outcomes: true,
        versions: { orderBy: { version: "desc" } },
      },
    });
    if (!row) return null;

    const current = row.versions[0];
    if (!current) return null;

    const draft: QuestionDraft = {
      type: row.type as QuestionType,
      stem: current.stem,
      options: (current.options as Option[] | null) ?? null,
      answerKey: (current.answerKey as AnswerKey) ?? null,
      explanation: current.explanation,
      hint: current.hint,
      marks: row.marks,
      outcomeIds: row.outcomes.map((o) => o.learningOutcomeId),
    };

    return {
      id: row.id,
      status: row.status,
      source: row.source,
      /** Advice from the validator, never a block. See core/questions/generate. */
      aiFlags: (row.aiFlags as { code: string; note: string }[] | null) ?? [],
      visibility: row.visibility,
      type: row.type as QuestionType,
      difficulty: row.difficulty,
      marks: row.marks,
      expectedTimeSeconds: row.expectedTimeSeconds,
      subjectId: row.subjectId,
      subjectName: row.subject.name,
      chapterId: row.chapterId,
      chapterTitle: row.chapter?.title ?? null,
      outcomeIds: row.outcomes.map((o) => o.learningOutcomeId),
      version: current.version,
      versionCount: row.versions.length,
      stem: current.stem,
      options: (current.options as Option[] | null) ?? null,
      answerKey: (current.answerKey as AnswerKey) ?? null,
      explanation: current.explanation,
      hint: current.hint,
      rubric: parseRubric(current.rubric),
      approvedAt: row.approvedAt,
      rejectionReason: row.rejectionReason,
      validation: validateQuestion(draft),
    };
  });
}

/**
 * How many questions the bank holds per subject and per chapter, for the
 * Class → Subject → Chapter steps that open the bank. `approved` travels with
 * `total`, because a chapter of forty drafts is not forty questions a teacher
 * can put in a paper today.
 */
export async function bankCounts(organizationId: string) {
  const grouped = await withTenant(organizationId, (tx) =>
    tx.question.groupBy({
      by: ["subjectId", "chapterId", "status"],
      where: { deletedAt: null },
      _count: true,
    }),
  );
  type Count = { total: number; approved: number };
  const bySubject = new Map<string, Count>();
  const byChapter = new Map<string, Count>();
  const add = (map: Map<string, Count>, key: string, n: number, approved: boolean) => {
    const entry = map.get(key) ?? { total: 0, approved: 0 };
    entry.total += n;
    if (approved) entry.approved += n;
    map.set(key, entry);
  };
  for (const row of grouped) {
    const approved = row.status === "APPROVED";
    add(bySubject, row.subjectId, row._count, approved);
    if (row.chapterId) add(byChapter, row.chapterId, row._count, approved);
  }
  return { bySubject, byChapter };
}

/**
 * Counts per status. Given filters, the counts follow them (every filter but
 * status itself), so the chips above a subject's list describe that subject
 * rather than the whole bank.
 */
export async function bankSummary(organizationId: string, filters: BankFilters = {}) {
  return withTenant(organizationId, async (tx) => {
    const grouped = await tx.question.groupBy({
      by: ["status"],
      where: bankWhere(filters, { status: false }),
      _count: true,
    });
    const counts = Object.fromEntries(
      grouped.map((row) => [row.status, row._count]),
    ) as Record<string, number>;

    return {
      total: Object.values(counts).reduce((sum, n) => sum + n, 0),
      draft: counts.DRAFT ?? 0,
      inReview: counts.IN_REVIEW ?? 0,
      approved: counts.APPROVED ?? 0,
      rejected: counts.REJECTED ?? 0,
      archived: counts.ARCHIVED ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Curriculum coherence
// ---------------------------------------------------------------------------

/**
 * Does this question's curriculum placement hold together?
 *
 * A question filed under Hindi with a Mathematics chapter, or mapped to an
 * outcome from a different chapter, will be SCORED correctly and will attribute
 * its evidence to the wrong concept for the rest of its life. Nothing later
 * looks wrong; the mastery numbers are just quietly about something else.
 *
 * So this is an error, not a warning, and it is checked on the server rather
 * than trusted from a form.
 */
export async function checkCurriculumFit(
  organizationId: string,
  input: Pick<QuestionInput, "subjectId" | "chapterId" | "outcomeIds">,
): Promise<string | null> {
  return withTenant(organizationId, async (tx) => {
    if (input.chapterId) {
      const chapter = await tx.chapter.findUnique({
        where: { id: input.chapterId },
        select: { subjectId: true },
      });
      if (!chapter) return "That chapter does not exist.";
      if (chapter.subjectId !== input.subjectId) {
        return "That chapter belongs to a different subject. Results would be filed against the wrong syllabus.";
      }
    }

    const outcomeIds = input.outcomeIds ?? [];
    if (outcomeIds.length === 0) return null;

    const outcomes = await tx.learningOutcome.findMany({
      where: { id: { in: outcomeIds } },
      select: { id: true, topic: { select: { chapterId: true } } },
    });

    if (outcomes.length !== new Set(outcomeIds).size) {
      return "One of the learning outcomes no longer exists.";
    }

    if (input.chapterId) {
      const stray = outcomes.find(
        (outcome) => outcome.topic.chapterId !== input.chapterId,
      );
      if (stray) {
        return "One of the learning outcomes belongs to a different chapter. Mastery would be credited to the wrong concept.";
      }
    }

    return null;
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type CreateResult =
  | { ok: true; id: string }
  | { ok: false; code: "INVALID"; problems: ReturnType<typeof validateQuestion> }
  | { ok: false; code: "MISFILED"; message: string }
  | { ok: false; code: "DUPLICATE"; existingId: string };

export async function createQuestion(
  actor: Actor,
  input: QuestionInput,
): Promise<CreateResult> {
  const draft = toDraft(input);
  const validation = validateQuestion(draft);
  if (!validation.valid) {
    return { ok: false, code: "INVALID", problems: validation };
  }

  // The mark scheme, checked against the question's own marks. An ERROR rather
  // than a warning: every rule it enforces produces a scheme that cannot be
  // used correctly, and discovering that at the twentieth paper costs every
  // mark already given.
  const rubricProblems = validateRubric(input.rubric ?? null, input.marks);
  if (rubricProblems.length > 0) {
    return { ok: false, code: "MISFILED", message: rubricProblems[0]!.message };
  }

  const misfiled = await checkCurriculumFit(actor.organizationId, input);
  if (misfiled) return { ok: false, code: "MISFILED", message: misfiled };

  const hash = contentHash(input.type, input.stem, input.options);

  const outcome = await withTenant<
    { duplicate: string } | { questionId: string }
  >(actor.organizationId, async (tx) => {
    const duplicate = await tx.question.findFirst({
      where: { contentHash: new Uint8Array(hash), deletedAt: null },
      select: { id: true },
    });
    if (duplicate) return { duplicate: duplicate.id };

    const questionId = randomUUID();
    const versionId = randomUUID();

    await tx.question.create({
      data: {
        id: questionId,
        organizationId: actor.organizationId,
        visibility: input.visibility ?? "ORGANIZATION",
        createdById: actor.userId,
        subjectId: input.subjectId,
        chapterId: input.chapterId ?? null,
        primaryOutcomeId: input.outcomeIds?.[0] ?? null,
        type: input.type,
        difficulty: input.difficulty,
        marks: input.marks,
        expectedTimeSeconds: input.expectedTimeSeconds ?? null,
        // Always DRAFT. Approval is a separate, named act — see approveQuestion.
        status: "DRAFT",
        source: input.source ?? "MANUAL",
        aiFlags: input.aiFlags?.length ? input.aiFlags : undefined,
        contentHash: new Uint8Array(hash),
      },
    });

    await tx.questionVersion.create({
      data: {
        id: versionId,
        questionId,
        version: 1,
        stem: input.stem.trim(),
        options: serialiseOptions(input),
        answerKey: (input.answerKey ?? null) as Prisma.InputJsonValue,
        rubric: (input.rubric ?? null) as Prisma.InputJsonValue,
        explanation: input.explanation?.trim() || null,
        hint: input.hint?.trim() || null,
        createdById: actor.userId,
      },
    });

    await tx.question.update({
      where: { id: questionId },
      data: { currentVersionId: versionId },
    });

    await linkOutcomes(tx, questionId, input.outcomeIds ?? []);
    return { questionId };
  });

  if ("duplicate" in outcome) {
    return { ok: false, code: "DUPLICATE", existingId: outcome.duplicate };
  }

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "question.created",
    entityType: "question",
    entityId: outcome.questionId,
    after: { type: input.type, marks: input.marks },
  });

  return { ok: true, id: outcome.questionId };
}

export type UpdateResult =
  | { ok: true; version: number }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "MISFILED"; message: string }
  | { ok: false; code: "INVALID"; problems: ReturnType<typeof validateQuestion> };

/**
 * Editing.
 *
 * A DRAFT is edited in place — nobody has seen it. An APPROVED question gets a
 * NEW VERSION and drops back to DRAFT, because the old version is what past
 * attempts were served and must keep marking the way it did.
 */
export async function updateQuestion(
  actor: Actor,
  questionId: string,
  given: QuestionInput,
): Promise<UpdateResult> {
  // A field the caller did not SEND is carried forward; only an explicit null
  // clears it. Writing `input.rubric ?? null` wiped the mark scheme, the hint
  // and the expected time every time somebody corrected a typo in the
  // explanation — and the mark scheme is part of what was approved.
  const input = await withPrevious(actor.organizationId, questionId, given);
  if (!input) return { ok: false, code: "NOT_FOUND" };

  const draft = toDraft(input);
  const validation = validateQuestion(draft);
  if (!validation.valid) {
    return { ok: false, code: "INVALID", problems: validation };
  }

  // The mark scheme, checked against the question's own marks. An ERROR rather
  // than a warning: every rule it enforces produces a scheme that cannot be
  // used correctly, and discovering that at the twentieth paper costs every
  // mark already given.
  const rubricProblems = validateRubric(input.rubric ?? null, input.marks);
  if (rubricProblems.length > 0) {
    return { ok: false, code: "MISFILED", message: rubricProblems[0]!.message };
  }

  const misfiled = await checkCurriculumFit(actor.organizationId, input);
  if (misfiled) return { ok: false, code: "MISFILED", message: misfiled };

  const result = await withTenant(actor.organizationId, async (tx) => {
    const question = await tx.question.findFirst({
      where: { id: questionId, deletedAt: null },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    });
    if (!question) return null;

    const current = question.versions[0];
    const wasApproved = question.status === "APPROVED";
    const nextVersion = wasApproved ? (current?.version ?? 1) + 1 : (current?.version ?? 1);

    if (wasApproved) {
      const versionId = randomUUID();
      await tx.questionVersion.create({
        data: {
          id: versionId,
          questionId,
          version: nextVersion,
          stem: input.stem.trim(),
          options: serialiseOptions(input),
          answerKey: (input.answerKey ?? null) as Prisma.InputJsonValue,
          rubric: (input.rubric ?? null) as Prisma.InputJsonValue,
          explanation: input.explanation?.trim() || null,
          hint: input.hint?.trim() || null,
          createdById: actor.userId,
        },
      });
      await tx.question.update({
        where: { id: questionId },
        data: {
          currentVersionId: versionId,
          // Back to DRAFT: an edit invalidates the approval that was given to
          // the previous wording.
          status: "DRAFT",
          approvedById: null,
          approvedAt: null,
        },
      });
    } else if (current) {
      await tx.questionVersion.update({
        where: { id: current.id },
        data: {
          stem: input.stem.trim(),
          options: serialiseOptions(input),
          answerKey: (input.answerKey ?? null) as Prisma.InputJsonValue,
          rubric: (input.rubric ?? null) as Prisma.InputJsonValue,
          explanation: input.explanation?.trim() || null,
          hint: input.hint?.trim() || null,
        },
      });
    }

    await tx.question.update({
      where: { id: questionId },
      data: {
        type: input.type,
        difficulty: input.difficulty,
        marks: input.marks,
        expectedTimeSeconds: input.expectedTimeSeconds ?? null,
        subjectId: input.subjectId,
        chapterId: input.chapterId ?? null,
        primaryOutcomeId: input.outcomeIds?.[0] ?? null,
        contentHash: new Uint8Array(
          contentHash(input.type, input.stem, input.options),
        ),
      },
    });

    await tx.questionOutcome.deleteMany({ where: { questionId } });
    await linkOutcomes(tx, questionId, input.outcomeIds ?? []);

    return { version: nextVersion, wasApproved };
  });

  if (!result) return { ok: false, code: "NOT_FOUND" };

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: result.wasApproved ? "question.revised" : "question.updated",
    entityType: "question",
    entityId: questionId,
    after: { version: result.version },
  });

  return { ok: true, version: result.version };
}

export type ApprovalResult =
  | { ok: true }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "NOT_APPROVABLE"; problems: ReturnType<typeof validateQuestion> };

export async function approveQuestion(
  actor: Actor,
  questionId: string,
): Promise<ApprovalResult> {
  const question = await getQuestion(actor.organizationId, questionId);
  if (!question) return { ok: false, code: "NOT_FOUND" };

  // Re-validated at the gate, not trusted from whenever it was written. The
  // outcome it was mapped to may since have been deleted.
  if (!question.validation.approvable) {
    return {
      ok: false,
      code: "NOT_APPROVABLE",
      problems: question.validation,
    };
  }

  await withTenant(actor.organizationId, (tx) =>
    tx.question.updateMany({
      where: { id: questionId, deletedAt: null },
      data: {
        status: "APPROVED",
        approvedById: actor.userId,
        approvedAt: new Date(),
        rejectedById: null,
        rejectedAt: null,
        rejectionReason: null,
      },
    }),
  );

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "question.approved",
    entityType: "question",
    entityId: questionId,
    after: { version: question.version },
  });

  return { ok: true };
}

export async function rejectQuestion(
  actor: Actor,
  questionId: string,
  reason: string,
): Promise<boolean> {
  const result = await withTenant(actor.organizationId, (tx) =>
    tx.question.updateMany({
      where: { id: questionId, deletedAt: null },
      data: {
        status: "REJECTED",
        rejectedById: actor.userId,
        rejectedAt: new Date(),
        rejectionReason: reason.trim(),
        approvedById: null,
        approvedAt: null,
      },
    }),
  );
  if (result.count === 0) return false;

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "question.rejected",
    entityType: "question",
    entityId: questionId,
    after: { reason },
  });
  return true;
}

export async function archiveQuestion(
  actor: Actor,
  questionId: string,
): Promise<boolean> {
  const result = await withTenant(actor.organizationId, (tx) =>
    tx.question.updateMany({
      where: { id: questionId, deletedAt: null },
      data: { status: "ARCHIVED" },
    }),
  );
  if (result.count === 0) return false;

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "question.archived",
    entityType: "question",
    entityId: questionId,
  });
  return true;
}

// ---------------------------------------------------------------------------

async function withPrevious(
  organizationId: string,
  questionId: string,
  input: QuestionInput,
): Promise<QuestionInput | null> {
  if (
    input.rubric !== undefined &&
    input.hint !== undefined &&
    input.expectedTimeSeconds !== undefined
  ) {
    return input;
  }
  const previous = await withTenant(organizationId, (tx) =>
    tx.question.findFirst({
      where: { id: questionId, deletedAt: null },
      select: {
        expectedTimeSeconds: true,
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: { rubric: true, hint: true },
        },
      },
    }),
  );
  if (!previous) return null;
  const current = previous.versions[0];
  return {
    ...input,
    rubric: input.rubric !== undefined ? input.rubric : parseRubric(current?.rubric ?? null),
    hint: input.hint !== undefined ? input.hint : (current?.hint ?? null),
    expectedTimeSeconds:
      input.expectedTimeSeconds !== undefined
        ? input.expectedTimeSeconds
        : previous.expectedTimeSeconds,
  };
}

function toDraft(input: QuestionInput): QuestionDraft {
  return {
    type: input.type,
    stem: input.stem,
    options: input.options,
    answerKey: input.answerKey,
    explanation: input.explanation,
    hint: input.hint,
    marks: input.marks,
    outcomeIds: input.outcomeIds,
  };
}

function serialiseOptions(input: QuestionInput): Prisma.InputJsonValue {
  if (!hasOptions(input.type) || !input.options) {
    return null as unknown as Prisma.InputJsonValue;
  }
  return input.options as unknown as Prisma.InputJsonValue;
}

async function linkOutcomes(
  tx: Prisma.TransactionClient,
  questionId: string,
  outcomeIds: string[],
) {
  const unique = [...new Set(outcomeIds)];
  if (unique.length === 0) return;

  await tx.questionOutcome.createMany({
    data: unique.map((learningOutcomeId, index) => ({
      questionId,
      learningOutcomeId,
      // The first carries full evidence weight; the rest are secondary, at the
      // partial weight DOMAIN_MODEL.md sets.
      isPrimary: index === 0,
      weight: index === 0 ? 1.0 : 0.4,
    })),
  });
}

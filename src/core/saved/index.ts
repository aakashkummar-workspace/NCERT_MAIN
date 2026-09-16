import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withTenant } from "@/db/tenant";
import { resultsVisible } from "@/core/assignments/window";

/**
 * Questions a student saved to come back to. Their own list: every read and
 * write is scoped to the student's user id on top of the tenant policy, the
 * same rule the tutor and the mistake bank follow.
 *
 * ---------------------------------------------------------------------------
 * A bookmark is not a way in
 * ---------------------------------------------------------------------------
 * A student may save only a question they have legitimately SEEN: one in a
 * paper of theirs whose review is open, one served in their own practice, or
 * one in their mistake bank. Anything else is refused as not found. Without
 * that, a question id — which travels in URLs and payloads — becomes a way to
 * pull the stem of a paper the class has not sat yet onto a page that renders
 * it, and "exists but you may not save it" would confirm the id was real.
 *
 * And the list shows the stem and the option TEXT, never which option is
 * right, never an explanation. The answer is revealed by the pages that
 * already decide when it may be — the result review, the mistake page,
 * practice — so the saved page links there instead of repeating a gate it
 * would eventually get wrong.
 */

export type SavedSummary = {
  total: number;
  /** The most recent few, for the home page. */
  recent: { questionId: string; stem: string; savedAt: Date }[];
};

export async function savedSummary(
  organizationId: string,
  studentUserId: string,
  limit = 3,
): Promise<SavedSummary> {
  return withTenant(organizationId, async (tx) => {
    const [total, rows] = await Promise.all([
      tx.savedQuestion.count({ where: { studentUserId, question: { deletedAt: null } } }),
      tx.savedQuestion.findMany({
        where: { studentUserId, question: { deletedAt: null } },
        orderBy: { createdAt: "desc" },
        take: limit,
        include: {
          question: { include: { versions: { orderBy: { version: "desc" }, take: 1 } } },
        },
      }),
    ]);
    return {
      total,
      recent: rows.map((row) => ({
        questionId: row.questionId,
        stem: row.question.versions[0]?.stem ?? "",
        savedAt: row.createdAt,
      })),
    };
  });
}

/** Whether this student has saved these questions — for rendering save buttons. */
export async function savedQuestionIds(
  organizationId: string,
  studentUserId: string,
  questionIds: string[],
): Promise<Set<string>> {
  if (questionIds.length === 0) return new Set();
  const rows = await withTenant(organizationId, (tx) =>
    tx.savedQuestion.findMany({
      where: { studentUserId, questionId: { in: questionIds } },
      select: { questionId: true },
    }),
  );
  return new Set(rows.map((row) => row.questionId));
}

// ---------------------------------------------------------------------------
// Writes and the full list
// ---------------------------------------------------------------------------

type Actor = { organizationId: string; userId: string; role: string };
type Tx = Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where the student can look at this question again, with its answer gated there. */
export type ReviewLink =
  | { kind: "mistake"; href: string }
  | { kind: "result"; href: string }
  | { kind: "practice"; href: string };

/**
 * Every place this student has legitimately seen these questions, most useful
 * first per question: the mistake page (which has a retry), then a result whose
 * review is open, then a practice set.
 *
 * One function for both the save check and the list's links, so "you may save
 * this" and "here is where you saw it" cannot disagree.
 */
async function seenAt(
  tx: Tx,
  studentUserId: string,
  questionIds: string[],
  now: Date,
): Promise<Map<string, ReviewLink>> {
  const found = new Map<string, ReviewLink>();
  if (questionIds.length === 0) return found;

  const mistakes = await tx.studentMistake.findMany({
    where: { studentUserId, questionId: { in: questionIds } },
    select: { id: true, questionId: true },
    orderBy: { createdAt: "desc" },
  });
  for (const mistake of mistakes) {
    if (!found.has(mistake.questionId)) {
      found.set(mistake.questionId, {
        kind: "mistake",
        href: `/student/mistakes/${mistake.id}/`,
      });
    }
  }

  const remaining = questionIds.filter((id) => !found.has(id));
  if (remaining.length > 0) {
    const placements = await tx.assessmentQuestion.findMany({
      where: { questionId: { in: remaining } },
      select: { id: true, questionId: true },
    });
    const questionOfPlacement = new Map(
      placements.map((placement) => [placement.id, placement.questionId]),
    );
    if (placements.length > 0) {
      const attempts = await tx.attempt.findMany({
        where: {
          studentUserId,
          status: { not: "IN_PROGRESS" },
          answers: { some: { assessmentQuestionId: { in: [...questionOfPlacement.keys()] } } },
        },
        select: {
          id: true,
          assignment: {
            select: { resultsPolicy: true, closesAt: true, resultsReleasedAt: true },
          },
          answers: {
            where: { assessmentQuestionId: { in: [...questionOfPlacement.keys()] } },
            select: { assessmentQuestionId: true },
          },
        },
        orderBy: { submittedAt: "desc" },
      });
      for (const attempt of attempts) {
        // The same gate as `studentResult`'s `reviewable`: the score showing is
        // not enough, because a class sitting in two sessions must not have the
        // first one passing the paper round before the second has finished.
        const reviewable =
          resultsVisible(attempt.assignment, now) &&
          (now >= attempt.assignment.closesAt ||
            attempt.assignment.resultsReleasedAt !== null);
        if (!reviewable) continue;
        for (const answer of attempt.answers) {
          const questionId = questionOfPlacement.get(answer.assessmentQuestionId);
          if (questionId && !found.has(questionId)) {
            found.set(questionId, { kind: "result", href: `/student/results/${attempt.id}/` });
          }
        }
      }
    }
  }

  const stillRemaining = questionIds.filter((id) => !found.has(id));
  if (stillRemaining.length > 0) {
    const served = await tx.practiceAnswer.findMany({
      where: { questionId: { in: stillRemaining }, session: { studentUserId } },
      select: { questionId: true, practiceSessionId: true },
      orderBy: { createdAt: "desc" },
    });
    for (const row of served) {
      if (!found.has(row.questionId)) {
        found.set(row.questionId, {
          kind: "practice",
          href: `/student/practice/${row.practiceSessionId}/`,
        });
      }
    }
  }

  return found;
}

export type SaveResult = { ok: true } | { ok: false; reason: "not-found" };

export async function saveQuestion(
  actor: Actor,
  questionId: string,
  options: { now?: Date } = {},
): Promise<SaveResult> {
  if (actor.role !== "STUDENT" || !UUID.test(questionId)) {
    return { ok: false, reason: "not-found" };
  }
  const now = options.now ?? new Date();

  return withTenant<SaveResult>(actor.organizationId, async (tx) => {
    const question = await tx.question.findFirst({
      where: { id: questionId, deletedAt: null },
      select: { id: true },
    });
    if (!question) return { ok: false, reason: "not-found" };

    const seen = await seenAt(tx, actor.userId, [questionId], now);
    if (!seen.has(questionId)) return { ok: false, reason: "not-found" };

    // Idempotent on the unique index: a second tap, or the same question saved
    // from the result page and again from the mistake page, is one bookmark
    // with its original date.
    await tx.savedQuestion.createMany({
      data: [
        {
          id: randomUUID(),
          organizationId: actor.organizationId,
          studentUserId: actor.userId,
          questionId,
        },
      ],
      skipDuplicates: true,
    });
    return { ok: true };
  });
}

/**
 * Always succeeds for a student: removing a bookmark that is not there leaves
 * the list exactly as asked for. Scoped to their own user id, so nobody else's
 * row can match.
 */
export async function unsaveQuestion(actor: Actor, questionId: string): Promise<SaveResult> {
  if (actor.role !== "STUDENT" || !UUID.test(questionId)) {
    return { ok: false, reason: "not-found" };
  }
  await withTenant(actor.organizationId, (tx) =>
    tx.savedQuestion.deleteMany({ where: { studentUserId: actor.userId, questionId } }),
  );
  return { ok: true };
}

export type SavedQuestionRow = {
  questionId: string;
  stem: string;
  type: string;
  /** Option TEXT only. Which one is right is not in this payload at all. */
  options: { key: string; text: string }[] | null;
  subjectName: string;
  chapterTitle: string | null;
  savedAt: Date;
  /** Null when nowhere it was seen still shows it — a result later withheld, say. */
  review: ReviewLink | null;
};

/** How many the saved page shows. It says so when there are more. */
export const SAVED_LIST_LIMIT = 100;

export async function listSavedQuestions(
  organizationId: string,
  studentUserId: string,
  options: { limit?: number; now?: Date } = {},
): Promise<{ rows: SavedQuestionRow[]; truncated: boolean }> {
  const limit = options.limit ?? SAVED_LIST_LIMIT;
  const now = options.now ?? new Date();

  return withTenant(organizationId, async (tx) => {
    const saved = await tx.savedQuestion.findMany({
      where: { studentUserId, question: { deletedAt: null } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: limit + 1,
      select: {
        questionId: true,
        createdAt: true,
        question: {
          select: {
            type: true,
            currentVersionId: true,
            subject: { select: { name: true } },
            chapter: { select: { title: true } },
          },
        },
      },
    });
    const shown = saved.slice(0, limit);
    const questionIds = shown.map((row) => row.questionId);

    // Versions are selected by naming the two fields shown. `answerKey`,
    // `explanation` and the options' `isCorrect` are never read into this
    // function, so no later edit to the mapping can leak them.
    const versions =
      questionIds.length === 0
        ? []
        : await tx.questionVersion.findMany({
            where: { questionId: { in: questionIds } },
            select: { id: true, questionId: true, version: true, stem: true, options: true },
            orderBy: { version: "desc" },
          });
    const links = await seenAt(tx, studentUserId, questionIds, now);

    return {
      rows: shown.map((row) => {
        const mine = versions.filter((version) => version.questionId === row.questionId);
        const version =
          mine.find((candidate) => candidate.id === row.question.currentVersionId) ??
          mine[0];
        const rawOptions = version?.options as { key?: unknown; text?: unknown }[] | null;
        return {
          questionId: row.questionId,
          stem: version?.stem ?? "",
          type: row.question.type,
          options: Array.isArray(rawOptions)
            ? rawOptions.map((option) => ({
                key: String(option.key ?? ""),
                text: String(option.text ?? ""),
              }))
            : null,
          subjectName: row.question.subject.name,
          chapterTitle: row.question.chapter?.title ?? null,
          savedAt: row.createdAt,
          review: links.get(row.questionId) ?? null,
        };
      }),
      truncated: saved.length > limit,
    };
  });
}

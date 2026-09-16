import "server-only";
import { withTenant } from "@/db/tenant";
import { conceptContext } from "@/core/curriculum/concepts";
import { markAnswer, type Response } from "@/core/attempts/score";
import { adviceFor, labelFor } from "./classify";

/**
 * Reading and working through the mistake bank.
 *
 * ---------------------------------------------------------------------------
 * The retry serves the SAME question, and says what that proves
 * ---------------------------------------------------------------------------
 * There is nothing else to serve yet — personalised practice arrives later —
 * and re-answering a question you have already seen the answer to mostly
 * measures memory. So a correct retry moves the row to RETRIED and not to
 * RESOLVED, and the screen says why. Pretending otherwise would let a student
 * clear their whole bank in an evening without having learned anything, which
 * is the revision-app failure mode this product exists to avoid.
 *
 * ---------------------------------------------------------------------------
 * It resolves on independent evidence, and on nothing else
 * ---------------------------------------------------------------------------
 * Same rule as a learning gap: no route closes one. A mistake resolves when a
 * DIFFERENT question on the same concept is answered correctly after the date
 * the mistake was made — which `concept_evidence` already records for every
 * marked answer, so this costs one reconciliation query and no new bookkeeping.
 */

export type MistakeStatus = "UNRESOLVED" | "RETRIED" | "RESOLVED";

export type MistakeRow = {
  id: string;
  questionId: string;
  conceptId: string | null;
  conceptName: string | null;
  chapters: string[];
  mistakeType: string;
  typeLabel: string;
  /** Null while nothing has classified it. Never a guess dressed as a fact. */
  typeReason: string | null;
  /** Has a nameable type — so there is a heading worth putting on the card. */
  classified: boolean;
  /**
   * Something HAS looked at it, whether or not it could name a type.
   *
   * The two come apart, and the distinction is the honest one: a wrong
   * true/false is settled by rule as "nothing here says why", which is a
   * finding. Reading that as "not looked at yet" would promise the student an
   * answer that is never coming.
   */
  examined: boolean;
  status: MistakeStatus;
  retryCount: number;
  lastRetryCorrect: boolean | null;
  stem: string;
  marks: number;
  awarded: number | null;
  occurredAt: Date;
  resolvedAt: Date | null;
};

/** Open before closed; within that, the oldest first — it has waited longest. */
const STATUS_ORDER: Record<MistakeStatus, number> = {
  UNRESOLVED: 0,
  RETRIED: 1,
  RESOLVED: 2,
};

export async function listMistakes(
  organizationId: string,
  studentUserId: string,
  options: { status?: MistakeStatus; conceptId?: string; includeResolved?: boolean } = {},
): Promise<MistakeRow[]> {
  const rows = await withTenant(organizationId, async (tx) => {
    const mistakes = await tx.studentMistake.findMany({
      where: {
        studentUserId,
        ...(options.status ? { status: options.status } : {}),
        ...(options.conceptId ? { conceptId: options.conceptId } : {}),
        ...(options.status || options.includeResolved
          ? {}
          : { status: { not: "RESOLVED" as const } }),
      },
      orderBy: { occurredAt: "desc" },
      take: 200,
    });
    if (mistakes.length === 0) return [];

    const [versions, answers] = await Promise.all([
      tx.questionVersion.findMany({
        where: {
          id: {
            in: mistakes.flatMap((m) => (m.questionVersionId ? [m.questionVersionId] : [])),
          },
        },
        select: { id: true, stem: true },
      }),
      tx.attemptAnswer.findMany({
        where: { id: { in: mistakes.map((m) => m.attemptAnswerId) } },
        select: { id: true, awardedMarks: true, maxMarks: true },
      }),
    ]);

    const stemByVersion = new Map(versions.map((v) => [v.id, v.stem]));
    const answerById = new Map(answers.map((a) => [a.id, a]));

    return mistakes.map((mistake) => ({ mistake, stemByVersion, answerById }));
  });

  if (rows.length === 0) return [];

  const context = await conceptContext([
    ...new Set(rows.flatMap((r) => (r.mistake.conceptId ? [r.mistake.conceptId] : []))),
  ]);

  return rows
    .map(({ mistake, stemByVersion, answerById }) => {
      const answer = answerById.get(mistake.attemptAnswerId);
      const concept = mistake.conceptId ? context.get(mistake.conceptId) : undefined;
      const examined = mistake.typeSource !== "PENDING";
      const classified = examined && mistake.mistakeType !== "UNCLASSIFIED";

      return {
        id: mistake.id,
        questionId: mistake.questionId,
        conceptId: mistake.conceptId,
        conceptName: concept?.name ?? null,
        chapters: concept?.chapters ?? [],
        mistakeType: mistake.mistakeType,
        typeLabel: labelFor(mistake.mistakeType),
        typeReason: mistake.typeReason,
        classified,
        examined,
        status: mistake.status as MistakeStatus,
        retryCount: mistake.retryCount,
        lastRetryCorrect: mistake.lastRetryCorrect,
        stem: mistake.questionVersionId
          ? (stemByVersion.get(mistake.questionVersionId) ?? "This question")
          : "This question",
        marks: answer ? Number(answer.maxMarks) : 0,
        awarded: answer?.awardedMarks === null || answer === undefined
          ? null
          : Number(answer.awardedMarks),
        occurredAt: mistake.occurredAt,
        resolvedAt: mistake.resolvedAt,
      };
    })
    .sort((a, b) => {
      const status = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (status !== 0) return status;
      return a.occurredAt.getTime() - b.occurredAt.getTime();
    });
}

export type MistakeDetail = MistakeRow & {
  type: string;
  /** The options as the student saw them — never carrying `isCorrect`. */
  options: { key: string; text: string }[] | null;
  /** What they put. Shown beside the right answer once they have retried. */
  originalResponse: unknown;
  /** Withheld until they have had a go. See the note on `revealed` below. */
  explanation: string | null;
  correctAnswer: string | null;
  /**
   * Whether the answer is on screen.
   *
   * False until they retry. A mistake bank that opens with the answer showing
   * is a reading exercise; the whole value is in having one more attempt at it
   * first. Once retried it stays revealed — they have earned it, and hiding it
   * again would be a puzzle rather than a revision tool.
   */
  revealed: boolean;
  advice: string;
};

export async function getMistake(
  organizationId: string,
  studentUserId: string,
  id: string,
): Promise<MistakeDetail | null> {
  const found = await withTenant(organizationId, async (tx) => {
    const mistake = await tx.studentMistake.findFirst({
      where: { id, studentUserId },
    });
    if (!mistake) return null;

    const [version, answer, question] = await Promise.all([
      mistake.questionVersionId
        ? tx.questionVersion.findFirst({ where: { id: mistake.questionVersionId } })
        : null,
      tx.attemptAnswer.findFirst({ where: { id: mistake.attemptAnswerId } }),
      tx.question.findFirst({
        where: { id: mistake.questionId },
        select: { type: true },
      }),
    ]);

    return { mistake, version, answer, question };
  });

  if (!found || !found.question) return null;
  const { mistake, version, answer, question } = found;

  const context = mistake.conceptId
    ? await conceptContext([mistake.conceptId])
    : new Map();
  const concept = mistake.conceptId ? context.get(mistake.conceptId) : undefined;

  // Rebuilt field by field rather than filtered, the same way the player does
  // it: a field added to Option later cannot leak by somebody forgetting to
  // strip it.
  const rawOptions = (version?.options ?? null) as
    | { key: string; text: string; isCorrect?: boolean }[]
    | null;
  const options =
    rawOptions === null
      ? null
      : rawOptions.map((option) => ({ key: option.key, text: option.text }));

  const revealed = mistake.retryCount > 0;

  return {
    id: mistake.id,
    questionId: mistake.questionId,
    conceptId: mistake.conceptId,
    conceptName: concept?.name ?? null,
    chapters: concept?.chapters ?? [],
    mistakeType: mistake.mistakeType,
    typeLabel: labelFor(mistake.mistakeType),
    typeReason: mistake.typeReason,
    classified:
      mistake.typeSource !== "PENDING" && mistake.mistakeType !== "UNCLASSIFIED",
    examined: mistake.typeSource !== "PENDING",
    status: mistake.status as MistakeStatus,
    retryCount: mistake.retryCount,
    lastRetryCorrect: mistake.lastRetryCorrect,
    stem: version?.stem ?? "This question",
    type: question.type,
    marks: answer ? Number(answer.maxMarks) : 0,
    awarded:
      answer?.awardedMarks === null || answer === null
        ? null
        : Number(answer.awardedMarks),
    options,
    originalResponse: answer?.response ?? null,
    explanation: revealed ? (version?.explanation ?? null) : null,
    correctAnswer: revealed ? describeAnswer(rawOptions, version?.answerKey) : null,
    revealed,
    advice: adviceFor(mistake.mistakeType),
    occurredAt: mistake.occurredAt,
    resolvedAt: mistake.resolvedAt,
  };
}

export type RetryResult =
  | {
      ok: true;
      correct: boolean;
      status: MistakeStatus;
      retryCount: number;
      explanation: string | null;
      correctAnswer: string | null;
      /** Said out loud on the screen. See the note at the top of this file. */
      message: string;
    }
  | { ok: false; message: string };

export async function retryMistake(
  actor: { organizationId: string; userId: string },
  id: string,
  response: Response,
  now = new Date(),
): Promise<RetryResult> {
  return withTenant<RetryResult>(actor.organizationId, async (tx) => {
    const mistake = await tx.studentMistake.findFirst({
      where: { id, studentUserId: actor.userId },
    });
    if (!mistake) return { ok: false, message: "We could not find that." };

    const version = mistake.questionVersionId
      ? await tx.questionVersion.findFirst({ where: { id: mistake.questionVersionId } })
      : null;
    const question = await tx.question.findFirst({
      where: { id: mistake.questionId },
      select: { type: true },
    });
    if (!version || !question) {
      return { ok: false, message: "That question is no longer available." };
    }

    const answer = await tx.attemptAnswer.findFirst({
      where: { id: mistake.attemptAnswerId },
      select: { maxMarks: true },
    });

    // Marked by the same function that marked it the first time, against the
    // version they were served. Two markers would eventually disagree, and a
    // retry told it was wrong when the paper said right is unarguable-with.
    const marked = markAnswer({
      type: question.type,
      maxMarks: answer ? Number(answer.maxMarks) : 1,
      options: (version.options ?? null) as never,
      answerKey: (version.answerKey ?? null) as never,
      response,
    });

    if (marked.isCorrect === null && marked.reason === "awaiting-marking") {
      // A written answer cannot be retried alone — there is nobody to read it.
      // Told plainly rather than accepted and silently never marked.
      return {
        ok: false,
        message:
          "This one needs a person to read it. Have another go on paper and check it against the explanation.",
      };
    }

    const correct = marked.isCorrect === true;

    await tx.studentMistake.update({
      where: { id },
      data: {
        retryCount: { increment: 1 },
        lastRetriedAt: now,
        lastRetryCorrect: correct,
        // RETRIED, never RESOLVED. Getting the same question right a second
        // time is engagement, not proof — resolution needs a different question
        // on the same concept, and `reconcileResolved` finds it.
        ...(correct && mistake.status === "UNRESOLVED"
          ? { status: "RETRIED" as const }
          : {}),
      },
    });

    return {
      ok: true,
      correct,
      status: correct && mistake.status === "UNRESOLVED"
        ? "RETRIED"
        : (mistake.status as MistakeStatus),
      retryCount: mistake.retryCount + 1,
      explanation: version.explanation,
      correctAnswer: describeAnswer(
        version.options as never,
        version.answerKey,
      ),
      message: retryMessage(correct),
    };
  });
}

/**
 * What a retry's verdict means, said the same way on the response and on the
 * page afterwards.
 *
 * The page renders it from the stored `lastRetryCorrect` rather than from the
 * response, because the response is gone the moment the page refreshes into
 * its revealed state — which is how "Right this time" used to vanish before
 * anybody could read it.
 */
export function retryMessage(correct: boolean): string {
  return correct
    ? "It stays in your bank until you get a different question on this concept right — that is what shows it stuck."
    : "Read the explanation, then come back to it another day rather than guessing again now.";
}

/**
 * Close the mistakes the evidence has closed.
 *
 * A reconciliation, not an accumulation: running it twice changes nothing, and
 * it never re-opens anything. The rule is one sentence — a different question
 * on the same concept, answered correctly, after the mistake was made.
 *
 * Runs after mastery sync, on the same hook, so a student who gets something
 * right today sees yesterday's mistake close without pressing anything.
 */
export async function reconcileResolved(
  organizationId: string,
  studentUserId: string,
  now = new Date(),
): Promise<{ resolved: number }> {
  return withTenant(organizationId, async (tx) => {
    const open = await tx.studentMistake.findMany({
      where: {
        studentUserId,
        status: { not: "RESOLVED" },
        conceptId: { not: null },
      },
    });
    if (open.length === 0) return { resolved: 0 };

    const evidence = await tx.conceptEvidence.findMany({
      where: {
        studentUserId,
        conceptId: { in: [...new Set(open.map((m) => m.conceptId!))] },
        // Full marks only. A 2-out-of-3 on the concept is progress, not proof,
        // and closing a mistake on it would be the same "partial credit is a
        // pass" mistake the marking layer refuses to make.
        score: 1,
      },
      select: { conceptId: true, observedAt: true, attemptAnswerId: true },
    });
    if (evidence.length === 0) return { resolved: 0 };

    let resolved = 0;
    for (const mistake of open) {
      const proof = evidence.find(
        (row) =>
          row.conceptId === mistake.conceptId &&
          row.observedAt > mistake.occurredAt &&
          // A DIFFERENT question. The same answer cannot both be the mistake
          // and the proof it is fixed.
          row.attemptAnswerId !== mistake.attemptAnswerId,
      );
      if (!proof) continue;

      await tx.studentMistake.update({
        where: { id: mistake.id },
        data: { status: "RESOLVED", resolvedAt: now },
      });
      resolved++;
    }

    return { resolved };
  });
}

/**
 * The correct answer in a sentence, for a student reading it back.
 *
 * Deliberately not the raw key: `{"kind":"choice","correct":["B"]}` is a log
 * line, not an answer.
 */
function describeAnswer(
  options: { key: string; text: string; isCorrect?: boolean }[] | null,
  answerKey: unknown,
): string | null {
  if (options && options.length > 0) {
    const correct = options.filter((option) => option.isCorrect);
    if (correct.length > 0) {
      return correct.map((option) => `${option.key}. ${option.text}`).join("  ·  ");
    }
  }

  if (answerKey && typeof answerKey === "object") {
    const key = answerKey as Record<string, unknown>;
    if (key.kind === "boolean") return key.correct === true ? "True" : "False";
    if (key.kind === "numeric" && typeof key.value === "number") {
      return String(key.value);
    }
    if (key.kind === "text" && Array.isArray(key.accepted)) {
      return (key.accepted as string[]).join("  ·  ");
    }
  }

  return null;
}

/**
 * The bank in one line, for the student's home page.
 *
 * Counts only. Home is where a student decides what to do with twenty minutes,
 * and a list of questions there competes with the thing they came for.
 */
export type MistakeSummary = {
  open: number;
  retried: number;
  resolved: number;
  /** The concept with the most open mistakes, by name. */
  worst: { conceptId: string; conceptName: string; count: number } | null;
};

export async function mistakeSummary(
  organizationId: string,
  studentUserId: string,
): Promise<MistakeSummary> {
  const rows = await withTenant(organizationId, (tx) =>
    tx.studentMistake.findMany({
      where: { studentUserId },
      select: { status: true, conceptId: true },
    }),
  );

  const open = rows.filter((row) => row.status === "UNRESOLVED").length;
  const retried = rows.filter((row) => row.status === "RETRIED").length;
  const resolved = rows.filter((row) => row.status === "RESOLVED").length;

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.status === "RESOLVED" || !row.conceptId) continue;
    counts.set(row.conceptId, (counts.get(row.conceptId) ?? 0) + 1);
  }

  let worst: MistakeSummary["worst"] = null;
  if (counts.size > 0) {
    const [conceptId, count] = [...counts].sort((a, b) => b[1] - a[1])[0]!;
    const context = await conceptContext([conceptId]);
    worst = {
      conceptId,
      conceptName: context.get(conceptId)?.name ?? "a concept",
      count,
    };
  }

  return { open, retried, resolved, worst };
}

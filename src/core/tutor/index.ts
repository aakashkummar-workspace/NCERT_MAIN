import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant } from "@/db/tenant";
import { can } from "@/core/billing/entitlements";
import { conceptContext } from "@/core/curriculum/concepts";
import { askTutor } from "@/ai/tasks/tutor";
import { organizationBoard } from "@/core/organizations";
import {
  isTop,
  leaksAnswer,
  nextLevel,
  type AnswerKey,
  type LeakVerdict,
  type Level,
  type Option,
} from "./guard";

/**
 * Asking for help on one question.
 *
 * ---------------------------------------------------------------------------
 * The order of operations
 * ---------------------------------------------------------------------------
 *   1. The plan, then the student's own daily cap — before the question is
 *      even looked up.
 *   2. Resolve the question at the version the student was SERVED.
 *   3. Call the model, with the answer key, at the level they asked for.
 *   4. **Check the reply for the answer.** If it leaked, serve the authored
 *      hint instead and stamp the turn.
 *   5. Store it.
 *
 * Step 4 is the feature. Everything else is plumbing around it.
 *
 * ---------------------------------------------------------------------------
 * Escalation is one-way and recorded
 * ---------------------------------------------------------------------------
 * `maxLevel` only ever rises. A student who has seen the method cannot un-see
 * it, and the practice evidence writer reads this: an answer given after being
 * walked through says nothing about what they can do alone, so it produces no
 * evidence at all. That is why the record has to be monotonic.
 */

export type Actor = { organizationId: string; userId: string };

/**
 * How many turns one student may have in a day.
 *
 * The entitlement is per organization, which is right for a bill and wrong for
 * fairness: on a 200-student plan with 500 hints a month, one student can spend
 * the whole class's allowance in an afternoon and everybody else meets a wall
 * they did nothing to cause. Same distinction the gateway already draws between
 * the plan and the budget — one is the promise, the other is a safety limit —
 * applied to the case where the users share an allowance they did not buy.
 *
 * Twelve is three questions taken all the way up the ladder, which is more help
 * than a session of practice should need.
 */
export const DAILY_TURNS_PER_STUDENT = 12;

export type AskResult =
  | {
      ok: true;
      sessionId: string;
      level: Level;
      content: string;
      /** True when the authored hint was served because the model leaked. */
      withheld: boolean;
      /** Whether there is a further level to ask for. */
      canEscalate: boolean;
      needsMoreBasics: boolean;
    }
  | {
      ok: false;
      message: string;
      /**
       * False when asking again will not help — the plan, the day's cap, or no
       * model to reach and no authored hint to fall back on. The panel stops
       * offering the button rather than inviting a student to press it forever.
       */
      retryable: boolean;
    };

/**
 * Whether help is on offer at all, for deciding whether to show the panel.
 *
 * The plan only, and deliberately not the monthly count: "used up" is a state
 * the panel explains when pressed, whereas a plan without the tutor would put a
 * control on every question whose only answer is a refusal — beside a warning
 * that taking the help costs the question its evidence.
 */
export async function tutorOffered(organizationId: string): Promise<boolean> {
  const entitled = await can(organizationId, "tutor_hints_per_month");
  return entitled.allowed || entitled.reason === "limit-reached";
}

export async function askForHelp(
  actor: Actor,
  input: {
    questionId: string;
    practiceAnswerId?: string | null;
    studentMistakeId?: string | null;
  },
  now = new Date(),
): Promise<AskResult> {
  // The plan first, before anything is read. Same ordering rule the Copilot
  // uses: "your plan does not include this" and "we could not find that
  // question" are different facts, and the first is the one that is true.
  const entitled = await can(actor.organizationId, "tutor_hints_per_month");
  if (!entitled.allowed) {
    return {
      ok: false,
      retryable: false,
      message:
        entitled.reason === "limit-reached"
          ? "Your school has used all of this month's help. It comes back on the first of next month."
          : "Help on questions is not part of your school's plan. Your teacher can tell you more.",
    };
  }

  const found = await withTenant(actor.organizationId, async (tx) => {
    const question = await tx.question.findFirst({
      where: { id: input.questionId, deletedAt: null },
      select: {
        id: true,
        currentVersionId: true,
        subject: { select: { name: true, grade: { select: { label: true } } } },
      },
    });
    if (!question) return null;

    const usedToday = await tx.tutorTurn.count({
      where: {
        createdAt: { gte: startOfDay(now) },
        session: { studentUserId: actor.userId },
      },
    });

    const session = await tx.tutorSession.findFirst({
      where: { studentUserId: actor.userId, questionId: input.questionId },
    });

    const turns = session
      ? await tx.tutorTurn.findMany({
          where: { sessionId: session.id },
          orderBy: { createdAt: "asc" },
        })
      : [];

    // Where they asked from, when they asked from somewhere. Both carry the
    // version they were served and what they actually put.
    const practice = input.practiceAnswerId
      ? await tx.practiceAnswer.findFirst({
          where: { id: input.practiceAnswerId, questionId: question.id },
          select: { questionVersionId: true, response: true },
        })
      : null;

    const mistake = input.studentMistakeId
      ? await tx.studentMistake.findFirst({
          where: {
            id: input.studentMistakeId,
            studentUserId: actor.userId,
            questionId: question.id,
          },
          select: { questionVersionId: true, attemptAnswerId: true },
        })
      : null;

    const attemptAnswer = mistake
      ? await tx.attemptAnswer.findFirst({
          where: { id: mistake.attemptAnswerId },
          select: { response: true },
        })
      : null;

    // The version they were SERVED, not the current one — a December edit must
    // not change what they were helped with in September. Falls back to current
    // for a question reached without either handle.
    const servedVersionId =
      session?.questionVersionId ??
      practice?.questionVersionId ??
      mistake?.questionVersionId ??
      question.currentVersionId;

    const version = servedVersionId
      ? await tx.questionVersion.findFirst({ where: { id: servedVersionId } })
      : null;

    const outcomeLinks = await tx.questionOutcome.findMany({
      where: { questionId: question.id },
      select: { learningOutcomeId: true },
    });
    const conceptLinks =
      outcomeLinks.length === 0
        ? []
        : await tx.conceptOutcome.findMany({
            where: {
              learningOutcomeId: {
                in: outcomeLinks.map((link) => link.learningOutcomeId),
              },
            },
            select: { conceptId: true },
          });

    return {
      question,
      session,
      turns,
      version,
      servedVersionId,
      usedToday,
      studentResponse: practice?.response ?? attemptAnswer?.response ?? null,
      conceptId: conceptLinks[0]?.conceptId ?? null,
    };
  });

  if (!found || !found.version) {
    return { ok: false, retryable: false, message: "We could not find that question." };
  }

  const { question, session, turns, version, servedVersionId } = found;

  const current = (session?.maxLevel as Level | undefined) ?? null;

  // Asked again at the top: the last thing said comes back rather than a fourth
  // call producing a fourth phrasing of the same idea — and it costs nothing,
  // so it is answered before the daily cap is applied.
  if (session && current !== null && isTop(current) && turns.length > 0) {
    const last = turns[turns.length - 1]!;
    return {
      ok: true,
      sessionId: session.id,
      level: last.level as Level,
      content: last.content,
      withheld: last.wasWithheld,
      canEscalate: false,
      needsMoreBasics: false,
    };
  }

  if (found.usedToday >= DAILY_TURNS_PER_STUDENT) {
    return {
      ok: false,
      retryable: false,
      message:
        "You have had a lot of help today. Have a go at the rest on your own — this comes back tomorrow.",
    };
  }

  const level = turns.length === 0 ? "HINT" : nextLevel(current);
  const rawOptions = (version.options ?? null) as Option[] | null;
  const answerKey = (version.answerKey ?? null) as AnswerKey;
  const conceptName = found.conceptId
    ? ((await conceptContext([found.conceptId])).get(found.conceptId)?.name ?? null)
    : null;

  const board = await organizationBoard(actor.organizationId);

  const outcome = await askTutor({
    organizationId: actor.organizationId,
    userId: actor.userId,
    level,
    boardName: board.name,
    gradeLabel: question.subject.grade.label,
    subjectName: question.subject.name,
    conceptName,
    stem: version.stem,
    options:
      rawOptions?.map((option) => ({
        key: option.key,
        text: option.text,
        isCorrect: option.isCorrect === true,
      })) ?? null,
    correctAnswer: describeAnswer(rawOptions, answerKey),
    explanation: version.explanation,
    studentAnswer: describeResponse(found.studentResponse, rawOptions),
    previous: turns.map((turn) => ({
      level: turn.level as Level,
      content: turn.content,
    })),
  });

  // The model could not be reached — no key, a provider outage, a budget.
  //
  // This used to return the gateway's "try again in a moment" and nothing else,
  // so on a deployment with no AI configured every press failed the same way
  // forever and the button never went away. The rule the guard already follows
  // applies here too: falling back to the AUTHORED hint beats refusing, because
  // a student who asked for help and got an error does not ask again.
  //
  // Only for the first rung. The hint is a nudge, and serving the same nudge
  // again under "the method" would be a label that lies about what it is.
  const authoredHint = version.hint?.trim() || null;
  if (!outcome.ok && !(level === "HINT" && authoredHint)) {
    return {
      ok: false,
      retryable: false,
      message:
        turns.length === 0
          ? "Help is not available on this question right now. Have a go on your own — your teacher can go through it with you."
          : "There is no more help available on this question right now. Have a go with what you have.",
    };
  }

  // The guard. The prompt is the intent; this is the guarantee.
  const reply = outcome.ok
    ? outcome.value
    : { content: authoredHint!, needsMoreBasics: false };
  // An authored hint is a person's own words and is not checked against itself.
  const verdict: LeakVerdict = outcome.ok
    ? leaksAnswer(reply.content, rawOptions, answerKey)
    : { leaked: false };
  let content = reply.content;
  let withheld = false;

  if (verdict.leaked) {
    // The authored hint is a person's own words and is always safe. Falling
    // back to it beats refusing: a student who asked for help and got an error
    // does not ask again.
    content = version.hint?.trim() || FALLBACK_HINT;
    withheld = true;
    console.warn(
      `[tutor] withheld a ${level} reply that gave away the ${verdict.what} on question ${question.id}`,
    );
  }

  const sessionId = await withTenant(actor.organizationId, async (tx) => {
    let id = session?.id ?? null;
    if (!id) {
      const created = await tx.tutorSession.create({
        data: {
          id: randomUUID(),
          organizationId: actor.organizationId,
          studentUserId: actor.userId,
          questionId: question.id,
          questionVersionId: servedVersionId,
          practiceAnswerId: input.practiceAnswerId ?? null,
          studentMistakeId: input.studentMistakeId ?? null,
          maxLevel: level,
          createdAt: now,
          lastAskedAt: now,
        },
        select: { id: true },
      });
      id = created.id;
    } else {
      // Only ever upward. The record has to be monotonic for the evidence rule
      // to mean anything.
      await tx.tutorSession.update({
        where: { id },
        data: { maxLevel: level, lastAskedAt: now },
      });
    }

    await tx.tutorTurn.create({
      data: {
        id: randomUUID(),
        organizationId: actor.organizationId,
        sessionId: id,
        level,
        content,
        wasWithheld: withheld,
        generationId: outcome.generationId || null,
        costMicros: outcome.costMicros,
        createdAt: now,
      },
      select: { id: true },
    });

    return id;
  });

  return {
    ok: true,
    sessionId,
    level,
    content,
    withheld,
    canEscalate: !isTop(level),
    needsMoreBasics: reply.needsMoreBasics,
  };
}

/**
 * What is served when the model gave it away and the author wrote no hint.
 *
 * Deliberately a nudge at method rather than an apology. "Something went wrong"
 * would be a lie — nothing went wrong that the student did or should care
 * about — and it teaches them the button does not work.
 */
const FALLBACK_HINT =
  "Look again at what the question is actually asking for, and at which quantity you have been given. I cannot say more than that without giving it away.";

export type TutorHistory = {
  sessionId: string;
  maxLevel: Level;
  canEscalate: boolean;
  turns: { level: Level; content: string; withheld: boolean; createdAt: Date }[];
};

/** What has already been said about this question, for this student. */
export async function helpSoFar(
  actor: Actor,
  questionId: string,
): Promise<TutorHistory | null> {
  return withTenant(actor.organizationId, async (tx) => {
    const session = await tx.tutorSession.findFirst({
      where: { studentUserId: actor.userId, questionId },
    });
    if (!session) return null;

    const turns = await tx.tutorTurn.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: "asc" },
    });

    return {
      sessionId: session.id,
      maxLevel: session.maxLevel as Level,
      canEscalate: !isTop(session.maxLevel as Level),
      turns: turns.map((turn) => ({
        level: turn.level as Level,
        content: turn.content,
        withheld: turn.wasWithheld,
        createdAt: turn.createdAt,
      })),
    };
  });
}

/** Midnight, for the daily cap. Server time; the product is one country. */
function startOfDay(now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

/** The correct answer in a sentence, for the model's reference only. */
export function describeAnswer(
  options: Option[] | null,
  answerKey: AnswerKey,
): string | null {
  if (options && options.length > 0) {
    const correct = options.filter((option) => option.isCorrect);
    if (correct.length > 0) {
      return correct.map((option) => `${option.key}. ${option.text}`).join("  ·  ");
    }
  }
  if (!answerKey) return null;
  if (answerKey.kind === "boolean") return answerKey.correct ? "True" : "False";
  if (answerKey.kind === "numeric") return String(answerKey.value);
  if (answerKey.kind === "text") return answerKey.accepted.join("  ·  ");
  return null;
}

/** What the student put, rendered for reading rather than as stored JSON. */
export function describeResponse(
  response: unknown,
  options: Option[] | null,
): string | null {
  if (!response || typeof response !== "object") return null;
  const value = response as Record<string, unknown>;

  if (value.kind === "choice" && Array.isArray(value.keys)) {
    const keys = value.keys as string[];
    if (keys.length === 0) return null;
    return keys
      .map((key) => {
        const option = options?.find((candidate) => candidate.key === key);
        return option ? `${key}. ${option.text}` : key;
      })
      .join("  ·  ");
  }
  if (value.kind === "boolean") return value.value === true ? "True" : "False";
  if (value.kind === "numeric") return String(value.value ?? "");
  // Capped: a student who wrote three paragraphs is helped by the first few,
  // and the rest is prompt weight nobody is paying for on purpose.
  if (value.kind === "text") return String(value.value ?? "").slice(0, 1000);
  return null;
}

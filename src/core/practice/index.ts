import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant } from "@/db/tenant";
import { conceptContext } from "@/core/curriculum/concepts";
import { markAnswer, type Response } from "@/core/attempts/score";
import { isObjective } from "@/core/questions/validate";
import { recommendFor, type ConceptState, type Recommendation, MIN_SET, MAX_SET } from "./recommend";
import { recordPracticeEvidence } from "./evidence";
import { nextDifficulty, pickNearest, type Difficulty } from "./adapt";
import { reconcileResolved } from "@/core/mistakes/read";

/**
 * Practice sessions: the student's own half of the loop.
 *
 * ---------------------------------------------------------------------------
 * Feedback after every question, not at the end
 * ---------------------------------------------------------------------------
 * This is the entire difference between practice and a test, and everything
 * else here follows from it. There is no clock, no submit ceremony, and no
 * withheld score — answer a question and you are told immediately whether it
 * was right and why. A runner that saved the verdict for the end would be the
 * exam player with the pressure removed, which teaches nothing the exam did
 * not already teach.
 *
 * ---------------------------------------------------------------------------
 * Machine-markable only
 * ---------------------------------------------------------------------------
 * A written answer needs a person, and there is nobody waiting. Serving one in
 * practice would either promise feedback that never arrives or quietly grade
 * prose with a string comparison. So practice draws from the objective types
 * and says so where a concept has nothing else.
 *
 * ---------------------------------------------------------------------------
 * A question they have just got right is not served again
 * ---------------------------------------------------------------------------
 * Repetition of what you can already do is the least useful minute in
 * revision — and, less obviously, it is what would let a student grind the same
 * four questions until their mastery estimate said whatever they wanted. The
 * cooldown makes the bank the limit rather than the student's patience.
 */

export const COOLDOWN_DAYS = 30;

export type Actor = { organizationId: string; userId: string };

// ---------------------------------------------------------------------------
// What to practise
// ---------------------------------------------------------------------------

/**
 * Assemble the student's concept states and ask `recommend` what to suggest.
 *
 * All the reading lives here; all the deciding lives in the pure module. The
 * split is what makes the recommendation testable without a database and
 * arguable without reading a query.
 */
export async function recommendations(
  actor: Actor,
  now = new Date(),
): Promise<Recommendation> {
  return recommendFor(await studentConceptStates(actor, now), now);
}

/**
 * Everything the product knows about where one student stands, per concept.
 *
 * Exported because the study plan needs exactly this and must not re-derive it.
 * Two functions that both decide what a student is weak at will eventually
 * disagree, and a plan contradicting the practice page on the same screen is
 * worse than either being wrong alone — the same reason `planRemedial` and
 * `buildRemedial` share one path, and one parser serves both roster routes.
 *
 * `subjectNames` rides along for the plan's benefit. It costs nothing here:
 * `conceptContext` already returns it.
 */
export async function studentConceptStates(
  actor: Actor,
  now = new Date(),
): Promise<(ConceptState & { subjectNames: string[] })[]> {
  const states = await withTenant(actor.organizationId, async (tx) => {
    const mastery = await tx.studentConceptMastery.findMany({
      where: { studentUserId: actor.userId },
    });
    if (mastery.length === 0) return [];

    const conceptIds = mastery.map((row) => row.conceptId);

    const [mistakes, outcomeLinks] = await Promise.all([
      tx.studentMistake.groupBy({
        by: ["conceptId"],
        where: {
          studentUserId: actor.userId,
          status: { not: "RESOLVED" },
          conceptId: { in: conceptIds },
        },
        _count: true,
      }),
      tx.conceptOutcome.findMany({
        where: { conceptId: { in: conceptIds } },
        select: { conceptId: true, learningOutcomeId: true },
      }),
    ]);

    const openByConcept = new Map(
      mistakes.map((row) => [row.conceptId ?? "", row._count]),
    );

    // How many servable questions each concept actually has. Counted rather
    // than assumed: a recommendation that opens an empty set has already spent
    // the student's tap.
    const available = await servableCounts(tx, actor.userId, outcomeLinks, now);

    return { mastery, openByConcept, available, conceptIds };
  });

  if (Array.isArray(states)) return [];

  const context = await conceptContext(states.conceptIds);

  return states.mastery.map((row) => ({
    conceptId: row.conceptId,
    conceptName: context.get(row.conceptId)?.name ?? "this concept",
    estimate: row.estimate === null ? null : Number(row.estimate),
    band: row.band as ConceptState["band"],
    openMistakes: states.openByConcept.get(row.conceptId) ?? 0,
    lastEvidenceAt: row.lastEvidenceAt,
    available: states.available.get(row.conceptId) ?? 0,
    subjectNames: context.get(row.conceptId)?.subjects ?? [],
  }));
}

type OutcomeLink = { conceptId: string; learningOutcomeId: string };

/**
 * Approved, machine-markable, not-recently-aced questions, per concept.
 *
 * One query for the pool and one for the cooldown rather than a query per
 * concept: this runs on the student's home page, and a page that fans out over
 * concepts gets slower every term.
 */
async function servableCounts(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  studentUserId: string,
  links: OutcomeLink[],
  now: Date,
): Promise<Map<string, number>> {
  if (links.length === 0) return new Map();

  const outcomeIds = [...new Set(links.map((link) => link.learningOutcomeId))];
  const questionLinks = await tx.questionOutcome.findMany({
    where: { learningOutcomeId: { in: outcomeIds } },
    select: { questionId: true, learningOutcomeId: true },
  });
  if (questionLinks.length === 0) return new Map();

  const questions = await tx.question.findMany({
    where: {
      id: { in: [...new Set(questionLinks.map((link) => link.questionId))] },
      deletedAt: null,
      status: "APPROVED",
    },
    select: { id: true, type: true },
  });
  const servable = new Set(
    questions.filter((q) => isObjective(q.type as never)).map((q) => q.id),
  );

  const cooling = await recentlyCorrect(tx, studentUserId, now);

  const conceptsByOutcome = new Map<string, string[]>();
  for (const link of links) {
    const list = conceptsByOutcome.get(link.learningOutcomeId) ?? [];
    list.push(link.conceptId);
    conceptsByOutcome.set(link.learningOutcomeId, list);
  }

  // A question reaching a concept through two outcomes counts once.
  const byConcept = new Map<string, Set<string>>();
  for (const link of questionLinks) {
    if (!servable.has(link.questionId) || cooling.has(link.questionId)) continue;
    for (const conceptId of conceptsByOutcome.get(link.learningOutcomeId) ?? []) {
      const set = byConcept.get(conceptId) ?? new Set<string>();
      set.add(link.questionId);
      byConcept.set(conceptId, set);
    }
  }

  return new Map([...byConcept].map(([conceptId, set]) => [conceptId, set.size]));
}

/** Questions this student got right in practice inside the cooldown. */
async function recentlyCorrect(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  studentUserId: string,
  now: Date,
): Promise<Set<string>> {
  const since = new Date(now.getTime() - COOLDOWN_DAYS * 86_400_000);
  const sessions = await tx.practiceSession.findMany({
    where: { studentUserId, startedAt: { gte: since } },
    select: { id: true },
  });
  if (sessions.length === 0) return new Set();

  const answers = await tx.practiceAnswer.findMany({
    where: {
      practiceSessionId: { in: sessions.map((s) => s.id) },
      isCorrect: true,
    },
    select: { questionId: true },
  });
  return new Set(answers.map((answer) => answer.questionId));
}

// ---------------------------------------------------------------------------
// Running a session
// ---------------------------------------------------------------------------

export type StartInput = {
  conceptId: string;
  source: "RECOMMENDED" | "MISTAKE_REVIEW" | "SELF_SELECTED" | "ASSIGNED";
  questionCount?: number;
  /**
   * The teacher instruction this set answers, when there is one.
   *
   * Stamped on the session rather than inferred from the concept and the date:
   * "did this student do what their teacher asked" must not be a guess, and a
   * student who practises the same idea on their own has not done the homework.
   */
  assignedPracticeId?: string | null;
};

export type StartResult =
  | { ok: true; sessionId: string; questionCount: number }
  | { ok: false; message: string };

export async function startPractice(
  actor: Actor,
  input: StartInput,
  now = new Date(),
): Promise<StartResult> {
  const wanted = Math.min(
    MAX_SET,
    Math.max(MIN_SET, input.questionCount ?? MIN_SET),
  );

  return withTenant<StartResult>(actor.organizationId, async (tx) => {
    // An unfinished session on the same concept is resumed rather than
    // duplicated. A student who backgrounds the tab and taps again should not
    // find two half-done sets.
    const open = await tx.practiceSession.findFirst({
      where: {
        studentUserId: actor.userId,
        completedAt: null,
        conceptIds: { has: input.conceptId },
      },
      orderBy: { startedAt: "desc" },
    });
    if (open) {
      // An open set on this concept is ADOPTED rather than duplicated when a
      // teacher instruction is named. Two half-done sets on the same idea is
      // exactly what the resume rule exists to prevent, and a student sitting
      // one right now is practising the thing they were asked to practise.
      if (input.assignedPracticeId && open.assignedPracticeId === null) {
        await tx.practiceSession.update({
          where: { id: open.id },
          data: { assignedPracticeId: input.assignedPracticeId },
        });
      }
      return { ok: true, sessionId: open.id, questionCount: open.questionCount };
    }

    const outcomes = await tx.conceptOutcome.findMany({
      where: { conceptId: input.conceptId },
      select: { learningOutcomeId: true },
    });
    if (outcomes.length === 0) {
      return { ok: false, message: "There is nothing to practise on this yet." };
    }

    const links = await tx.questionOutcome.findMany({
      where: {
        learningOutcomeId: { in: outcomes.map((o) => o.learningOutcomeId) },
      },
      select: { questionId: true },
    });

    const cooling = await recentlyCorrect(tx, actor.userId, now);
    const pool = await tx.question.findMany({
      where: {
        id: {
          in: [...new Set(links.map((l) => l.questionId))].filter(
            (id) => !cooling.has(id),
          ),
        },
        deletedAt: null,
        status: "APPROVED",
      },
      select: { id: true, type: true, currentVersionId: true, difficulty: true },
      orderBy: { createdAt: "asc" },
    });

    const servable = pool.filter((q) => isObjective(q.type as never));
    if (servable.length < MIN_SET) {
      return {
        ok: false,
        message:
          servable.length === 0
            ? "There are no practice questions on this yet. Your teacher can add some."
            : `There are only ${servable.length} questions on this that you have not just done. Come back after your next test.`,
      };
    }

    // Where the set opens: from how far behind they are on this concept, not
    // from a constant. A student at 0.3 meets something they can do, because
    // the point is to rebuild the concept rather than to measure again how far
    // behind they are — which is already known.
    const reading = await tx.studentConceptMastery.findFirst({
      where: { studentUserId: actor.userId, conceptId: input.conceptId },
      select: { estimate: true },
    });
    const estimate =
      reading?.estimate === null || reading === null ? null : Number(reading.estimate);
    const base: Difficulty =
      estimate === null || estimate < 0.6 ? "EASY" : estimate < 0.8 ? "MEDIUM" : "HARD";

    const count = Math.min(wanted, servable.length);
    // Only the FIRST question is materialised. The rest are chosen one at a
    // time, from how the student is actually doing — see `answerPractice`.
    const first = pickNearest(base, servable);
    if (!first) {
      return { ok: false, message: "There is nothing to practise on this yet." };
    }

    const sessionId = randomUUID();
    await tx.practiceSession.create({
      data: {
        id: sessionId,
        organizationId: actor.organizationId,
        studentUserId: actor.userId,
        source: input.source,
        assignedPracticeId: input.assignedPracticeId ?? null,
        conceptIds: [input.conceptId],
        questionCount: count,
        baseDifficulty: base,
        startedAt: now,
      },
    });

    await tx.practiceAnswer.createMany({
      data: [
        {
          id: randomUUID(),
          organizationId: actor.organizationId,
          practiceSessionId: sessionId,
          questionId: first.id,
          // Frozen at serve time, exactly as an attempt does it.
          questionVersionId: first.currentVersionId,
          position: 1,
        },
      ],
    });

    return { ok: true, sessionId, questionCount: count };
  });
}

export type PracticeQuestion = {
  practiceAnswerId: string;
  /**
   * The question itself, so the runner can ask the tutor about it.
   *
   * An opaque id for a question already on their screen. It is deliberately
   * NOT the version id: the tutor resolves the served version from the
   * practice answer, which is the record that cannot be argued with.
   */
  questionId: string;
  position: number;
  type: string;
  stem: string;
  /** Never carrying `isCorrect`. Rebuilt field by field, as the player does. */
  options: { key: string; text: string }[] | null;
  marks: number;
  /** Their answer, once given. */
  response: unknown;
  isCorrect: boolean | null;
  /** All three null until they have answered THIS question. */
  explanation: string | null;
  correctAnswer: string | null;
  /**
   * Which option keys are right, so the runner can mark them in place.
   *
   * A verdict panel that only names the answer in prose leaves the option the
   * student actually tapped sitting there in the "chosen" colour, which reads
   * as approval directly above the words "not this time".
   */
  correctKeys: string[] | null;
};

export type PracticeView = {
  sessionId: string;
  conceptId: string;
  conceptName: string;
  source: string;
  questionCount: number;
  answered: number;
  correct: number;
  completedAt: Date | null;
  score: number | null;
  questions: PracticeQuestion[];
};

export async function getPractice(
  actor: Actor,
  sessionId: string,
): Promise<PracticeView | null> {
  const found = await withTenant(actor.organizationId, async (tx) => {
    const session = await tx.practiceSession.findFirst({
      where: { id: sessionId, studentUserId: actor.userId },
    });
    if (!session) return null;

    const answers = await tx.practiceAnswer.findMany({
      where: { practiceSessionId: sessionId },
      orderBy: { position: "asc" },
    });

    const [versions, questions] = await Promise.all([
      tx.questionVersion.findMany({
        where: {
          id: { in: answers.flatMap((a) => (a.questionVersionId ? [a.questionVersionId] : [])) },
        },
      }),
      tx.question.findMany({
        where: { id: { in: answers.map((a) => a.questionId) } },
        select: { id: true, type: true, marks: true },
      }),
    ]);

    return { session, answers, versions, questions };
  });
  if (!found) return null;

  const { session, answers, versions, questions } = found;
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const questionById = new Map(questions.map((q) => [q.id, q]));

  const context = await conceptContext(session.conceptIds);

  return {
    sessionId: session.id,
    conceptId: session.conceptIds[0] ?? "",
    conceptName: context.get(session.conceptIds[0] ?? "")?.name ?? "Practice",
    source: session.source,
    questionCount: session.questionCount,
    answered: answers.filter((a) => a.isCorrect !== null).length,
    correct: answers.filter((a) => a.isCorrect === true).length,
    completedAt: session.completedAt,
    score: session.score === null ? null : Number(session.score),
    questions: answers.map((answer) => {
      const version = answer.questionVersionId
        ? versionById.get(answer.questionVersionId)
        : undefined;
      const question = questionById.get(answer.questionId);
      const answered = answer.isCorrect !== null;

      const rawOptions = (version?.options ?? null) as
        | { key: string; text: string; isCorrect?: boolean }[]
        | null;

      return {
        practiceAnswerId: answer.id,
        questionId: answer.questionId,
        position: answer.position,
        type: question?.type ?? "MCQ",
        stem: version?.stem ?? "This question",
        options:
          rawOptions === null
            ? null
            : rawOptions.map((option) => ({ key: option.key, text: option.text })),
        marks: question?.marks ?? 1,
        response: answer.response,
        isCorrect: answer.isCorrect,
        // Per question, not per session. Answering question 3 must not hand
        // over the answers to 4 through 8.
        explanation: answered ? (version?.explanation ?? null) : null,
        correctAnswer: answered ? describeAnswer(rawOptions, version?.answerKey) : null,
        correctKeys: answered ? correctKeysOf(rawOptions) : null,
      };
    }),
  };
}

export type AnswerResult =
  | {
      ok: true;
      correct: boolean;
      explanation: string | null;
      correctAnswer: string | null;
      correctKeys: string[] | null;
      answered: number;
      questionCount: number;
      /** Set when that was the last one. */
      finished: boolean;
      /**
       * The question chosen from how this set has gone, ready to render.
       *
       * Returned with the verdict rather than fetched separately: the runner
       * needs it the instant the student presses Next, and a second round trip
       * there is a spinner between every question.
       */
      next: PracticeQuestion | null;
    }
  | { ok: false; message: string };

/**
 * Answer one question and be told at once.
 *
 * Marked by the same `markAnswer` the exam uses, against the version served.
 * Two markers would eventually disagree, and a practice question told it was
 * wrong when the exam would call it right is unarguable-with.
 */
export async function answerPractice(
  actor: Actor,
  practiceAnswerId: string,
  response: Response,
  timeSpentSeconds = 0,
  now = new Date(),
): Promise<AnswerResult> {
  const outcome = await withTenant<
    AnswerResult & { sessionId?: string; finishedNow?: boolean }
  >(actor.organizationId, async (tx) => {
    const answer = await tx.practiceAnswer.findFirst({
      where: { id: practiceAnswerId },
    });
    if (!answer) return { ok: false, message: "We could not find that." };

    const session = await tx.practiceSession.findFirst({
      where: { id: answer.practiceSessionId, studentUserId: actor.userId },
    });
    if (!session) return { ok: false, message: "We could not find that." };

    if (answer.isCorrect !== null) {
      // Answering twice would let a student walk the set until every verdict
      // was green, which is the one thing that would make practice evidence
      // worthless. The first answer stands.
      return {
        ok: false,
        message: "You have already answered this one. Move on to the next.",
      };
    }

    const version = answer.questionVersionId
      ? await tx.questionVersion.findFirst({ where: { id: answer.questionVersionId } })
      : null;
    const question = await tx.question.findFirst({
      where: { id: answer.questionId },
      select: { type: true, marks: true },
    });
    if (!version || !question) {
      return { ok: false, message: "That question is no longer available." };
    }

    const marked = markAnswer({
      type: question.type,
      maxMarks: question.marks,
      options: (version.options ?? null) as never,
      answerKey: (version.answerKey ?? null) as never,
      response,
    });

    // Practice only serves objective questions, so a null verdict here means
    // the question has no key — a hole in the bank, not in the student.
    if (marked.isCorrect === null) {
      return {
        ok: false,
        message: "This question cannot be marked automatically. Skip it for now.",
      };
    }

    await tx.practiceAnswer.update({
      where: { id: practiceAnswerId },
      data: {
        response: (response ?? undefined) as never,
        isCorrect: marked.isCorrect,
        timeSpentSeconds,
        answeredAt: now,
      },
    });

    const answers = await tx.practiceAnswer.findMany({
      where: { practiceSessionId: session.id },
      orderBy: { position: "asc" },
    });
    const answered = answers.filter((a) => a.isCorrect !== null).length;
    const correct = answers.filter((a) => a.isCorrect === true).length;
    const finished = answered >= session.questionCount;

    // Serve the next one, at a level chosen from how this set has actually
    // gone. Two consecutive in one direction moves it; a single answer does
    // not, or the set sawtooths instead of pointing somewhere.
    let served: { practiceAnswerId: string } | null = null;
    let servedQuestion: PracticeQuestion | null = null;
    if (!finished) {
      const difficulties = await tx.question.findMany({
        where: { id: { in: answers.map((a) => a.questionId) } },
        select: { id: true, difficulty: true },
      });
      const byQuestion = new Map(difficulties.map((row) => [row.id, row.difficulty]));

      const history = answers
        .filter((a) => a.isCorrect !== null)
        .map((a) => ({
          correct: a.isCorrect === true,
          difficulty: (byQuestion.get(a.questionId) ?? "MEDIUM") as Difficulty,
        }));

      const wanted = nextDifficulty(session.baseDifficulty as Difficulty, history);

      const outcomes = await tx.conceptOutcome.findMany({
        where: { conceptId: { in: session.conceptIds } },
        select: { learningOutcomeId: true },
      });
      const links = await tx.questionOutcome.findMany({
        where: {
          learningOutcomeId: { in: outcomes.map((o) => o.learningOutcomeId) },
        },
        select: { questionId: true },
      });

      const cooling = await recentlyCorrect(tx, actor.userId, now);
      const alreadyServed = new Set(answers.map((a) => a.questionId));

      const pool = await tx.question.findMany({
        where: {
          id: {
            in: [...new Set(links.map((l) => l.questionId))].filter(
              (id) => !cooling.has(id) && !alreadyServed.has(id),
            ),
          },
          deletedAt: null,
          status: "APPROVED",
        },
        select: { id: true, type: true, currentVersionId: true, difficulty: true },
        orderBy: { createdAt: "asc" },
      });

      const next = pickNearest(
        wanted.next,
        pool
          .filter((question) => isObjective(question.type as never))
          .map((question) => ({
            ...question,
            difficulty: question.difficulty as Difficulty,
          })),
      );

      if (next) {
        const id = randomUUID();
        await tx.practiceAnswer.createMany({
          data: [
            {
              id,
              organizationId: actor.organizationId,
              practiceSessionId: session.id,
              questionId: next.id,
              questionVersionId: next.currentVersionId,
              position: answers.length + 1,
            },
          ],
        });
        served = { practiceAnswerId: id };

        const nextVersion = next.currentVersionId
          ? await tx.questionVersion.findFirst({ where: { id: next.currentVersionId } })
          : null;
        const nextQuestion = await tx.question.findFirst({
          where: { id: next.id },
          select: { marks: true },
        });
        const nextOptions = (nextVersion?.options ?? null) as
          | { key: string; text: string; isCorrect?: boolean }[]
          | null;

        servedQuestion = {
          practiceAnswerId: id,
          questionId: next.id,
          position: answers.length + 1,
          type: next.type,
          stem: nextVersion?.stem ?? "This question",
          // Rebuilt field by field, never filtered — the rule the player set.
          options:
            nextOptions === null
              ? null
              : nextOptions.map((option) => ({ key: option.key, text: option.text })),
          marks: nextQuestion?.marks ?? 1,
          response: null,
          isCorrect: null,
          // Sealed, exactly as a question fetched any other way is.
          explanation: null,
          correctAnswer: null,
          correctKeys: null,
        };
      } else {
        // The bank ran out. The set ends here rather than stalling on a screen
        // with no next button — and its count comes down to what was actually
        // served, so the score is over what they did.
        await tx.practiceSession.update({
          where: { id: session.id },
          data: { questionCount: answered },
        });
      }
    }

    // Over either because they answered the planned number, or because the
    // bank ran out and there is nothing left to serve.
    const ranOut = served === null && !finished;
    const over = finished || ranOut;

    // When the bank ran out, the score is over what they actually did — not
    // over a number the set promised and could not deliver.
    const total = ranOut ? answered : session.questionCount;

    if (over && session.completedAt === null) {
      await tx.practiceSession.update({
        where: { id: session.id },
        data: {
          completedAt: now,
          score: Math.round((correct / Math.max(1, total)) * 1000) / 1000,
        },
      });
    }

    return {
      ok: true,
      correct: marked.isCorrect,
      explanation: version.explanation,
      correctAnswer: describeAnswer(version.options as never, version.answerKey),
      correctKeys: correctKeysOf(version.options as never),
      answered,
      questionCount: total,
      finished: over,
      next: servedQuestion,
      sessionId: session.id,
      finishedNow: over && session.completedAt === null,
    };
  });

  // After the transaction, deliberately — same rule as a submitted paper. A
  // student's practice must never fail because the ledger was busy.
  if (outcome.ok && outcome.finishedNow && outcome.sessionId) {
    await recordPracticeEvidence(actor.organizationId, outcome.sessionId, now);
    // And then the mistake bank, which reads the evidence just written.
    //
    // Practice CAN close a mistake, and that is deliberate. The rule has always
    // been "a different question on the same idea, right" — practice satisfies
    // it literally. The alternative, resolution only from a test, would mean a
    // student can never clear their own bank by their own effort, because they
    // cannot set themselves a paper. A list that only grows is the failure the
    // page's own copy warns about.
    await reconcileResolved(actor.organizationId, actor.userId, now);
  }

  return outcome;
}

export type SessionRow = {
  id: string;
  conceptId: string;
  conceptName: string;
  source: string;
  questionCount: number;
  answered: number;
  score: number | null;
  startedAt: Date;
  completedAt: Date | null;
};

export async function recentSessions(
  actor: Actor,
  take = 20,
): Promise<SessionRow[]> {
  const rows = await withTenant(actor.organizationId, async (tx) => {
    const sessions = await tx.practiceSession.findMany({
      where: { studentUserId: actor.userId },
      orderBy: { startedAt: "desc" },
      take,
    });
    if (sessions.length === 0) return [];

    const answers = await tx.practiceAnswer.groupBy({
      by: ["practiceSessionId"],
      where: {
        practiceSessionId: { in: sessions.map((s) => s.id) },
        isCorrect: { not: null },
      },
      _count: true,
    });
    const answeredBySession = new Map(
      answers.map((row) => [row.practiceSessionId, row._count]),
    );
    return sessions.map((session) => ({ session, answeredBySession }));
  });
  if (rows.length === 0) return [];

  const context = await conceptContext([
    ...new Set(rows.flatMap((row) => row.session.conceptIds)),
  ]);

  return rows.map(({ session, answeredBySession }) => ({
    id: session.id,
    conceptId: session.conceptIds[0] ?? "",
    conceptName:
      context.get(session.conceptIds[0] ?? "")?.name ?? "Practice",
    source: session.source,
    questionCount: session.questionCount,
    answered: answeredBySession.get(session.id) ?? 0,
    score: session.score === null ? null : Number(session.score),
    startedAt: session.startedAt,
    completedAt: session.completedAt,
  }));
}

/** The keys that are right, for marking the options themselves. */
function correctKeysOf(
  options: { key: string; isCorrect?: boolean }[] | null,
): string[] | null {
  if (!options || options.length === 0) return null;
  const keys = options.filter((option) => option.isCorrect).map((o) => o.key);
  return keys.length > 0 ? keys : null;
}

/** The correct answer in a sentence. A raw key is a log line, not an answer. */
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
    if (key.kind === "numeric" && typeof key.value === "number") return String(key.value);
    if (key.kind === "text" && Array.isArray(key.accepted)) {
      return (key.accepted as string[]).join("  ·  ");
    }
  }
  return null;
}

export { MIN_SET, MAX_SET };

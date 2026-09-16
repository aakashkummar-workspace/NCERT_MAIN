import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";
import { conceptContext, outcomeIdsFor } from "@/core/curriculum/concepts";
import { allocate } from "@/core/assessments/blueprint";
import { publishAssessment, DEFAULT_SETTINGS } from "@/core/assessments";
import { createAssignment } from "@/core/assignments";
import { STUDENT_THRESHOLD } from "./rules";
import type { Prisma } from "@prisma/client";

/**
 * One click, from a gap to a paper only the students who need it will sit.
 *
 * ---------------------------------------------------------------------------
 * Calibrated down, deliberately
 * ---------------------------------------------------------------------------
 * A remedial paper is not a shorter version of the one they just failed. A
 * class at 0.35 on a concept cannot do it at all; handing them the same
 * difficulty again measures the same thing twice and teaches them they are bad
 * at Mathematics. So the mix is set from how far behind the group actually is,
 * and the weakest groups get a paper they can mostly finish — which is what
 * produces the evidence that says whether the reteaching landed.
 *
 * ---------------------------------------------------------------------------
 * It refuses rather than pad
 * ---------------------------------------------------------------------------
 * If the bank holds four questions on the concept, this builds a four-question
 * paper and says so before building it. What it will not do is reach for
 * questions on a neighbouring concept to make the number up: the whole purpose
 * of the sitting is a clean second reading on ONE concept, and a paper half
 * about something else cannot give that.
 */

export type Actor = { organizationId: string; userId: string; role: string };
export type Difficulty = "EASY" | "MEDIUM" | "HARD";

/** Below this many questions there is not enough to read anything from. */
export const MIN_REMEDIAL_QUESTIONS = 4;

/** And past this it stops being a check and starts being another exam. */
export const MAX_REMEDIAL_QUESTIONS = 10;

/**
 * The mix, from how far behind the struggling students are.
 *
 * Three bands rather than a formula, because a teacher has to be able to
 * disagree with it: "they were at 0.35, so they get mostly easy questions" is
 * an argument. A curve fitted to the estimate is not.
 */
export function calibrate(meanEstimate: number): Record<Difficulty, number> {
  // Cannot do it at all. Nothing hard — a hard question here measures nothing
  // except that they are still stuck, which is already known.
  if (meanEstimate < 0.4) return { EASY: 70, MEDIUM: 30, HARD: 0 };
  // Can sometimes. Enough medium to tell "can now" from "got lucky".
  if (meanEstimate < 0.5) return { EASY: 50, MEDIUM: 40, HARD: 10 };
  // Nearly there. The question is whether it holds under pressure.
  return { EASY: 30, MEDIUM: 50, HARD: 20 };
}

export type RemedialPlan = {
  gapId: string;
  conceptId: string;
  conceptName: string;
  /** Whose paper this is. Never the whole class — that is the point. */
  studentUserIds: string[];
  classId: string;
  className: string;
  subjectId: string;
  meanEstimate: number;
  /** What the calibration WANTS, in percent. Not what the paper will be. */
  mix: Record<Difficulty, number>;
  /** What the bank holds on this concept, by difficulty. */
  available: Record<Difficulty, number>;
  /**
   * Of those, the ones none of these students has already met — on a paper
   * they sat or in practice. A second reading on a question they have seen is
   * a reading of their memory.
   */
  unseen: Record<Difficulty, number>;
  /**
   * What the paper WILL hold, by difficulty — counted from `chosen`, so the
   * preview describes the built paper rather than the calibration's wish.
   */
  chosenByDifficulty: Record<Difficulty, number>;
  /** How many chosen questions at least one of these students has met before. */
  reused: number;
  /**
   * Where the paper departs from the calibration, in sentences. Not problems:
   * the paper can still be built, and the teacher should know how it differs
   * before pressing the button, not discover it when the papers come back.
   */
  notes: string[];
  /** What would actually go on the paper. */
  chosen: {
    questionId: string;
    difficulty: Difficulty;
    marks: number;
    seconds: number;
  }[];
  totalMarks: number;
  durationMinutes: number;
  feasible: boolean;
  /** Why not, in a sentence a teacher can act on. */
  problems: string[];
};

/**
 * Everything the button would do, before it does it.
 *
 * Shown on the gap card so a teacher knows they are about to set six questions
 * to four students, rather than finding out after the fact. Same code path as
 * the build, so the preview cannot disagree with the outcome.
 */
export async function planRemedial(
  organizationId: string,
  gapId: string,
): Promise<RemedialPlan | { error: string }> {
  const gap = await withTenant(organizationId, (tx) =>
    tx.learningGap.findFirst({ where: { id: gapId } }),
  );
  if (!gap) return { error: "We could not find that gap." };
  if (gap.scope !== "CLASS") {
    return {
      error:
        "Remedial papers are built for a class gap. A single student is better served by a conversation.",
    };
  }

  const klass = await withTenant(organizationId, (tx) =>
    tx.class.findFirst({
      where: { id: gap.scopeId, deletedAt: null },
      select: { id: true, name: true, subjectId: true, gradeId: true },
    }),
  );
  if (!klass) return { error: "We could not find the class this gap is for." };

  // Who it is for: the students in this class who are actually below the line
  // on this concept, now. Not who was below it when the gap was found — a
  // student who has since got there does not need to sit it again.
  const readings = await withTenant(organizationId, async (tx) => {
    const enrolments = await tx.classEnrolment.findMany({
      where: { classId: klass.id, status: "ACTIVE" },
      select: { studentUserId: true },
    });
    return tx.studentConceptMastery.findMany({
      where: {
        conceptId: gap.conceptId,
        studentUserId: { in: enrolments.map((e) => e.studentUserId) },
      },
      select: { studentUserId: true, estimate: true },
    });
  });

  const struggling = readings.filter(
    (row) => row.estimate !== null && Number(row.estimate) < STUDENT_THRESHOLD,
  );

  const mean =
    struggling.length > 0
      ? struggling.reduce((sum, row) => sum + Number(row.estimate), 0) /
        struggling.length
      : Number(gap.meanEstimate);

  const mix = calibrate(mean);

  // The concept's outcomes, on the curriculum plane — and then the tenant's
  // own approved questions against them. Only APPROVED: a draft is somebody's
  // unfinished thought and cannot be put in front of a student who is already
  // behind.
  const [outcomeIds, context] = await Promise.all([
    outcomeIdsFor(gap.conceptId),
    conceptContext([gap.conceptId]),
  ]);
  const conceptName = context.get(gap.conceptId)?.name ?? "this concept";

  const questions =
    outcomeIds.length === 0
      ? []
      : await withTenant(organizationId, async (tx) => {
          const links = await tx.questionOutcome.findMany({
            where: { learningOutcomeId: { in: outcomeIds } },
            select: { questionId: true },
          });
          const ids = [...new Set(links.map((link) => link.questionId))];
          if (ids.length === 0) return [];

          return tx.question.findMany({
            where: {
              id: { in: ids },
              deletedAt: null,
              status: "APPROVED",
              subjectId: klass.subjectId,
            },
            select: {
              id: true,
              difficulty: true,
              marks: true,
              expectedTimeSeconds: true,
            },
            // Stable, so a teacher who presses the button twice after cancelling
            // the first gets the same paper rather than a different one.
            orderBy: { createdAt: "asc" },
          });
        });

  // What these students have already met, in any sitting: every paper they
  // started and every practice question they were served. A remedial paper
  // made of questions they have seen measures whether they remember the
  // answer, which is not the thing the intervention is about.
  const strugglingIds = struggling.map((row) => row.studentUserId);
  const seenIds =
    questions.length === 0 || strugglingIds.length === 0
      ? new Set<string>()
      : await withTenant(organizationId, async (tx) => {
          const questionIds = questions.map((q) => q.id);
          const attempts = await tx.attempt.findMany({
            where: { studentUserId: { in: strugglingIds } },
            select: { assignment: { select: { assessmentId: true } } },
          });
          const assessmentIds = [
            ...new Set(attempts.map((attempt) => attempt.assignment.assessmentId)),
          ];
          const onPapers =
            assessmentIds.length === 0
              ? []
              : await tx.assessmentQuestion.findMany({
                  where: {
                    assessmentId: { in: assessmentIds },
                    questionId: { in: questionIds },
                  },
                  select: { questionId: true },
                });
          const inPractice = await tx.practiceAnswer.findMany({
            where: {
              questionId: { in: questionIds },
              session: { studentUserId: { in: strugglingIds } },
            },
            select: { questionId: true },
          });
          return new Set([
            ...onPapers.map((row) => row.questionId),
            ...inPractice.map((row) => row.questionId),
          ]);
        });

  return assemble({
    gapId,
    gap,
    klass,
    conceptName,
    struggling,
    mean,
    mix,
    questions,
    seenIds,
  });
}

/**
 * Choosing the questions — the part the preview has to describe truthfully.
 *
 * Separate from the reads above only so it is legible; `planRemedial` is still
 * the single path both the preview and the build go through.
 */
function assemble(input: {
  gapId: string;
  gap: { conceptId: string };
  klass: { id: string; name: string; subjectId: string };
  conceptName: string;
  struggling: { studentUserId: string }[];
  mean: number;
  mix: Record<Difficulty, number>;
  questions: {
    id: string;
    difficulty: string;
    marks: number;
    expectedTimeSeconds: number | null;
  }[];
  seenIds: Set<string>;
}): RemedialPlan {
  const { questions, mix, seenIds, klass, conceptName, struggling } = input;
  type Question = (typeof questions)[number];
  const LEVELS = ["EASY", "MEDIUM", "HARD"] as Difficulty[];

  const count = (list: Question[]) =>
    Object.fromEntries(
      LEVELS.map((level) => [level, list.filter((q) => q.difficulty === level).length]),
    ) as Record<Difficulty, number>;

  const fresh = questions.filter((q) => !seenIds.has(q.id));
  const seen = questions.filter((q) => seenIds.has(q.id));
  const available = count(questions);
  const unseen = count(fresh);

  // Unseen questions only, whenever there are enough of them to read anything
  // from. Questions they have met come in only to reach the floor, and the
  // preview says so.
  const target =
    fresh.length >= MIN_REMEDIAL_QUESTIONS
      ? Math.min(MAX_REMEDIAL_QUESTIONS, fresh.length)
      : Math.min(MIN_REMEDIAL_QUESTIONS, questions.length);
  const wanted = allocate(target, mix) as Record<Difficulty, number>;

  const chosen: RemedialPlan["chosen"] = [];
  const taken = new Set<string>();

  // The author's own estimate when there is one. The fallback is 90 seconds a
  // mark, which is the CBSE rule of thumb — three hours for a 120-mark paper.
  const take = (question: Question) => {
    taken.add(question.id);
    chosen.push({
      questionId: question.id,
      difficulty: question.difficulty as Difficulty,
      marks: question.marks,
      seconds: question.expectedTimeSeconds ?? question.marks * 90,
    });
  };

  for (const level of LEVELS) {
    const pool = fresh.filter((q) => q.difficulty === level);
    for (const question of pool.slice(0, wanted[level] ?? 0)) take(question);
  }

  // A difficulty the bank cannot fill is topped up rather than shrinking the
  // paper, easiest first — the calibration only ever errs downwards. The mix
  // is a preference; the count is what makes the second reading comparable to
  // the first. The preview reports the result, not the preference.
  for (const pool of [fresh, seen]) {
    for (const level of LEVELS) {
      for (const question of pool) {
        if (chosen.length >= target) break;
        if (question.difficulty !== level || taken.has(question.id)) continue;
        take(question);
      }
    }
  }

  const chosenByDifficulty = Object.fromEntries(
    LEVELS.map((level) => [level, chosen.filter((c) => c.difficulty === level).length]),
  ) as Record<Difficulty, number>;
  const reused = chosen.filter((c) => seenIds.has(c.questionId)).length;

  const LABEL: Record<Difficulty, string> = { EASY: "easy", MEDIUM: "medium", HARD: "hard" };
  const notes: string[] = [];
  for (const level of LEVELS) {
    const want = wanted[level] ?? 0;
    if (chosenByDifficulty[level] >= want || chosen.length === 0) continue;
    notes.push(
      unseen[level] === 0
        ? `The calibration wants ${want} ${LABEL[level]} ${want === 1 ? "question" : "questions"}, and your bank has no ${LABEL[level]} questions on ${conceptName} that these students have not already answered${available[level] > 0 ? ` (it has ${available[level]} they have met)` : ""}.`
        : `The calibration wants ${want} ${LABEL[level]} ${want === 1 ? "question" : "questions"}, and your bank has only ${unseen[level]} these students have not already answered.`,
    );
  }
  if (notes.length > 0 && chosenByDifficulty.EASY < (wanted.EASY ?? 0)) {
    notes.push(
      "So the paper is harder than a group this far behind should get. Adding a few easy questions on this concept first would make the second reading fairer.",
    );
  }
  if (reused > 0) {
    notes.push(
      `${reused} of the ${chosen.length} ${reused === 1 ? "question has" : "questions have"} been seen before by at least one of these students — there are not enough new ones in the bank. A question they remember measures their memory, so read the result with that in mind.`,
    );
  }

  const totalMarks = chosen.reduce((sum, item) => sum + item.marks, 0);

  // Half again as long as the paper is worth, rounded up to five minutes and
  // never under fifteen. These are students who are behind: what is being
  // measured is whether they can do it, not whether they can do it quickly, and
  // a tight clock on a remedial paper measures the wrong thing twice over.
  const seconds = chosen.reduce((total, item) => total + item.seconds, 0);
  const durationMinutes = Math.max(
    15,
    Math.ceil((seconds * 1.5) / 60 / 5) * 5,
  );

  const problems: string[] = [];
  if (struggling.length === 0) {
    problems.push(
      `Nobody in ${klass.name} is below the line on ${conceptName} any more. There is nobody to set this to.`,
    );
  }
  if (chosen.length < MIN_REMEDIAL_QUESTIONS) {
    problems.push(
      questions.length === 0
        ? `Your bank has no approved questions on ${conceptName}. Write or generate a few first — a remedial paper has to be about the concept that is missing, not about the chapter it sits in.`
        : `Your bank has ${questions.length} approved ${questions.length === 1 ? "question" : "questions"} on ${conceptName}, and a second reading needs at least ${MIN_REMEDIAL_QUESTIONS} to mean anything.`,
    );
  }

  return {
    gapId: input.gapId,
    conceptId: input.gap.conceptId,
    conceptName,
    studentUserIds: struggling.map((row) => row.studentUserId),
    classId: klass.id,
    className: klass.name,
    subjectId: klass.subjectId,
    meanEstimate: Math.round(input.mean * 1000) / 1000,
    mix,
    available,
    unseen,
    chosenByDifficulty,
    reused,
    notes,
    chosen,
    totalMarks,
    durationMinutes,
    feasible: problems.length === 0,
    problems,
  };
}

export type BuildResult =
  | {
      ok: true;
      assessmentId: string;
      assignmentId: string;
      interventionId: string;
      questionCount: number;
      studentCount: number;
    }
  | { ok: false; reason: "NOT_FOUND" | "CONFLICT"; message: string };

/**
 * Build it, publish it, assign it to those students, and stamp the baseline.
 *
 * The intervention is created in the same call, because an assessment built
 * from a gap and not measured against it is just another paper — and the
 * measurement is the only part of this that the product exists for.
 */
export async function buildRemedial(
  actor: Actor,
  gapId: string,
  window: { opensAt: Date; closesAt: Date },
): Promise<BuildResult> {
  const plan = await planRemedial(actor.organizationId, gapId);
  // A gap this tenant cannot see is a miss, not a refusal — and must look
  // identical to one that never existed.
  if ("error" in plan) return { ok: false, reason: "NOT_FOUND", message: plan.error };
  if (!plan.feasible) {
    return { ok: false, reason: "CONFLICT", message: plan.problems[0]! };
  }

  const gap = await withTenant(actor.organizationId, (tx) =>
    tx.learningGap.findFirst({ where: { id: gapId } }),
  );
  if (!gap) {
    return { ok: false, reason: "NOT_FOUND", message: "We could not find that gap." };
  }
  if (gap.status === "RESOLVED") {
    return {
      ok: false,
      reason: "CONFLICT",
      message: "That gap has already closed — the evidence no longer shows it.",
    };
  }

  const open = await withTenant(actor.organizationId, (tx) =>
    tx.intervention.findFirst({
      where: { learningGapId: gapId, status: { in: ["PLANNED", "ACTIVE"] } },
    }),
  );
  if (open) {
    return {
      ok: false,
      reason: "CONFLICT",
      message:
        "There is already something in progress against this gap. Measure it before starting another, or the result belongs to neither.",
    };
  }

  const klass = await withTenant(actor.organizationId, (tx) =>
    tx.class.findFirst({
      where: { id: plan.classId, deletedAt: null },
      select: { gradeId: true },
    }),
  );
  if (!klass) {
    return { ok: false, reason: "NOT_FOUND", message: "We could not find the class." };
  }

  // 1. The paper. Created and filled inside one transaction: a half-built
  //    remedial assessment left in the teacher's drafts by a failure halfway
  //    down this function is worse than no button at all.
  const assessmentId = randomUUID();
  await withTenant(actor.organizationId, async (tx) => {
    await tx.assessment.create({
      data: {
        id: assessmentId,
        organizationId: actor.organizationId,
        createdById: actor.userId,
        classId: plan.classId,
        title: `${plan.conceptName} — second look`,
        subjectId: plan.subjectId,
        gradeId: klass.gradeId,
        durationMinutes: plan.durationMinutes,
        totalMarks: plan.totalMarks,
        blueprint: {
          totalMarks: plan.totalMarks,
          totalQuestions: plan.chosen.length,
          difficultyMix: plan.mix,
          typeMix: {},
          conceptIds: [plan.conceptId],
        } as unknown as Prisma.InputJsonValue,
        settings: {
          ...DEFAULT_SETTINGS,
          // Shuffling a four-question paper gains nothing and makes it harder
          // to talk about afterwards: "question 2" should mean one thing when
          // the teacher goes through it with them.
          shuffleQuestions: false,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    await tx.assessmentQuestion.createMany({
      data: plan.chosen.map((item, index) => ({
        id: randomUUID(),
        organizationId: actor.organizationId,
        assessmentId,
        questionId: item.questionId,
        position: index + 1,
        marks: item.marks,
      })),
    });
  });

  // 2. Publish it, which freezes the question versions.
  const published = await publishAssessment(actor, assessmentId);
  if (!published.ok) {
    // Leave the draft rather than delete it: the teacher can see what was
    // built and fix whatever the check named, which is more useful than a
    // vanished paper and an error message.
    return {
      ok: false,
      reason: "CONFLICT",
      message: `The paper was built but could not be published: ${published.problems[0]}`,
    };
  }

  // 3. Assign it — to those students, not to the class.
  const assignment = await createAssignment(actor, {
    assessmentId,
    classId: plan.classId,
    opensAt: window.opensAt,
    closesAt: window.closesAt,
    maxAttempts: 1,
    resultsPolicy: "AFTER_CLOSE",
    studentUserIds: plan.studentUserIds,
  });
  if (!assignment.ok) {
    return { ok: false, reason: "CONFLICT", message: assignment.message };
  }

  // 4. Stamp the baseline. Everything above was in service of this.
  const interventionId = randomUUID();
  await withTenant(actor.organizationId, async (tx) => {
    await tx.intervention.create({
      data: {
        id: interventionId,
        organizationId: actor.organizationId,
        learningGapId: gapId,
        createdById: actor.userId,
        kind: "REMEDIAL_ASSESSMENT",
        assessmentId,
        assignmentId: assignment.id,
        baselineMastery: plan.meanEstimate,
        baselineStudentCount: plan.studentUserIds.length,
        targetMastery: Math.min(
          0.95,
          Math.max(plan.meanEstimate + 0.15, STUDENT_THRESHOLD + 0.05),
        ),
        status: "ACTIVE",
      },
    });

    await tx.learningGap.update({
      where: { id: gapId },
      data: { status: "INTERVENING" },
    });
  });

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "intervention.remedial_built",
    entityType: "intervention",
    entityId: interventionId,
    after: {
      gapId,
      assessmentId,
      assignmentId: assignment.id,
      questions: plan.chosen.length,
      students: plan.studentUserIds.length,
      baseline: plan.meanEstimate,
    },
  });

  return {
    ok: true,
    assessmentId,
    assignmentId: assignment.id,
    interventionId,
    questionCount: plan.chosen.length,
    studentCount: plan.studentUserIds.length,
  };
}

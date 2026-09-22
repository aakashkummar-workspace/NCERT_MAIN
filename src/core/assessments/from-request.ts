import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";
import { FIXTURE_CHAPTER_FLOOR } from "@/core/readiness";
import { planPaper } from "@/ai/tasks/plan-paper";
import type { QuestionType } from "@/core/questions/validate";
import { createAssessment, setQuestions, updateDraft, type Actor } from "./index";
import { answerableMarks, patternForSubject } from "./pattern";
import {
  describeSubstitutions,
  mixForBank,
  normaliseMix,
  pickForMix,
  pickForSections,
  typeWord,
  windowFor,
  type Candidate,
} from "./auto-fill";
import type { Difficulty } from "./blueprint";

/**
 * A paper from a sentence: "a 40-mark test on Triangles and Circles for 10-A,
 * due Friday".
 *
 * ---------------------------------------------------------------------------
 * What the model decides, and what it does not
 * ---------------------------------------------------------------------------
 * The model turns the sentence into a PLAN — class, chapters, shape, length,
 * window (src/ai/tasks/plan-paper.ts). Everything after that is the paper
 * builder's own code: the plan is checked by rule, the questions are picked by
 * rule from APPROVED bank questions only (./auto-fill.ts), and the draft is
 * written through `createAssessment`, `updateDraft` and `setQuestions` — so it
 * passes exactly the checks a hand-built paper passes, and lands as a DRAFT.
 *
 * Nothing is published and nothing is assigned. The teacher opens the draft,
 * reads it, and presses Publish and Assign as they always do; the window they
 * asked for is offered in the assign panel, not applied. A paper reaches a
 * class because a person sent it, which is the rule the whole product keeps.
 *
 * ---------------------------------------------------------------------------
 * Refusals
 * ---------------------------------------------------------------------------
 * - A request the model could not read as a paper, or whose class it could
 *   not tell, comes back with the model's one-sentence question and no draft.
 * - A class or chapter index that was not offered is dropped, never clamped,
 *   and a chapter outside the class's own subject is dropped too.
 * - A bank with nothing approved in scope builds nothing and says so — an
 *   empty draft is a thing somebody has to delete.
 * - A short bank builds what it can and names every shortfall with numbers.
 */

export type FromRequestResult =
  | {
      ok: true;
      assessmentId: string;
      classId: string;
      className: string;
      title: string;
      /** Plain sentences describing what was built. */
      summary: string[];
      /** The model's stated assumption, if any, for the teacher to check. */
      note: string | null;
      /** What was changed to fit the bank — a type dropped, a difficulty topped up. */
      adjustments: string[];
      /** What the bank could not supply, one sentence each. */
      shortfalls: string[];
      /** A chapter to generate more questions for, when something was short. */
      generateChapterId: string | null;
      /** The window asked for, offered to the assign panel — never applied. */
      window: { opensAt: string; closesAt: string } | null;
    }
  | { ok: false; reason: "FORBIDDEN" | "INVALID" | "UNCLEAR" | "EMPTY" | "AI"; message: string };

const STAFF = new Set(["OWNER", "ADMIN", "TEACHER"]);
const DEFAULT_DIFFICULTY: Record<Difficulty, number> = { EASY: 30, MEDIUM: 50, HARD: 20 };

/** Today in India as "2026-09-22 (Tuesday)" — for the request, never the system prompt. */
function todayInIndia(now: Date): string {
  const date = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const weekday = now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long" });
  return `${date} (${weekday})`;
}

export async function draftPaperFromRequest(
  actor: Actor,
  input: { request: string },
  now = new Date(),
): Promise<FromRequestResult> {
  if (!STAFF.has(actor.role)) {
    return { ok: false, reason: "FORBIDDEN", message: "Only teachers can set papers." };
  }
  const request = input.request.trim();
  if (request.length < 8) {
    return { ok: false, reason: "INVALID", message: "Describe the paper in a sentence — which class, which chapters, how long." };
  }

  // The teacher's own classes (every class, for an owner or admin), and the
  // chapters of those classes' subjects. Real chapters only: a test fixture
  // (numbered 1000+) must never be offered to a teacher.
  const context = await withTenant(actor.organizationId, async (tx) => {
    const classes = await tx.class.findMany({
      where: {
        deletedAt: null,
        ...(actor.role === "TEACHER" ? { ownerTeacherId: actor.userId } : {}),
      },
      include: { subject: { include: { grade: { include: { board: true } } } } },
      orderBy: { name: "asc" },
    });
    const subjectIds = [...new Set(classes.map((klass) => klass.subjectId))];
    const chapters = await tx.chapter.findMany({
      where: { subjectId: { in: subjectIds }, number: { lt: FIXTURE_CHAPTER_FLOOR } },
      include: {
        subject: { include: { grade: true } },
        topics: { include: { outcomes: { select: { id: true } } } },
      },
      orderBy: [{ subject: { name: "asc" } }, { number: "asc" }],
    });
    return { classes, chapters };
  });

  if (context.classes.length === 0) {
    return { ok: false, reason: "EMPTY", message: "You have no classes yet. Create a class first, then describe the paper." };
  }

  const board = context.classes[0]!.subject.grade.board;
  const outcome = await planPaper({
    organizationId: actor.organizationId,
    userId: actor.userId,
    boardName: board.name,
    classes: context.classes.map((klass) => ({
      name: klass.name,
      subjectName: klass.subject.name,
      gradeLabel: klass.subject.grade.label,
      boardPattern: patternForSubject(klass.subject.grade.board.code, klass.subject.code) !== null,
    })),
    chapters: context.chapters.map((chapter) => ({
      number: chapter.number,
      title: chapter.title,
      subjectName: chapter.subject.name,
      gradeLabel: chapter.subject.grade.label,
    })),
    request,
    today: todayInIndia(now),
  });
  if (!outcome.ok) return { ok: false, reason: "AI", message: outcome.message };
  const plan = outcome.value;

  if (!plan.understood) {
    return {
      ok: false,
      reason: "UNCLEAR",
      message: plan.note.trim() || "I could not tell what paper you want. Name the class and the chapters.",
    };
  }

  const klass = plan.classIndex === null ? undefined : context.classes[plan.classIndex];
  if (!klass) {
    return { ok: false, reason: "UNCLEAR", message: "I could not tell which class this is for. Name the class." };
  }
  // Offered, and in the class's own subject — the coherence check the question
  // editor makes, applied to the model's choice.
  const chapters = [...new Set(plan.chapterIndexes)]
    .map((index) => context.chapters[index])
    .filter((chapter) => chapter !== undefined && chapter.subjectId === klass.subjectId);
  if (chapters.length === 0) {
    return {
      ok: false,
      reason: "UNCLEAR",
      message: `I could not tell which ${klass.subject.name} chapters the paper should cover. Name them.`,
    };
  }
  const outcomeIds = chapters.flatMap((chapter) => chapter!.topics.flatMap((topic) => topic.outcomes.map((o) => o.id)));

  const candidates: Candidate[] = await withTenant(actor.organizationId, (tx) =>
    tx.question.findMany({
      where: {
        deletedAt: null,
        status: "APPROVED",
        subjectId: klass.subjectId,
        outcomes: { some: { learningOutcomeId: { in: outcomeIds } } },
      },
      select: { id: true, type: true, difficulty: true, marks: true, chapterId: true },
    }),
  ).then((rows) => rows.map((row) => ({ ...row, type: row.type as QuestionType })));

  const chapterNames = chapters.map((chapter) => chapter!.title);
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "EMPTY",
      message: `The question bank has no approved questions on ${chapterNames.join(", ")} yet. Approve some in the review queue, or generate drafts first.`,
    };
  }

  const pattern =
    plan.shape === "BOARD_PATTERN" ? patternForSubject(klass.subject.grade.board.code, klass.subject.code) : null;
  const difficultyMix = normaliseMix(
    { EASY: plan.difficulty.easy, MEDIUM: plan.difficulty.medium, HARD: plan.difficulty.hard },
    DEFAULT_DIFFICULTY,
  );
  const askedTypes = normaliseMix(
    Object.fromEntries(plan.typeMix.map((row) => [row.type, row.percent])) as Record<string, number>,
    { MCQ: 100 },
  ) as Partial<Record<QuestionType, number>>;
  // A type the bank holds none of on these chapters is re-shared over the
  // types it does hold, and said — rather than leaving its slots empty.
  const { typeMix, dropped } = mixForBank(askedTypes, candidates);

  const seed = randomUUID();
  const { picked, short, substitutions } = pattern
    ? pickForSections(candidates, pattern.sections, seed)
    : pickForMix(candidates, { questionCount: plan.questionCount, difficultyMix, typeMix }, seed);
  const adjustments = [
    ...(pattern
      ? []
      : dropped.map(
          (type) =>
            `No approved ${typeWord(type)} questions on ${chapters.length === 1 ? "this chapter" : "these chapters"}, so the paper uses the other types instead.`,
        )),
    ...describeSubstitutions(substitutions),
  ];

  if (picked.length === 0) {
    return {
      ok: false,
      reason: "EMPTY",
      message: `The bank has approved questions on ${chapterNames.join(", ")}, but none of the kind this paper asks for. Try a different mix, or generate drafts first.`,
    };
  }

  const marks = answerableMarks(picked);
  const durationMinutes = pattern && plan.durationMinutes < pattern.durationMinutes ? pattern.durationMinutes : plan.durationMinutes;
  const created = await createAssessment(actor, {
    title: plan.title.trim(),
    subjectId: klass.subjectId,
    gradeId: klass.subject.gradeId,
    classId: klass.id,
    durationMinutes,
    totalMarks: marks,
  });
  if ("error" in created) return { ok: false, reason: "INVALID", message: created.error };

  const questionCount = picked.length - picked.filter((row, index) =>
    row.choiceGroup !== null && picked.findIndex((other) => other.choiceGroup === row.choiceGroup) !== index,
  ).length;
  await updateDraft(actor, created.id, {
    totalMarks: marks,
    blueprint: {
      totalQuestions: questionCount,
      totalMarks: marks,
      difficultyMix,
      typeMix: pattern ? { MCQ: 100 } : typeMix,
      outcomeIds,
      pattern: pattern ? { key: pattern.key, label: pattern.label, sections: pattern.sections } : null,
    },
  });
  const placed = await setQuestions(
    actor,
    created.id,
    picked.map((row) => ({ questionId: row.id, section: row.section, choiceGroup: row.choiceGroup })),
  );
  if (!placed.ok) {
    return {
      ok: false,
      reason: "INVALID",
      message: `A draft was started but its questions could not be placed (${placed.error}). Open it from your papers to finish it by hand.`,
    };
  }

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "assessment.drafted_from_request",
    entityType: "assessment",
    entityId: created.id,
    // Counts, never the sentence: the audit view is read in an incident.
    after: { questions: questionCount, marks, chapters: chapters.length, shortfalls: short.length, adjustments: adjustments.length },
  });

  const summary = [
    `${questionCount} ${questionCount === 1 ? "question" : "questions"}, ${marks} marks, ${durationMinutes} minutes${pattern ? ` — ${pattern.label}` : ""}.`,
    `From ${chapterNames.join(", ")}, all approved questions from your bank.`,
  ];
  const shortfalls = short.map(
    (row) => `Asked for ${row.wanted} ${row.label} ${row.wanted === 1 ? "question" : "questions"}; the bank had ${row.found}.`,
  );
  const window = windowFor(plan.opensOn, plan.closesOn, durationMinutes, now);

  return {
    ok: true,
    assessmentId: created.id,
    classId: klass.id,
    className: klass.name,
    title: plan.title.trim(),
    summary,
    note: plan.note.trim() || null,
    adjustments,
    shortfalls,
    generateChapterId: shortfalls.length > 0 ? chapters[0]!.id : null,
    window: window ? { opensAt: window.opensAt.toISOString(), closesAt: window.closesAt.toISOString() } : null,
  };
}

import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";
import { alternativesToDrop, displayNumbers } from "@/core/assessments/pattern";
import { markAnswer, type Response } from "@/core/attempts/score";
import { normaliseResponse } from "@/core/attempts/response";
import { rescoreAttempt } from "@/core/results/rescore";
import { syncAttemptMastery } from "@/core/mastery/sync";
import { recomputeMastery } from "@/core/mastery/ledger";
import { syncGapsForAttempt } from "@/core/gaps/sync";
import { recordAttemptMistakes } from "@/core/mistakes/record";
import { reconcileResolved } from "@/core/mistakes/read";
import { isObjective, type AnswerKey, type Option, type QuestionType } from "@/core/questions/validate";
import { ID_BITS } from "@/core/omr/layout";

/**
 * A paper sat on paper, brought back in.
 *
 * Most schools still test on paper, and until this existed only a paper sat in
 * the player could say anything about a concept — so every mastery figure,
 * gap and report in the product described the schools that test on devices,
 * which is not most of them. Recording a sitting here makes it an attempt
 * like any other: marked by the same `markAnswer`, totalled by the same
 * `rescoreAttempt`, and fed to the same four hooks (evidence, gaps, mistakes,
 * resolution). Nothing downstream knows or cares that it was paper.
 *
 * ---------------------------------------------------------------------------
 * The rules
 * ---------------------------------------------------------------------------
 * - **Only a PAPER assignment.** An online paper already has its sittings, and
 *   a teacher typing answers over one would leave two versions of a child's
 *   paper with no way to say which counts.
 * - **Dated to when it was sat.** `submittedAt` is the exam day, because the
 *   evidence ledger dates evidence from it and a December data-entry session
 *   is not December evidence.
 * - **Objective answers are ENTERED, not marked.** The teacher records the
 *   letter the child chose; the product marks it against the frozen key, so a
 *   teacher reading a sheet can never type a mark that disagrees with it.
 * - **A written answer is a mark, or "not marked yet".** Its words stay on the
 *   script — the response is `{kind: "paper"}`, which says only that something
 *   was written — and an unmarked one joins the ordinary marking queue.
 * - **Recording again corrects, in place.** The same attempt, the same answer
 *   rows where possible, and the evidence rewritten from them, so fixing a
 *   typo does not create a second sitting or double a child's evidence.
 * - **"OR" alternatives follow the paper's rule**: the first one answered
 *   counts and the other is dropped — the same `alternativesToDrop` the online
 *   submit uses.
 */

type Actor = { organizationId: string; userId: string; role: string };

export type PaperEntry =
  | { assessmentQuestionId: string; kind: "choice"; keys: string[] }
  | { assessmentQuestionId: string; kind: "boolean"; value: boolean }
  | { assessmentQuestionId: string; kind: "numeric"; value: number }
  | { assessmentQuestionId: string; kind: "text"; value: string }
  /** Written on the script. `marks: null` means written, not marked yet. */
  | { assessmentQuestionId: string; kind: "written"; marks: number | null }
  | { assessmentQuestionId: string; kind: "blank" };

export type PaperQuestion = {
  assessmentQuestionId: string;
  position: number;
  number: number;
  section: string | null;
  choiceGroup: number | null;
  type: QuestionType;
  marks: number;
  objective: boolean;
  /** Option keys for the choice types; never which is correct. */
  optionKeys: string[] | null;
  stem: string;
};

export type RecordedSitting = {
  attemptId: string;
  satOn: string;
  rawScore: number | null;
  maxScore: number | null;
  /** What was recorded per question, to fill the form for a correction. */
  entries: PaperEntry[];
};

export type PaperStudent = {
  userId: string;
  fullName: string;
  rollNumber: string | null;
  /** The number printed on their answer sheet's identity strip. */
  sheetCode: number;
  recorded: RecordedSitting | null;
  /** They sat this online, somehow — nothing to record here. */
  satOnline: boolean;
};

export type PaperSheet = {
  assignmentId: string;
  title: string;
  className: string;
  subjectName: string;
  opensAt: string;
  deliveryMode: "ONLINE" | "PAPER";
  totalMarks: number;
  questions: PaperQuestion[];
  students: PaperStudent[];
};

/**
 * A student's sheet number for one paper: twenty bits of a hash of the two
 * ids. Nothing is stored — the printer and the scanner both derive it — and
 * the scanner resolves it against THIS paper's roster only, so the space is
 * a class of forty, not the world. If two students in one class ever share a
 * code, the screen asks rather than choosing.
 */
export function sheetCodeFor(assignmentId: string, studentUserId: string): number {
  const digest = createHash("sha256").update(`omr:${assignmentId}:${studentUserId}`).digest();
  return digest.readUInt32BE(0) & (2 ** ID_BITS - 1);
}

export async function paperSheet(
  organizationId: string,
  assignmentId: string,
): Promise<PaperSheet | null> {
  return withTenant(organizationId, async (tx) => {
    const assignment = await tx.assignment.findFirst({
      where: { id: assignmentId },
      include: {
        assessment: {
          select: { title: true, totalMarks: true, subject: { select: { name: true } } },
        },
        class: { select: { name: true } },
        targets: { select: { studentUserId: true } },
      },
    });
    if (!assignment) return null;

    const questions = await paperQuestions(tx, assignment.assessmentId);

    const studentIds =
      assignment.targets.length > 0
        ? assignment.targets.map((target) => target.studentUserId)
        : (
            await tx.classEnrolment.findMany({
              where: { classId: assignment.classId, status: "ACTIVE" },
              select: { studentUserId: true },
            })
          ).map((row) => row.studentUserId);

    const [users, profiles, attempts] = await Promise.all([
      tx.user.findMany({ where: { id: { in: studentIds } }, select: { id: true, fullName: true } }),
      tx.studentProfile.findMany({
        where: { userId: { in: studentIds } },
        select: { userId: true, rollNumber: true },
      }),
      tx.attempt.findMany({
        where: { assignmentId, studentUserId: { in: studentIds } },
        include: { answers: true },
        orderBy: { attemptNumber: "desc" },
      }),
    ]);
    const rollOf = new Map(profiles.map((p) => [p.userId, p.rollNumber]));

    const students = users
      .map((user) => {
        const mine = attempts.filter((attempt) => attempt.studentUserId === user.id);
        const paper = mine.find((attempt) => attempt.submitReason === "PAPER");
        return {
          userId: user.id,
          fullName: user.fullName,
          rollNumber: rollOf.get(user.id) ?? null,
          sheetCode: sheetCodeFor(assignmentId, user.id),
          satOnline: mine.some((attempt) => attempt.submitReason !== "PAPER"),
          recorded: paper
            ? {
                attemptId: paper.id,
                satOn: (paper.submittedAt ?? paper.startedAt).toISOString(),
                rawScore: paper.rawScore === null ? null : Number(paper.rawScore),
                maxScore: paper.maxScore === null ? null : Number(paper.maxScore),
                entries: paper.answers.map((answer) =>
                  entryFrom(answer, questions.find((q) => q.assessmentQuestionId === answer.assessmentQuestionId)),
                ),
              }
            : null,
        };
      })
      .sort(
        (a, b) =>
          (a.rollNumber ?? "").localeCompare(b.rollNumber ?? "", undefined, { numeric: true }) ||
          a.fullName.localeCompare(b.fullName),
      );

    return {
      assignmentId,
      title: assignment.assessment.title,
      className: assignment.class.name,
      subjectName: assignment.assessment.subject.name,
      opensAt: assignment.opensAt.toISOString(),
      deliveryMode: assignment.deliveryMode,
      totalMarks: assignment.assessment.totalMarks,
      questions,
      students,
    };
  });
}

async function paperQuestions(
  tx: Prisma.TransactionClient,
  assessmentId: string,
): Promise<PaperQuestion[]> {
  const placements = await tx.assessmentQuestion.findMany({
    where: { assessmentId },
    orderBy: { position: "asc" },
    include: { question: { select: { type: true } } },
  });
  const versionIds = placements.flatMap((p) => (p.questionVersionId ? [p.questionVersionId] : []));
  const versions = await tx.questionVersion.findMany({
    where: { id: { in: versionIds } },
    select: { id: true, stem: true, options: true },
  });
  const versionOf = new Map(versions.map((version) => [version.id, version]));
  const numbers = displayNumbers(placements);

  return placements.map((placement, index) => {
    const version = placement.questionVersionId ? versionOf.get(placement.questionVersionId) : undefined;
    const options = (version?.options ?? null) as Option[] | null;
    const type = placement.question.type as QuestionType;
    return {
      assessmentQuestionId: placement.id,
      position: placement.position,
      number: numbers[index]!,
      section: placement.section,
      choiceGroup: placement.choiceGroup,
      type,
      marks: placement.marks,
      objective: isObjective(type),
      // Keys only, rebuilt: the entry form and the answer sheet must never be
      // able to carry which option is right.
      optionKeys: options ? options.map((option) => option.key) : null,
      stem: version?.stem ?? "",
    };
  });
}

function entryFrom(
  answer: { assessmentQuestionId: string; response: unknown; awardedMarks: unknown },
  question: PaperQuestion | undefined,
): PaperEntry {
  const id = answer.assessmentQuestionId;
  const response = answer.response as Response;
  if (question && !question.objective) {
    if (response === null) return { assessmentQuestionId: id, kind: "blank" };
    return {
      assessmentQuestionId: id,
      kind: "written",
      marks: answer.awardedMarks === null ? null : Number(answer.awardedMarks),
    };
  }
  if (response === null) return { assessmentQuestionId: id, kind: "blank" };
  switch (response.kind) {
    case "choice":
      return { assessmentQuestionId: id, kind: "choice", keys: response.keys };
    case "boolean":
      return { assessmentQuestionId: id, kind: "boolean", value: response.value };
    case "numeric":
      return { assessmentQuestionId: id, kind: "numeric", value: response.value };
    case "text":
      return { assessmentQuestionId: id, kind: "text", value: response.value };
    default:
      return { assessmentQuestionId: id, kind: "blank" };
  }
}

export type RecordResult =
  | { ok: true; attemptId: string; created: boolean; rawScore: number; maxScore: number; pendingMarks: number }
  | { ok: false; code: "NOT_FOUND" | "INVALID" | "CONFLICT"; message: string };

type Planned = {
  question: PaperQuestion;
  response: Response;
  awardedMarks: number | null;
  isCorrect: boolean | null;
  gradeSource: "AUTO" | "TEACHER" | null;
};

/**
 * Record, or correct, one student's paper sitting.
 */
export async function recordPaperSitting(
  actor: Actor,
  assignmentId: string,
  studentUserId: string,
  entries: PaperEntry[],
  satOn?: Date,
): Promise<RecordResult> {
  const now = new Date();

  const outcome = await withTenant<
    RecordResult & { conceptsToRecompute?: string[] }
  >(actor.organizationId, async (tx) => {
    const assignment = await tx.assignment.findFirst({
      where: { id: assignmentId, cancelledAt: null },
      include: {
        assessment: { select: { durationMinutes: true } },
        targets: { select: { studentUserId: true } },
      },
    });
    if (!assignment) {
      return { ok: false, code: "NOT_FOUND", message: "We could not find that paper." };
    }
    if (assignment.deliveryMode !== "PAPER") {
      return {
        ok: false,
        code: "CONFLICT",
        message: "This paper is sat online, so its answers come from the player, not from here.",
      };
    }

    const enrolled = await tx.classEnrolment.findFirst({
      where: { classId: assignment.classId, studentUserId, status: "ACTIVE" },
      select: { id: true },
    });
    const targeted =
      assignment.targets.length === 0 ||
      assignment.targets.some((target) => target.studentUserId === studentUserId);
    if (!enrolled || !targeted) {
      return { ok: false, code: "NOT_FOUND", message: "That student does not sit this paper." };
    }

    const questions = await paperQuestions(tx, assignment.assessmentId);
    const byId = new Map(questions.map((question) => [question.assessmentQuestionId, question]));

    // --- Validate every entry before touching anything --------------------
    const entryOf = new Map<string, PaperEntry>();
    for (const entry of entries) {
      const question = byId.get(entry.assessmentQuestionId);
      if (!question) {
        return { ok: false, code: "INVALID", message: "One of those answers is for a question not on this paper." };
      }
      const problem = checkEntry(question, entry);
      if (problem) return { ok: false, code: "INVALID", message: problem };
      entryOf.set(entry.assessmentQuestionId, entry);
    }

    // --- Which alternatives count -----------------------------------------
    const drop = new Set(
      alternativesToDrop(
        questions.map((question) => ({
          position: question.position,
          choiceGroup: question.choiceGroup,
          answered: isAnswered(entryOf.get(question.assessmentQuestionId)),
        })),
      ),
    );
    const kept = questions.filter((question) => !drop.has(question.position));

    // --- Mark, with the same function the player's submit uses -------------
    const versions = await tx.assessmentQuestion.findMany({
      where: { id: { in: kept.map((q) => q.assessmentQuestionId) } },
      select: { id: true, questionVersionId: true },
    });
    const versionIdOf = new Map(versions.map((row) => [row.id, row.questionVersionId]));
    const keyRows = await tx.questionVersion.findMany({
      where: { id: { in: versions.flatMap((row) => (row.questionVersionId ? [row.questionVersionId] : [])) } },
      select: { id: true, options: true, answerKey: true },
    });
    const keyOf = new Map(keyRows.map((row) => [row.id, row]));

    const planned: Planned[] = kept.map((question) => {
      const entry = entryOf.get(question.assessmentQuestionId) ?? {
        assessmentQuestionId: question.assessmentQuestionId,
        kind: "blank" as const,
      };
      if (!question.objective) {
        if (entry.kind !== "written") {
          // Nothing written: settled, the same as a blank in the player.
          return { question, response: null, awardedMarks: null, isCorrect: null, gradeSource: null };
        }
        const marks = entry.marks;
        return {
          question,
          response: { kind: "paper" },
          awardedMarks: marks,
          isCorrect: marks === null ? null : marks >= question.marks ? true : marks <= 0 ? false : null,
          gradeSource: marks === null ? null : "TEACHER",
        };
      }
      const response = normaliseResponse(responseOf(entry));
      const version = keyOf.get(versionIdOf.get(question.assessmentQuestionId) ?? "");
      const marked = markAnswer({
        type: question.type,
        maxMarks: question.marks,
        options: (version?.options as Option[] | null) ?? null,
        answerKey: (version?.answerKey as AnswerKey) ?? null,
        response,
      });
      return {
        question,
        response,
        awardedMarks: marked.awardedMarks,
        isCorrect: marked.isCorrect,
        gradeSource: marked.awardedMarks === null ? null : "AUTO",
      };
    });

    // --- The attempt ---------------------------------------------------------
    const attempts = await tx.attempt.findMany({
      where: { assignmentId, studentUserId },
      include: { answers: true },
    });
    if (attempts.some((attempt) => attempt.submitReason !== "PAPER")) {
      return {
        ok: false,
        code: "CONFLICT",
        message: "This student already has an online sitting of this paper, so there is nothing to record by hand.",
      };
    }
    const existing = attempts[0] ?? null;
    const sat = satOn ?? assignment.opensAt;
    const durationMs = (assignment.durationOverrideMinutes ?? assignment.assessment.durationMinutes) * 60_000;

    let attemptId: string;
    const conceptsToRecompute = new Set<string>();

    if (!existing) {
      attemptId = randomUUID();
      await tx.attempt.createMany({
        data: [
          {
            id: attemptId,
            organizationId: actor.organizationId,
            assignmentId,
            studentUserId,
            clientAttemptId: randomUUID(),
            attemptNumber: 1,
            status: "SCORED",
            startedAt: sat,
            durationMs,
            expiresAt: new Date(sat.getTime() + durationMs),
            submittedAt: sat,
            submitReason: "PAPER",
            scoredAt: now,
          },
        ],
      });
    } else {
      attemptId = existing.id;
      // Every answer's evidence is rewritten from the corrected rows below.
      // Deleted first, because an answer that became blank writes no new row
      // and its old one would otherwise go on counting.
      const oldIds = existing.answers.map((answer) => answer.id);
      const stale = await tx.conceptEvidence.findMany({
        where: { attemptAnswerId: { in: oldIds } },
        select: { conceptId: true },
      });
      for (const row of stale) conceptsToRecompute.add(row.conceptId);
      await tx.conceptEvidence.deleteMany({ where: { attemptAnswerId: { in: oldIds } } });

      const keptIds = new Set(kept.map((q) => q.assessmentQuestionId));
      const leaving = existing.answers.filter((answer) => !keptIds.has(answer.assessmentQuestionId));
      if (leaving.length > 0) {
        const leavingIds = leaving.map((answer) => answer.id);
        await tx.studentMistake.deleteMany({ where: { attemptAnswerId: { in: leavingIds } } });
        await tx.attemptAnswer.deleteMany({ where: { id: { in: leavingIds } } });
      }
      await tx.attempt.update({
        where: { id: attemptId },
        data: { startedAt: sat, submittedAt: sat, expiresAt: new Date(sat.getTime() + durationMs) },
      });
    }

    const rowOf = new Map(
      (existing?.answers ?? []).map((answer) => [answer.assessmentQuestionId, answer]),
    );
    for (const plan of planned) {
      const data = {
        response: (plan.response ?? null) as Prisma.InputJsonValue,
        isCorrect: plan.isCorrect,
        awardedMarks: plan.awardedMarks,
        gradeSource: plan.gradeSource,
        gradedAt: plan.awardedMarks === null ? null : now,
        answeredAt: plan.response === null ? null : sat,
      };
      const row = rowOf.get(plan.question.assessmentQuestionId);
      if (row) {
        await tx.attemptAnswer.update({
          where: { id: row.id },
          data: { ...data, response: plan.response === null ? Prisma.DbNull : data.response },
        });
      } else {
        await tx.attemptAnswer.createMany({
          data: [
            {
              id: randomUUID(),
              organizationId: actor.organizationId,
              attemptId,
              assessmentQuestionId: plan.question.assessmentQuestionId,
              questionVersionId: versionIdOf.get(plan.question.assessmentQuestionId) ?? null,
              maxMarks: plan.question.marks,
              ...data,
              response: plan.response === null ? Prisma.DbNull : data.response,
            },
          ],
        });
      }
    }

    const summary = await rescoreAttempt(tx, attemptId, now);

    return {
      ok: true,
      attemptId,
      created: !existing,
      rawScore: summary.rawScore,
      maxScore: summary.maxScore,
      pendingMarks: summary.pendingMarks,
      conceptsToRecompute: [...conceptsToRecompute],
    };
  });

  if (!outcome.ok) return outcome;

  // After the transaction, as on every other path: the sitting is committed
  // before the ledger is touched.
  await syncAttemptMastery(actor.organizationId, outcome.attemptId, now);
  // A concept whose evidence was deleted by a correction and not rewritten
  // (an answer that became blank) still needs its estimate recomputed; doing
  // it for every such concept is idempotent, so no bookkeeping is needed.
  for (const conceptId of outcome.conceptsToRecompute ?? []) {
    await withTenant(actor.organizationId, (tx) =>
      recomputeMastery(tx, actor.organizationId, studentUserId, conceptId, now),
    );
  }
  await syncGapsForAttempt(actor.organizationId, outcome.attemptId, now);
  await recordAttemptMistakes(actor.organizationId, outcome.attemptId, now);
  await reconcileResolved(actor.organizationId, studentUserId, now);

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: outcome.created ? "attempt.paper_recorded" : "attempt.paper_corrected",
    entityType: "attempt",
    entityId: outcome.attemptId,
    after: { studentUserId, score: outcome.rawScore, of: outcome.maxScore },
  });

  return {
    ok: true,
    attemptId: outcome.attemptId,
    created: outcome.created,
    rawScore: outcome.rawScore,
    maxScore: outcome.maxScore,
    pendingMarks: outcome.pendingMarks,
  };
}


function isAnswered(entry: PaperEntry | undefined): boolean {
  if (!entry) return false;
  if (entry.kind === "blank") return false;
  if (entry.kind === "written") return true;
  return responseOf(entry) !== null && normaliseResponse(responseOf(entry)) !== null;
}

function responseOf(entry: PaperEntry): Response {
  switch (entry.kind) {
    case "choice":
      return { kind: "choice", keys: [...entry.keys].sort() };
    case "boolean":
      return { kind: "boolean", value: entry.value };
    case "numeric":
      return { kind: "numeric", value: entry.value };
    case "text":
      return { kind: "text", value: entry.value };
    default:
      return null;
  }
}

/** A sentence for the first thing wrong with one entry, or null. */
export function checkEntry(question: PaperQuestion, entry: PaperEntry): string | null {
  const name = `Question ${question.number}`;
  if (entry.kind === "blank") return null;
  if (!question.objective) {
    if (entry.kind !== "written") return `${name} is marked by a person — give a mark, not an answer.`;
    if (entry.marks === null) return null;
    if (!Number.isFinite(entry.marks) || entry.marks < 0 || entry.marks > question.marks) {
      return `${name} is out of ${question.marks}. Give a mark between 0 and ${question.marks}.`;
    }
    if (Math.round(entry.marks * 2) !== entry.marks * 2) {
      return `${name}: marks go in halves — 1.5, not 1.3.`;
    }
    return null;
  }
  switch (question.type) {
    case "MCQ":
    case "ASSERTION_REASON":
    case "MULTI_SELECT": {
      if (entry.kind !== "choice") return `${name} needs the option the student chose.`;
      const allowed = new Set(question.optionKeys ?? []);
      const unknown = entry.keys.find((key) => !allowed.has(key));
      if (unknown) return `${name} has no option ${unknown}. It has ${[...allowed].join(", ")}.`;
      if (question.type !== "MULTI_SELECT" && entry.keys.length > 1) {
        return `${name} takes one option. If the student marked two, leave it blank or record the one they meant.`;
      }
      return null;
    }
    case "TRUE_FALSE":
      return entry.kind === "boolean" ? null : `${name} needs True or False.`;
    case "NUMERIC":
      return entry.kind === "numeric" && Number.isFinite(entry.value)
        ? null
        : `${name} needs the number the student wrote.`;
    case "FILL_BLANK":
      return entry.kind === "text" ? null : `${name} needs the word the student wrote.`;
    default:
      return null;
  }
}

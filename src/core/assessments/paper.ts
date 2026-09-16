import "server-only";
import { withTenant } from "@/db/tenant";
import type { QuestionType } from "@prisma/client";
import type { AnswerKey, Option } from "@/core/questions/validate";
import type { Rubric } from "@/core/questions/rubric";
import { DEFAULT_SETTINGS, type AssessmentSettings } from "./index";

/**
 * A paper, for printing on paper.
 *
 * ---------------------------------------------------------------------------
 * It reads the FROZEN version, not the question
 * ---------------------------------------------------------------------------
 * `getAssessment` returns each question's latest version, which is right for
 * the builder — a teacher editing the bank should see what they just typed.
 * It is wrong here. A printed paper is a copy of what was published, and the
 * whole reason `assessment_questions` stamps `question_version_id` is that the
 * source question may have been edited since. Printing the current wording
 * would hand a class a paper that no longer matches the one their marks will
 * be computed against.
 *
 * So a DRAFT cannot be printed at all: it has no frozen versions, so there is
 * nothing stable to print. The refusal names that rather than printing the
 * live wording and hoping nobody edits it before the exam.
 *
 * ---------------------------------------------------------------------------
 * The paper carries no answer key, and the key is a separate read
 * ---------------------------------------------------------------------------
 * Same rule as `getPlayer`, for a sharper reason: this document is photocopied
 * and handed to thirty teenagers. Options are rebuilt as `{key, text}` rather
 * than filtered, so a field added to `Option` later cannot leak by being
 * forgotten, and `answerKey`, `rubric`, `explanation` and `hint` are not in
 * this payload at all. `answerKeyForPrint` is the second function, read by the
 * teacher's own copy, and it is a different URL so the two cannot be printed
 * by one careless press.
 */

export type PaperQuestion = {
  position: number;
  marks: number;
  type: QuestionType;
  stem: string;
  /** Present for the choice types; never carries which one is correct. */
  options: { key: string; text: string }[] | null;
};

export type Paper = {
  id: string;
  title: string;
  subjectName: string;
  gradeLabel: string;
  className: string | null;
  durationMinutes: number;
  totalMarks: number;
  passingMarks: number | null;
  publishedAt: Date | null;
  settings: AssessmentSettings;
  questions: PaperQuestion[];
  /** Marks the questions actually carry, which may differ from `totalMarks`. */
  questionMarks: number;
};

export type PaperResult =
  | { ok: true; paper: Paper }
  | { ok: false; reason: "not-found" | "not-published"; message: string };

const NOT_PUBLISHED =
  "Only a published paper can be printed. A draft's questions are not frozen yet, so what you printed today could differ from what the class sits.";

export async function paperForPrint(
  organizationId: string,
  id: string,
): Promise<PaperResult> {
  const row = await withTenant(organizationId, (tx) =>
    tx.assessment.findFirst({
      where: { id, deletedAt: null },
      include: {
        subject: { select: { name: true } },
        grade: { select: { label: true } },
        class: { select: { name: true } },
        questions: { orderBy: { position: "asc" } },
      },
    }),
  );
  if (!row) {
    return { ok: false, reason: "not-found", message: "We could not find that paper." };
  }
  if (row.status === "DRAFT") {
    return { ok: false, reason: "not-published", message: NOT_PUBLISHED };
  }

  const versionIds = row.questions
    .map((item) => item.questionVersionId)
    .filter((value): value is string => value !== null);

  const versions = await withTenant(organizationId, (tx) =>
    tx.questionVersion.findMany({
      where: { id: { in: versionIds } },
      // Everything but the answer: no answerKey, no rubric, no explanation,
      // no hint. What is not selected cannot be printed by accident.
      select: { id: true, stem: true, options: true, question: { select: { type: true } } },
    }),
  );
  const byId = new Map(versions.map((version) => [version.id, version]));

  const questions: PaperQuestion[] = [];
  for (const item of row.questions) {
    const version = item.questionVersionId ? byId.get(item.questionVersionId) : undefined;
    if (!version) continue;
    const options = (version.options ?? null) as Option[] | null;
    questions.push({
      position: item.position,
      marks: Number(item.marks),
      type: version.question.type,
      stem: version.stem,
      // Rebuilt, never filtered.
      options: options ? options.map((option) => ({ key: option.key, text: option.text })) : null,
    });
  }

  return {
    ok: true,
    paper: {
      id: row.id,
      title: row.title,
      subjectName: row.subject.name,
      gradeLabel: row.grade.label,
      className: row.class?.name ?? null,
      durationMinutes: row.durationMinutes,
      totalMarks: row.totalMarks,
      passingMarks: row.passingMarks,
      publishedAt: row.publishedAt,
      settings: { ...DEFAULT_SETTINGS, ...(row.settings as object) } as AssessmentSettings,
      questions,
      questionMarks: questions.reduce((sum, question) => sum + question.marks, 0),
    },
  };
}

export type KeyQuestion = PaperQuestion & {
  rubric: Rubric | null;
  explanation: string | null;
  difficulty: string;
  /**
   * The answer as a printed line, or null when there is no key and the answer
   * is a person's judgement.
   *
   * Derived the way `core/attempts/score.ts` derives it, not from one field:
   * a choice question's truth is `options[].isCorrect` and its `answerKey` is
   * usually NULL, so reading the key column alone printed "marked by hand"
   * against every MCQ in the bank. A printed key that disagrees with the
   * marking is worse than no printed key.
   */
  answerLabel: string | null;
};

export type AnswerKeyResult =
  | { ok: true; paper: Omit<Paper, "questions">; questions: KeyQuestion[] }
  | { ok: false; reason: "not-found" | "not-published"; message: string };

/**
 * The teacher's copy: the answers, the mark scheme and the explanation.
 *
 * A second function and a second URL rather than a flag on the first, because
 * the difference between the two documents is the difference between a paper a
 * class may hold and one they may not.
 */
export async function answerKeyForPrint(
  organizationId: string,
  id: string,
): Promise<AnswerKeyResult> {
  const base = await paperForPrint(organizationId, id);
  if (!base.ok) return base;

  const rows = await withTenant(organizationId, (tx) =>
    tx.assessment.findFirst({
      where: { id, deletedAt: null },
      include: { questions: { orderBy: { position: "asc" } } },
    }),
  );
  if (!rows) return { ok: false, reason: "not-found", message: "We could not find that paper." };

  const versionIds = rows.questions
    .map((item) => item.questionVersionId)
    .filter((value): value is string => value !== null);
  const versions = await withTenant(organizationId, (tx) =>
    tx.questionVersion.findMany({
      where: { id: { in: versionIds } },
      select: {
        id: true,
        // Options are needed HERE, unlike on the paper, because for a choice
        // question `isCorrect` is the answer.
        options: true,
        answerKey: true,
        rubric: true,
        explanation: true,
        question: { select: { difficulty: true } },
      },
    }),
  );
  const byId = new Map(versions.map((version) => [version.id, version]));

  const { questions, ...paper } = base.paper;
  const keyed: KeyQuestion[] = questions.map((question) => {
    const item = rows.questions.find((row) => row.position === question.position);
    const version = item?.questionVersionId ? byId.get(item.questionVersionId) : undefined;
    return {
      ...question,
      rubric: (version?.rubric ?? null) as Rubric | null,
      explanation: version?.explanation ?? null,
      difficulty: version?.question.difficulty ?? "MEDIUM",
      answerLabel: answerLabelFor(
        question.type,
        (version?.options ?? null) as Option[] | null,
        (version?.answerKey ?? null) as AnswerKey | null,
      ),
    };
  });

  return { ok: true, paper, questions: keyed };
}

/**
 * The answer, as one printed line — in the same precedence the scorer uses.
 *
 * Null means there is no key at all, which is an ordinary state for a written
 * question and must not be printed as if the key were missing by mistake.
 */
function answerLabelFor(
  type: QuestionType,
  options: Option[] | null,
  answer: AnswerKey | null,
): string | null {
  const correctOptions = (options ?? [])
    .filter((option) => option.isCorrect)
    .map((option) => option.key);

  if (type === "MCQ" || type === "MULTI_SELECT" || type === "ASSERTION_REASON") {
    return correctOptions.length > 0 ? correctOptions.join(", ") : null;
  }

  if (!answer) {
    // A true/false question whose truth sits in its options rather than a key.
    return correctOptions.length > 0 ? correctOptions.join(", ") : null;
  }

  switch (answer.kind) {
    case "choice":
      return answer.correctKeys.join(", ");
    case "boolean":
      return answer.correct ? "True" : "False";
    case "numeric":
      // The tolerance is part of the answer: a marker with the paper in front
      // of them needs to know 9.8 and 9.81 are both right.
      return [
        String(answer.value),
        answer.tolerance ? `± ${answer.tolerance}` : "",
        answer.unit ?? "",
      ]
        .filter(Boolean)
        .join(" ");
    case "text":
      return answer.accepted.join("  /  ");
    default:
      return null;
  }
}

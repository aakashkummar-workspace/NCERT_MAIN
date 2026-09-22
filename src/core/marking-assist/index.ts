import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";
import { isObjective, type AnswerKey, type QuestionType } from "@/core/questions/validate";
import { parseRubric } from "@/core/questions/rubric";
import { draftMarksWithModel } from "@/ai/tasks/draft-marks";
import { checkDraft } from "./check";
import { MAX_IMAGES_PER_ANSWER, sniffAnswerImage } from "./image";

/**
 * Marking written answers, with a photo and a model's first pass.
 *
 * Two things live here, and they are separable on purpose:
 *
 * 1. **Photos of written answers.** A student taking a paper in the player
 *    can photograph their working instead of typing it — a Class 10 proof is
 *    written in a notebook, not on a phone keyboard. A teacher can photograph
 *    a script from a paper sitting. Either way the photo belongs to the
 *    answer row, is served only to staff and to the student who wrote it,
 *    and is never shown to a parent (the parent read scope names what it
 *    reads, and this is not in it).
 *
 * 2. **A drafted mark.** Pressed by a teacher, per answer. The model reads the
 *    answer against the scheme and suggests marks; `checkDraft` refuses any
 *    draft that breaks the scheme's rules; the survivor is stored as a
 *    `MarkingDraft` and shown beside the answer. It becomes a mark only when
 *    the teacher saves it, and the mark is then stamped `AI_ASSISTED` —
 *    so "how many of this term's marks did a model suggest" has an answer.
 *
 * The draft never reaches a student, a parent, the evidence ledger or a
 * total. Those read `attempt_answers`, and only a person writes marks there.
 */

type Actor = { organizationId: string; userId: string; role: string };

const STAFF = new Set(["OWNER", "ADMIN", "TEACHER"]);

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

export type ImageResult =
  | { ok: true; id: string }
  | { ok: false; code: "NOT_FOUND" | "INVALID" | "CONFLICT"; message: string };

/**
 * Attach a photo to a written answer.
 *
 * A student may add one only to their own answer while the paper is still
 * being written; a teacher to any written answer in their school, which is
 * how a paper script gets in. Objective questions never take a photo — the
 * answer is a letter, and a photo of a letter is an answer the marker cannot
 * mark.
 */
export async function addAnswerImage(
  actor: Actor,
  target: { answerId: string } | { attemptId: string; assessmentQuestionId: string },
  bytes: Uint8Array,
): Promise<ImageResult> {
  const sniffed = sniffAnswerImage(bytes);
  if (!sniffed.ok) return { ok: false, code: "INVALID", message: sniffed.message };
  const staff = STAFF.has(actor.role);
  const now = new Date();

  const result = await withTenant<ImageResult & { answerId?: string }>(
    actor.organizationId,
    async (tx) => {
      const answer = await tx.attemptAnswer.findFirst({
        where:
          "answerId" in target
            ? { id: target.answerId }
            : { attemptId: target.attemptId, assessmentQuestionId: target.assessmentQuestionId },
        include: {
          attempt: { select: { studentUserId: true, status: true, expiresAt: true } },
        },
      });
      if (!answer) return { ok: false, code: "NOT_FOUND", message: "We could not find that answer." };

      if (!staff) {
        if (actor.role !== "STUDENT" || answer.attempt.studentUserId !== actor.userId) {
          return { ok: false, code: "NOT_FOUND", message: "We could not find that answer." };
        }
        if (answer.attempt.status !== "IN_PROGRESS" || answer.attempt.expiresAt <= now) {
          return {
            ok: false,
            code: "CONFLICT",
            message: "This paper has been handed in, so its answers cannot change now.",
          };
        }
      }

      const placement = await tx.assessmentQuestion.findFirst({
        where: { id: answer.assessmentQuestionId },
        include: { question: { select: { type: true } } },
      });
      if (!placement || isObjective(placement.question.type as QuestionType)) {
        return {
          ok: false,
          code: "INVALID",
          message: "Only a written answer takes a photo.",
        };
      }

      const count = await tx.answerImage.count({ where: { attemptAnswerId: answer.id } });
      if (count >= MAX_IMAGES_PER_ANSWER) {
        return {
          ok: false,
          code: "CONFLICT",
          message: `An answer can have at most ${MAX_IMAGES_PER_ANSWER} photos. Remove one first.`,
        };
      }

      const id = randomUUID();
      await tx.answerImage.createMany({
        data: [
          {
            id,
            organizationId: actor.organizationId,
            attemptAnswerId: answer.id,
            mime: sniffed.mime,
            bytes: new Uint8Array(bytes),
            byteSize: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            uploadedById: actor.userId,
            createdAt: now,
          },
        ],
      });

      // A teacher photographing a script for an answer recorded as blank has
      // just shown it was not blank. The answer becomes "written on paper",
      // and so joins the marking queue — the same response a paper sitting
      // records for a written answer.
      if (staff && answer.response === null) {
        await tx.attemptAnswer.update({
          where: { id: answer.id },
          data: { response: { kind: "paper" } },
        });
      }

      return { ok: true, id, answerId: answer.id };
    },
  );

  if (result.ok) {
    await writeAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "answer.photo_added",
      entityType: "attempt_answer",
      entityId: result.answerId,
      after: { imageId: result.id, bytes: bytes.byteLength },
    });
    return { ok: true, id: result.id };
  }
  return result;
}

/** Remove a photo: its uploader only, and a student only while still writing. */
export async function removeAnswerImage(actor: Actor, imageId: string): Promise<boolean> {
  const now = new Date();
  return withTenant(actor.organizationId, async (tx) => {
    const image = await tx.answerImage.findFirst({ where: { id: imageId } });
    if (!image || image.uploadedById !== actor.userId) return false;
    if (!STAFF.has(actor.role)) {
      const answer = await tx.attemptAnswer.findFirst({
        where: { id: image.attemptAnswerId },
        include: { attempt: { select: { status: true, expiresAt: true } } },
      });
      if (!answer || answer.attempt.status !== "IN_PROGRESS" || answer.attempt.expiresAt <= now) {
        return false;
      }
    }
    await tx.answerImage.deleteMany({ where: { id: imageId } });
    return true;
  });
}

/**
 * One photo's bytes, for a viewer allowed to see it: staff, or the student
 * whose answer it is. Anybody else gets the same null as a photo that does
 * not exist.
 */
export async function readAnswerImage(
  actor: Actor,
  imageId: string,
): Promise<{ mime: string; bytes: Uint8Array } | null> {
  return withTenant(actor.organizationId, async (tx) => {
    const image = await tx.answerImage.findFirst({ where: { id: imageId } });
    if (!image) return null;
    if (!STAFF.has(actor.role)) {
      if (actor.role !== "STUDENT") return null;
      const answer = await tx.attemptAnswer.findFirst({
        where: { id: image.attemptAnswerId },
        include: { attempt: { select: { studentUserId: true } } },
      });
      if (!answer || answer.attempt.studentUserId !== actor.userId) return null;
    }
    return { mime: image.mime, bytes: image.bytes };
  });
}

/** Photo ids per answer, oldest first. Ids only — bytes are fetched per photo. */
export async function imagesFor(
  organizationId: string,
  answerIds: string[],
): Promise<Map<string, string[]>> {
  if (answerIds.length === 0) return new Map();
  const rows = await withTenant(organizationId, (tx) =>
    tx.answerImage.findMany({
      where: { attemptAnswerId: { in: answerIds } },
      select: { id: true, attemptAnswerId: true },
      orderBy: { createdAt: "asc" },
    }),
  );
  const map = new Map<string, string[]>();
  for (const row of rows) {
    map.set(row.attemptAnswerId, [...(map.get(row.attemptAnswerId) ?? []), row.id]);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export type DraftView = {
  answerId: string;
  readable: boolean;
  transcript: string | null;
  total: number | null;
  criteria: { criterionId: string; marks: number; reason: string }[] | null;
  reason: string | null;
  feedback: string | null;
  confidence: "low" | "medium" | "high";
  concerns: string[];
  createdAt: string;
  acceptedAt: string | null;
};

export type DraftResult =
  | { ok: true; draft: DraftView }
  | { ok: false; code: "NOT_FOUND" | "INVALID" | "AI"; message: string };

export async function draftMarks(actor: Actor, answerId: string): Promise<DraftResult> {
  if (!STAFF.has(actor.role)) {
    return { ok: false, code: "NOT_FOUND", message: "We could not find that answer." };
  }

  const context = await withTenant(actor.organizationId, async (tx) => {
    const answer = await tx.attemptAnswer.findFirst({
      where: { id: answerId },
      include: { attempt: { select: { status: true } } },
    });
    if (!answer) return null;
    const placement = await tx.assessmentQuestion.findFirst({
      where: { id: answer.assessmentQuestionId },
      include: {
        question: { select: { type: true } },
        assessment: {
          select: {
            subject: { select: { name: true } },
            grade: { select: { label: true, board: { select: { name: true } } } },
          },
        },
      },
    });
    const version = answer.questionVersionId
      ? await tx.questionVersion.findFirst({ where: { id: answer.questionVersionId } })
      : null;
    const images = await tx.answerImage.findMany({
      where: { attemptAnswerId: answerId },
      orderBy: { createdAt: "asc" },
      select: { mime: true, bytes: true },
    });
    return { answer, placement, version, images };
  });

  if (!context || !context.placement || !context.version) {
    return { ok: false, code: "NOT_FOUND", message: "We could not find that answer." };
  }
  const { answer, placement, version, images } = context;
  if (answer.attempt.status === "IN_PROGRESS") {
    return { ok: false, code: "INVALID", message: "That paper is still being written." };
  }
  const type = placement.question.type as QuestionType;
  if (isObjective(type)) {
    return { ok: false, code: "INVALID", message: "Objective questions are marked automatically." };
  }

  const response = answer.response as { kind?: string; value?: unknown } | null;
  const typed =
    response?.kind === "text" && String(response.value ?? "").trim().length > 0
      ? String(response.value)
      : null;
  if (!typed && images.length === 0) {
    return {
      ok: false,
      code: "INVALID",
      message:
        response?.kind === "paper"
          ? "This answer is on a paper script. Add a photo of it first, and the draft can read that."
          : "There is nothing written here to read.",
    };
  }

  const rubric = parseRubric(version.rubric);
  const key = version.answerKey as AnswerKey | null;
  const modelAnswer =
    [
      key && typeof key === "object" && "kind" in key && key.kind === "text" && Array.isArray(key.accepted)
        ? key.accepted.join(" / ")
        : null,
      version.explanation,
    ]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join("\n") || null;

  const outcome = await draftMarksWithModel({
    organizationId: actor.organizationId,
    userId: actor.userId,
    boardName: placement.assessment.grade.board.name,
    gradeLabel: placement.assessment.grade.label,
    subjectName: placement.assessment.subject.name,
    questionType: type,
    stem: version.stem,
    maxMarks: Number(answer.maxMarks),
    criteria: rubric
      ? rubric.criteria.map((criterion) => ({
          label: criterion.label,
          marks: criterion.marks,
          descriptor: criterion.descriptor ?? null,
        }))
      : null,
    modelAnswer,
    typedAnswer: typed,
    images: images.map((image) => ({
      mediaType: image.mime as "image/jpeg" | "image/png" | "image/webp",
      data: Buffer.from(image.bytes).toString("base64"),
    })),
  });

  if (!outcome.ok) return { ok: false, code: "AI", message: outcome.message };

  const checked = checkDraft(outcome.value, {
    maxMarks: Number(answer.maxMarks),
    rows: rubric ? rubric.criteria.map((criterion) => ({ id: criterion.id, marks: criterion.marks })) : null,
  });
  if (!checked.ok) {
    // Counted, and said: a teacher who sees this often knows the feature is
    // struggling with this question, and somebody can see it in the ledger.
    return {
      ok: false,
      code: "AI",
      message: `The draft was discarded because it broke the mark scheme (${checked.message}). Mark this one yourself, or try again.`,
    };
  }

  const value = outcome.value;
  const data = {
    generationId: outcome.generationId || null,
    readable: checked.readable,
    transcript: value.transcript.trim() || null,
    total: checked.total,
    criteria: (checked.criteria ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
    reason: value.reason.trim() || null,
    feedback: checked.readable ? value.feedback.trim() || null : null,
    confidence: value.confidence,
    concerns: value.concerns.map((concern) => concern.trim()).filter(Boolean),
    requestedById: actor.userId,
    createdAt: new Date(),
    acceptedAt: null,
  };
  const saved = await withTenant(actor.organizationId, (tx) =>
    tx.markingDraft.upsert({
      where: { attemptAnswerId: answerId },
      create: { id: randomUUID(), organizationId: actor.organizationId, attemptAnswerId: answerId, ...data },
      update: data,
    }),
  );

  return { ok: true, draft: draftView(saved) };
}

/** Drafts for a set of answers — staff only, and never with anything else. */
export async function draftsFor(
  organizationId: string,
  answerIds: string[],
): Promise<Map<string, DraftView>> {
  if (answerIds.length === 0) return new Map();
  const rows = await withTenant(organizationId, (tx) =>
    tx.markingDraft.findMany({ where: { attemptAnswerId: { in: answerIds } } }),
  );
  return new Map(rows.map((row) => [row.attemptAnswerId, draftView(row)]));
}

/** Stamp the draft as used, when the teacher saves a mark built from it. */
export async function acceptDraft(
  tx: Prisma.TransactionClient,
  answerId: string,
  now: Date,
): Promise<boolean> {
  const updated = await tx.markingDraft.updateMany({
    where: { attemptAnswerId: answerId },
    data: { acceptedAt: now },
  });
  return updated.count > 0;
}

export function draftView(row: {
  attemptAnswerId: string;
  readable: boolean;
  transcript: string | null;
  total: Prisma.Decimal | null;
  criteria: Prisma.JsonValue;
  reason: string | null;
  feedback: string | null;
  confidence: string;
  concerns: Prisma.JsonValue;
  createdAt: Date;
  acceptedAt: Date | null;
}): DraftView {
  return {
    answerId: row.attemptAnswerId,
    readable: row.readable,
    transcript: row.transcript,
    total: row.total === null ? null : Number(row.total),
    criteria: Array.isArray(row.criteria)
      ? (row.criteria as { criterionId: string; marks: number; reason: string }[])
      : null,
    reason: row.reason,
    feedback: row.feedback,
    confidence:
      row.confidence === "high" || row.confidence === "medium" ? row.confidence : "low",
    concerns: Array.isArray(row.concerns) ? (row.concerns as string[]) : [],
    createdAt: row.createdAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
  };
}

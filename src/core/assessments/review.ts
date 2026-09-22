import "server-only";
import type { Prisma } from "@prisma/client";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";

/**
 * A head of department checks a paper before a class sits it.
 *
 * Most schools already do this on paper — a draft goes to the HOD, comes back
 * with red ink, and only then is it photocopied. When a school turns it on
 * (`organizations.paper_review_required`), publishing waits for it.
 *
 * ---------------------------------------------------------------------------
 * The rules
 * ---------------------------------------------------------------------------
 * - **Off by default.** A solo teacher has nobody to ask, and a gate that can
 *   only be passed by asking yourself is decoration.
 * - **Reviewed by an owner or admin who is NOT the author.** Approving your
 *   own paper is the step the process exists to prevent. A school whose only
 *   admin writes every paper is told so, and can switch review off.
 * - **Any edit clears the review.** It was given to the paper as it stood —
 *   the rule an approved question and a reviewed curriculum draft follow.
 * - **Changes requested is a note, not a veto.** The author edits and sends
 *   it again; the note stays readable until then.
 * - Every step is audited: "who signed off the half-yearly paper" is asked
 *   after something went wrong in it.
 */

type Actor = { organizationId: string; userId: string; role: string };

export const REVIEWERS = new Set(["OWNER", "ADMIN"]);

export type ReviewState =
  | { required: false }
  | {
      required: true;
      status: "NOT_SENT" | "WAITING" | "CHANGES_REQUESTED" | "APPROVED";
      note: string | null;
      reviewerName: string | null;
      decidedAt: Date | null;
    };

/** What an edit to a draft must write, so a stale sign-off cannot survive it. */
export const CLEAR_REVIEW = {
  reviewRequestedAt: null,
  reviewRequestedById: null,
  reviewDecision: null,
  reviewedById: null,
  reviewedAt: null,
} satisfies Prisma.AssessmentUpdateInput;

export function reviewStatus(row: {
  reviewRequestedAt: Date | null;
  reviewDecision: string | null;
}): "NOT_SENT" | "WAITING" | "CHANGES_REQUESTED" | "APPROVED" {
  if (row.reviewDecision === "APPROVED") return "APPROVED";
  if (row.reviewDecision === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
  return row.reviewRequestedAt ? "WAITING" : "NOT_SENT";
}

export async function reviewState(organizationId: string, assessmentId: string): Promise<ReviewState> {
  return withTenant(organizationId, async (tx) => {
    const org = await tx.organization.findFirst({ select: { paperReviewRequired: true } });
    if (!org?.paperReviewRequired) return { required: false };
    const row = await tx.assessment.findFirst({
      where: { id: assessmentId },
      select: { reviewRequestedAt: true, reviewDecision: true, reviewNote: true, reviewedById: true, reviewedAt: true },
    });
    if (!row) return { required: false };
    const reviewer = row.reviewedById
      ? await tx.user.findFirst({ where: { id: row.reviewedById }, select: { fullName: true } })
      : null;
    return {
      required: true,
      status: reviewStatus(row),
      note: row.reviewNote,
      reviewerName: reviewer?.fullName ?? null,
      decidedAt: row.reviewedAt,
    };
  });
}

/** Whether publishing must wait. Read by `publishCheck`. */
export async function reviewBlocksPublishing(
  organizationId: string,
  assessmentId: string,
): Promise<string | null> {
  const state = await reviewState(organizationId, assessmentId);
  if (!state.required || state.status === "APPROVED") return null;
  return state.status === "CHANGES_REQUESTED"
    ? "The reviewer asked for changes. Make them and send the paper for review again."
    : state.status === "WAITING"
      ? "This paper is waiting for review by an owner or admin. It can be published once they approve it."
      : "Your school checks papers before they are published. Send it for review first.";
}

export type ReviewResult = { ok: true } | { ok: false; message: string };

export async function requestReview(actor: Actor, assessmentId: string): Promise<ReviewResult> {
  const result = await withTenant<ReviewResult>(actor.organizationId, async (tx) => {
    const row = await tx.assessment.findFirst({ where: { id: assessmentId, deletedAt: null } });
    if (!row) return { ok: false, message: "We could not find that paper." };
    if (row.status !== "DRAFT") return { ok: false, message: "Only a draft is sent for review." };
    const count = await tx.assessmentQuestion.count({ where: { assessmentId } });
    if (count === 0) return { ok: false, message: "Add questions before sending the paper for review." };
    await tx.assessment.update({
      where: { id: assessmentId },
      data: {
        reviewRequestedAt: new Date(),
        reviewRequestedById: actor.userId,
        reviewDecision: null,
        reviewedById: null,
        reviewedAt: null,
      },
    });
    return { ok: true };
  });
  if (result.ok) {
    await writeAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "assessment.review_requested",
      entityType: "assessment",
      entityId: assessmentId,
    });
  }
  return result;
}

export async function decideReview(
  actor: Actor,
  assessmentId: string,
  decision: "APPROVED" | "CHANGES_REQUESTED",
  note: string | null,
): Promise<ReviewResult> {
  if (!REVIEWERS.has(actor.role)) {
    return { ok: false, message: "Only an owner or admin reviews papers." };
  }
  const trimmed = note?.trim() ? note.trim().slice(0, 2000) : null;
  if (decision === "CHANGES_REQUESTED" && !trimmed) {
    return { ok: false, message: "Say what should change, so the author knows what to do." };
  }

  const result = await withTenant<ReviewResult>(actor.organizationId, async (tx) => {
    const row = await tx.assessment.findFirst({ where: { id: assessmentId, deletedAt: null } });
    if (!row) return { ok: false, message: "We could not find that paper." };
    if (row.status !== "DRAFT") return { ok: false, message: "That paper is already published." };
    if (!row.reviewRequestedAt) {
      return { ok: false, message: "Nobody has sent this paper for review yet." };
    }
    if (row.createdById === actor.userId) {
      return {
        ok: false,
        message:
          "You wrote this paper, so another owner or admin has to review it. If nobody else can, review can be switched off in Settings.",
      };
    }
    await tx.assessment.update({
      where: { id: assessmentId },
      data: {
        reviewDecision: decision,
        reviewedById: actor.userId,
        reviewedAt: new Date(),
        reviewNote: trimmed,
      },
    });
    return { ok: true };
  });

  if (result.ok) {
    await writeAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: decision === "APPROVED" ? "assessment.review_approved" : "assessment.review_changes_requested",
      entityType: "assessment",
      entityId: assessmentId,
      after: { note: trimmed },
    });
  }
  return result;
}

export type ReviewQueueRow = {
  id: string;
  title: string;
  subjectName: string;
  gradeLabel: string;
  authorName: string;
  requestedAt: Date;
  mine: boolean;
};

/** Papers waiting for a decision. Empty when review is off. */
export async function reviewQueue(actor: Actor): Promise<ReviewQueueRow[]> {
  if (!REVIEWERS.has(actor.role)) return [];
  return withTenant(actor.organizationId, async (tx) => {
    const org = await tx.organization.findFirst({ select: { paperReviewRequired: true } });
    if (!org?.paperReviewRequired) return [];
    const rows = await tx.assessment.findMany({
      where: { status: "DRAFT", deletedAt: null, reviewRequestedAt: { not: null }, reviewDecision: null },
      include: { subject: { select: { name: true } }, grade: { select: { label: true } } },
      orderBy: { reviewRequestedAt: "asc" },
    });
    const authors = await tx.user.findMany({
      where: { id: { in: rows.map((row) => row.createdById) } },
      select: { id: true, fullName: true },
    });
    const nameOf = new Map(authors.map((author) => [author.id, author.fullName]));
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      subjectName: row.subject.name,
      gradeLabel: row.grade.label,
      authorName: nameOf.get(row.createdById) ?? "A colleague",
      requestedAt: row.reviewRequestedAt!,
      mine: row.createdById === actor.userId,
    }));
  });
}

/** Turn the school's review rule on or off. Owners and admins only. */
export async function setPaperReview(actor: Actor, required: boolean): Promise<ReviewResult> {
  if (!REVIEWERS.has(actor.role)) return { ok: false, message: "Only an owner or admin can change this." };
  await withTenant(actor.organizationId, (tx) =>
    tx.organization.updateMany({ data: { paperReviewRequired: required } }),
  );
  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: required ? "organization.paper_review_on" : "organization.paper_review_off",
    entityType: "organization",
    entityId: actor.organizationId,
  });
  return { ok: true };
}

export async function paperReviewRequired(organizationId: string): Promise<boolean> {
  const org = await withTenant(organizationId, (tx) =>
    tx.organization.findFirst({ select: { paperReviewRequired: true } }),
  );
  return org?.paperReviewRequired ?? false;
}

export type PreviewQuestion = {
  position: number;
  number: number;
  section: string | null;
  choiceGroup: number | null;
  marks: number;
  type: string;
  stem: string;
  options: { key: string; text: string }[] | null;
  answerLabel: string | null;
  explanation: string | null;
  difficulty: string;
  rubric: { criteria: { label: string; marks: number }[] } | null;
};

/**
 * A DRAFT as the reviewer needs it: every question with its answer, in paper
 * order and numbering. The current versions, because nothing is frozen until
 * publish — which is why any edit after approval clears the approval.
 */
export async function draftPreview(organizationId: string, assessmentId: string): Promise<PreviewQuestion[]> {
  // Imported here rather than at the top: paper.ts imports index.ts, which
  // imports this file, and a static import would close that loop.
  const { answerLabelFor } = await import("./paper");
  const { displayNumbers } = await import("./pattern");
  return withTenant(organizationId, async (tx) => {
    const rows = await tx.assessmentQuestion.findMany({
      where: { assessmentId },
      orderBy: { position: "asc" },
      include: { question: { select: { type: true, difficulty: true, currentVersionId: true } } },
    });
    const versions = await tx.questionVersion.findMany({
      where: { id: { in: rows.flatMap((row) => (row.question.currentVersionId ? [row.question.currentVersionId] : [])) } },
    });
    const versionOf = new Map(versions.map((version) => [version.id, version]));
    const numbers = displayNumbers(rows);
    return rows.flatMap((row, index) => {
      const version = row.question.currentVersionId ? versionOf.get(row.question.currentVersionId) : undefined;
      if (!version) return [];
      const options = (version.options ?? null) as { key: string; text: string; isCorrect?: boolean }[] | null;
      const rubric = version.rubric as { criteria?: { label: string; marks: number }[] } | null;
      return [
        {
          position: row.position,
          number: numbers[index]!,
          section: row.section,
          choiceGroup: row.choiceGroup,
          marks: row.marks,
          type: row.question.type,
          stem: version.stem,
          options: options ? options.map((option) => ({ key: option.key, text: option.text })) : null,
          answerLabel: answerLabelFor(
            row.question.type,
            options as Parameters<typeof answerLabelFor>[1],
            (version.answerKey ?? null) as Parameters<typeof answerLabelFor>[2],
          ),
          explanation: version.explanation,
          difficulty: row.question.difficulty,
          rubric: rubric?.criteria ? { criteria: rubric.criteria } : null,
        },
      ];
    });
  });
}

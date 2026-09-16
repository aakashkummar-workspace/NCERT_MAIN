import "server-only";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";
import { boardByCode, listBoards, type BoardOption } from "@/core/curriculum";

/**
 * The organization's own settings — today, which board it teaches.
 *
 * ---------------------------------------------------------------------------
 * Why the board is a property of the ORGANIZATION
 * ---------------------------------------------------------------------------
 * The curriculum tree has been board-rooted since slice 1: board → grade →
 * subject → chapter → topic → outcome. What was missing was the tenant's edge
 * into it, so every read defaulted to CBSE and the product was CBSE-only by
 * accident rather than by decision.
 *
 * It is not a property of a class, because a class's grade and subject are
 * already rows in one board's tree — putting the board on the class would let
 * one school hold two disjoint syllabuses and make "which board is this
 * report about" unanswerable.
 *
 * The board is read from the session's organization, exactly like the
 * organization id itself. There is no function here that takes a board from a
 * caller and applies it to a read.
 */

export type OrganizationBoard = {
  id: string;
  code: string;
  name: string;
};

/** The board this organization teaches. */
export async function organizationBoard(
  organizationId: string,
): Promise<OrganizationBoard> {
  const row = await withTenant(organizationId, (tx) =>
    tx.organization.findFirst({
      where: { id: organizationId },
      select: { board: { select: { id: true, code: true, name: true } } },
    }),
  );

  // The column is NOT NULL with a foreign key, so this is unreachable short of
  // the row having been deleted underneath a live session. Throwing beats
  // returning a fallback: a fallback here is the CBSE default again, one layer
  // down.
  if (!row) throw new Error(`No organization ${organizationId}`);
  return row.board;
}

/** Just the id, for the many reads that only need to scope a query. */
export async function organizationBoardId(
  organizationId: string,
): Promise<string> {
  return (await organizationBoard(organizationId)).id;
}

export { listBoards };
export type { BoardOption };

// ---------------------------------------------------------------------------
// Changing it
// ---------------------------------------------------------------------------

/**
 * What already ties this organization to its current board's tree.
 *
 * Every one of these rows points at a grade, a subject or a chapter that
 * belongs to one board. Nothing in the database stops the board column
 * changing underneath them — there is no constraint that could express it —
 * so the check lives here and the answer is a refusal.
 */
export type BoardChangeBlockers = {
  classes: number;
  questions: number;
  assessments: number;
  total: number;
};

export async function boardChangeBlockers(
  organizationId: string,
): Promise<BoardChangeBlockers> {
  return withTenant(organizationId, async (tx) => {
    const [classes, questions, assessments] = await Promise.all([
      tx.class.count({ where: { deletedAt: null } }),
      tx.question.count({ where: { deletedAt: null } }),
      tx.assessment.count({ where: { deletedAt: null } }),
    ]);
    return {
      classes,
      questions,
      assessments,
      total: classes + questions + assessments,
    };
  });
}

export type SetBoardResult =
  | { ok: true; board: OrganizationBoard }
  | {
      ok: false;
      code: "UNKNOWN_BOARD" | "IN_USE" | "EMPTY_BOARD";
      message: string;
      blockers?: BoardChangeBlockers;
    };

/**
 * Change the board.
 *
 * ---------------------------------------------------------------------------
 * REFUSED once anything exists, rather than warned. Here is why.
 * ---------------------------------------------------------------------------
 * A class carries `grade_id` and `subject_id`; a question carries
 * `subject_id` and `chapter_id`; an assessment carries both. Every one of
 * those is a row in ONE board's tree, and none of them has any column that
 * says which board it came from — the board is reached by walking upwards.
 * So switching the board on the organization does not migrate anything: it
 * leaves every class, every question and every paper pointing into a tree the
 * school no longer teaches, while the class-creation form, the question
 * picker and the analytics denominators all quietly move to the new one.
 *
 * A loud warning was the alternative, and it fails on what happens after the
 * teacher presses through it. There is no undo that puts the school back:
 * pointing the column at the old board again restores the reads, but any
 * class created in between is now the orphan instead. And the damage is not
 * visible on the screen where it is done — it shows up weeks later as a
 * heatmap with no columns and a paper that cannot be rebuilt.
 *
 * A warning is right when the person pressing it can see the consequence and
 * accept it. Nobody can see this one. So: a fresh organization may choose
 * freely — which is the case this actually serves, a school that picked wrong
 * on the signup form five minutes ago — and an organization with work in it is
 * refused, with the counts named so the refusal is checkable rather than
 * mysterious. Moving a school with real data to another board is a migration,
 * not a settings toggle, and it should cost a conversation.
 */
export async function setOrganizationBoard(
  actor: { organizationId: string; userId: string; role: string },
  boardCode: string,
): Promise<SetBoardResult> {
  const board = await boardByCode(boardCode);
  if (!board) {
    return {
      ok: false,
      code: "UNKNOWN_BOARD",
      message: "We do not have that board.",
    };
  }

  if (board.gradeCount === 0) {
    // Nothing is authored under it yet, so every class-creation form would be
    // empty. Refusing here is the same refusal a report makes below three
    // measured concepts: the state is real, and moving into it silently is
    // worse than being told.
    return {
      ok: false,
      code: "EMPTY_BOARD",
      message: `${board.name} has no grades or subjects authored yet, so you could not create a class under it. Ask us to author it first.`,
    };
  }

  const current = await organizationBoard(actor.organizationId);
  if (current.id === board.id) return { ok: true, board };

  const blockers = await boardChangeBlockers(actor.organizationId);
  if (blockers.total > 0) {
    return {
      ok: false,
      code: "IN_USE",
      message:
        `You already have ${describe(blockers)} built against ${current.name}. ` +
        `Each of those points at a grade, subject or chapter that belongs to ${current.name}, ` +
        `and changing the board does not move them — it would leave every one of them orphaned. ` +
        `Talk to us before switching; this is a migration, not a setting.`,
      blockers,
    };
  }

  await withTenant(actor.organizationId, (tx) =>
    tx.organization.updateMany({
      where: { id: actor.organizationId },
      data: { boardId: board.id },
    }),
  );

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "organization.board_changed",
    entityType: "organization",
    entityId: actor.organizationId,
    before: { boardCode: current.code },
    after: { boardCode: board.code },
  });

  return { ok: true, board };
}

function describe(blockers: BoardChangeBlockers): string {
  const parts: string[] = [];
  if (blockers.classes > 0) {
    parts.push(`${blockers.classes} class${blockers.classes === 1 ? "" : "es"}`);
  }
  if (blockers.questions > 0) {
    parts.push(`${blockers.questions} question${blockers.questions === 1 ? "" : "s"}`);
  }
  if (blockers.assessments > 0) {
    parts.push(
      `${blockers.assessments} assessment${blockers.assessments === 1 ? "" : "s"}`,
    );
  }
  if (parts.length === 0) return "work";
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]!}`;
}

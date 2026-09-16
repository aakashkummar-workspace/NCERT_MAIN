import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";

/**
 * Class announcements: a teacher's short message to one class.
 *
 * One direction, no replies, no attachments — in a product for fifteen-year-olds
 * each of those is a moderation problem, and "Monday's test covers chapters 1
 * and 2" needs none of them. A student sees the announcements of the classes
 * they are ACTIVELY enrolled in, newest first, and nothing from a class they
 * have left.
 *
 * The body is plain text and stays plain text all the way to the screen. It is
 * rendered as a text node with `white-space: pre-line`, never as HTML — a
 * message typed by one adult and shown to thirty children is not a place for
 * markup of any kind.
 */

export type AnnouncementRow = {
  id: string;
  classId: string;
  className: string;
  body: string;
  createdAt: Date;
};

/** How far back a student's home looks. An announcement is news, not an archive. */
export const ANNOUNCEMENT_DAYS = 30;

export const ANNOUNCEMENT_MAX_LENGTH = 1000;

/**
 * The same body to the same class inside this window is a double tap, not a
 * second message. Two minutes, because a flaky connection that retries is slow
 * and a teacher deliberately repeating themselves is slower.
 */
export const DUPLICATE_WINDOW_MS = 2 * 60_000;

/** How many a teacher's list shows. It says so when there are more. */
export const CLASS_LIST_LIMIT = 20;

export async function announcementsForStudent(
  organizationId: string,
  studentUserId: string,
  options: { limit?: number; now?: Date } = {},
): Promise<AnnouncementRow[]> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - ANNOUNCEMENT_DAYS * 24 * 3600_000);
  return withTenant(organizationId, async (tx) => {
    const enrolments = await tx.classEnrolment.findMany({
      where: { studentUserId, status: "ACTIVE", leftAt: null },
      select: { classId: true },
    });
    const classIds = [...new Set(enrolments.map((e) => e.classId))];
    if (classIds.length === 0) return [];
    const rows = await tx.announcement.findMany({
      where: { classId: { in: classIds }, deletedAt: null, createdAt: { gte: since } },
      include: { class: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: options.limit ?? 5,
    });
    return rows.map((row) => ({
      id: row.id,
      classId: row.classId,
      className: row.class.name,
      body: row.body,
      createdAt: row.createdAt,
    }));
  });
}

// ---------------------------------------------------------------------------
// Writes and the teacher's view
// ---------------------------------------------------------------------------

type Actor = { organizationId: string; userId: string; role: string };

type Tx = Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * Trimmed, with line endings normalised so "\r\n" from one browser and "\n"
 * from another are the same message to the duplicate check and the same length
 * to the counter the teacher was shown.
 */
export function normaliseBody(body: string): string {
  return body.replace(/\r\n?/g, "\n").trim();
}

export function checkBody(body: string): string | null {
  if (body.length === 0) return "Write something to post.";
  if (body.length > ANNOUNCEMENT_MAX_LENGTH) {
    return `Keep it to ${ANNOUNCEMENT_MAX_LENGTH} characters — this is ${body.length}.`;
  }
  return null;
}

/**
 * Whether this person may post to (and remove from) this class.
 *
 * An owner or admin runs the whole organization. A teacher needs to teach THIS
 * class — its owner, or listed in `class_teachers` — because thirty students'
 * home pages are not a noticeboard for every colleague in the building.
 * Anybody else, a student included, may not.
 */
async function mayPost(tx: Tx, actor: Actor, classId: string): Promise<boolean> {
  if (actor.role === "OWNER" || actor.role === "ADMIN") return true;
  if (actor.role !== "TEACHER") return false;
  const klass = await tx.class.findFirst({
    where: { id: classId, deletedAt: null },
    select: { ownerTeacherId: true },
  });
  if (!klass) return false;
  if (klass.ownerTeacherId === actor.userId) return true;
  const listed = await tx.classTeacher.count({
    where: { classId, teacherUserId: actor.userId },
  });
  return listed > 0;
}

export async function canPostToClass(actor: Actor, classId: string): Promise<boolean> {
  if (!isUuid(classId)) return false;
  return withTenant(actor.organizationId, (tx) => mayPost(tx, actor, classId));
}

export type TeacherAnnouncement = AnnouncementRow & {
  authorName: string | null;
};

export async function listAnnouncementsForClass(
  organizationId: string,
  classId: string,
  options: { limit?: number } = {},
): Promise<{ rows: TeacherAnnouncement[]; truncated: boolean } | null> {
  if (!isUuid(classId)) return null;
  const limit = options.limit ?? CLASS_LIST_LIMIT;
  return withTenant(organizationId, async (tx) => {
    const klass = await tx.class.findFirst({
      where: { id: classId, deletedAt: null },
      select: { name: true },
    });
    if (!klass) return null;

    // One more than shown, so the list can say it was cut rather than letting
    // twenty rows read as "that is all of them".
    const rows = await tx.announcement.findMany({
      where: { classId, deletedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: limit + 1,
    });
    const shown = rows.slice(0, limit);
    const authorIds = [...new Set(shown.map((row) => row.authorId))];
    const authors =
      authorIds.length === 0
        ? []
        : await tx.user.findMany({
            where: { id: { in: authorIds } },
            select: { id: true, fullName: true },
          });
    const nameOf = new Map(authors.map((author) => [author.id, author.fullName]));

    return {
      rows: shown.map((row) => ({
        id: row.id,
        classId: row.classId,
        className: klass.name,
        body: row.body,
        createdAt: row.createdAt,
        authorName: nameOf.get(row.authorId) ?? null,
      })),
      truncated: rows.length > limit,
    };
  });
}

export type AnnouncementWriteResult =
  | { ok: true; announcement: TeacherAnnouncement }
  | {
      ok: false;
      reason: "not-found" | "forbidden" | "invalid" | "duplicate";
      message: string;
    };

export async function createAnnouncement(
  actor: Actor,
  classId: string,
  rawBody: string,
  options: { now?: Date } = {},
): Promise<AnnouncementWriteResult> {
  if (!isUuid(classId)) {
    return { ok: false, reason: "not-found", message: "We could not find that class." };
  }
  const body = normaliseBody(rawBody);
  const problem = checkBody(body);
  if (problem) return { ok: false, reason: "invalid", message: problem };
  const now = options.now ?? new Date();

  const result = await withTenant<AnnouncementWriteResult>(
    actor.organizationId,
    async (tx) => {
      const klass = await tx.class.findFirst({
        where: { id: classId, deletedAt: null },
        select: { name: true },
      });
      if (!klass) {
        return { ok: false, reason: "not-found", message: "We could not find that class." };
      }
      if (!(await mayPost(tx, actor, classId))) {
        return {
          ok: false,
          reason: "forbidden",
          message: "Only a teacher of this class can post to it.",
        };
      }

      // Serialises posts to one class, so two taps landing in the same
      // millisecond cannot both pass the duplicate check below. Released when
      // the transaction ends.
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${classId}))`;

      const recent = await tx.announcement.findFirst({
        where: {
          classId,
          body,
          deletedAt: null,
          createdAt: { gte: new Date(now.getTime() - DUPLICATE_WINDOW_MS) },
        },
        select: { id: true },
      });
      if (recent) {
        return {
          ok: false,
          reason: "duplicate",
          message: "That message was just posted to this class.",
        };
      }

      const row = await tx.announcement.create({
        data: {
          id: randomUUID(),
          organizationId: actor.organizationId,
          classId,
          authorId: actor.userId,
          body,
          createdAt: now,
        },
      });
      const author = await tx.user.findFirst({
        where: { id: actor.userId },
        select: { fullName: true },
      });
      return {
        ok: true,
        announcement: {
          id: row.id,
          classId,
          className: klass.name,
          body: row.body,
          createdAt: row.createdAt,
          authorName: author?.fullName ?? null,
        },
      };
    },
  );

  if (result.ok) {
    // The length and the class, never the words. An audit row is read during
    // an incident by somebody who has no business reading a teacher's message
    // to children, and "was something posted, by whom, when" needs none of it.
    await writeAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "announcement.created",
      entityType: "announcement",
      entityId: result.announcement.id,
      after: { classId, length: result.announcement.body.length },
    });
  }
  return result;
}

export async function deleteAnnouncement(
  actor: Actor,
  announcementId: string,
): Promise<{ ok: true } | { ok: false; reason: "not-found" | "forbidden"; message: string }> {
  const missing = {
    ok: false as const,
    reason: "not-found" as const,
    message: "We could not find that announcement.",
  };
  if (!isUuid(announcementId)) return missing;

  const result = await withTenant(actor.organizationId, async (tx) => {
    const row = await tx.announcement.findFirst({
      where: { id: announcementId, deletedAt: null },
      select: { id: true, classId: true, body: true },
    });
    if (!row) return missing;
    if (!(await mayPost(tx, actor, row.classId))) {
      return {
        ok: false as const,
        reason: "forbidden" as const,
        message: "Only a teacher of this class can remove its announcements.",
      };
    }
    // A stamp, never a delete: "what were these students told, and when did it
    // stop showing" is a question somebody asks after something has gone wrong.
    await tx.announcement.update({
      where: { id: row.id },
      data: { deletedAt: new Date() },
    });
    return { ok: true as const, classId: row.classId, length: row.body.length };
  });

  if (!result.ok) return result;
  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "announcement.deleted",
    entityType: "announcement",
    entityId: announcementId,
    before: { classId: result.classId, length: result.length },
  });
  return { ok: true };
}

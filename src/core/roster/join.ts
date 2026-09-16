import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";

/**
 * A student joining a class with the code the teacher read out.
 *
 * ---------------------------------------------------------------------------
 * Why this is scoped to the student's own organization
 * ---------------------------------------------------------------------------
 * The lookup runs inside `withTenant`, so a code belonging to another
 * organization simply is not found. That is a real limitation and it is the
 * honest one: a student can currently hold a session for exactly one
 * organization, and there is no way to switch. Enrolling them in a class they
 * could never open would be worse than refusing — they would have joined
 * something invisible and have no idea why.
 *
 * When multi-organization students arrive they need three things together: a
 * pre-tenant code lookup (a narrow SECURITY DEFINER function, like the auth
 * seam), a membership in the second organization, and an organization switcher
 * in the session. None of those exists yet, so none of them is half-built here.
 *
 * ---------------------------------------------------------------------------
 * What the refusals deliberately do not say
 * ---------------------------------------------------------------------------
 * "No class here uses that code" is the answer to a wrong code, a code from
 * another organization, and a code that has been rotated. Distinguishing them
 * would turn the form into a way of testing whether a code is live somewhere
 * on the platform.
 */

export type Actor = { organizationId: string; userId: string };

export type JoinResult =
  | { ok: true; classId: string; className: string; alreadyIn: boolean }
  | { ok: false; message: string };

export async function joinClassByCode(
  actor: Actor,
  rawCode: string,
): Promise<JoinResult> {
  // Read aloud in a classroom and typed on a phone: case and stray spaces are
  // the student's environment, not their mistake.
  const code = rawCode.trim().toUpperCase().replace(/\s+/g, "");
  if (code.length < 4 || code.length > 12) {
    return { ok: false, message: "That does not look like a class code." };
  }

  const outcome = await withTenant<JoinResult>(actor.organizationId, async (tx) => {
    const klass = await tx.class.findFirst({
      where: { joinCode: code, deletedAt: null },
      select: { id: true, name: true, status: true },
    });

    if (!klass) {
      return { ok: false, message: "No class here uses that code." };
    }
    if (klass.status !== "ACTIVE") {
      return {
        ok: false,
        message: "That class has been archived, so it is not taking new students.",
      };
    }

    const existing = await tx.classEnrolment.findFirst({
      where: { classId: klass.id, studentUserId: actor.userId },
    });

    if (existing) {
      if (existing.status === "ACTIVE") {
        // Not an error. A student who taps join twice, or who was already
        // added by their teacher, has done nothing wrong and should land in
        // the class either way.
        return { ok: true, classId: klass.id, className: klass.name, alreadyIn: true };
      }
      await tx.classEnrolment.updateMany({
        where: { id: existing.id },
        data: { status: "ACTIVE", leftAt: null },
      });
      return { ok: true, classId: klass.id, className: klass.name, alreadyIn: false };
    }

    await tx.classEnrolment.createMany({
      data: [
        {
          id: randomUUID(),
          organizationId: actor.organizationId,
          classId: klass.id,
          studentUserId: actor.userId,
          status: "ACTIVE",
        },
      ],
    });

    return { ok: true, classId: klass.id, className: klass.name, alreadyIn: false };
  });

  if (outcome.ok && !outcome.alreadyIn) {
    await writeAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: "STUDENT",
      action: "class.joined",
      entityType: "class",
      entityId: outcome.classId,
      after: { via: "join_code" },
    });
  }

  return outcome;
}

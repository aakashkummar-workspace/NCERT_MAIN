import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant } from "@/db/tenant";
import { consumeLoginCard } from "@/db/unscoped";
import { writeAudit } from "./audit";
import {
  formatCardCode,
  generateCardCode,
  hashCardCode,
  normaliseCardCode,
} from "./card-code";
import { createSessionToken } from "./session";
import type { Role } from "./authorize";

/**
 * Printed sign-in cards: a way in for a student with no phone.
 *
 * A mobile number used to be the only way a student signed in, and the
 * product said so on every roster: "they cannot sit a test until one is
 * added". That was true and it was a wall — a Class 9 student often has no
 * phone of their own, a family phone is not always in the house at 9am, and a
 * computer lab has thirty machines and no handsets at all. And sign-in codes
 * go nowhere until the SMS provider is registered, which is paperwork.
 *
 * So a teacher prints a card. It carries a QR code for a phone camera and the
 * same code in letters for a lab keyboard.
 *
 * ---------------------------------------------------------------------------
 * The rules
 * ---------------------------------------------------------------------------
 * - **The code is shown once.** Only its hash is stored; the printout is the
 *   only copy. Reprinting therefore means ISSUING, and issuing revokes the
 *   previous card — a student has at most one card that works, so a card left
 *   on a desk stops working the day its replacement is printed.
 * - **A card session is short.** Twelve hours, not a student's thirty days:
 *   cards exist for shared machines, and the next child to sit at a lab
 *   computer must not open the previous one's account tomorrow.
 * - **Removal is revocation.** The sign-in function refuses a suspended
 *   membership, so taking a student off the roster stops their card without
 *   anybody remembering to.
 * - **Cards are for students only.** A teacher's account can mark and publish;
 *   a bearer credential printed on paper is the wrong shape for that.
 */

export const CARD_SESSION_MS = 12 * 60 * 60 * 1000;

type Actor = { organizationId: string; userId: string; role: string };

export type CardStatus = {
  studentUserId: string;
  /** The last four characters of the working card, or null when there is none. */
  hint: string | null;
  issuedAt: Date | null;
  lastUsedAt: Date | null;
};

/** Which students in a class hold a working card. */
export async function cardStatusForClass(
  organizationId: string,
  classId: string,
): Promise<CardStatus[] | null> {
  return withTenant(organizationId, async (tx) => {
    const klass = await tx.class.findFirst({
      where: { id: classId, deletedAt: null },
      select: { id: true },
    });
    if (!klass) return null;

    const enrolments = await tx.classEnrolment.findMany({
      where: { classId, status: "ACTIVE" },
      select: { studentUserId: true },
    });
    const ids = enrolments.map((e) => e.studentUserId);
    const cards = await tx.loginCard.findMany({
      where: { studentUserId: { in: ids }, revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    const byStudent = new Map<string, (typeof cards)[number]>();
    for (const card of cards) {
      if (!byStudent.has(card.studentUserId)) byStudent.set(card.studentUserId, card);
    }

    return ids.map((id) => {
      const card = byStudent.get(id);
      return {
        studentUserId: id,
        hint: card?.hint ?? null,
        issuedAt: card?.createdAt ?? null,
        lastUsedAt: card?.lastUsedAt ?? null,
      };
    });
  });
}

/** The ids of students (from a list) who hold a working card. */
export async function studentsWithCards(
  organizationId: string,
  studentIds: string[],
): Promise<Set<string>> {
  if (studentIds.length === 0) return new Set();
  const rows = await withTenant(organizationId, (tx) =>
    tx.loginCard.findMany({
      where: { studentUserId: { in: studentIds }, revokedAt: null },
      select: { studentUserId: true },
    }),
  );
  return new Set(rows.map((row) => row.studentUserId));
}

export type IssuedCard = {
  studentUserId: string;
  fullName: string;
  rollNumber: string | null;
  /** Formatted for printing. Returned once, never stored. */
  code: string;
};

export type IssueResult =
  | { ok: true; className: string; cards: IssuedCard[] }
  | { ok: false; code: "NOT_FOUND" | "NOTHING_TO_ISSUE"; message: string };

/**
 * Issue cards for a class.
 *
 * `scope: "missing"` covers students with no working card — the safe default,
 * because it replaces nothing. `"all"` reprints the whole class and revokes
 * every card already out. `studentIds` narrows either to named students, which
 * is how a single lost card is replaced; a name that is not enrolled in this
 * class is ignored rather than trusted, since the list arrives in a request.
 */
export async function issueCards(
  actor: Actor,
  classId: string,
  options: { scope: "missing" | "all"; studentIds?: string[] },
): Promise<IssueResult> {
  const now = new Date();

  const result = await withTenant<IssueResult>(actor.organizationId, async (tx) => {
    const klass = await tx.class.findFirst({
      where: { id: classId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!klass) {
      return { ok: false, code: "NOT_FOUND", message: "We could not find that class." };
    }

    const enrolments = await tx.classEnrolment.findMany({
      where: { classId, status: "ACTIVE" },
      select: { studentUserId: true },
    });
    let ids = enrolments.map((e) => e.studentUserId);
    if (options.studentIds) {
      const wanted = new Set(options.studentIds);
      ids = ids.filter((id) => wanted.has(id));
    }

    const memberships = await tx.membership.findMany({
      where: { userId: { in: ids }, role: "STUDENT", status: "ACTIVE", leftAt: null },
      select: { id: true, userId: true },
    });
    const membershipOf = new Map(memberships.map((m) => [m.userId, m.id]));
    ids = ids.filter((id) => membershipOf.has(id));

    if (options.scope === "missing") {
      const holding = await tx.loginCard.findMany({
        where: { studentUserId: { in: ids }, revokedAt: null },
        select: { studentUserId: true },
      });
      const has = new Set(holding.map((row) => row.studentUserId));
      ids = ids.filter((id) => !has.has(id));
    }

    if (ids.length === 0) {
      return {
        ok: false,
        code: "NOTHING_TO_ISSUE",
        message:
          options.scope === "missing"
            ? "Every student in this class already has a card. To replace them, print new cards for the whole class."
            : "There is nobody in this class to print a card for.",
      };
    }

    const [users, profiles] = await Promise.all([
      tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } }),
      tx.studentProfile.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, rollNumber: true },
      }),
    ]);
    const nameOf = new Map(users.map((u) => [u.id, u.fullName]));
    const rollOf = new Map(profiles.map((p) => [p.userId, p.rollNumber]));

    // Revoke before issuing, in the same transaction: there is never a moment
    // with two working cards for one student.
    await tx.loginCard.updateMany({
      where: { studentUserId: { in: ids }, revokedAt: null },
      data: { revokedAt: now },
    });

    const issued: IssuedCard[] = [];
    const rows = ids.map((id) => {
      const code = generateCardCode();
      issued.push({
        studentUserId: id,
        fullName: nameOf.get(id) ?? "Student",
        rollNumber: rollOf.get(id) ?? null,
        code: formatCardCode(code),
      });
      return {
        id: randomUUID(),
        organizationId: actor.organizationId,
        studentUserId: id,
        membershipId: membershipOf.get(id)!,
        codeHash: new Uint8Array(hashCardCode(code)),
        hint: code.slice(-4),
        issuedById: actor.userId,
        createdAt: now,
      };
    });
    await tx.loginCard.createMany({ data: rows });

    issued.sort(
      (a, b) =>
        (a.rollNumber ?? "").localeCompare(b.rollNumber ?? "", undefined, { numeric: true }) ||
        a.fullName.localeCompare(b.fullName),
    );
    return { ok: true, className: klass.name, cards: issued };
  });

  if (result.ok) {
    // The audit row names who and how many — never a code.
    await writeAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "login_cards.issued",
      entityType: "class",
      entityId: classId,
      after: { scope: options.scope, count: result.cards.length },
    });
  }
  return result;
}

/** Stop a student's card working, without printing a new one. */
export async function revokeCard(
  actor: Actor,
  classId: string,
  studentUserId: string,
): Promise<boolean> {
  const count = await withTenant(actor.organizationId, async (tx) => {
    const enrolled = await tx.classEnrolment.findFirst({
      where: { classId, studentUserId, status: "ACTIVE" },
      select: { id: true },
    });
    if (!enrolled) return 0;
    const updated = await tx.loginCard.updateMany({
      where: { studentUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return updated.count;
  });
  if (count > 0) {
    await writeAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "login_cards.revoked",
      entityType: "user",
      entityId: studentUserId,
    });
  }
  return count > 0;
}

export type CardSignInResult =
  | { ok: true; token: string; expiresAt: Date; role: Role }
  | { ok: false; message: string };

/** One sentence for a mistyped, revoked and unknown card alike. */
export const CARD_REFUSED =
  "That card did not work. Check the letters, or ask your teacher — the card may have been replaced.";

export async function signInWithCard(
  rawCode: string,
  meta: { userAgent?: string; ip?: string } = {},
): Promise<CardSignInResult> {
  const code = normaliseCardCode(rawCode);
  if (!code) return { ok: false, message: CARD_REFUSED };

  const principal = await consumeLoginCard(hashCardCode(code));
  if (!principal || principal.role !== "STUDENT") {
    return { ok: false, message: CARD_REFUSED };
  }

  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + CARD_SESSION_MS);

  await withTenant(principal.organization_id, (tx) =>
    tx.session.create({
      data: {
        userId: principal.user_id,
        organizationId: principal.organization_id,
        membershipId: principal.membership_id,
        tokenHash: new Uint8Array(token.hash),
        userAgent: meta.userAgent ?? null,
        ip: meta.ip ?? null,
        expiresAt,
      },
    }),
  );

  await writeAudit({
    organizationId: principal.organization_id,
    actorUserId: principal.user_id,
    actorRole: "STUDENT",
    action: "auth.card_signin",
    entityType: "user",
    entityId: principal.user_id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return { ok: true, token: token.raw, expiresAt, role: "STUDENT" };
}

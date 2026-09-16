import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  acceptInvitation,
  cancelParentInvitation,
  inviteParent,
  linksForStudent,
  previewInvitation,
  revokeLink,
} from "@/core/parent/link";
import { childProgress, childView, linkedStudents } from "@/core/parent/read";
import {
  getPlayer,
  saveAnswers,
  startAttempt,
  submitAttempt,
  type AnswerPatch,
} from "@/core/attempts";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

/** A parent user, already existing, to link. */
async function makeParent(world: World, name = "A Parent") {
  const userId = randomUUID();
  await withTenant(world.organizationId, async (tx) => {
    await tx.user.createMany({
      data: [{ id: userId, fullName: `${name} ${userId.slice(0, 6)}`, status: "ACTIVE" }],
    });
    await tx.membership.createMany({
      data: [
        {
          id: randomUUID(),
          organizationId: world.organizationId,
          userId,
          role: "PARENT",
          status: "ACTIVE",
          joinedAt: new Date(),
        },
      ],
    });
  });
  return { organizationId: world.organizationId, userId };
}

/** Invite and accept in one go, returning the consented parent actor. */
async function linkParent(world: World, studentUserId = world.studentId) {
  const parent = await makeParent(world);
  const phone = `9${String(Date.now() + Math.floor(Math.random() * 9999)).slice(-9)}`;

  const invited = await inviteParent(teacherOf(world), {
    studentUserId,
    phone,
    relationship: "MOTHER",
  });
  if (!invited.ok) throw new Error(invited.message);

  const accepted = await acceptInvitation(invited.token, phone, parent.userId);
  if (!accepted.ok) throw new Error(accepted.message);

  return { parent, token: invited.token, phone };
}

async function sit(world: World, correct: boolean) {
  const actor = studentOf(world);
  const started = await startAttempt(actor, world.assignmentId, randomUUID());
  if (!started.ok) throw new Error(started.message);
  const player = await getPlayer(actor, started.attemptId);
  const patches: AnswerPatch[] = [];
  for (const [index, question] of player!.questions.entries()) {
    if (question.type === "MCQ") {
      patches.push({
        assessmentQuestionId: question.assessmentQuestionId,
        response: { kind: "choice", keys: [correct ? "A" : "B"] },
        clientSeq: index + 1,
      });
    } else if (question.type === "TRUE_FALSE") {
      patches.push({
        assessmentQuestionId: question.assessmentQuestionId,
        response: { kind: "boolean", value: !correct },
        clientSeq: index + 1,
      });
    }
  }
  await saveAnswers(actor, started.attemptId, patches);
  await submitAttempt(actor, started.attemptId);
}

describe("access is the link, never the role", () => {
  it("shows a parent with no links nothing at all", async () => {
    const world = await makeWorld();
    const parent = await makeParent(world);
    // A PARENT membership on its own grants nothing. This is the whole design.
    expect(await linkedStudents(parent)).toHaveLength(0);
    expect(await childView(parent, world.studentId)).toBeNull();
  });

  it("shows nothing for an invitation that has not been accepted", async () => {
    const world = await makeWorld();
    const parent = await makeParent(world);
    const invited = await inviteParent(teacherOf(world), {
      studentUserId: world.studentId,
      phone: `9${String(Date.now()).slice(-9)}`,
      relationship: "FATHER",
    });
    expect(invited.ok).toBe(true);

    // Which is what makes it safe to send the link to a number a teacher typed.
    expect(await linkedStudents(parent)).toHaveLength(0);

    // But the teacher must see it, or they cannot tell whether they already
    // invited somebody — and they send a second link.
    const links = await linksForStudent(world.organizationId, world.studentId);
    expect(links).toHaveLength(1);
    expect(links[0]!.status).toBe("INVITED");
    expect(links[0]!.consentGrantedAt).toBeNull();
    // Masked: a class list on a shared screen does not need a guardian's
    // number on it.
    expect(links[0]!.parentName).toMatch(/^••••••/);
  });

  it("shows the child once consent is recorded", async () => {
    const world = await makeWorld();
    const { parent } = await linkParent(world);

    const children = await linkedStudents(parent);
    expect(children).toHaveLength(1);
    expect(children[0]!.studentUserId).toBe(world.studentId);
    expect(children[0]!.relationship).toBe("MOTHER");
  });

  it("stamps consent to the parent who gave it, not the teacher who asked", async () => {
    const world = await makeWorld();
    const { parent } = await linkParent(world);

    const link = await withTenant(world.organizationId, (tx) =>
      tx.parentStudentLink.findFirstOrThrow({
        where: { parentUserId: parent.userId },
      }),
    );
    expect(link.consentGrantedAt).not.toBeNull();
    // The teacher asked; the parent holding the phone agreed. That distinction
    // is the whole of what "explicit recorded consent" means later.
    expect(link.consentGrantedBy).toBe(parent.userId);
    expect(link.consentGrantedBy).not.toBe(world.teacherId);
  });

  it("stops at revocation, and keeps the history", async () => {
    const world = await makeWorld();
    const { parent } = await linkParent(world);
    const links = await linksForStudent(world.organizationId, world.studentId);
    const link = links.find((row) => row.status === "ACTIVE")!;

    const revoked = await revokeLink(teacherOf(world), link.id!);
    expect(revoked.ok).toBe(true);

    expect(await linkedStudents(parent)).toHaveLength(0);
    expect(await childView(parent, world.studentId)).toBeNull();

    // A stamp, not a delete: who could see what, and until when, is exactly
    // what gets asked after something goes wrong.
    const row = await withTenant(world.organizationId, (tx) =>
      tx.parentStudentLink.findFirstOrThrow({ where: { id: link.id! } }),
    );
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedBy).toBe(world.teacherId);
  });

  it("refuses a scope that does not include performance", async () => {
    const world = await makeWorld();
    const { parent } = await linkParent(world);

    // The column is consulted, not assumed. A scope nothing reads is a promise
    // in a comment.
    await withTenant(world.organizationId, (tx) =>
      tx.parentStudentLink.updateMany({
        where: { parentUserId: parent.userId },
        data: { scope: {} },
      }),
    );
    expect(await childView(parent, world.studentId)).toBeNull();
    expect(await childProgress(parent, world.studentId)).toBeNull();
  });
});

describe("a parent never reaches another child", () => {
  it("refuses a student they are not linked to", async () => {
    const world = await makeWorld();
    const { parent } = await linkParent(world, world.studentId);

    // Same class, same organisation, and still nothing — the id in the request
    // is a claim, and the link is what turns one into permission.
    expect(await childView(parent, world.otherStudentId)).toBeNull();
    expect(await childProgress(parent, world.otherStudentId)).toBeNull();
  });

  it("refuses a student in another organisation", async () => {
    const world = await makeWorld();
    const { parent } = await linkParent(world);
    const other = await makeWorld();

    expect(await childView(parent, other.studentId)).toBeNull();
  });

  it("lists only their own children when they have two", async () => {
    const world = await makeWorld();
    const { parent } = await linkParent(world, world.studentId);

    // A second child for the same parent.
    await withTenant(world.organizationId, (tx) =>
      tx.parentStudentLink.create({
        data: {
          organizationId: world.organizationId,
          parentUserId: parent.userId,
          studentUserId: world.otherStudentId,
          relationship: "MOTHER",
          consentGrantedAt: new Date(),
          consentGrantedBy: parent.userId,
        },
      }),
    );

    const children = await linkedStudents(parent);
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.studentUserId).sort()).toEqual(
      [world.studentId, world.otherStudentId].sort(),
    );
  });
});

describe("what a parent sees, and what they do not", () => {
  it("never returns a free-text answer, anywhere", async () => {
    const world = await makeWorld({ maxAttempts: 3, withWritten: true });
    const actor = studentOf(world);
    const started = await startAttempt(actor, world.assignmentId, randomUUID());
    if (!started.ok) throw new Error(started.message);
    const player = await getPlayer(actor, started.attemptId);
    await saveAnswers(
      actor,
      started.attemptId,
      player!.questions.map((question, index) => ({
        assessmentQuestionId: question.assessmentQuestionId,
        response:
          question.type === "SA"
            ? { kind: "text" as const, value: "MY SECRET WRITTEN ANSWER" }
            : { kind: "choice" as const, keys: ["A"] },
        clientSeq: index + 1,
      })),
    );
    await submitAttempt(actor, started.attemptId);

    const { parent } = await linkParent(world);
    const view = await childView(parent, world.studentId);

    // The one thing this whole module exists to prevent. Serialised whole and
    // searched, so a field added later cannot leak by being forgotten.
    expect(JSON.stringify(view)).not.toContain("MY SECRET WRITTEN ANSWER");
    const progress = await childProgress(parent, world.studentId);
    expect(JSON.stringify(progress)).not.toContain("MY SECRET WRITTEN ANSWER");
  });

  it("carries the concept names and the denominator", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    for (let pass = 0; pass < 3; pass++) await sit(world, false);

    const { parent } = await linkParent(world);
    const view = await childView(parent, world.studentId);

    expect(view!.fullName).toBeTruthy();
    expect(view!.measured).toBeGreaterThan(0);
    // Named, never a single overall score — an average across concepts moves
    // when the syllabus moves and invites comparison with another child.
    expect(JSON.stringify(view)).not.toMatch(/overallScore|totalScore/);
    expect(view!.attention.every((row) => row.conceptName.length > 0)).toBe(true);

    // A concept never appears under both headings. With one measured concept
    // it used to be listed as both the strongest and the weakest, carrying the
    // same "Needs help" badge in each.
    const attentionIds = new Set(view!.attention.map((row) => row.conceptId));
    expect(view!.strengths.some((row) => attentionIds.has(row.conceptId))).toBe(
      false,
    );
  });

  it("refuses to write a summary below the evidence threshold", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await sit(world, false);

    const { parent } = await linkParent(world);
    const view = await childView(parent, world.studentId);

    // A parent is the audience least equipped to discount a confident
    // paragraph and most likely to act on one.
    if (view!.measured < 3) expect(view!.summary).toBeNull();
  });

  it("hides a mark the teacher has not released", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await withTenant(world.organizationId, (tx) =>
      tx.assignment.update({
        where: { id: world.assignmentId },
        data: { resultsPolicy: "MANUAL", resultsReleasedAt: null },
      }),
    );
    await sit(world, true);

    const { parent } = await linkParent(world);
    const view = await childView(parent, world.studentId);

    expect(view!.sittings.length).toBeGreaterThan(0);
    // A parent seeing a mark before their child does turns a result into an
    // ambush. Same rule, same function, as the student's own page.
    expect(view!.sittings.every((s) => s.percentage === null)).toBe(true);
    expect(view!.sittings.every((s) => s.marks === null)).toBe(true);
    // The sitting itself is not hidden — "they sat it" is not the mark.
    expect(view!.sittings[0]!.title).toBeTruthy();
  });

  it("shows it once released", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await sit(world, true);

    const { parent } = await linkParent(world);
    const view = await childView(parent, world.studentId);
    // The world assigns IMMEDIATE.
    expect(view!.sittings.some((s) => s.percentage !== null)).toBe(true);
  });

  it("shows an unmarked written answer as marked so far, never as zero", async () => {
    const world = await makeWorld({ withWritten: true });
    const actor = studentOf(world);
    const started = await startAttempt(actor, world.assignmentId, randomUUID());
    if (!started.ok) throw new Error(started.message);
    const player = await getPlayer(actor, started.attemptId);
    const patches: AnswerPatch[] = player!.questions.map((question, index) => ({
      assessmentQuestionId: question.assessmentQuestionId,
      // Every objective answer wrong, so the decided marks really are zero —
      // the case where "0 / 6" would read as a final fail.
      response:
        question.type === "MCQ"
          ? { kind: "choice", keys: ["B"] }
          : question.type === "TRUE_FALSE"
            ? { kind: "boolean", value: true }
            : { kind: "text", value: "The third angle follows, a sentence nobody has read." },
      clientSeq: index + 1,
    }));
    await saveAnswers(actor, started.attemptId, patches);
    await submitAttempt(actor, started.attemptId);

    const { parent } = await linkParent(world);
    const view = await childView(parent, world.studentId);
    const sitting = view!.sittings[0]!;

    expect(sitting.marks).not.toBeNull();
    // The three written marks are still with the teacher, and say so.
    expect(sitting.marks!.awaitingMarking).toBe(3);
    expect(sitting.fullyMarked).toBe(false);
    // A percentage over a half-marked paper is a wrong figure, not a smaller one.
    expect(sitting.percentage).toBeNull();
    // And the child's words still do not leave the module.
    expect(JSON.stringify(view)).not.toContain("nobody has read");
  });

  it("keeps the mastery refusal intact", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await sit(world, false);

    const { parent } = await linkParent(world);
    const view = await childView(parent, world.studentId);

    // A concept below the evidence bar reaches a parent as null, never as a
    // number and never as a zero.
    const insufficient = view!.strengths
      .concat(view!.attention)
      .filter((row) => row.band === "INSUFFICIENT");
    expect(insufficient.every((row) => row.estimate === null)).toBe(true);
  });
});

describe("the invitation", () => {
  it("previews only what identifies the link", async () => {
    const world = await makeWorld();
    const phone = `9${String(Date.now()).slice(-9)}`;
    const invited = await inviteParent(teacherOf(world), {
      studentUserId: world.studentId,
      phone,
      relationship: "GUARDIAN",
    });
    if (!invited.ok) throw new Error(invited.message);

    const preview = await previewInvitation(invited.token);
    if (!preview.ok) throw new Error(preview.message);

    expect(preview.studentName).toBeTruthy();
    expect(preview.organizationName).toBeTruthy();
    // Masked. Anyone holding the URL sees this, so it carries enough to
    // recognise and not enough to be a disclosure.
    expect(preview.phoneHint).not.toContain(phone);
    expect(preview.phoneHint).toContain(phone.slice(-4));
  });

  it("stores only the hash of the token", async () => {
    const world = await makeWorld();
    const invited = await inviteParent(teacherOf(world), {
      studentUserId: world.studentId,
      phone: `9${String(Date.now()).slice(-9)}`,
      relationship: "FATHER",
    });
    if (!invited.ok) throw new Error(invited.message);

    const row = await withTenant(world.organizationId, (tx) =>
      tx.invitation.findFirstOrThrow({ where: { id: invited.invitationId } }),
    );
    // A database leak must not be a set of working links to children's records.
    expect(Buffer.from(row.tokenHash).toString("utf8")).not.toContain(
      invited.token,
    );
  });

  it("refuses a token accepted from the wrong number", async () => {
    const world = await makeWorld();
    const parent = await makeParent(world);
    const invited = await inviteParent(teacherOf(world), {
      studentUserId: world.studentId,
      phone: `9${String(Date.now()).slice(-9)}`,
      relationship: "FATHER",
    });
    if (!invited.ok) throw new Error(invited.message);

    const wrong = await acceptInvitation(invited.token, "9000000000", parent.userId);
    expect(wrong.ok).toBe(false);
    // Same message as an expired link — saying "not the invited number" would
    // turn this into a way of testing which numbers belong to which children.
    if (!wrong.ok) expect(wrong.message).toMatch(/not valid any more/i);
  });

  it("refuses a student from another organisation", async () => {
    const world = await makeWorld();
    const other = await makeWorld();

    const invited = await inviteParent(teacherOf(world), {
      studentUserId: other.studentId,
      phone: `9${String(Date.now()).slice(-9)}`,
      relationship: "FATHER",
    });
    // Being able to name a user id is not the same as having them as a student.
    expect(invited.ok).toBe(false);
  });

  it("works once, and a second acceptance changes nothing", async () => {
    const world = await makeWorld();
    const parent = await makeParent(world);
    const phone = `9${String(Date.now()).slice(-9)}`;
    const invited = await inviteParent(teacherOf(world), {
      studentUserId: world.studentId,
      phone,
      relationship: "MOTHER",
    });
    if (!invited.ok) throw new Error(invited.message);

    const first = await acceptInvitation(invited.token, phone, parent.userId);
    expect(first.ok).toBe(true);
    const stamped = await withTenant(world.organizationId, (tx) =>
      tx.parentStudentLink.findFirstOrThrow({ where: { parentUserId: parent.userId } }),
    );

    const second = await acceptInvitation(invited.token, phone, parent.userId);
    // Single use. The parent who taps it again is already linked and signed in.
    expect(second.ok).toBe(false);
    expect((await previewInvitation(invited.token)).ok).toBe(false);
    expect(await linkedStudents(parent)).toHaveLength(1);

    // And the original consent stamp did not move.
    const after = await withTenant(world.organizationId, (tx) =>
      tx.parentStudentLink.findFirstOrThrow({ where: { id: stamped.id } }),
    );
    expect(after.consentGrantedAt!.getTime()).toBe(stamped.consentGrantedAt!.getTime());
  });
});

describe("revocation cannot be undone by the parent", () => {
  it("refuses the ORIGINAL link after access is revoked", async () => {
    // The attack: a revoked parent reopens the invitation they were first sent
    // and consents again. It used to work, and it erased the revocation stamp.
    const world = await makeWorld();
    const { parent, token, phone } = await linkParent(world);
    const link = (await linksForStudent(world.organizationId, world.studentId)).find(
      (row) => row.status === "ACTIVE",
    )!;
    expect((await revokeLink(teacherOf(world), link.id!)).ok).toBe(true);

    expect((await previewInvitation(token)).ok).toBe(false);
    const replay = await acceptInvitation(token, phone, parent.userId);
    expect(replay.ok).toBe(false);

    expect(await linkedStudents(parent)).toHaveLength(0);
    const row = await withTenant(world.organizationId, (tx) =>
      tx.parentStudentLink.findFirstOrThrow({ where: { id: link.id! } }),
    );
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedBy).toBe(world.teacherId);
  });

  it("cancels an unaccepted second invitation when access is revoked", async () => {
    const world = await makeWorld();
    const { parent, phone } = await linkParent(world);
    // A real parent account carries the number it verified; revocation finds
    // outstanding invitations through it. Unique per run — phone numbers are
    // globally unique and this database is never reset.
    await withTenant(world.organizationId, (tx) =>
      tx.user.update({ where: { id: parent.userId }, data: { phone } }),
    );
    // A second link sitting unopened in the parent's messages.
    const spare = await inviteParent(teacherOf(world), {
      studentUserId: world.studentId,
      phone,
      relationship: "MOTHER",
    });
    if (!spare.ok) throw new Error(spare.message);

    const link = (await linksForStudent(world.organizationId, world.studentId)).find(
      (row) => row.status === "ACTIVE",
    )!;
    await revokeLink(teacherOf(world), link.id!);

    expect((await acceptInvitation(spare.token, phone, parent.userId)).ok).toBe(false);
    expect(await linkedStudents(parent)).toHaveLength(0);
    const invitation = await withTenant(world.organizationId, (tx) =>
      tx.invitation.findFirstOrThrow({ where: { id: spare.invitationId } }),
    );
    expect(invitation.revokedAt).not.toBeNull();
  });

  it("restores access only through a NEW invitation, and keeps the revoked period", async () => {
    const world = await makeWorld();
    const { parent, phone } = await linkParent(world);
    const link = (await linksForStudent(world.organizationId, world.studentId)).find(
      (row) => row.status === "ACTIVE",
    )!;
    await revokeLink(teacherOf(world), link.id!);
    const revoked = await withTenant(world.organizationId, (tx) =>
      tx.parentStudentLink.findFirstOrThrow({ where: { id: link.id! } }),
    );

    // The school decides to restore it, and sends a fresh link.
    const again = await inviteParent(teacherOf(world), {
      studentUserId: world.studentId,
      phone,
      relationship: "MOTHER",
    });
    if (!again.ok) throw new Error(again.message);
    const accepted = await acceptInvitation(again.token, phone, parent.userId);
    expect(accepted.ok).toBe(true);
    expect(await linkedStudents(parent)).toHaveLength(1);

    // The previous period survives in the append-only log: who consented, when
    // it was revoked and by whom.
    const history = await withTenant(world.organizationId, (tx) =>
      tx.auditLog.findFirstOrThrow({
        where: { action: "parent.consent_regranted", entityId: link.id! },
      }),
    );
    const before = history.before as Record<string, string | null>;
    expect(before.revokedAt).toBe(revoked.revokedAt!.toISOString());
    expect(before.revokedBy).toBe(world.teacherId);
    expect(before.consentGrantedAt).toBe(revoked.consentGrantedAt!.toISOString());
  });

  it("lets a teacher cancel an invitation nobody has opened", async () => {
    const world = await makeWorld();
    const parent = await makeParent(world);
    const phone = `9${String(Date.now()).slice(-9)}`;
    const invited = await inviteParent(teacherOf(world), {
      studentUserId: world.studentId,
      phone,
      relationship: "FATHER",
    });
    if (!invited.ok) throw new Error(invited.message);

    const cancelled = await cancelParentInvitation(
      teacherOf(world),
      world.studentId,
      invited.invitationId,
    );
    expect(cancelled.ok).toBe(true);
    expect((await acceptInvitation(invited.token, phone, parent.userId)).ok).toBe(false);
    const links = await linksForStudent(world.organizationId, world.studentId);
    expect(links.some((row) => row.invitationId === invited.invitationId)).toBe(false);
  });

  it("answers a malformed id as not found, not as an error", async () => {
    const world = await makeWorld();
    expect((await revokeLink(teacherOf(world), "bad")).ok).toBe(false);
    expect(await linksForStudent(world.organizationId, "bad")).toEqual([]);
  });
});

describe("tenancy", () => {
  it("keeps links behind row-level security", async () => {
    const world = await makeWorld();
    await linkParent(world);
    const other = await makeWorld();

    const reachable = await withTenant(other.organizationId, (tx) =>
      tx.parentStudentLink.findMany({ where: { studentUserId: world.studentId } }),
    );
    expect(reachable).toHaveLength(0);
  });

  it("shows a teacher who can see their student", async () => {
    const world = await makeWorld();
    const { parent } = await linkParent(world);

    const links = await linksForStudent(world.organizationId, world.studentId);
    const active = links.find((row) => row.status === "ACTIVE")!;
    expect(active.parentUserId).toBe(parent.userId);
    expect(active.consentGrantedAt).not.toBeNull();
  });
});

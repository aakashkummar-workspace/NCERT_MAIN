import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  cancelInvite,
  changeRole,
  inviteStaff,
  listStaff,
  pendingStaffInvites,
  removeStaff,
} from "@/core/institute/members";
import {
  exceptions,
  instituteKpis,
  teacherActivity,
  MARKING_OVERDUE_DAYS,
} from "@/core/institute/kpis";
import { batches, conceptsAcrossBatches } from "@/core/institute/batches";
import {
  getPlayer,
  saveAnswers,
  startAttempt,
  submitAttempt,
  type AnswerPatch,
} from "@/core/attempts";
import { createClass } from "@/core/classes";
import { prisma } from "@/db/client";
import { platformPrisma } from "@/db/platform";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;

/** Another member of staff, so ownership rules have something to work on. */
async function addStaff(world: World, role: "OWNER" | "ADMIN" | "TEACHER") {
  const userId = randomUUID();
  const membershipId = randomUUID();
  await withTenant(world.organizationId, async (tx) => {
    await tx.user.createMany({
      data: [
        {
          id: userId,
          fullName: `Staff ${userId.slice(0, 6)}`,
          email: `staff.${userId.slice(0, 8)}@example.test`,
          status: "ACTIVE",
        },
      ],
    });
    await tx.membership.createMany({
      data: [
        {
          id: membershipId,
          organizationId: world.organizationId,
          userId,
          role,
          status: "ACTIVE",
          joinedAt: new Date(),
        },
      ],
    });
  });
  return { userId, membershipId };
}

async function sit(world: World) {
  const actor = studentOf(world);
  const started = await startAttempt(actor, world.assignmentId, randomUUID());
  if (!started.ok) throw new Error(started.message);
  const player = await getPlayer(actor, started.attemptId);
  const patches: AnswerPatch[] = [];
  for (const [index, question] of player!.questions.entries()) {
    if (question.type === "MCQ") {
      patches.push({
        assessmentQuestionId: question.assessmentQuestionId,
        response: { kind: "choice", keys: ["B"] },
        clientSeq: index + 1,
      });
    } else if (question.type === "TRUE_FALSE") {
      patches.push({
        assessmentQuestionId: question.assessmentQuestionId,
        response: { kind: "boolean", value: true },
        clientSeq: index + 1,
      });
    } else if (question.type === "SA") {
      patches.push({
        assessmentQuestionId: question.assessmentQuestionId,
        response: { kind: "text", value: "An answer awaiting a person." },
        clientSeq: index + 1,
      });
    }
  }
  await saveAnswers(actor, started.attemptId, patches);
  await submitAttempt(actor, started.attemptId);
  return started.attemptId;
}

describe("an organization always keeps one owner", () => {
  it("refuses to demote the only owner", async () => {
    const world = await makeWorld();
    const [owner] = await listStaff(world.organizationId);

    const result = await changeRole(
      { ...teacherOf(world), role: "OWNER" },
      owner!.membershipId,
      "TEACHER",
    );
    // Not because of the self-check — because there would be nobody left who
    // could undo it, and no route back except database access.
    expect(result.ok).toBe(false);
  });

  it("refuses to remove the only owner", async () => {
    const world = await makeWorld();
    const [owner] = await listStaff(world.organizationId);

    const result = await removeStaff(
      { ...teacherOf(world), role: "OWNER" },
      owner!.membershipId,
    );
    expect(result.ok).toBe(false);
  });

  it("allows it once there is a second owner", async () => {
    const world = await makeWorld();
    const second = await addStaff(world, "OWNER");
    const actor = { ...teacherOf(world), role: "OWNER" };

    const result = await changeRole(actor, second.membershipId, "TEACHER");
    expect(result.ok).toBe(true);

    const staff = await listStaff(world.organizationId);
    expect(staff.find((row) => row.userId === second.userId)!.role).toBe("TEACHER");
  });

  it("refuses to change your own role, even as an owner", async () => {
    const world = await makeWorld();
    await addStaff(world, "OWNER");
    const staff = await listStaff(world.organizationId);
    const self = staff.find((row) => row.userId === world.teacherId)!;

    const result = await changeRole(
      { ...teacherOf(world), role: "OWNER" },
      self.membershipId,
      "TEACHER",
    );
    // How somebody locks themselves out by accident. An owner stepping down
    // should be handing over to a named person, not demoting themselves.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/your own role/i);
  });

  it("refuses to remove yourself", async () => {
    const world = await makeWorld();
    await addStaff(world, "OWNER");
    const staff = await listStaff(world.organizationId);
    const self = staff.find((row) => row.userId === world.teacherId)!;

    const result = await removeStaff(
      { ...teacherOf(world), role: "OWNER" },
      self.membershipId,
    );
    expect(result.ok).toBe(false);
  });

  it("lets only an owner make another owner", async () => {
    const world = await makeWorld();
    const admin = await addStaff(world, "ADMIN");
    const target = await addStaff(world, "TEACHER");

    const byAdmin = await changeRole(
      { organizationId: world.organizationId, userId: admin.userId, role: "ADMIN" },
      target.membershipId,
      "OWNER",
    );
    // An admin who could promote to owner could promote themselves, which makes
    // the distinction between the two roles decorative.
    expect(byAdmin.ok).toBe(false);

    const byOwner = await changeRole(
      { ...teacherOf(world), role: "OWNER" },
      target.membershipId,
      "OWNER",
    );
    expect(byOwner.ok).toBe(true);
  });
});

describe("removing somebody keeps their work", () => {
  it("suspends rather than deletes, and signs them out", async () => {
    const world = await makeWorld();
    const teacher = await addStaff(world, "TEACHER");

    await withTenant(world.organizationId, (tx) =>
      tx.session.create({
        data: {
          userId: teacher.userId,
          organizationId: world.organizationId,
          membershipId: teacher.membershipId,
          tokenHash: new Uint8Array(Buffer.alloc(32, 7)),
          expiresAt: new Date(Date.now() + DAY),
        },
      }),
    );

    const result = await removeStaff(
      { ...teacherOf(world), role: "OWNER" },
      teacher.membershipId,
    );
    expect(result.ok).toBe(true);

    const membership = await withTenant(world.organizationId, (tx) =>
      tx.membership.findFirstOrThrow({ where: { id: teacher.membershipId } }),
    );
    // The row survives: their papers and their marking point at them, and "who
    // marked this" is asked a year later.
    expect(membership.status).toBe("SUSPENDED");

    const sessions = await withTenant(world.organizationId, (tx) =>
      tx.session.count({ where: { userId: teacher.userId } }),
    );
    // Removed and still signed in until the cookie expires is not removed.
    expect(sessions).toBe(0);
  });

  it("still lists them, marked as gone", async () => {
    const world = await makeWorld();
    const teacher = await addStaff(world, "TEACHER");
    await removeStaff({ ...teacherOf(world), role: "OWNER" }, teacher.membershipId);

    const staff = await listStaff(world.organizationId);
    const row = staff.find((entry) => entry.userId === teacher.userId);
    expect(row).toBeDefined();
    expect(row!.status).not.toBe("ACTIVE");
  });
});

describe("invitations", () => {
  it("stores only the hash of the token", async () => {
    const world = await makeWorld();
    const invited = await inviteStaff(
      { ...teacherOf(world), role: "OWNER" },
      { email: `new.${randomUUID().slice(0, 8)}@example.test`, role: "TEACHER" },
    );
    if (!invited.ok) throw new Error(invited.message);

    const row = await withTenant(world.organizationId, (tx) =>
      tx.invitation.findFirstOrThrow({ where: { id: invited.invitationId } }),
    );
    expect(Buffer.from(row.tokenHash).toString("utf8")).not.toContain(invited.token);
  });

  it("refuses a second live invitation to the same address", async () => {
    const world = await makeWorld();
    const email = `dup.${randomUUID().slice(0, 8)}@example.test`;
    const actor = { ...teacherOf(world), role: "OWNER" };

    expect((await inviteStaff(actor, { email, role: "TEACHER" })).ok).toBe(true);
    const second = await inviteStaff(actor, { email, role: "ADMIN" });
    // Two live invitations to one address is two links, and whichever is used
    // decides the role — which nobody chose.
    expect(second.ok).toBe(false);
  });

  it("lets an owner cancel one, and stops showing it", async () => {
    const world = await makeWorld();
    const actor = { ...teacherOf(world), role: "OWNER" };
    const invited = await inviteStaff(actor, {
      email: `cancel.${randomUUID().slice(0, 8)}@example.test`,
      role: "TEACHER",
    });
    if (!invited.ok) throw new Error(invited.message);

    expect(await pendingStaffInvites(world.organizationId)).toHaveLength(1);
    expect((await cancelInvite(actor, invited.invitationId)).ok).toBe(true);
    expect(await pendingStaffInvites(world.organizationId)).toHaveLength(0);
  });

  it("shows an expired invitation rather than hiding it", async () => {
    const world = await makeWorld();
    const invited = await inviteStaff(
      { ...teacherOf(world), role: "OWNER" },
      { email: `old.${randomUUID().slice(0, 8)}@example.test`, role: "TEACHER" },
    );
    if (!invited.ok) throw new Error(invited.message);

    await withTenant(world.organizationId, (tx) =>
      tx.invitation.update({
        where: { id: invited.invitationId },
        data: { expiresAt: new Date(Date.now() - DAY) },
      }),
    );

    const pending = await pendingStaffInvites(world.organizationId);
    // An owner who sent one a month ago and sees nothing assumes they never
    // sent it, and sends another.
    expect(pending).toHaveLength(1);
    expect(pending[0]!.expired).toBe(true);
  });

  it("refuses a teacher inviting an owner", async () => {
    const world = await makeWorld();
    const result = await inviteStaff(
      { ...teacherOf(world), role: "ADMIN" },
      { email: `x.${randomUUID().slice(0, 8)}@example.test`, role: "OWNER" },
    );
    expect(result.ok).toBe(false);
  });
});

describe("the dashboard surfaces exceptions", () => {
  it("counts distinct active students, not sittings", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await sit(world);
    await sit(world);
    await sit(world);

    const kpis = await instituteKpis(world.organizationId);
    // Six papers from one keen student is not six active students, and an
    // engagement figure that says otherwise gets quoted in a renewal meeting.
    expect(kpis.activeStudents).toBe(1);
    expect(kpis.attemptsSubmitted).toBe(3);
    expect(kpis.windowDays).toBe(30);
  });

  it("raises overdue marking, naming how long", async () => {
    const world = await makeWorld({ withWritten: true });
    const attemptId = await sit(world);

    // Age it past the threshold.
    await withTenant(world.organizationId, (tx) =>
      tx.attempt.update({
        where: { id: attemptId },
        data: {
          submittedAt: new Date(Date.now() - (MARKING_OVERDUE_DAYS + 5) * DAY),
        },
      }),
    );

    const found = await exceptions(world.organizationId);
    const marking = found.find((row) => row.kind === "marking-overdue");
    expect(marking).toBeDefined();
    // "Somebody has marking to do" is not actionable; a number of days is.
    expect(marking!.message).toMatch(/days/);
    expect(marking!.href).toContain("/marking");
  });

  it("does not raise marking that is merely recent", async () => {
    const world = await makeWorld({ withWritten: true });
    await sit(world);

    const found = await exceptions(world.organizationId);
    expect(found.some((row) => row.kind === "marking-overdue")).toBe(false);
  });

  it("raises students who cannot sign in", async () => {
    const world = await makeWorld();
    // The world's roster is created without phone numbers.
    const found = await exceptions(world.organizationId);
    const blocked = found.find((row) => row.kind === "students-cannot-sign-in");
    expect(blocked).toBeDefined();
    expect(blocked!.severity).toBe("high");
  });

  it("does not call a brand-new class quiet", async () => {
    const world = await makeWorld();
    const found = await exceptions(world.organizationId);
    // The class was created seconds ago. "Nothing set for 30 days" would be
    // false, and an owner who reads one false line stops believing the list.
    expect(found.some((row) => row.kind === "class-untested")).toBe(false);
  });

  it("does call an old class quiet", async () => {
    const world = await makeWorld();
    await withTenant(world.organizationId, (tx) =>
      tx.class.update({
        where: { id: world.classId },
        data: { createdAt: new Date(Date.now() - 90 * DAY) },
      }),
    );
    // Age the assignment too, or it counts as recent activity.
    await withTenant(world.organizationId, (tx) =>
      tx.assignment.update({
        where: { id: world.assignmentId },
        data: { createdAt: new Date(Date.now() - 90 * DAY) },
      }),
    );

    const found = await exceptions(world.organizationId);
    expect(found.some((row) => row.kind === "class-untested")).toBe(true);
  });

  it("puts the urgent ones first", async () => {
    const world = await makeWorld();
    const found = await exceptions(world.organizationId);
    const severities = found.map((row) => row.severity);
    // An owner reads the top of this list and stops.
    expect(severities).toEqual([...severities].sort());
  });
});

describe("teacher activity, never a league table", () => {
  it("reports what a teacher controls", async () => {
    const world = await makeWorld({ withWritten: true });
    await sit(world);

    const rows = await teacherActivity(world.organizationId);
    const owner = rows.find((row) => row.userId === world.teacherId);
    expect(owner).toBeDefined();
    expect(owner!.assessmentsCreated).toBeGreaterThan(0);
    expect(owner!.assignmentsSet).toBeGreaterThan(0);
    expect(owner!.unmarkedPapers).toBeGreaterThan(0);
  });

  it("returns no measure of their students' results", async () => {
    const world = await makeWorld();
    await sit(world);
    const rows = await teacherActivity(world.organizationId);

    // The considered refusal. A teacher handed the bottom set scores lower on
    // any absolute measure however well they teach, so a league table built on
    // it measures the timetable — and once teachers know they are ranked on
    // it, avoiding the students who need them most becomes the rational move.
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toMatch(/mastery|estimate|score|percentage|rank/i);
  });

  it("orders by who needs help, not alphabetically", async () => {
    const world = await makeWorld({ withWritten: true });
    await addStaff(world, "TEACHER");
    await sit(world);

    const rows = await teacherActivity(world.organizationId);
    expect(rows[0]!.unmarkedPapers).toBeGreaterThanOrEqual(
      rows[rows.length - 1]!.unmarkedPapers,
    );
  });
});

describe("batches carry their denominators", () => {
  it("refuses a mean below the measured threshold", async () => {
    const world = await makeWorld();
    await sit(world);

    const rows = await batches(world.organizationId);
    expect(rows).toHaveLength(1);
    // One measured student is not a class. Arithmetically correct, factually
    // false — the same bar the teacher's own analytics uses.
    expect(rows[0]!.meanEstimate).toBeNull();
    expect(rows[0]!.students).toBeGreaterThan(0);
  });

  it("always reports how many were measured", async () => {
    const world = await makeWorld();
    const rows = await batches(world.organizationId);
    for (const row of rows) {
      expect(row.measured).toBeLessThanOrEqual(row.students);
      expect(typeof row.measured).toBe("number");
    }
  });

  it("compares a concept across classes without inventing numbers", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    for (let pass = 0; pass < 3; pass++) await sit(world);

    const concepts = await conceptsAcrossBatches(world.organizationId);
    for (const concept of concepts) {
      for (const cell of concept.perClass) {
        // Below the bar the cell is null, not zero and not a guess.
        if (cell.measured < 3) expect(cell.meanEstimate).toBeNull();
      }
    }
  });

  it("counts a student enrolled in two classes in both of them", async () => {
    // The bug this pins: the student→class lookup was built with
    // `new Map(enrolments.map(...))`, which keeps only the LAST entry per key.
    // A student in 10-A and in the Maths set therefore reached exactly one of
    // the two grids, and the other room under-counted its own `measured` with
    // nothing looking wrong — a real mean over a denominator quietly missing
    // people, which is the precise failure MIN_MEASURED exists to prevent.
    //
    // They belong in both, because they are in both rooms: a teacher reading
    // either column is asking about the students actually in front of them.
    // The SEEDED concept already covers this outcome, so sitting produces
    // mastery without authoring anything.
    //
    // The first version of this test authored its own concept over
    // `world.outcomeId` instead, and that was a genuine mistake with a
    // permanent blast radius: concepts live on the curriculum plane, which
    // carries no organization_id, so the row is visible to every tenant
    // forever. Three runs left three concepts on the one outcome every world
    // uses, gap detection began finding four gaps where the suite expects one,
    // and eight unrelated intervention tests failed. It also broke the rule the
    // concept editor already enforces — only outcomes nothing else covers may
    // be linked, because the same answer counting towards two concepts splits
    // the evidence for both.
    //
    // A test may author curriculum, but only curriculum of its own.
    const world = await makeWorld({ maxAttempts: 3 });
    const suffix = randomUUID().slice(0, 6);

    for (let pass = 0; pass < 3; pass++) await sit(world);

    const subject = await platformPrisma.subject.findFirstOrThrow({
      where: { id: world.subjectId },
      select: { gradeId: true },
    });
    const second = await createClass(teacherOf(world), {
      name: `Maths set ${suffix}`,
      gradeId: subject.gradeId,
      subjectId: world.subjectId,
      academicYear: "2026-27",
    });

    await withTenant(world.organizationId, (tx) =>
      tx.classEnrolment.createMany({
        data: [
          {
            id: randomUUID(),
            organizationId: world.organizationId,
            classId: second.id,
            studentUserId: world.studentId,
            status: "ACTIVE",
          },
        ],
      }),
    );

    const concepts = await conceptsAcrossBatches(world.organizationId);

    // Whichever concept the sitting actually measured, found by EITHER class —
    // under the old Map the mastery landed in exactly one of the two, and which
    // one depended on enrolment order, so looking only in the original class
    // would fail here for the wrong reason. Asserted to exist, so an empty grid
    // fails the test rather than passing it vacuously.
    const row = concepts.find((c) =>
      c.perClass.some(
        (cell) =>
          (cell.classId === world.classId || cell.classId === second.id) &&
          cell.measured > 0,
      ),
    );
    expect(row).toBeDefined();

    const inOriginal = row!.perClass.find((cell) => cell.classId === world.classId);
    const inSecond = row!.perClass.find((cell) => cell.classId === second.id);

    // The pair that fails on the old Map: one of these two read zero, and
    // nothing on the page said so.
    expect(inOriginal?.measured).toBeGreaterThan(0);
    expect(inSecond?.measured).toBeGreaterThan(0);
  });
});

describe("tenancy", () => {
  it("shows another organisation nothing", async () => {
    const world = await makeWorld();
    await addStaff(world, "TEACHER");
    const other = await makeWorld();

    const staff = await listStaff(other.organizationId);
    expect(staff.every((row) => row.userId !== world.teacherId)).toBe(true);

    const rows = await batches(other.organizationId);
    expect(rows.every((row) => row.classId !== world.classId)).toBe(true);
  });

  it("cannot change a role in another organisation", async () => {
    const world = await makeWorld();
    const teacher = await addStaff(world, "TEACHER");
    const other = await makeWorld();

    const result = await changeRole(
      { ...teacherOf(other), role: "OWNER" },
      teacher.membershipId,
      "ADMIN",
    );
    expect(result.ok).toBe(false);
  });
});

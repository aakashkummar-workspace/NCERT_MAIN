import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { studentDashboard } from "@/core/student/dashboard";
import { markFeedbackSeen } from "@/core/student/feedback";
import { maskPhone } from "@/core/student/rules";
import { setOwnLocale } from "@/core/student/locale";
import { getPlayer, saveAnswers, startAttempt, submitAttempt, type AnswerPatch } from "@/core/attempts";
import { awardMarks } from "@/core/results/marking";
import { createAnnouncement } from "@/core/announcements";
import { saveQuestion } from "@/core/saved";
import { acceptInvitation, inviteParent } from "@/core/parent/link";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { hours, makeWorld, studentOf, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

const FEEDBACK = `Show the step where the third angle follows ${randomUUID().slice(0, 6)}`;

/** A number no other run has claimed. Phone uniqueness is global and never reset. */
function freshPhone(): string {
  return `9${String(Date.now()).slice(-5)}${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
}

/** The student sits the paper: both objective answers wrong, one written answer. */
async function sitBadly(world: World): Promise<{ attemptId: string; writtenAnswerId: string }> {
  const actor = studentOf(world);
  const started = await startAttempt(actor, world.assignmentId, randomUUID());
  if (!started.ok) throw new Error(started.message);
  const player = await getPlayer(actor, started.attemptId);
  const patches: AnswerPatch[] = player!.questions.map((question, index) => ({
    assessmentQuestionId: question.assessmentQuestionId,
    response:
      question.type === "MCQ"
        ? { kind: "choice", keys: ["B"] }
        : question.type === "TRUE_FALSE"
          ? { kind: "boolean", value: true }
          : { kind: "text", value: "Because the angles are equal." },
    clientSeq: index + 1,
  }));
  await saveAnswers(actor, started.attemptId, patches);
  await submitAttempt(actor, started.attemptId);

  const written = await withTenant(world.organizationId, (tx) =>
    tx.attemptAnswer.findFirstOrThrow({
      where: { attemptId: started.attemptId, awardedMarks: null },
      select: { id: true },
    }),
  );
  return { attemptId: started.attemptId, writtenAnswerId: written.id };
}

async function closeWindow(world: World) {
  await withTenant(world.organizationId, (tx) =>
    tx.assignment.update({
      where: { id: world.assignmentId },
      data: { opensAt: new Date(Date.now() - hours(48)), closesAt: new Date(Date.now() - 60_000) },
    }),
  );
}

/** A parent with a real number, invited and accepted for this student. */
async function linkMother(world: World, studentUserId: string) {
  const phone = freshPhone();
  const parentId = randomUUID();
  await withTenant(world.organizationId, async (tx) => {
    await tx.user.createMany({
      data: [{ id: parentId, fullName: `Mother ${parentId.slice(0, 6)}`, phone, status: "ACTIVE" }],
    });
    await tx.membership.createMany({
      data: [
        {
          id: randomUUID(),
          organizationId: world.organizationId,
          userId: parentId,
          role: "PARENT",
          status: "ACTIVE",
          joinedAt: new Date(),
        },
      ],
    });
  });
  const invited = await inviteParent(teacherOf(world), {
    studentUserId,
    phone,
    relationship: "MOTHER",
  });
  if (!invited.ok) throw new Error(invited.message);
  const accepted = await acceptInvitation(invited.token, phone, parentId);
  if (!accepted.ok) throw new Error(accepted.message);
  return { phone, parentId };
}

/** One finished practice set with one answer, and one mistake fixed — this week. */
async function someEffort(world: World) {
  await withTenant(world.organizationId, async (tx) => {
    const sessionId = randomUUID();
    await tx.practiceSession.create({
      data: {
        id: sessionId,
        organizationId: world.organizationId,
        studentUserId: world.studentId,
        source: "SELF_SELECTED",
        conceptIds: [],
        questionCount: 1,
        completedAt: new Date(),
        score: 1,
      },
    });
    await tx.practiceAnswer.create({
      data: {
        organizationId: world.organizationId,
        practiceSessionId: sessionId,
        questionId: world.questionIds[0]!,
        position: 1,
        isCorrect: true,
        answeredAt: new Date(),
      },
    });
    const mistake = await tx.studentMistake.findFirstOrThrow({
      where: { studentUserId: world.studentId },
    });
    await tx.studentMistake.update({
      where: { id: mistake.id },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
  });
}

describe("the student dashboard read model", () => {
  it("assembles every section for one student and none of it for a classmate", async () => {
    const world = await makeWorld({ withWritten: true });
    const { writtenAnswerId } = await sitBadly(world);
    const marked = await awardMarks(teacherOf(world), writtenAnswerId, 1, FEEDBACK);
    if (!marked.ok) throw new Error(marked.message);
    await closeWindow(world);

    const posted = await createAnnouncement(
      teacherOf(world),
      world.classId,
      `Bring your geometry box on Monday ${randomUUID().slice(0, 6)}`,
    );
    if (!posted.ok) throw new Error(posted.message);
    const saved = await saveQuestion({ ...studentOf(world), role: "STUDENT" }, world.questionIds[0]!);
    expect(saved.ok).toBe(true);
    const { phone } = await linkMother(world, world.studentId);
    await someEffort(world);

    const mine = await studentDashboard(world.organizationId, world.studentId);

    // Latest result: fully marked, so a final figure — 1 of 6 — and the three
    // questions short of full marks named as the ones to look at again.
    expect(mine.latestResult.ok).toBe(true);
    if (!mine.latestResult.ok || !mine.latestResult.data) throw new Error("no result");
    expect(mine.latestResult.data.marks).toEqual({ kind: "final", awarded: 1, total: 6 });
    expect(mine.latestResult.data.toReview).toBe(3);
    expect(mine.latestResult.data.reviewable).toBe(true);

    // Feedback: new, and readable because the review gate is open.
    if (!mine.feedback.ok || !mine.feedback.data) throw new Error("no feedback");
    expect(mine.feedback.data.snippet).toBe(FEEDBACK);

    if (!mine.plan.ok || !mine.plan.data.ok) throw new Error("no plan");
    expect(mine.plan.data.items.length).toBeLessThanOrEqual(3);
    expect(mine.plan.data.items.length).toBeGreaterThan(0);

    if (!mine.mistakes.ok || !mine.effort.ok) throw new Error("sections failed");
    expect(mine.mistakes.data.resolvedThisWeek).toBe(1);
    expect(mine.effort.data).toEqual({
      days: 7,
      setsFinished: 1,
      questionsAnswered: 1,
      mistakesFixed: 1,
    });

    if (!mine.announcements.ok || !mine.saved.ok || !mine.viewers.ok) {
      throw new Error("sections failed");
    }
    expect(mine.announcements.data.items).toHaveLength(1);
    expect(mine.announcements.data.truncated).toBe(false);
    expect(mine.saved.data.total).toBe(1);
    expect(mine.viewers.data).toEqual([
      expect.objectContaining({ relationship: "MOTHER", status: "ACTIVE", phoneHint: maskPhone(phone) }),
    ]);
    // Masked on the server: the number itself is nowhere in the payload.
    expect(JSON.stringify(mine)).not.toContain(phone);

    // The classmate in the same class sees the class announcement and nothing
    // that is the first student's.
    const theirs = await studentDashboard(world.organizationId, world.otherStudentId);
    expect(theirs.latestResult).toEqual({ ok: true, data: null });
    expect(theirs.feedback).toEqual({ ok: true, data: null });
    expect(theirs.saved.ok && theirs.saved.data.total).toBe(0);
    expect(theirs.viewers).toEqual({ ok: true, data: [] });
    expect(theirs.mistakes.ok && theirs.mistakes.data).toEqual({ open: 0, resolvedThisWeek: 0 });
    expect(theirs.effort.ok && theirs.effort.data.setsFinished).toBe(0);
    const serialised = JSON.stringify(theirs);
    expect(serialised).not.toContain(FEEDBACK);
    expect(serialised).not.toContain(phone);
  });

  it("stops calling feedback new once the result is opened, and starts again when the teacher writes more", async () => {
    const world = await makeWorld({ withWritten: true });
    const { attemptId, writtenAnswerId } = await sitBadly(world);
    await awardMarks(teacherOf(world), writtenAnswerId, 2, FEEDBACK);
    await closeWindow(world);

    const before = await studentDashboard(world.organizationId, world.studentId);
    expect(before.feedback.ok && before.feedback.data?.attemptId).toBe(attemptId);

    await markFeedbackSeen(world.organizationId, world.studentId, attemptId);
    const seen = await studentDashboard(world.organizationId, world.studentId);
    expect(seen.feedback).toEqual({ ok: true, data: null });

    // A classmate cannot stamp somebody else's sitting by id.
    await withTenant(world.organizationId, (tx) =>
      tx.attempt.update({ where: { id: attemptId }, data: { feedbackSeenAt: null } }),
    );
    await markFeedbackSeen(world.organizationId, world.otherStudentId, attemptId);
    const stillNew = await studentDashboard(world.organizationId, world.studentId);
    expect(stillNew.feedback.ok && stillNew.feedback.data?.attemptId).toBe(attemptId);

    await markFeedbackSeen(world.organizationId, world.studentId, attemptId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await awardMarks(teacherOf(world), writtenAnswerId, 3, `${FEEDBACK} — better now`);
    const again = await studentDashboard(world.organizationId, world.studentId);
    expect(again.feedback.ok && again.feedback.data?.snippet).toContain("better now");
  });

  it("withholds the comment itself while the answers are still closed", async () => {
    // The window is still open, so the score is visible under IMMEDIATE but
    // the review — and the teacher's words — are not.
    const world = await makeWorld({ withWritten: true });
    const { writtenAnswerId } = await sitBadly(world);
    await awardMarks(teacherOf(world), writtenAnswerId, 1, FEEDBACK);

    const dashboard = await studentDashboard(world.organizationId, world.studentId);
    if (!dashboard.feedback.ok || !dashboard.feedback.data) throw new Error("no notice");
    expect(dashboard.feedback.data.reviewable).toBe(false);
    expect(dashboard.feedback.data.snippet).toBeNull();
    expect(JSON.stringify(dashboard)).not.toContain(FEEDBACK);
  });

  it("never prints a zero for a paper nobody has marked", async () => {
    const world = await makeWorld({ withWritten: true });
    const actor = studentOf(world);
    const started = await startAttempt(actor, world.assignmentId, randomUUID());
    if (!started.ok) throw new Error(started.message);
    const player = await getPlayer(actor, started.attemptId);
    // Only the written answer: the objective ones are left blank.
    await saveAnswers(
      actor,
      started.attemptId,
      player!.questions
        .filter((question) => question.type === "SA")
        .map((question) => ({
          assessmentQuestionId: question.assessmentQuestionId,
          response: { kind: "text", value: "A written answer." },
          clientSeq: 1,
        })),
    );
    await submitAttempt(actor, started.attemptId);

    const dashboard = await studentDashboard(world.organizationId, world.studentId);
    if (!dashboard.latestResult.ok || !dashboard.latestResult.data) throw new Error("no result");
    expect(dashboard.latestResult.data.marks).toEqual({ kind: "unmarked", total: 6, pending: 3 });
  });
});

describe("setting my own language", () => {
  it("writes the signed-in user's row and refuses anything that is not a locale", async () => {
    const world = await makeWorld();
    expect(await setOwnLocale(studentOf(world), "hi-IN")).toEqual({ ok: true, locale: "hi-IN" });
    expect(await setOwnLocale(studentOf(world), "fr-FR")).toEqual({ ok: false });

    const [mine, theirs] = await withTenant(world.organizationId, (tx) =>
      Promise.all([
        tx.user.findFirstOrThrow({ where: { id: world.studentId }, select: { locale: true } }),
        tx.user.findFirstOrThrow({ where: { id: world.otherStudentId }, select: { locale: true } }),
      ]),
    );
    expect(mine.locale).toBe("hi-IN");
    expect(theirs.locale).toBe("en-IN");
  });
});

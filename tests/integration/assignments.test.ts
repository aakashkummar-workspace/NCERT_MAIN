import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUp } from "@/core/identity/accounts";
import { createClass } from "@/core/classes";
import { addStudents } from "@/core/roster/add";
import { parseRoster } from "@/core/roster/parse";
import { approveQuestion, createQuestion } from "@/core/questions";
import {
  createAssessment,
  publishAssessment,
  setQuestions,
} from "@/core/assessments";
import {
  cancelAssignment,
  createAssignment,
  getAssignment,
  listAssignments,
  updateAssignment,
} from "@/core/assignments";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { textToken } from "./support/text-token";

afterAll(async () => {
  await prisma.$disconnect();
});

type Ctx = {
  organizationId: string;
  userId: string;
  role: string;
  subjectId: string;
  gradeId: string;
  chapterId: string;
  outcomeId: string;
  classId: string;
  studentIds: string[];
};

const actorOf = (ctx: Ctx) => ({
  organizationId: ctx.organizationId,
  userId: ctx.userId,
  role: ctx.role,
});

const hours = (n: number) => n * 3600_000;

async function makeOrg(): Promise<Ctx> {
  const result = await signUp({
    fullName: "Teacher",
    email: `asg-${randomUUID()}@example.test`,
    password: "a-long-enough-password",
    organizationName: "Assignment Org",
    organizationType: "TUITION_CENTRE",
    boardCode: "CBSE",
  });
  if (!result.ok) throw new Error("signUp failed");

  const membership = await withTenant(result.organizationId, (tx) =>
    tx.membership.findFirstOrThrow({ where: { role: "OWNER" } }),
  );

  const outcome = await prisma.learningOutcome.findFirstOrThrow({
    where: { code: "SIM-2" },
    include: { topic: { include: { chapter: { include: { subject: true } } } } },
  });

  const ctx: Ctx = {
    organizationId: result.organizationId,
    userId: membership.userId,
    role: result.role,
    subjectId: outcome.topic.chapter.subjectId,
    gradeId: outcome.topic.chapter.subject.gradeId,
    chapterId: outcome.topic.chapterId,
    outcomeId: outcome.id,
    classId: "",
    studentIds: [],
  };

  const klass = await createClass(actorOf(ctx), {
    name: "Class 10-A",
    gradeId: ctx.gradeId,
    subjectId: ctx.subjectId,
    academicYear: "2026-27",
  });
  ctx.classId = klass.id;

  const roster = await addStudents(
    actorOf(ctx),
    klass.id,
    parseRoster(`Arun ${randomUUID().slice(0, 6)}\nMeera ${randomUUID().slice(0, 6)}`)
      .students,
  );
  ctx.studentIds = roster.outcomes.flatMap((o) =>
    o.status === "added" ? [o.userId] : [],
  );

  return ctx;
}

/** A published assessment, ready to assign. */
async function publishedAssessment(ctx: Ctx) {
  const question = await createQuestion(actorOf(ctx), {
    type: "MCQ",
    subjectId: ctx.subjectId,
    chapterId: ctx.chapterId,
    difficulty: "MEDIUM",
    marks: 1,
    stem: `A question for the paper ${textToken()}`,
    options: [
      { key: "A", text: "AA", isCorrect: true },
      { key: "B", text: "SSS", isCorrect: false },
    ],
    explanation: "Two equal angles force the third.",
    outcomeIds: [ctx.outcomeId],
  });
  if (!question.ok) throw new Error("question failed");
  await approveQuestion(actorOf(ctx), question.id);

  const created = await createAssessment(actorOf(ctx), {
    title: `Paper ${randomUUID().slice(0, 6)}`,
    subjectId: ctx.subjectId,
    gradeId: ctx.gradeId,
    durationMinutes: 45,
    totalMarks: 1,
  });
  if ("error" in created) throw new Error(created.error);

  await setQuestions(actorOf(ctx), created.id, [question.id]);
  const published = await publishAssessment(actorOf(ctx), created.id);
  if (!published.ok) throw new Error(JSON.stringify(published.problems));

  return created.id;
}

function futureWindow() {
  const opensAt = new Date(Date.now() + hours(1));
  const closesAt = new Date(Date.now() + hours(25));
  return { opensAt, closesAt };
}

let A: Ctx;
let B: Ctx;

beforeAll(async () => {
  A = await makeOrg();
  B = await makeOrg();
});

describe("creating an assignment", () => {
  it("assigns a published paper to a class", async () => {
    const assessmentId = await publishedAssessment(A);
    const result = await createAssignment(actorOf(A), {
      assessmentId,
      classId: A.classId,
      ...futureWindow(),
      maxAttempts: 1,
      resultsPolicy: "AFTER_CLOSE",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const assignment = await getAssignment(A.organizationId, result.id);
    expect(assignment?.status).toBe("SCHEDULED");
    expect(assignment?.wholeClass).toBe(true);
    expect(assignment?.students).toHaveLength(2);
  });

  it("refuses a DRAFT assessment", async () => {
    // A draft has no frozen question versions, so what a student saw could
    // never be reconstructed afterwards.
    const created = await createAssessment(actorOf(A), {
      title: "Still a draft",
      subjectId: A.subjectId,
      gradeId: A.gradeId,
      durationMinutes: 45,
      totalMarks: 1,
    });
    if ("error" in created) throw new Error(created.error);

    const result = await createAssignment(actorOf(A), {
      assessmentId: created.id,
      classId: A.classId,
      ...futureWindow(),
      maxAttempts: 1,
      resultsPolicy: "AFTER_CLOSE",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/published/);
  });

  it("refuses a class that does not study the subject", async () => {
    const assessmentId = await publishedAssessment(A);
    const otherSubject = await prisma.subject.findFirstOrThrow({
      where: { gradeId: A.gradeId, id: { not: A.subjectId } },
    });
    const otherClass = await createClass(actorOf(A), {
      name: "Different subject",
      gradeId: A.gradeId,
      subjectId: otherSubject.id,
      academicYear: "2026-27",
    });

    const result = await createAssignment(actorOf(A), {
      assessmentId,
      classId: otherClass.id,
      ...futureWindow(),
      maxAttempts: 1,
      resultsPolicy: "AFTER_CLOSE",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/does not study/);
  });

  it("refuses a window shorter than the paper", async () => {
    const assessmentId = await publishedAssessment(A);
    const opensAt = new Date(Date.now() + hours(1));
    const result = await createAssignment(actorOf(A), {
      assessmentId,
      classId: A.classId,
      opensAt,
      // The paper takes 45 minutes; this window is 30.
      closesAt: new Date(opensAt.getTime() + 30 * 60_000),
      maxAttempts: 1,
      resultsPolicy: "AFTER_CLOSE",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Nobody could finish it/);
  });

  it("refuses a window that has already closed", async () => {
    const assessmentId = await publishedAssessment(A);
    const result = await createAssignment(actorOf(A), {
      assessmentId,
      classId: A.classId,
      opensAt: new Date(Date.now() - hours(48)),
      closesAt: new Date(Date.now() - hours(24)),
      maxAttempts: 1,
      resultsPolicy: "AFTER_CLOSE",
    });
    expect(result.ok).toBe(false);
  });
});

describe("targeting a subset", () => {
  it("assigns to named students only", async () => {
    const assessmentId = await publishedAssessment(A);
    const result = await createAssignment(actorOf(A), {
      assessmentId,
      classId: A.classId,
      ...futureWindow(),
      maxAttempts: 1,
      resultsPolicy: "AFTER_CLOSE",
      studentUserIds: [A.studentIds[0]!],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const assignment = await getAssignment(A.organizationId, result.id);
    expect(assignment?.wholeClass).toBe(false);
    expect(assignment?.students).toHaveLength(1);
    expect(assignment?.students[0]?.userId).toBe(A.studentIds[0]);
  });

  it("refuses a student who is not in the class", async () => {
    const assessmentId = await publishedAssessment(A);
    const result = await createAssignment(actorOf(A), {
      assessmentId,
      classId: A.classId,
      ...futureWindow(),
      maxAttempts: 1,
      resultsPolicy: "AFTER_CLOSE",
      studentUserIds: [B.studentIds[0]!],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not in this class/);
  });

  it("an empty target list means the whole class, including later joiners", async () => {
    // The reason no rows means everyone: a student who joins tomorrow is
    // included without anyone having to remember to edit the assignment.
    const assessmentId = await publishedAssessment(A);
    const result = await createAssignment(actorOf(A), {
      assessmentId,
      classId: A.classId,
      ...futureWindow(),
      maxAttempts: 1,
      resultsPolicy: "AFTER_CLOSE",
      studentUserIds: [],
    });
    if (!result.ok) throw new Error(result.message);

    const before = await getAssignment(A.organizationId, result.id);
    expect(before?.students).toHaveLength(2);

    await addStudents(
      actorOf(A),
      A.classId,
      parseRoster(`Latecomer ${randomUUID().slice(0, 6)}`).students,
    );

    const after = await getAssignment(A.organizationId, result.id);
    expect(after?.students).toHaveLength(3);
  });
});

describe("the derived window", () => {
  it("reports OPEN without anything having written to the row", async () => {
    const assessmentId = await publishedAssessment(A);
    const result = await createAssignment(actorOf(A), {
      assessmentId,
      classId: A.classId,
      // Opens a minute ago, so it is already open on read.
      opensAt: new Date(Date.now() - 60_000),
      closesAt: new Date(Date.now() + hours(24)),
      maxAttempts: 1,
      resultsPolicy: "AFTER_CLOSE",
    });
    if (!result.ok) throw new Error(result.message);

    const assignment = await getAssignment(A.organizationId, result.id);
    expect(assignment?.status).toBe("OPEN");
  });

  it("cancelling overrides the clock", async () => {
    const assessmentId = await publishedAssessment(A);
    const result = await createAssignment(actorOf(A), {
      assessmentId,
      classId: A.classId,
      opensAt: new Date(Date.now() - 60_000),
      closesAt: new Date(Date.now() + hours(24)),
      maxAttempts: 1,
      resultsPolicy: "AFTER_CLOSE",
    });
    if (!result.ok) throw new Error(result.message);

    expect(await cancelAssignment(actorOf(A), result.id)).toBe(true);
    const assignment = await getAssignment(A.organizationId, result.id);
    expect(assignment?.status).toBe("CANCELLED");

    // Cancelling twice changes nothing and is not an error worth raising.
    expect(await cancelAssignment(actorOf(A), result.id)).toBe(false);
  });
});

describe("editing an assignment", () => {
  it("extends the window", async () => {
    const assessmentId = await publishedAssessment(A);
    const created = await createAssignment(actorOf(A), {
      assessmentId,
      classId: A.classId,
      ...futureWindow(),
      maxAttempts: 1,
      resultsPolicy: "AFTER_CLOSE",
    });
    if (!created.ok) throw new Error(created.message);

    const extended = new Date(Date.now() + hours(72));
    const result = await updateAssignment(actorOf(A), created.id, {
      closesAt: extended,
    });
    expect(result.ok).toBe(true);

    const assignment = await getAssignment(A.organizationId, created.id);
    expect(assignment?.closesAt.getTime()).toBe(extended.getTime());
  });

  it("refuses an edit that would make the window too short", async () => {
    const assessmentId = await publishedAssessment(A);
    const created = await createAssignment(actorOf(A), {
      assessmentId,
      classId: A.classId,
      ...futureWindow(),
      maxAttempts: 1,
      resultsPolicy: "AFTER_CLOSE",
    });
    if (!created.ok) throw new Error(created.message);

    const assignment = await getAssignment(A.organizationId, created.id);
    const result = await updateAssignment(actorOf(A), created.id, {
      closesAt: new Date(assignment!.opensAt.getTime() + 10 * 60_000),
    });
    expect(result.ok).toBe(false);
  });

  it("refuses to edit a cancelled assignment", async () => {
    const assessmentId = await publishedAssessment(A);
    const created = await createAssignment(actorOf(A), {
      assessmentId,
      classId: A.classId,
      ...futureWindow(),
      maxAttempts: 1,
      resultsPolicy: "AFTER_CLOSE",
    });
    if (!created.ok) throw new Error(created.message);

    await cancelAssignment(actorOf(A), created.id);
    const result = await updateAssignment(actorOf(A), created.id, {
      maxAttempts: 2,
    });
    expect(result.ok).toBe(false);
  });
});

describe("tenancy", () => {
  it("one organization does not see another's assignments", async () => {
    const assessmentId = await publishedAssessment(B);
    await createAssignment(actorOf(B), {
      assessmentId,
      classId: B.classId,
      ...futureWindow(),
      maxAttempts: 1,
      resultsPolicy: "AFTER_CLOSE",
    });

    const mine = await listAssignments(A.organizationId);
    const theirs = await listAssignments(B.organizationId);
    expect(mine.filter((m) => theirs.some((t) => t.id === m.id))).toEqual([]);
  });

  it("returns null for another organization's assignment by exact id", async () => {
    const assessmentId = await publishedAssessment(B);
    const created = await createAssignment(actorOf(B), {
      assessmentId,
      classId: B.classId,
      ...futureWindow(),
      maxAttempts: 1,
      resultsPolicy: "AFTER_CLOSE",
    });
    if (!created.ok) throw new Error(created.message);

    expect(await getAssignment(A.organizationId, created.id)).toBeNull();
    expect(await getAssignment(B.organizationId, created.id)).not.toBeNull();
  });

  it("cannot cancel another organization's assignment", async () => {
    const assessmentId = await publishedAssessment(B);
    const created = await createAssignment(actorOf(B), {
      assessmentId,
      classId: B.classId,
      ...futureWindow(),
      maxAttempts: 1,
      resultsPolicy: "AFTER_CLOSE",
    });
    if (!created.ok) throw new Error(created.message);

    expect(await cancelAssignment(actorOf(A), created.id)).toBe(false);
    expect((await getAssignment(B.organizationId, created.id))?.status).toBe(
      "SCHEDULED",
    );
  });

  it("cannot assign another organization's paper to its own class", async () => {
    const theirPaper = await publishedAssessment(B);
    const result = await createAssignment(actorOf(A), {
      assessmentId: theirPaper,
      classId: A.classId,
      ...futureWindow(),
      maxAttempts: 1,
      resultsPolicy: "AFTER_CLOSE",
    });
    expect(result.ok).toBe(false);
  });
});

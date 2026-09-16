import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { examReadiness, FIXTURE_CHAPTER_FLOOR } from "@/core/readiness";
import {
  getPlayer,
  saveAnswers,
  startAttempt,
  submitAttempt,
  type AnswerPatch,
} from "@/core/attempts";
import { signUp } from "@/core/identity/accounts";
import { createClass } from "@/core/classes";
import { addStudents } from "@/core/roster/add";
import { parseRoster } from "@/core/roster/parse";
import { prisma } from "@/db/client";
import { platformPrisma } from "@/db/platform";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, type World } from "./support/world";

/**
 * Readiness against a real database.
 *
 * The pure module is argued with in tests/unit/readiness.test.ts. What is
 * tested here is the half that needs a database to be true at all: that the
 * denominators come from the seeded curriculum rather than from what happens
 * to have been measured, that a chapter is called "tested" because a paper
 * carried a question from it, and that all of it is read for the acting
 * student alone.
 *
 * The seeded curriculum has concepts on one chapter of fourteen, so every
 * fixture here lands on a refusal. That is not a gap in the test — it is the
 * state the page is in for a real student for most of a year, and it is the
 * path most worth pinning.
 */

afterAll(async () => {
  await prisma.$disconnect();
});

/** Sit the world's two-question paper, right or wrong. */
async function sit(world: World, correct: boolean) {
  const actor = studentOf(world);
  const started = await startAttempt(actor, world.assignmentId, randomUUID());
  if (!started.ok) throw new Error(started.message);

  const player = await getPlayer(actor, started.attemptId);
  const patches: AnswerPatch[] = [];
  for (const [index, question] of (player?.questions ?? []).entries()) {
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

/** The seeded chapter count for the world's subject — never hard-coded. */
async function chaptersInSyllabus(world: World): Promise<number> {
  // Fixture chapters are not syllabus, and during a run they sit in real
  // subjects. Readiness leaves them out, so the count here must too.
  return prisma.chapter.count({
    where: { subjectId: world.subjectId, number: { lt: FIXTURE_CHAPTER_FLOOR } },
  });
}

describe("the denominator comes from the syllabus, not from what was measured", () => {
  it("counts every chapter in the subject, including the untested ones", async () => {
    const world = await makeWorld();
    const total = await chaptersInSyllabus(world);

    const readiness = await examReadiness(studentOf(world));

    expect(readiness.coverage.totalChapters).toBe(total);
    // The honest denominator is the whole point. Counting only what has been
    // measured is what makes two answered questions look like a syllabus.
    expect(total).toBeGreaterThan(1);
    expect(readiness.coverage.measuredChapters).toBe(0);
    expect(readiness.coverage.testedChapters).toBe(0);
    expect(readiness.untested).toHaveLength(total);

    // Concepts are authored by somebody who teaches the subject, and most
    // outcomes have none. Whatever that number is, it is the denominator —
    // and it must not be the count of rows this student happens to have.
    expect(readiness.coverage.totalConcepts).toBeGreaterThan(0);
    expect(readiness.coverage.measuredConcepts).toBe(0);
  });

  it("refuses, and says nothing has been measured rather than guessing", async () => {
    const world = await makeWorld();

    const readiness = await examReadiness(studentOf(world));

    expect(readiness.ok).toBe(false);
    if (readiness.ok) throw new Error("expected a refusal");
    expect(readiness.reason).toBe("nothing-measured");
    expect(readiness.message).toMatch(/once you have sat a test/i);
    // Structural, not remembered: there is no field on a refusal that could
    // print band counts beside a coverage figure this thin.
    expect("standing" in readiness).toBe(false);
  });

  it("has no syllabus for a student whose enrolment has ended", async () => {
    const world = await makeWorld();

    // Their classes are what tell us which subjects they are sitting. A class
    // they have left is not their syllabus — counting its chapters would move
    // the denominator for a reason nobody could explain.
    await withTenant(world.organizationId, (tx) =>
      tx.classEnrolment.updateMany({
        where: { studentUserId: world.studentId, classId: world.classId },
        data: { status: "LEFT", leftAt: new Date() },
      }),
    );

    const readiness = await examReadiness(studentOf(world));

    if (readiness.ok) throw new Error("expected a refusal");
    expect(readiness.reason).toBe("no-syllabus");
    expect(readiness.coverage.totalChapters).toBe(0);
    expect(readiness.message).toMatch(/join one with the code/i);
  });

  it("names the subject, and whose gap it is, when it has no chapters", async () => {
    // Three of the seeded Class 10 subjects have no chapters recorded at all,
    // and that is a designed state: chapters are public record entered by
    // somebody who has the syllabus, not invented. A student enrolled in one
    // must not be told to go and join a class.
    // AUTHORED here, not found. This used to look for a CBSE subject named
    // "English" with no chapters — true when it was written, false from the
    // day the NCERT question bank was imported with its English chapters. A
    // test that needs a scarce state of the shared curriculum must make it
    // (CLAUDE.md, "Tests that depend on the world staying unchanged"). Written
    // on the platform connection, because the app role has no insert grant on
    // the curriculum plane; scoped to CBSE because the organization below
    // teaches CBSE, and a class can only be created against its own board.
    const grade = await platformPrisma.grade.findFirstOrThrow({
      where: { number: 10, board: { code: "CBSE" } },
      select: { id: true },
    });
    // ONE fixture subject, reused by every run. It used to be a fresh one per
    // run, and a subject cannot be cleaned up once a class points at it — so
    // every run left another "Unwritten Subject" in every school's pickers.
    // Nothing authors chapters into it, so it stays chapterless.
    const subject = await platformPrisma.subject.upsert({
      where: { gradeId_code: { gradeId: grade.id, code: "ZZNOCHAPTERS" } },
      update: {},
      create: {
        gradeId: grade.id,
        code: "ZZNOCHAPTERS",
        name: "Test fixture – no chapters",
        shortName: "Test fixture",
      },
    });

    const signup = await signUp({
      fullName: "Teacher",
      email: `readiness-${randomUUID()}@example.test`,
      password: "a-long-enough-password",
      organizationName: "Readiness Org",
      organizationType: "TUITION_CENTRE",
      boardCode: "CBSE",
    });
    if (!signup.ok) throw new Error("signUp failed");
    const membership = await withTenant(signup.organizationId, (tx) =>
      tx.membership.findFirstOrThrow({ where: { role: "OWNER" } }),
    );
    const teacher = {
      organizationId: signup.organizationId,
      userId: membership.userId,
      role: signup.role,
    };

    const klass = await createClass(teacher, {
      name: "Class 10-E",
      gradeId: subject.gradeId,
      subjectId: subject.id,
      academicYear: "2026-27",
    });
    const roster = await addStudents(
      teacher,
      klass.id,
      parseRoster(`Nikhil ${randomUUID().slice(0, 6)}`).students,
    );
    const studentUserId = roster.outcomes.flatMap((row) =>
      row.status === "added" ? [row.userId] : [],
    )[0]!;

    const readiness = await examReadiness({
      organizationId: signup.organizationId,
      userId: studentUserId,
    });

    if (readiness.ok) throw new Error("expected a refusal");
    expect(readiness.reason).toBe("no-syllabus");
    expect(readiness.subjects).toEqual([subject.name]);
    expect(readiness.message).toContain(subject.name);
    expect(readiness.message).toMatch(/gap is ours, not yours/i);
  });
});

describe("tested is read from the paper, not from the evidence ledger", () => {
  it("moves a chapter off the untested list as soon as a paper covering it is sat", async () => {
    const world = await makeWorld();
    const total = await chaptersInSyllabus(world);

    await sit(world, true);
    const readiness = await examReadiness(studentOf(world));

    expect(readiness.coverage.testedChapters).toBe(1);
    expect(
      readiness.untested.some((chapter) => chapter.chapterId === world.chapterId),
    ).toBe(false);
    expect(readiness.untested).toHaveLength(total - 1);

    // Tested and measured are different questions, and the chapter is in the
    // third state: asked about, and not enough answers on any one idea in it
    // to stand behind a figure. Reading "tested" off the ledger instead would
    // have called this chapter untested — 64 of the 69 seeded outcomes have no
    // concept mapped to them, so a paper on one produces no evidence at all,
    // and a student who had just sat it would know the page was lying.
    expect(readiness.thin.map((chapter) => chapter.chapterId)).toEqual([
      world.chapterId,
    ]);
    expect(readiness.coverage.measuredChapters).toBe(0);

    if (readiness.ok) throw new Error("expected a refusal");
    expect(readiness.message).toMatch(/tested on 1 chapter of the/i);
    // Not "you have done nothing". They sat the paper; what is missing is
    // answers on the same idea, and the sentence has to say which.
    expect(readiness.message).toMatch(/not about you/i);
  });

  it("still refuses once ideas are measured, because one chapter is not a syllabus", async () => {
    const world = await makeWorld({ maxAttempts: 5 });
    const total = await chaptersInSyllabus(world);

    // Three sittings of a two-question paper clears the estimator's four-answer
    // floor on the concepts behind those questions.
    for (let pass = 0; pass < 3; pass++) await sit(world, true);

    const readiness = await examReadiness(studentOf(world));

    expect(readiness.coverage.measuredConcepts).toBeGreaterThan(0);
    expect(readiness.coverage.measuredChapters).toBe(1);
    expect(readiness.thin).toEqual([]);

    if (readiness.ok) throw new Error("expected a refusal");
    expect(readiness.reason).toBe("too-thin");
    // The sentence the whole feature is built around, with both numbers in it.
    expect(readiness.message).toContain(`1 of the ${total} chapters`);
    expect(readiness.message).toMatch(
      /not enough to tell you whether you are ready/i,
    );
  });
});

describe("what it reads, and what it will not say", () => {
  it("reads the acting student only, never the class", async () => {
    const world = await makeWorld();
    await sit(world, true);

    const sitter = await examReadiness(studentOf(world));
    const classmate = await examReadiness({
      organizationId: world.organizationId,
      userId: world.otherStudentId,
    });

    expect(sitter.coverage.testedChapters).toBe(1);
    // Same class, same syllabus, and nothing of the first student's sitting
    // in it. The actor comes from the session and there is no student id to
    // pass in — a readiness page that took one would be the first crack in
    // that.
    expect(classmate.coverage.testedChapters).toBe(0);
    expect(classmate.coverage.totalChapters).toBe(sitter.coverage.totalChapters);
  });

  it("returns no composite score, at any depth, in any state", async () => {
    const world = await makeWorld({ maxAttempts: 5 });
    for (let pass = 0; pass < 3; pass++) await sit(world, true);

    const readiness = await examReadiness(studentOf(world));

    // The number everybody asks for and the one that must not exist. It is
    // the same composite the students index, class analytics and a term
    // report all refuse — an average over concepts moves when the syllabus
    // moves, and this one would be read by an anxious fifteen-year-old.
    const banned =
      /^(score|percentage|percent|overall|readiness|rank|grade|average|mean)$/i;
    const keys: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          keys.push(key);
          walk(child);
        }
      }
    };
    walk(readiness);

    expect(keys.filter((key) => banned.test(key))).toEqual([]);
    // And nothing anywhere is a mastery figure the estimator refused: a null
    // estimate is absent from this payload rather than present as a zero.
    expect(JSON.stringify(readiness)).not.toContain('"estimate":null');
  });
});

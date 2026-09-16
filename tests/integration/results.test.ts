import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getPlayer, saveAnswers, startAttempt, submitAttempt } from "@/core/attempts";
import { studentResult } from "@/core/attempts/student-view";
import { getAssignment } from "@/core/assignments";
import {
  assignmentResults,
  itemAnalysis,
  releaseResults,
  MIN_TO_SUMMARISE,
} from "@/core/results";
import { awardMarks, markingQueue } from "@/core/results/marking";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

const otherStudentOf = (w: World) => ({
  organizationId: w.organizationId,
  userId: w.otherStudentId,
});

/** Sits the paper, answers what it is told to, and submits. */
async function sit(
  world: World,
  actor: { organizationId: string; userId: string },
  choose: (question: { type: string; assessmentQuestionId: string }) => unknown,
) {
  const started = await startAttempt(actor, world.assignmentId, randomUUID());
  if (!started.ok) throw new Error(started.message);

  const player = await getPlayer(actor, started.attemptId);
  const patches = player!.questions.flatMap((question, index) => {
    const response = choose(question);
    return response === undefined
      ? []
      : [
          {
            assessmentQuestionId: question.assessmentQuestionId,
            response: response as never,
            clientSeq: index + 1,
          },
        ];
  });
  if (patches.length > 0) await saveAnswers(actor, started.attemptId, patches);

  await submitAttempt(actor, started.attemptId);
  return started.attemptId;
}

describe("the class result", () => {
  it("counts everyone expected, not just everyone who sat it", async () => {
    const world = await makeWorld();
    await sit(world, studentOf(world), (q) =>
      q.type === "MCQ" ? { kind: "choice", keys: ["A"] } : undefined,
    );

    const results = await assignmentResults(world.organizationId, world.assignmentId);
    // Two students on the roster, one sitting. A denominator of one would make
    // a class that mostly ignored the test look like a class that aced it.
    expect(results?.expected).toBe(2);
    expect(results?.submitted).toBe(1);
    expect(results?.notStarted).toBe(1);
    expect(results?.rows).toHaveLength(2);
  });

  it("computes the mean over fully marked papers only, and says how many", async () => {
    const world = await makeWorld({ withWritten: true });

    // One paper is fully objective-answered and needs nobody.
    await sit(world, studentOf(world), (q) =>
      q.type === "MCQ"
        ? { kind: "choice", keys: ["A"] }
        : q.type === "TRUE_FALSE"
          ? { kind: "boolean", value: false }
          : undefined,
    );

    // The other wrote something, so three marks are waiting on a person.
    await sit(world, otherStudentOf(world), (q) =>
      q.type === "SA" ? { kind: "text", value: "Because the third angle follows." } : undefined,
    );

    const results = await assignmentResults(world.organizationId, world.assignmentId);

    expect(results?.submitted).toBe(2);
    expect(results?.awaitingMarking).toBe(1);
    // One paper counted, one excluded. An average over both would silently
    // score three unread marks as nought.
    expect(results?.counted).toBe(1);
    expect(results?.rows.filter((row) => row.fullyMarked)).toHaveLength(1);
  });

  it("refuses to describe a class from too few marked papers", async () => {
    // The same refusal the mastery scale makes below its evidence threshold.
    // A median over two papers is not a median, and four cards reading "0%"
    // because the marked papers happened to score nothing tells a teacher
    // their class failed when in truth nobody has marked the rest.
    const world = await makeWorld();
    for (const actor of [studentOf(world), otherStudentOf(world)]) {
      await sit(world, actor, (q) =>
        q.type === "MCQ" ? { kind: "choice", keys: ["A"] } : undefined,
      );
    }

    const results = await assignmentResults(world.organizationId, world.assignmentId);
    expect(results?.counted).toBe(2);
    expect(results!.counted).toBeLessThan(MIN_TO_SUMMARISE);
    expect(results?.enoughToSummarise).toBe(false);
    // Withheld in core/, so a number that must not be shown never reaches a
    // component in the first place.
    expect(results?.mean).toBeNull();
    expect(results?.median).toBeNull();
    expect(results?.highest).toBeNull();
    expect(results?.lowest).toBeNull();
  });

  it("reports no average at all rather than zero when nothing is marked", async () => {
    const world = await makeWorld({ withWritten: true });
    await sit(world, studentOf(world), (q) =>
      q.type === "SA" ? { kind: "text", value: "An answer." } : undefined,
    );

    const results = await assignmentResults(world.organizationId, world.assignmentId);
    // Null, not 0. A class mean of zero is a statement about the class; "no
    // marked papers" is a statement about the marking.
    expect(results?.mean).toBeNull();
    expect(results?.median).toBeNull();
    expect(results?.counted).toBe(0);
    expect(results?.enoughToSummarise).toBe(false);
  });

  it("shows a paper the clock closed as expired, not submitted", async () => {
    const world = await makeWorld();
    const attemptId = await sit(world, studentOf(world), () => undefined);
    await withTenant(world.organizationId, (tx) =>
      tx.attempt.updateMany({ where: { id: attemptId }, data: { submitReason: "SWEEP" } }),
    );

    const results = await assignmentResults(world.organizationId, world.assignmentId);
    const row = results?.rows.find((r) => r.attemptId === attemptId);
    expect(row?.status).toBe("EXPIRED");

    const assignment = await getAssignment(world.organizationId, world.assignmentId);
    expect(
      assignment?.students.find((s) => s.userId === world.studentId)?.attemptStatus,
    ).toBe("EXPIRED");
  });

  it("does not show another organisation's results", async () => {
    const world = await makeWorld();
    const other = await makeWorld();
    expect(await assignmentResults(other.organizationId, world.assignmentId)).toBeNull();
    expect(await itemAnalysis(other.organizationId, world.assignmentId)).toBeNull();
  });
});

describe("item analysis", () => {
  it("names the distractor more students chose than the key", async () => {
    const world = await makeWorld();
    // The MCQ's correct key is A. Both students pick B.
    for (const actor of [studentOf(world), otherStudentOf(world)]) {
      await sit(world, actor, (q) =>
        q.type === "MCQ" ? { kind: "choice", keys: ["B"] } : undefined,
      );
    }

    const analysis = await itemAnalysis(world.organizationId, world.assignmentId);
    const mcq = analysis?.items.find((item) => item.type === "MCQ");

    expect(mcq?.attempted).toBe(2);
    expect(mcq?.facility).toBe(0);
    // This is the line worth the page: not "they found it hard" but "they all
    // believe B", which names the misconception to teach against.
    expect(mcq?.topDistractor).toEqual({ key: "B", chosen: 2 });
    expect(mcq?.options?.find((o) => o.key === "B")?.chosen).toBe(2);
    expect(mcq?.options?.find((o) => o.key === "A")?.isCorrect).toBe(true);
  });

  it("does not flag a hard question on a handful of papers", async () => {
    const world = await makeWorld();
    await sit(world, studentOf(world), (q) =>
      q.type === "MCQ" ? { kind: "choice", keys: ["C"] } : undefined,
    );

    const analysis = await itemAnalysis(world.organizationId, world.assignmentId);
    const mcq = analysis?.items.find((item) => item.type === "MCQ");
    // Facility is 0, but on one paper. One student is not a finding.
    expect(mcq?.facility).toBe(0);
    expect(mcq?.needsAttention).toBe(false);
  });

  it("counts an unmarked written answer as pending, not as zero", async () => {
    const world = await makeWorld({ withWritten: true });
    await sit(world, studentOf(world), (q) =>
      q.type === "SA" ? { kind: "text", value: "An answer nobody has read." } : undefined,
    );

    const analysis = await itemAnalysis(world.organizationId, world.assignmentId);
    const written = analysis?.items.find((item) => item.type === "SA");
    expect(written?.pending).toBe(1);
    // No facility index at all, rather than a facility of zero — nobody has
    // marked it, so there is nothing to average.
    expect(written?.facility).toBeNull();
    expect(written?.averageMarks).toBeNull();
  });
});

describe("marking", () => {
  it("queues written answers by question and leaves objective ones alone", async () => {
    const world = await makeWorld({ withWritten: true });
    await sit(world, studentOf(world), (q) =>
      q.type === "SA"
        ? { kind: "text", value: "Equal angles force the third." }
        : q.type === "MCQ"
          ? { kind: "choice", keys: ["A"] }
          : undefined,
    );

    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    expect(queue?.groups).toHaveLength(1);
    expect(queue?.groups[0]?.type).toBe("SA");
    expect(queue?.totalUnmarked).toBe(1);
    expect(queue?.groups[0]?.answers[0]?.response).toBe("Equal angles force the third.");
  });

  it("does not queue a blank answer for a person to mark", async () => {
    const world = await makeWorld({ withWritten: true });
    await sit(world, studentOf(world), () => undefined);

    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    // Nothing was written, so there is nothing to read. Queueing it would ask
    // a teacher to award marks for a blank page.
    expect(queue?.totalUnmarked).toBe(0);
    expect(queue?.groups).toHaveLength(0);
  });

  it("awards marks and moves the student's total the same moment", async () => {
    const world = await makeWorld({ withWritten: true });
    const attemptId = await sit(world, studentOf(world), (q) =>
      q.type === "SA" ? { kind: "text", value: "A good answer." } : undefined,
    );

    const before = await studentResult(world.organizationId, world.studentId, attemptId);
    expect(before?.rawScore).toBe(0);
    expect(before?.pendingMarks).toBe(3);

    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    const answerId = queue!.groups[0]!.answers[0]!.answerId;

    const awarded = await awardMarks(teacherOf(world), answerId, 2, "Right idea, no reason given.");
    expect(awarded.ok).toBe(true);
    if (!awarded.ok) return;
    expect(awarded.rawScore).toBe(2);
    expect(awarded.pendingMarks).toBe(0);

    const after = await studentResult(world.organizationId, world.studentId, attemptId);
    expect(after?.rawScore).toBe(2);
    expect(after?.pendingMarks).toBe(0);
    expect(after?.provisional).toBe(false);
  });

  it("records partial credit as neither correct nor incorrect", async () => {
    const world = await makeWorld({ withWritten: true });
    await sit(world, studentOf(world), (q) =>
      q.type === "SA" ? { kind: "text", value: "Half an answer." } : undefined,
    );

    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    const answerId = queue!.groups[0]!.answers[0]!.answerId;
    await awardMarks(teacherOf(world), answerId, 2);

    const answer = await withTenant(world.organizationId, (tx) =>
      tx.attemptAnswer.findUniqueOrThrow({ where: { id: answerId } }),
    );
    // 2 out of 3 is not "wrong". Storing false would tell the analytics the
    // student did not know it.
    expect(answer.isCorrect).toBeNull();
    expect(answer.gradeSource).toBe("TEACHER");
  });

  it("refuses a mark outside the question's range rather than clamping it", async () => {
    const world = await makeWorld({ withWritten: true });
    await sit(world, studentOf(world), (q) =>
      q.type === "SA" ? { kind: "text", value: "An answer." } : undefined,
    );

    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    const answerId = queue!.groups[0]!.answers[0]!.answerId;

    const tooMany = await awardMarks(teacherOf(world), answerId, 30);
    expect(tooMany.ok).toBe(false);
    if (tooMany.ok) return;
    expect(tooMany.message).toContain("between 0 and 3");

    const negative = await awardMarks(teacherOf(world), answerId, -1);
    expect(negative.ok).toBe(false);
  });

  it("lets a marker change their mind", async () => {
    const world = await makeWorld({ withWritten: true });
    const attemptId = await sit(world, studentOf(world), (q) =>
      q.type === "SA" ? { kind: "text", value: "An answer." } : undefined,
    );

    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    const answerId = queue!.groups[0]!.answers[0]!.answerId;

    await awardMarks(teacherOf(world), answerId, 1);
    const revised = await awardMarks(teacherOf(world), answerId, 3);
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    // The total follows, rather than accumulating both marks.
    expect(revised.rawScore).toBe(3);

    const result = await studentResult(world.organizationId, world.studentId, attemptId);
    expect(result?.rawScore).toBe(3);
  });

  it("cannot mark another organisation's answer", async () => {
    const world = await makeWorld({ withWritten: true });
    await sit(world, studentOf(world), (q) =>
      q.type === "SA" ? { kind: "text", value: "An answer." } : undefined,
    );
    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    const answerId = queue!.groups[0]!.answers[0]!.answerId;

    const other = await makeWorld();
    const stolen = await awardMarks(teacherOf(other), answerId, 3);
    expect(stolen.ok).toBe(false);
  });
});

describe("releasing results", () => {
  it("is idempotent and reports what is still unmarked", async () => {
    const world = await makeWorld({ withWritten: true });
    await withTenant(world.organizationId, (tx) =>
      tx.assignment.updateMany({
        where: { id: world.assignmentId },
        data: { resultsPolicy: "MANUAL" },
      }),
    );
    const attemptId = await sit(world, studentOf(world), (q) =>
      q.type === "SA" ? { kind: "text", value: "An answer." } : undefined,
    );

    const hidden = await studentResult(world.organizationId, world.studentId, attemptId);
    expect(hidden?.visible).toBe(false);

    const first = await releaseResults(teacherOf(world), world.assignmentId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.alreadyReleased).toBe(false);
    // Released with marking outstanding, and it says so: twenty students are
    // not held back by four unmarked papers.
    expect(first.pendingPapers).toBe(1);

    const again = await releaseResults(teacherOf(world), world.assignmentId);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.alreadyReleased).toBe(true);
    expect(again.releasedAt.getTime()).toBe(first.releasedAt.getTime());

    const shown = await studentResult(world.organizationId, world.studentId, attemptId);
    expect(shown?.visible).toBe(true);
  });

  it("refuses to release a cancelled assignment", async () => {
    const world = await makeWorld();
    await withTenant(world.organizationId, (tx) =>
      tx.assignment.updateMany({
        where: { id: world.assignmentId },
        data: { cancelledAt: new Date() },
      }),
    );

    const result = await releaseResults(teacherOf(world), world.assignmentId);
    expect(result.ok).toBe(false);
  });
});

describe("what a student may review", () => {
  it("withholds the answer key while the window is still open", async () => {
    // The policy is IMMEDIATE, so the score is theirs the moment they submit.
    // The key is not: a class sitting in two sessions would otherwise have the
    // first session holding the answers while the second is still writing.
    const world = await makeWorld();
    const attemptId = await sit(world, studentOf(world), (q) =>
      q.type === "MCQ" ? { kind: "choice", keys: ["A"] } : undefined,
    );

    const result = await studentResult(world.organizationId, world.studentId, attemptId);
    expect(result?.visible).toBe(true);
    expect(result?.reviewable).toBe(false);

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("isCorrect\":true,\"chosen");
    expect(result?.breakdown.every((row) => row.options === null)).toBe(true);
    expect(result?.breakdown.every((row) => row.explanation === null)).toBe(true);
    expect(result?.breakdown.every((row) => row.correctAnswer === null)).toBe(true);
  });

  it("shows the key, the explanation and the marker's comment once released", async () => {
    const world = await makeWorld({ withWritten: true });
    const attemptId = await sit(world, studentOf(world), (q) =>
      q.type === "MCQ"
        ? { kind: "choice", keys: ["B"] }
        : q.type === "SA"
          ? { kind: "text", value: "An answer." }
          : undefined,
    );

    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    await awardMarks(
      teacherOf(world),
      queue!.groups[0]!.answers[0]!.answerId,
      2,
      "Right idea, but you never said why.",
    );
    await releaseResults(teacherOf(world), world.assignmentId);

    const result = await studentResult(world.organizationId, world.studentId, attemptId);
    expect(result?.reviewable).toBe(true);

    const mcq = result?.breakdown.find((row) => row.type === "MCQ");
    expect(mcq?.options?.find((o) => o.isCorrect)?.key).toBe("A");
    expect(mcq?.explanation).toBeTruthy();

    const written = result?.breakdown.find((row) => row.type === "SA");
    expect(written?.awardedMarks).toBe(2);
    // The number without the sentence teaches nobody anything.
    expect(written?.feedback).toBe("Right idea, but you never said why.");
  });

  it("sends nothing at all while the policy withholds the result", async () => {
    const world = await makeWorld();
    await withTenant(world.organizationId, (tx) =>
      tx.assignment.updateMany({
        where: { id: world.assignmentId },
        data: { resultsPolicy: "MANUAL", resultsReleasedAt: null },
      }),
    );
    const attemptId = await sit(world, studentOf(world), (q) =>
      q.type === "MCQ" ? { kind: "choice", keys: ["A"] } : undefined,
    );

    const result = await studentResult(world.organizationId, world.studentId, attemptId);
    expect(result?.visible).toBe(false);
    expect(result?.reviewable).toBe(false);
    expect(result?.breakdown).toEqual([]);
  });
});

describe("the marking queue holds still", () => {
  it("returns answers in the same order every time", async () => {
    // Without an explicit order Postgres may return these differently on the
    // next read. A marker who saves a mark and watches the list reshuffle has
    // just lost their place, and "Answer 3" is now somebody else.
    const world = await makeWorld({ withWritten: true });
    for (const [index, actor] of [studentOf(world), otherStudentOf(world)].entries()) {
      await sit(world, actor, (q) =>
        q.type === "SA" ? { kind: "text", value: `Answer number ${index}` } : undefined,
      );
    }

    const first = await markingQueue(teacherOf(world), world.assignmentId);
    const answerId = first!.groups[0]!.answers[0]!.answerId;
    await awardMarks(teacherOf(world), answerId, 2);

    for (let pass = 0; pass < 3; pass++) {
      const again = await markingQueue(teacherOf(world), world.assignmentId);
      expect(again!.groups[0]!.answers.map((a) => a.answerId)).toEqual(
        first!.groups[0]!.answers.map((a) => a.answerId),
      );
    }
  });
});

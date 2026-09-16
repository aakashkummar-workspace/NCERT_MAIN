import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { updateQuestion } from "@/core/questions";
import {
  getPlayer,
  saveAnswers,
  startAttempt,
  submitAttempt,
  sweepExpiredAttempts,
} from "@/core/attempts";
import { sweepAllOrganizations } from "@/core/attempts/sweep";
import { resumeSequence } from "@/core/attempts/response";
import { studentAssignments, studentResult } from "@/core/attempts/student-view";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { hours, makeWorld, studentOf, teacherOf } from "./support/world";
import { textToken } from "./support/text-token";

afterAll(async () => {
  await prisma.$disconnect();
});


describe("starting an attempt", () => {
  it("creates one, with an answer row per question", async () => {
    const world = await makeWorld();
    const started = await startAttempt(
      studentOf(world),
      world.assignmentId,
      randomUUID(),
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const player = await getPlayer(studentOf(world), started.attemptId);
    expect(player?.questions).toHaveLength(2);
    expect(player?.status).toBe("IN_PROGRESS");
  });

  it("is idempotent on the client id — tapping Start twice makes one sitting", async () => {
    // A student on a flaky connection tapping Start twice must not end up with
    // two papers and half their answers in each.
    const world = await makeWorld();
    const clientId = randomUUID();

    const first = await startAttempt(studentOf(world), world.assignmentId, clientId);
    const second = await startAttempt(studentOf(world), world.assignmentId, clientId);

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.attemptId).toBe(first.attemptId);
      expect(second.resumed).toBe(true);
    }

    const count = await withTenant(world.organizationId, (tx) =>
      tx.attempt.count({ where: { assignmentId: world.assignmentId } }),
    );
    expect(count).toBe(1);
  });

  it("resumes an unfinished sitting even when the client lost its id", async () => {
    // A phone that cleared its storage mid-test must get the paper back, not
    // a second one.
    const world = await makeWorld();
    const first = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    const second = await startAttempt(studentOf(world), world.assignmentId, randomUUID());

    if (first.ok && second.ok) {
      expect(second.attemptId).toBe(first.attemptId);
      expect(second.resumed).toBe(true);
    }
  });

  it("refuses when the window is not open", async () => {
    const world = await makeWorld();
    await withTenant(world.organizationId, (tx) =>
      tx.assignment.updateMany({
        where: { id: world.assignmentId },
        data: { opensAt: new Date(Date.now() + hours(2)) },
      }),
    );

    const started = await startAttempt(
      studentOf(world),
      world.assignmentId,
      randomUUID(),
    );
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.code).toBe("CLOSED");
  });

  it("refuses a student who is not in the class", async () => {
    const world = await makeWorld();
    const other = await makeWorld();

    const started = await startAttempt(
      { organizationId: world.organizationId, userId: other.studentId },
      world.assignmentId,
      randomUUID(),
    );
    // 404-shaped: no reason to confirm the test exists to someone not sitting it.
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.code).toBe("NOT_FOUND");
  });

  it("enforces the attempt limit", async () => {
    const world = await makeWorld();
    const first = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!first.ok) throw new Error("start failed");
    await submitAttempt(studentOf(world), first.attemptId);

    const second = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("NO_ATTEMPTS_LEFT");
  });

  it("allows a second sitting when the assignment permits it", async () => {
    const world = await makeWorld({ maxAttempts: 2 });
    const first = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!first.ok) throw new Error("start failed");
    await submitAttempt(studentOf(world), first.attemptId);

    const second = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.attemptId).not.toBe(first.attemptId);
  });

  it("ends the sitting at the window close when that comes first", async () => {
    // Nobody is handed time they could not use.
    //
    // The window cannot be CREATED shorter than the paper — validateWindow
    // refuses that, correctly — so this is the case where a teacher shortens
    // an already-running window, or a student starts near the end of one.
    const world = await makeWorld();
    await withTenant(world.organizationId, (tx) =>
      tx.assignment.updateMany({
        where: { id: world.assignmentId },
        data: { closesAt: new Date(Date.now() + 10 * 60_000) },
      }),
    );

    const started = await startAttempt(
      studentOf(world),
      world.assignmentId,
      randomUUID(),
    );
    if (!started.ok) throw new Error("start failed");

    const player = await getPlayer(studentOf(world), started.attemptId);
    // The paper is 45 minutes; the window has 10 left.
    expect(player!.remainingMs).toBeLessThanOrEqual(10 * 60_000 + 2000);
  });
});

describe("the answer key never leaves during a sitting", () => {
  it("sends options without isCorrect", async () => {
    // The single most important assertion in this file. Not hidden in the UI,
    // not filtered in a component: absent from the payload.
    const world = await makeWorld();
    const started = await startAttempt(
      studentOf(world),
      world.assignmentId,
      randomUUID(),
    );
    if (!started.ok) throw new Error("start failed");

    const player = await getPlayer(studentOf(world), started.attemptId);
    const serialised = JSON.stringify(player);

    expect(serialised).not.toContain("isCorrect");
    expect(serialised).not.toContain("answerKey");
    expect(serialised).not.toContain("explanation");

    const mcq = player!.questions.find((q) => q.type === "MCQ");
    expect(mcq?.options).toHaveLength(3);
    for (const option of mcq!.options!) {
      expect(Object.keys(option).sort()).toEqual(["key", "text"]);
    }
  });

  it("does not let one student read another's paper", async () => {
    const world = await makeWorld();
    const started = await startAttempt(
      studentOf(world),
      world.assignmentId,
      randomUUID(),
    );
    if (!started.ok) throw new Error("start failed");

    const asOther = await getPlayer(
      { organizationId: world.organizationId, userId: world.otherStudentId },
      started.attemptId,
    );
    expect(asOther).toBeNull();
  });
});

describe("saving answers", () => {
  it("saves a batch and reads it back", async () => {
    const world = await makeWorld();
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");

    const player = await getPlayer(studentOf(world), started.attemptId);
    const first = player!.questions[0]!;

    const result = await saveAnswers(studentOf(world), started.attemptId, [
      {
        assessmentQuestionId: first.assessmentQuestionId,
        response: { kind: "choice", keys: ["A"] },
        clientSeq: 1,
      },
    ]);
    expect(result?.saved).toBe(1);

    const after = await getPlayer(studentOf(world), started.attemptId);
    expect(after!.questions[0]!.response).toEqual({ kind: "choice", keys: ["A"] });
  });

  it("ignores a stale batch that arrives after a newer one", async () => {
    // The reconnect case: a queued batch from before the drop must not
    // overwrite what the student has since answered.
    const world = await makeWorld();
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");

    const player = await getPlayer(studentOf(world), started.attemptId);
    const q = player!.questions[0]!.assessmentQuestionId;

    await saveAnswers(studentOf(world), started.attemptId, [
      { assessmentQuestionId: q, response: { kind: "choice", keys: ["A"] }, clientSeq: 5 },
    ]);

    const stale = await saveAnswers(studentOf(world), started.attemptId, [
      { assessmentQuestionId: q, response: { kind: "choice", keys: ["B"] }, clientSeq: 3 },
    ]);
    expect(stale?.ignored).toBe(1);
    expect(stale?.saved).toBe(0);

    const after = await getPlayer(studentOf(world), started.attemptId);
    expect(after!.questions[0]!.response).toEqual({ kind: "choice", keys: ["A"] });
  });

  it("accepts a flush after submission without erroring", async () => {
    // A client draining its offline queue after submitting should not be told
    // something it cannot act on.
    const world = await makeWorld();
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");

    const player = await getPlayer(studentOf(world), started.attemptId);
    await submitAttempt(studentOf(world), started.attemptId);

    const late = await saveAnswers(studentOf(world), started.attemptId, [
      {
        assessmentQuestionId: player!.questions[0]!.assessmentQuestionId,
        response: { kind: "choice", keys: ["B"] },
        clientSeq: 99,
      },
    ]);
    expect(late).not.toBeNull();
    expect(late?.saved).toBe(0);
  });

  it("marks for review without losing the answer", async () => {
    const world = await makeWorld();
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");

    const player = await getPlayer(studentOf(world), started.attemptId);
    const q = player!.questions[0]!.assessmentQuestionId;

    await saveAnswers(studentOf(world), started.attemptId, [
      {
        assessmentQuestionId: q,
        response: { kind: "choice", keys: ["A"] },
        markedForReview: true,
        clientSeq: 1,
      },
    ]);

    const after = await getPlayer(studentOf(world), started.attemptId);
    expect(after!.questions[0]!.markedForReview).toBe(true);
    expect(after!.questions[0]!.response).toEqual({ kind: "choice", keys: ["A"] });
  });

  it("lets a reloaded player change an answer it already saved", async () => {
    // The blocker. The player restarted its sequence at 1 on every load, and
    // the server keeps a save only when its sequence beats the stored one — so
    // after a refresh, every edit to an answered question was ignored while the
    // header said Saved.
    const world = await makeWorld();
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");
    const q = (await getPlayer(studentOf(world), started.attemptId))!.questions[0]!
      .assessmentQuestionId;

    // The first page load: three edits, sequences 1 to 3.
    for (const [seq, key] of [[1, "A"], [2, "B"], [3, "C"]] as const) {
      await saveAnswers(studentOf(world), started.attemptId, [
        { assessmentQuestionId: q, response: { kind: "choice", keys: [key] }, clientSeq: seq },
      ]);
    }

    // The reload, deriving its sequence exactly as the player does.
    const reloaded = await getPlayer(studentOf(world), started.attemptId);
    const seq = resumeSequence(reloaded!.questions);
    expect(seq).toBeGreaterThan(3);

    const edit = await saveAnswers(studentOf(world), started.attemptId, [
      { assessmentQuestionId: q, response: { kind: "choice", keys: ["D"] }, clientSeq: seq },
    ]);
    expect(edit?.saved).toBe(1);

    // And the ordering rule still holds the other way: a batch delayed from
    // before the reload cannot overwrite it.
    const delayed = await saveAnswers(studentOf(world), started.attemptId, [
      { assessmentQuestionId: q, response: { kind: "choice", keys: ["B"] }, clientSeq: 2 },
    ]);
    expect(delayed?.ignored).toBe(1);

    const after = await getPlayer(studentOf(world), started.attemptId);
    expect(after!.questions[0]!.response).toEqual({ kind: "choice", keys: ["D"] });
  });

  it("stores a cleared selection and a box of spaces as blank", async () => {
    // A blank objective question is settled, not pending. `{keys: []}` stored
    // as-is was read back as an answer awaiting marking.
    const world = await makeWorld();
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");
    const [first, second] = (await getPlayer(studentOf(world), started.attemptId))!.questions;

    await saveAnswers(studentOf(world), started.attemptId, [
      { assessmentQuestionId: first!.assessmentQuestionId, response: { kind: "choice", keys: [] }, clientSeq: 1 },
      { assessmentQuestionId: second!.assessmentQuestionId, response: { kind: "text", value: "   " }, clientSeq: 1 },
    ]);

    const rows = await withTenant(world.organizationId, (tx) =>
      tx.attemptAnswer.findMany({ where: { attemptId: started.attemptId } }),
    );
    expect(rows.every((row) => row.response === null)).toBe(true);

    await submitAttempt(studentOf(world), started.attemptId);
    const result = await studentResult(world.organizationId, world.studentId, started.attemptId);
    if (result?.visible) {
      expect(result.pendingMarks).toBe(0);
      expect(result.breakdown.every((row) => row.answered === false)).toBe(true);
    }
  });

  it("counts visits and time as totals, not once per save", async () => {
    // It went up by one per SAVE, so a long answer typed in one visit looked
    // like somebody who kept coming back — and the CARELESS rule reads it.
    const world = await makeWorld();
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");
    const q = (await getPlayer(studentOf(world), started.attemptId))!.questions[0]!
      .assessmentQuestionId;

    for (let seq = 1; seq <= 4; seq++) {
      await saveAnswers(studentOf(world), started.attemptId, [
        {
          assessmentQuestionId: q,
          response: { kind: "choice", keys: ["A"] },
          timeSpentSeconds: seq * 10,
          visitCount: 1,
          clientSeq: seq,
        },
      ]);
    }

    const after = await getPlayer(studentOf(world), started.attemptId);
    expect(after!.questions[0]!.visitCount).toBe(1);
    expect(after!.questions[0]!.timeSpentSeconds).toBe(40);
  });
});

describe("submitting", () => {
  it("marks objective answers and returns a score", async () => {
    const world = await makeWorld();
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");

    const player = await getPlayer(studentOf(world), started.attemptId);
    const mcq = player!.questions.find((q) => q.type === "MCQ")!;
    const tf = player!.questions.find((q) => q.type === "TRUE_FALSE")!;

    await saveAnswers(studentOf(world), started.attemptId, [
      {
        assessmentQuestionId: mcq.assessmentQuestionId,
        response: { kind: "choice", keys: ["A"] },
        clientSeq: 1,
      },
      {
        assessmentQuestionId: tf.assessmentQuestionId,
        response: { kind: "boolean", value: false },
        clientSeq: 1,
      },
    ]);

    const result = await submitAttempt(studentOf(world), started.attemptId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.rawScore).toBe(3);
    expect(result.maxScore).toBe(3);
    expect(result.percentage).toBe(100);
    expect(result.provisional).toBe(false);
  });

  it("is idempotent — a retry returns the first result, not an error", async () => {
    // The client that retried did nothing wrong.
    const world = await makeWorld();
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");

    const first = await submitAttempt(studentOf(world), started.attemptId);
    const second = await submitAttempt(studentOf(world), started.attemptId);

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.alreadySubmitted).toBe(true);
      expect(second.rawScore).toBe(first.rawScore);
    }
  });

  it("a retry does not call a skipped question 'still being marked'", async () => {
    // A blank objective answer is SETTLED at zero — unscored, but not waiting
    // on a person. The re-submit branch used to ask only `awardedMarks === null`
    // and therefore counted it as outstanding, so a student who skipped one MCQ
    // and whose submit was retried — a double tap on flaky school wifi, the
    // exact case this path exists for — was promised marks that were never
    // coming. Every other reader in the product already carries both halves of
    // the test; this one did not.
    //
    // The first submit was always correct, so the two must agree. That is the
    // assertion: the retry cannot say something the original did not.
    const world = await makeWorld();
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");

    // Nothing answered at all, so every objective question is blank.
    const first = await submitAttempt(studentOf(world), started.attemptId);
    const second = await submitAttempt(studentOf(world), started.attemptId);
    if (!first.ok || !second.ok) throw new Error("submit failed");

    expect(second.alreadySubmitted).toBe(true);
    expect(first.provisional).toBe(false);
    expect(second.provisional).toBe(first.provisional);
  });

  it("scores an untouched question as pending, not as zero", async () => {
    const world = await makeWorld();
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");

    const result = await submitAttempt(studentOf(world), started.attemptId);
    if (!result.ok) throw new Error("submit failed");

    expect(result.rawScore).toBe(0);

    const answers = await withTenant(world.organizationId, (tx) =>
      tx.attemptAnswer.findMany({ where: { attemptId: started.attemptId } }),
    );
    // Null, not zero: they did not answer, which is different from answering
    // wrongly.
    for (const answer of answers) {
      expect(answer.awardedMarks).toBeNull();
      expect(answer.isCorrect).toBeNull();
    }
  });

  it("marks against the version served, not the current one", async () => {
    // The rule the whole freezing design exists for. Editing the question
    // after the sitting must not change what the answer was marked against.
    const world = await makeWorld();
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");

    const player = await getPlayer(studentOf(world), started.attemptId);
    const mcq = player!.questions.find((q) => q.type === "MCQ")!;

    await saveAnswers(studentOf(world), started.attemptId, [
      {
        assessmentQuestionId: mcq.assessmentQuestionId,
        response: { kind: "choice", keys: ["A"] },
        clientSeq: 1,
      },
    ]);

    // The teacher revises the question after the student answered, moving the
    // correct option to B. An approved question is immutable, so this creates
    // version 2 and leaves version 1 — the one the student sat — alone.
    const before = await withTenant(world.organizationId, (tx) =>
      tx.questionVersion.count({ where: { questionId: world.questionIds[0] } }),
    );

    const revised = await updateQuestion(teacherOf(world), world.questionIds[0]!, {
      type: "MCQ",
      subjectId: world.subjectId,
      chapterId: world.chapterId,
      difficulty: "MEDIUM",
      marks: 2,
      stem: `Reworded after the sitting ${textToken()}`,
      options: [
        { key: "A", text: "AA", isCorrect: false },
        { key: "B", text: "SSS", isCorrect: true },
        { key: "C", text: "SAS", isCorrect: false },
      ],
      explanation: "Changed on purpose.",
      outcomeIds: [world.outcomeId],
    });
    expect(revised.ok).toBe(true);

    const after = await withTenant(world.organizationId, (tx) =>
      tx.questionVersion.count({ where: { questionId: world.questionIds[0] } }),
    );
    expect(after).toBe(before + 1);

    const result = await submitAttempt(studentOf(world), started.attemptId);
    if (!result.ok) throw new Error("submit failed");
    // Still 2 out of 2 on the MCQ, because that is the version they sat.
    expect(result.rawScore).toBe(2);
  });

  it("respects the results policy", async () => {
    const world = await makeWorld();
    await withTenant(world.organizationId, (tx) =>
      tx.assignment.updateMany({
        where: { id: world.assignmentId },
        data: { resultsPolicy: "AFTER_CLOSE" },
      }),
    );

    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");

    const result = await submitAttempt(studentOf(world), started.attemptId);
    if (!result.ok) throw new Error("submit failed");
    // Scored, but the student does not see it until the window shuts — the
    // first finisher must not be able to tell the rest what came up.
    expect(result.showResult).toBe(false);
  });
});

describe("the sweep", () => {
  it("finishes an attempt whose clock ran out while the page was closed", async () => {
    // Without this a student who shuts their laptop leaves a row that is
    // IN_PROGRESS forever, and their work is never marked.
    const world = await makeWorld();
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");

    await withTenant(world.organizationId, (tx) =>
      tx.attempt.updateMany({
        where: { id: started.attemptId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      }),
    );

    const swept = await sweepExpiredAttempts(world.organizationId);
    expect(swept).toBeGreaterThanOrEqual(1);

    const attempt = await withTenant(world.organizationId, (tx) =>
      tx.attempt.findUniqueOrThrow({ where: { id: started.attemptId } }),
    );
    expect(attempt.status).toBe("SCORED");
    expect(attempt.submitReason).toBe("SWEEP");
  });

  it("leaves a live attempt alone", async () => {
    const world = await makeWorld();
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");

    await sweepExpiredAttempts(world.organizationId);

    const attempt = await withTenant(world.organizationId, (tx) =>
      tx.attempt.findUniqueOrThrow({ where: { id: started.attemptId } }),
    );
    expect(attempt.status).toBe("IN_PROGRESS");
  });
});

describe("the whole-platform sweep", () => {
  it("reaches every tenant with expired work, not just one", async () => {
    // The property under test is cross-tenant reach. RLS shows a query exactly
    // one organization, so a sweep written the obvious way silently finishes
    // the first customer's papers and abandons everybody else's — and the
    // single-tenant test above would still pass.
    const first = await makeWorld();
    const second = await makeWorld();

    const startedFirst = await startAttempt(studentOf(first), first.assignmentId, randomUUID());
    const startedSecond = await startAttempt(studentOf(second), second.assignmentId, randomUUID());
    if (!startedFirst.ok || !startedSecond.ok) throw new Error("start failed");

    for (const [world, started] of [
      [first, startedFirst],
      [second, startedSecond],
    ] as const) {
      await withTenant(world.organizationId, (tx) =>
        tx.attempt.updateMany({
          where: { id: started.attemptId },
          data: { expiresAt: new Date(Date.now() - 60_000) },
        }),
      );
    }

    const report = await sweepAllOrganizations();
    expect(report.organizations).toBeGreaterThanOrEqual(2);
    // Failures are asserted for THIS test's two organizations, not the whole
    // database. The sweep visits every tenant with expired work, and this
    // database is never reset: on 11 September a bulk SQL change moved 36,381
    // questions out of the organizations that authored them, leaving papers in
    // 32 old test tenants pointing at questions they can no longer see. Those
    // tenants now fail on every sweep, correctly — recording one tenant's bad
    // row and moving on is exactly what the sweep promises — and asserting
    // `failures` was empty made this test a statement about every other
    // tenant's data rather than about cross-tenant reach. Same class of
    // defect as a test hunting for a scarce shared row (CLAUDE.md).
    const ours = new Set([first.organizationId, second.organizationId]);
    expect(report.failures.filter((f) => ours.has(f.organizationId))).toEqual([]);

    for (const [world, started] of [
      [first, startedFirst],
      [second, startedSecond],
    ] as const) {
      const attempt = await withTenant(world.organizationId, (tx) =>
        tx.attempt.findUniqueOrThrow({ where: { id: started.attemptId } }),
      );
      expect(attempt.status).toBe("SCORED");
      expect(attempt.submitReason).toBe("SWEEP");
    }
  });

  it("is safe to run twice — the second pass finds nothing to do", async () => {
    const world = await makeWorld();
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");

    await withTenant(world.organizationId, (tx) =>
      tx.attempt.updateMany({
        where: { id: started.attemptId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      }),
    );

    await sweepAllOrganizations();
    const scoredAt = await withTenant(world.organizationId, (tx) =>
      tx.attempt.findUniqueOrThrow({ where: { id: started.attemptId } }),
    );

    await sweepAllOrganizations();
    const again = await withTenant(world.organizationId, (tx) =>
      tx.attempt.findUniqueOrThrow({ where: { id: started.attemptId } }),
    );

    // A second run must not re-mark, re-stamp or otherwise disturb a paper that
    // is already finished — cron retries, and so do humans.
    expect(again.scoredAt?.getTime()).toBe(scoredAt.scoredAt?.getTime());
    expect(again.rawScore?.toString()).toBe(scoredAt.rawScore?.toString());
  });
});

describe("the result a student is shown", () => {
  it("does not call a blank objective question 'waiting to be marked'", async () => {
    // Both answers left blank. Nothing here will ever be marked by a person,
    // so promising the student marks that are still coming is a lie — and one
    // they would go on believing until the teacher never marked anything.
    const world = await makeWorld();
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");

    await submitAttempt(studentOf(world), started.attemptId);

    const result = await studentResult(
      world.organizationId,
      world.studentId,
      started.attemptId,
    );
    expect(result?.pendingMarks).toBe(0);
    expect(result?.provisional).toBe(false);
    expect(result?.breakdown.every((row) => row.answered === false)).toBe(true);
    expect(result?.maxScore).toBe(3);
  });

  it("counts only the written answer as waiting on a person", async () => {
    const world = await makeWorld({ withWritten: true });
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");

    const player = await getPlayer(studentOf(world), started.attemptId);
    const written = player!.questions.find((q) => q.type === "SA")!;

    await saveAnswers(studentOf(world), started.attemptId, [
      {
        assessmentQuestionId: written.assessmentQuestionId,
        response: { kind: "text", value: "Because the third angle follows." },
        clientSeq: 1,
      },
    ]);
    await submitAttempt(studentOf(world), started.attemptId);

    const result = await studentResult(
      world.organizationId,
      world.studentId,
      started.attemptId,
    );

    // Three marks of written work are pending. The three objective marks were
    // left blank and are settled, not pending.
    expect(result?.pendingMarks).toBe(3);
    expect(result?.maxScore).toBe(6);
    expect(result?.provisional).toBe(true);

    const writtenRow = result?.breakdown.find((row) => row.marks === 3);
    expect(writtenRow?.answered).toBe(true);
    expect(writtenRow?.awardedMarks).toBeNull();
  });

  it("shows nothing at all when the policy has not released it", async () => {
    const world = await makeWorld();
    await withTenant(world.organizationId, (tx) =>
      tx.assignment.updateMany({
        where: { id: world.assignmentId },
        data: { resultsPolicy: "MANUAL", resultsReleasedAt: null },
      }),
    );

    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");
    await submitAttempt(studentOf(world), started.attemptId);

    const result = await studentResult(
      world.organizationId,
      world.studentId,
      started.attemptId,
    );
    // Not merely hidden in the UI — never sent. A score that must not be
    // displayed is a score that should not be transmitted.
    expect(result?.visible).toBe(false);
    expect(result?.breakdown).toEqual([]);
    expect(result?.maxScore).toBe(0);
  });

  it("lists the student's own assignments and nobody else's", async () => {
    const world = await makeWorld();

    const mine = await studentAssignments(world.organizationId, world.studentId);
    expect(mine.some((a) => a.assignmentId === world.assignmentId)).toBe(true);

    const other = await makeWorld();
    const theirs = await studentAssignments(other.organizationId, other.studentId);
    expect(theirs.some((a) => a.assignmentId === world.assignmentId)).toBe(false);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setProvider } from "@/ai/gateway";
import { MockProvider } from "@/ai/mock";
import type { AIContentPart } from "@/ai/provider";
import { startAttempt, submitAttempt } from "@/core/attempts";
import {
  addAnswerImage,
  draftMarks,
  readAnswerImage,
} from "@/core/marking-assist";
import { awardMarks, markingQueue } from "@/core/results/marking";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

let mock: MockProvider;
beforeEach(() => {
  mock = new MockProvider();
  setProvider(mock);
});
afterEach(() => {
  setProvider(null);
});

/** The first bytes of a JPEG: enough for the sniffer, and the model is mocked. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);

async function grantMarking(organizationId: string) {
  const plan = await prisma.plan.findFirstOrThrow({ where: { code: "teacher_pro" } });
  await withTenant(organizationId, async (tx) => {
    if (await tx.subscription.findFirst({ where: { planId: plan.id } })) return;
    await tx.subscription.createMany({
      data: [{ id: randomUUID(), organizationId, planId: plan.id, status: "ACTIVE" }],
    });
  });
}

/** A sitting in progress, and the id of its written answer. */
async function sitting(world: World) {
  const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
  if (!started.ok) throw new Error(started.message);
  const written = await withTenant(world.organizationId, async (tx) => {
    const answers = await tx.attemptAnswer.findMany({ where: { attemptId: started.attemptId } });
    const placements = await tx.assessmentQuestion.findMany({
      where: { id: { in: answers.map((a) => a.assessmentQuestionId) } },
      include: { question: { select: { type: true } } },
    });
    const sa = placements.find((p) => p.question.type === "SA")!;
    const mcq = placements.find((p) => p.question.type === "MCQ")!;
    return {
      writtenAnswer: answers.find((a) => a.assessmentQuestionId === sa.id)!,
      mcqPlacement: mcq.id,
      writtenPlacement: sa.id,
    };
  });
  return { attemptId: started.attemptId, ...written };
}

const draftValue = (total: number, extra: Record<string, unknown> = {}) => ({
  kind: "ok" as const,
  value: {
    readable: true,
    transcript: "AA similarity: two angles equal, so the third is equal too.",
    criteria: [],
    total,
    reason: "Correct reasoning; the final statement is missing.",
    feedback: "You showed why the third angle is equal. Finish by naming the similarity.",
    confidence: "medium",
    concerns: [],
    ...extra,
  },
});

describe("a photo of a written answer", () => {
  it("counts as the answer when nothing was typed, and reaches the marker", async () => {
    const world = await makeWorld({ withWritten: true });
    const { attemptId, writtenPlacement } = await sitting(world);

    const added = await addAnswerImage(
      { ...studentOf(world), role: "STUDENT" },
      { attemptId, assessmentQuestionId: writtenPlacement },
      JPEG,
    );
    expect(added.ok).toBe(true);

    const submitted = await submitAttempt(studentOf(world), attemptId);
    if (!submitted.ok) throw new Error("submit failed");
    // Waiting on a person — not settled as a blank.
    expect(submitted.provisional).toBe(true);

    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    const answer = queue!.groups.flatMap((g) => g.answers)[0]!;
    expect(answer.images).toHaveLength(1);
    expect(answer.response).toMatch(/photo/);
  });

  it("is refused on an objective question, and after the paper is handed in", async () => {
    const world = await makeWorld({ withWritten: true });
    const { attemptId, mcqPlacement, writtenPlacement } = await sitting(world);
    const student = { ...studentOf(world), role: "STUDENT" };

    const onMcq = await addAnswerImage(student, { attemptId, assessmentQuestionId: mcqPlacement }, JPEG);
    expect(onMcq.ok).toBe(false);

    await submitAttempt(studentOf(world), attemptId);
    const late = await addAnswerImage(student, { attemptId, assessmentQuestionId: writtenPlacement }, JPEG);
    expect(late.ok).toBe(false);
  });

  it("refuses bytes that are not a photo, whatever they claim to be", async () => {
    const world = await makeWorld({ withWritten: true });
    const { attemptId, writtenPlacement } = await sitting(world);
    const svg = new TextEncoder().encode("<svg onload='alert(1)'></svg>");
    const result = await addAnswerImage(
      { ...studentOf(world), role: "STUDENT" },
      { attemptId, assessmentQuestionId: writtenPlacement },
      svg,
    );
    expect(result.ok).toBe(false);
  });

  it("is seen by the teacher and its author, and by nobody else", async () => {
    const world = await makeWorld({ withWritten: true });
    const { attemptId, writtenPlacement } = await sitting(world);
    const added = await addAnswerImage(
      { ...studentOf(world), role: "STUDENT" },
      { attemptId, assessmentQuestionId: writtenPlacement },
      JPEG,
    );
    if (!added.ok) throw new Error(added.message);

    expect(await readAnswerImage(teacherOf(world), added.id)).not.toBeNull();
    expect(await readAnswerImage({ ...studentOf(world), role: "STUDENT" }, added.id)).not.toBeNull();
    expect(
      await readAnswerImage(
        { organizationId: world.organizationId, userId: world.otherStudentId, role: "STUDENT" },
        added.id,
      ),
    ).toBeNull();
    expect(
      await readAnswerImage(
        { organizationId: world.organizationId, userId: randomUUID(), role: "PARENT" },
        added.id,
      ),
    ).toBeNull();
  });
});

describe("a drafted mark", () => {
  async function marked() {
    const world = await makeWorld({ withWritten: true });
    const { attemptId, writtenAnswer } = await sitting(world);
    await withTenant(world.organizationId, (tx) =>
      tx.attemptAnswer.update({
        where: { id: writtenAnswer.id },
        data: { response: { kind: "text", value: "Two angles are equal so the third is equal." } },
      }),
    );
    await submitAttempt(studentOf(world), attemptId);
    return { world, answerId: writtenAnswer.id };
  }

  it("is not included on a plan without it, and costs nothing to be told so", async () => {
    const { world, answerId } = await marked();
    const result = await draftMarks(teacherOf(world), answerId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/plan/i);
    expect(mock.callCount).toBe(0);
  });

  it("is a suggestion: stored beside the answer, and no mark is written", async () => {
    const { world, answerId } = await marked();
    await grantMarking(world.organizationId);
    mock.script(draftValue(2));

    const result = await draftMarks(teacherOf(world), answerId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.total).toBe(2);

    const answer = await withTenant(world.organizationId, (tx) =>
      tx.attemptAnswer.findUniqueOrThrow({ where: { id: answerId } }),
    );
    expect(answer.awardedMarks).toBeNull();
    expect(answer.gradeSource).toBeNull();
  });

  it("is discarded, not clamped, when it breaks the scheme", async () => {
    const { world, answerId } = await marked();
    await grantMarking(world.organizationId);
    // Five marks on a three-mark question.
    mock.script(draftValue(5));

    const result = await draftMarks(teacherOf(world), answerId);
    expect(result.ok).toBe(false);
    const stored = await withTenant(world.organizationId, (tx) =>
      tx.markingDraft.count({ where: { attemptAnswerId: answerId } }),
    );
    expect(stored).toBe(0);
  });

  it("sends the answer and never the student's name", async () => {
    const { world, answerId } = await marked();
    await grantMarking(world.organizationId);
    mock.script(draftValue(2));
    await draftMarks(teacherOf(world), answerId);

    // Read inside the tenant: outside one, RLS shows no users at all.
    const student = await withTenant(world.organizationId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: world.studentId } }),
    );
    const sent = JSON.stringify(mock.received[0]);
    expect(sent).toContain("the third is equal");
    expect(sent).not.toContain(student.fullName);
  });

  it("sends the photo when there is one", async () => {
    const world = await makeWorld({ withWritten: true });
    await grantMarking(world.organizationId);
    const { attemptId, writtenPlacement, writtenAnswer } = await sitting(world);
    await addAnswerImage(
      { ...studentOf(world), role: "STUDENT" },
      { attemptId, assessmentQuestionId: writtenPlacement },
      JPEG,
    );
    await submitAttempt(studentOf(world), attemptId);
    mock.script(draftValue(1.5));

    const result = await draftMarks(teacherOf(world), writtenAnswer.id);
    expect(result.ok).toBe(true);
    const parts = mock.received[0]!.messages[0]!.content as AIContentPart[];
    expect(parts.some((part) => part.type === "image")).toBe(true);
  });

  it("becomes a mark only when the teacher saves it, stamped as assisted", async () => {
    const { world, answerId } = await marked();
    await grantMarking(world.organizationId);
    mock.script(draftValue(2));
    await draftMarks(teacherOf(world), answerId);

    const saved = await awardMarks(teacherOf(world), answerId, 2, null, { assisted: true });
    expect(saved.ok).toBe(true);
    const [answer, draft] = await withTenant(world.organizationId, (tx) =>
      Promise.all([
        tx.attemptAnswer.findUniqueOrThrow({ where: { id: answerId } }),
        tx.markingDraft.findUniqueOrThrow({ where: { attemptAnswerId: answerId } }),
      ]),
    );
    expect(answer.gradeSource).toBe("AI_ASSISTED");
    expect(Number(answer.awardedMarks)).toBe(2);
    expect(draft.acceptedAt).not.toBeNull();
  });
});

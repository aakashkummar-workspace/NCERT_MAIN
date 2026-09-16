import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUp } from "@/core/identity/accounts";
import {
  approveQuestion,
  archiveQuestion,
  bankSummary,
  contentHash,
  createQuestion,
  getQuestion,
  listQuestions,
  rejectQuestion,
  updateQuestion,
  type QuestionInput,
} from "@/core/questions";
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
  chapterId: string;
  outcomeId: string;
};

async function makeOrg(): Promise<Ctx> {
  const result = await signUp({
    fullName: "Author",
    email: `q-${randomUUID()}@example.test`,
    password: "a-long-enough-password",
    organizationName: "Question Org",
    organizationType: "TUITION_CENTRE",
    boardCode: "CBSE",
  });
  if (!result.ok) throw new Error("signUp failed");

  const membership = await withTenant(result.organizationId, (tx) =>
    tx.membership.findFirstOrThrow({ where: { role: "OWNER" } }),
  );

  // The worked example: a chapter that actually has outcomes to map to.
  const outcome = await prisma.learningOutcome.findFirstOrThrow({
    where: { code: "SIM-2" },
    include: { topic: { include: { chapter: true } } },
  });

  return {
    organizationId: result.organizationId,
    userId: membership.userId,
    role: result.role,
    subjectId: outcome.topic.chapter.subjectId,
    chapterId: outcome.topic.chapterId,
    outcomeId: outcome.id,
  };
}

let A: Ctx;
let B: Ctx;

beforeAll(async () => {
  A = await makeOrg();
  B = await makeOrg();
});

const draft = (ctx: Ctx, overrides: Partial<QuestionInput> = {}): QuestionInput => ({
  type: "MCQ",
  subjectId: ctx.subjectId,
  chapterId: ctx.chapterId,
  difficulty: "MEDIUM",
  marks: 1,
  stem: `Which criterion proves similarity from two equal angles? ${textToken().slice(0, 8)}`,
  options: [
    { key: "A", text: "AA", isCorrect: true },
    { key: "B", text: "SSS", isCorrect: false },
    { key: "C", text: "SAS", isCorrect: false },
  ],
  explanation: "Two equal angles force the third.",
  outcomeIds: [ctx.outcomeId],
  ...overrides,
});

describe("content hashing", () => {
  it("ignores whitespace and case", () => {
    const a = contentHash("MCQ", "What is  2 + 2?", null);
    const b = contentHash("MCQ", "what is 2 + 2?", null);
    expect(a.equals(b)).toBe(true);
  });

  it("ignores the order of the options", () => {
    // Reordering choices does not make it a different question.
    const options = [
      { key: "A", text: "Four", isCorrect: true },
      { key: "B", text: "Five", isCorrect: false },
    ];
    const reversed = [options[1]!, options[0]!];
    expect(
      contentHash("MCQ", "What is 2 + 2?", options).equals(
        contentHash("MCQ", "What is 2 + 2?", reversed),
      ),
    ).toBe(true);
  });

  it("distinguishes different questions", () => {
    expect(
      contentHash("MCQ", "What is 2 + 2?", null).equals(
        contentHash("MCQ", "What is 3 + 3?", null),
      ),
    ).toBe(false);
  });
});

describe("creating a question", () => {
  it("creates it as a DRAFT with version 1", async () => {
    const created = await createQuestion(actorOf(A), draft(A));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const question = await getQuestion(A.organizationId, created.id);
    expect(question?.status).toBe("DRAFT");
    expect(question?.version).toBe(1);
    expect(question?.source).toBe("MANUAL");
    expect(question?.outcomeIds).toContain(A.outcomeId);
  });

  it("refuses a question that would be wrong in an exam", async () => {
    const result = await createQuestion(
      actorOf(A),
      draft(A, {
        options: [
          { key: "A", text: "AA", isCorrect: true },
          { key: "B", text: "SSS", isCorrect: true },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "INVALID") {
      expect(result.problems.problems[0]?.severity).toBe("error");
    }
  });

  it("saves a question that carries only warnings", async () => {
    // Warnings are advice. The author decides.
    const result = await createQuestion(
      actorOf(A),
      draft(A, { explanation: null }),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses an exact duplicate and names the one that exists", async () => {
    const input = draft(A);
    const first = await createQuestion(actorOf(A), input);
    const second = await createQuestion(actorOf(A), input);

    expect(second.ok).toBe(false);
    if (!second.ok && second.code === "DUPLICATE" && first.ok) {
      expect(second.existingId).toBe(first.id);
    }
  });

  it("does not treat another organization's question as a duplicate", async () => {
    // Duplicate detection is per tenant. Two centres may legitimately hold the
    // same question, and neither should learn about the other's bank.
    const input = draft(A);
    await createQuestion(actorOf(A), input);
    const theirs = await createQuestion(actorOf(B), {
      ...input,
      subjectId: B.subjectId,
      chapterId: B.chapterId,
      outcomeIds: [B.outcomeId],
    });
    expect(theirs.ok).toBe(true);
  });
});

describe("approval", () => {
  it("requires a human, and records who", async () => {
    const created = await createQuestion(actorOf(A), draft(A));
    if (!created.ok) throw new Error("create failed");

    expect((await approveQuestion(actorOf(A), created.id)).ok).toBe(true);

    const question = await getQuestion(A.organizationId, created.id);
    expect(question?.status).toBe("APPROVED");
    expect(question?.approvedAt).toBeInstanceOf(Date);

    const row = await withTenant(A.organizationId, (tx) =>
      tx.question.findUniqueOrThrow({ where: { id: created.id } }),
    );
    expect(row.approvedById).toBe(A.userId);
  });

  it("refuses to approve a question with no learning outcome", async () => {
    // It can be scored, but it can never inform mastery.
    const created = await createQuestion(actorOf(A), draft(A, { outcomeIds: [] }));
    if (!created.ok) throw new Error("create failed");

    const result = await approveQuestion(actorOf(A), created.id);
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "NOT_APPROVABLE") {
      expect(
        result.problems.problems.some((p) => p.field === "outcomes"),
      ).toBe(true);
    }
  });

  it("re-validates at the gate rather than trusting the draft", async () => {
    const created = await createQuestion(actorOf(A), draft(A));
    if (!created.ok) throw new Error("create failed");

    // The outcome mapping disappears after the question was written — which is
    // exactly what happens when a curriculum row is reorganised.
    await withTenant(A.organizationId, (tx) =>
      tx.questionOutcome.deleteMany({ where: { questionId: created.id } }),
    );

    expect((await approveQuestion(actorOf(A), created.id)).ok).toBe(false);
  });

  it("rejects with a reason, and the reason survives", async () => {
    const created = await createQuestion(actorOf(A), draft(A));
    if (!created.ok) throw new Error("create failed");

    expect(
      await rejectQuestion(actorOf(A), created.id, "The distractors are implausible."),
    ).toBe(true);

    const question = await getQuestion(A.organizationId, created.id);
    expect(question?.status).toBe("REJECTED");
    expect(question?.rejectionReason).toMatch(/distractors/);
  });

  it("archives", async () => {
    const created = await createQuestion(actorOf(A), draft(A));
    if (!created.ok) throw new Error("create failed");
    expect(await archiveQuestion(actorOf(A), created.id)).toBe(true);
    expect((await getQuestion(A.organizationId, created.id))?.status).toBe("ARCHIVED");
  });
});

describe("versioning", () => {
  it("edits a draft in place — nobody has seen it", async () => {
    const created = await createQuestion(actorOf(A), draft(A));
    if (!created.ok) throw new Error("create failed");

    const result = await updateQuestion(
      actorOf(A),
      created.id,
      draft(A, { stem: "Edited while still a draft, which changes nothing else." }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.version).toBe(1);

    const versions = await withTenant(A.organizationId, (tx) =>
      tx.questionVersion.findMany({ where: { questionId: created.id } }),
    );
    expect(versions).toHaveLength(1);
  });

  it("editing an APPROVED question creates version 2 and keeps version 1", async () => {
    // An attempt records the version it was served, so a paper written in
    // August must keep marking the way it did in August.
    const created = await createQuestion(actorOf(A), draft(A));
    if (!created.ok) throw new Error("create failed");
    await approveQuestion(actorOf(A), created.id);

    const before = await getQuestion(A.organizationId, created.id);
    const originalStem = before!.stem;

    const result = await updateQuestion(
      actorOf(A),
      created.id,
      draft(A, { stem: "Reworded after approval, so this becomes version two." }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.version).toBe(2);

    const versions = await withTenant(A.organizationId, (tx) =>
      tx.questionVersion.findMany({
        where: { questionId: created.id },
        orderBy: { version: "asc" },
      }),
    );
    expect(versions).toHaveLength(2);
    expect(versions[0]?.stem).toBe(originalStem);
    expect(versions[1]?.stem).toMatch(/version two/);
  });

  it("an edit after approval drops the question back to DRAFT", async () => {
    // The approval was given to the previous wording, not to this one.
    const created = await createQuestion(actorOf(A), draft(A));
    if (!created.ok) throw new Error("create failed");
    await approveQuestion(actorOf(A), created.id);
    await updateQuestion(
      actorOf(A),
      created.id,
      draft(A, { stem: "Changed after approval, so the approval no longer applies." }),
    );

    const question = await getQuestion(A.organizationId, created.id);
    expect(question?.status).toBe("DRAFT");
    expect(question?.approvedAt).toBeNull();
  });

  it("an edit that does not send the rubric, hint or expected time keeps them", async () => {
    // Writing `input.rubric ?? null` wiped the mark scheme, the hint and the
    // expected time whenever somebody corrected the explanation.
    const rubric = {
      criteria: [
        { id: "method", label: "Method", marks: 2, descriptor: "Uses AA similarity" },
        { id: "answer", label: "Final answer", marks: 1, descriptor: null },
      ],
    };
    const created = await createQuestion(
      actorOf(A),
      draft(A, {
        type: "SA",
        marks: 3,
        options: null,
        stem: `Explain why two triangles with two equal angles are similar. ${textToken().slice(0, 8)}`,
        rubric,
        hint: "Think about the angle sum.",
        expectedTimeSeconds: 180,
      }),
    );
    if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created)}`);

    const before = await getQuestion(A.organizationId, created.id);
    expect(before?.rubric?.criteria).toHaveLength(2);

    const edit = draft(A, {
      type: "SA",
      marks: 3,
      options: null,
      stem: before!.stem,
      explanation: "Corrected explanation: the third angles are then equal too.",
    });
    delete edit.rubric;
    delete edit.hint;
    delete edit.expectedTimeSeconds;
    const result = await updateQuestion(actorOf(A), created.id, edit);
    expect(result.ok).toBe(true);

    const after = await getQuestion(A.organizationId, created.id);
    expect(after?.explanation).toMatch(/Corrected explanation/);
    expect(after?.rubric).toEqual(rubric);
    expect(after?.hint).toBe("Think about the angle sum.");
    expect(after?.expectedTimeSeconds).toBe(180);

    // An explicit null still clears it.
    await updateQuestion(actorOf(A), created.id, { ...edit, rubric: null, hint: null });
    const cleared = await getQuestion(A.organizationId, created.id);
    expect(cleared?.rubric).toBeNull();
    expect(cleared?.hint).toBeNull();
    expect(cleared?.expectedTimeSeconds).toBe(180);
  });

  it("refuses a rubric that does not add up to the question's marks", async () => {
    const result = await createQuestion(
      actorOf(A),
      draft(A, {
        type: "SA",
        marks: 3,
        options: null,
        stem: `Explain the AA criterion in your own words. ${textToken().slice(0, 8)}`,
        rubric: { criteria: [{ id: "m", label: "Method", marks: 2 }] },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "MISFILED") {
      expect(result.message).toMatch(/add up to 2/);
    }
  });
});

describe("tenancy", () => {
  it("one organization does not see another's questions", async () => {
    await createQuestion(actorOf(B), {
      ...draft(B),
      stem: "A question that belongs entirely to organisation B and nobody else.",
    });

    const mine = await listQuestions(A.organizationId);
    expect(mine.every((q) => !q.stem.includes("entirely to organisation B"))).toBe(true);
  });

  it("returns null for another organization's question by exact id", async () => {
    const created = await createQuestion(actorOf(B), draft(B));
    if (!created.ok) throw new Error("create failed");

    expect(await getQuestion(A.organizationId, created.id)).toBeNull();
    expect(await getQuestion(B.organizationId, created.id)).not.toBeNull();
  });

  it("cannot approve or archive another organization's question", async () => {
    const created = await createQuestion(actorOf(B), draft(B));
    if (!created.ok) throw new Error("create failed");

    expect((await approveQuestion(actorOf(A), created.id)).ok).toBe(false);
    expect(await archiveQuestion(actorOf(A), created.id)).toBe(false);

    expect((await getQuestion(B.organizationId, created.id))?.status).toBe("DRAFT");
  });

  it("cannot create a GLOBAL question from a tenant", async () => {
    // The CHECK constraint plus the write policy: a tenant must not be able to
    // publish into every other customer's bank by setting a field.
    await expect(
      withTenant(A.organizationId, (tx) =>
        tx.question.create({
          data: {
            visibility: "GLOBAL",
            organizationId: null,
            createdById: A.userId,
            subjectId: A.subjectId,
            type: "MCQ",
            difficulty: "EASY",
            marks: 1,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("the bank view", () => {
  it("filters by status", async () => {
    const created = await createQuestion(actorOf(A), draft(A));
    if (!created.ok) throw new Error("create failed");
    await approveQuestion(actorOf(A), created.id);

    const approved = await listQuestions(A.organizationId, { status: "APPROVED" });
    expect(approved.every((q) => q.status === "APPROVED")).toBe(true);
    expect(approved.some((q) => q.id === created.id)).toBe(true);
  });

  it("searches the question text", async () => {
    const marker = `pythagoras${randomUUID().slice(0, 6)}`;
    await createQuestion(
      actorOf(A),
      draft(A, { stem: `A question mentioning ${marker} for the search test.` }),
    );

    const found = await listQuestions(A.organizationId, { search: marker });
    expect(found).toHaveLength(1);
  });

  it("matches every word of a search, in any order", async () => {
    const one = `alpha${randomUUID().slice(0, 6)}`;
    const two = `beta${randomUUID().slice(0, 6)}`;
    await createQuestion(
      actorOf(A),
      draft(A, { stem: `The ${two} comes before the ${one} in this question text.` }),
    );
    expect(await listQuestions(A.organizationId, { search: `${one} ${two}` })).toHaveLength(1);
    expect(
      await listQuestions(A.organizationId, { search: `${one} missing${randomUUID().slice(0, 6)}` }),
    ).toHaveLength(0);
  });

  it("treats % and _ as text, not as wildcards", async () => {
    const all = await listQuestions(A.organizationId, { limit: 2000 });
    const percent = await listQuestions(A.organizationId, { search: "%", limit: 2000 });
    const underscore = await listQuestions(A.organizationId, { search: "_", limit: 2000 });
    expect(percent.length).toBe(all.filter((q) => q.stem.includes("%")).length);
    expect(underscore.length).toBe(all.filter((q) => q.stem.includes("_")).length);
  });

  it("counts by status", async () => {
    const summary = await bankSummary(A.organizationId);
    expect(summary.total).toBeGreaterThan(0);
    expect(summary.total).toBe(
      summary.draft + summary.inReview + summary.approved + summary.rejected +
        (await listQuestions(A.organizationId, { status: "ARCHIVED" })).length,
    );
  });
});

function actorOf(ctx: Ctx) {
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    role: ctx.role,
  };
}

describe("curriculum coherence", () => {
  it("refuses a chapter that belongs to a different subject", async () => {
    // Found by looking at a screenshot: the detail page showed Subject "Hindi"
    // beside Chapter "Triangles". Such a question SCORES correctly and then
    // attributes its evidence to the wrong syllabus for the rest of its life —
    // nothing downstream looks wrong, the mastery numbers are just quietly
    // about something else.
    const otherSubject = await prisma.subject.findFirstOrThrow({
      where: { code: "HIN" },
    });

    const result = await createQuestion(
      actorOf(A),
      draft(A, { subjectId: otherSubject.id }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "MISFILED") {
      expect(result.message).toMatch(/different subject/);
    } else {
      throw new Error(`expected MISFILED, got ${JSON.stringify(result)}`);
    }
  });

  it("refuses an outcome from a different chapter", async () => {
    const strayOutcome = await prisma.learningOutcome.findFirst({
      where: { topic: { chapterId: { not: A.chapterId } } },
    });
    if (!strayOutcome) return; // only one authored chapter exists

    const result = await createQuestion(
      actorOf(A),
      draft(A, { outcomeIds: [strayOutcome.id] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "MISFILED") {
      expect(result.message).toMatch(/different chapter/);
    }
  });

  it("refuses an outcome that no longer exists", async () => {
    const result = await createQuestion(
      actorOf(A),
      draft(A, { outcomeIds: [randomUUID()] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "MISFILED") {
      expect(result.message).toMatch(/no longer exists/);
    }
  });

  it("refuses a chapter that does not exist", async () => {
    const result = await createQuestion(
      actorOf(A),
      draft(A, { chapterId: randomUUID() }),
    );
    expect(result.ok).toBe(false);
  });

  it("allows a question with no chapter at all", async () => {
    // Filing by subject only is legitimate — a teacher may not know the
    // chapter yet. It simply cannot be approved without an outcome.
    const result = await createQuestion(
      actorOf(A),
      draft(A, { chapterId: null, outcomeIds: [] }),
    );
    expect(result.ok).toBe(true);
  });

  it("blocks a mis-filed edit too, not only a mis-filed create", async () => {
    const created = await createQuestion(actorOf(A), draft(A));
    if (!created.ok) throw new Error("create failed");

    const otherSubject = await prisma.subject.findFirstOrThrow({
      where: { code: "HIN" },
    });
    const result = await updateQuestion(
      actorOf(A),
      created.id,
      draft(A, { subjectId: otherSubject.id }),
    );
    expect(result.ok).toBe(false);
  });
});

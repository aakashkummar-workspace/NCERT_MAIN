import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUp } from "@/core/identity/accounts";
import { createClass, InvalidCurriculumSelection } from "@/core/classes";
import { listGradesWithSubjects, listBoards } from "@/core/curriculum";
import {
  boardChangeBlockers,
  organizationBoard,
  setOrganizationBoard,
} from "@/core/organizations";
import { prisma } from "@/db/client";
import { platformPrisma } from "@/db/platform";
import { withTenant } from "@/db/tenant";

/**
 * Multi-board, against a real database with RLS on.
 *
 * Nothing here hunts for a scarce shared row and nothing attaches a concept to
 * a seeded outcome: concepts carry no organization_id, so they are global and
 * permanent. Every organization this suite needs, it signs up itself.
 */

afterAll(async () => {
  await prisma.$disconnect();
});

type Org = { organizationId: string; userId: string; role: string };

async function makeOrg(boardCode: string): Promise<Org> {
  const result = await signUp({
    fullName: "Board Tester",
    email: `board-${randomUUID()}@example.test`,
    password: "a-long-enough-password",
    organizationName: `Board Org ${randomUUID().slice(0, 6)}`,
    organizationType: "TUITION_CENTRE",
    boardCode,
  });
  if (!result.ok) throw new Error(`signUp failed: ${result.message}`);

  const membership = await withTenant(result.organizationId, (tx) =>
    tx.membership.findFirstOrThrow({ where: { role: "OWNER" } }),
  );
  return {
    organizationId: result.organizationId,
    userId: membership.userId,
    role: result.role,
  };
}

let boards: Awaited<ReturnType<typeof listBoards>>;

beforeAll(async () => {
  boards = await listBoards();
});

describe("the board column", () => {
  it("is required, which is what makes a defaulted read impossible", async () => {
    // The migration's whole shape: nullable, backfilled with CBSE, then NOT
    // NULL. A nullable column would have left every read with a fallback to
    // write, and a fallback is the CBSE default one layer down.
    const [row] = await prisma.$queryRaw<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns
      where table_name = 'organizations' and column_name = 'board_id'
    `;
    expect(row?.is_nullable).toBe("NO");
  });

  it("puts a new organization on the board it chose", async () => {
    const org = await makeOrg("CBSE");
    const board = await organizationBoard(org.organizationId);
    expect(board.code).toBe("CBSE");
  });

  it("refuses a board nobody has seeded, rather than falling back", async () => {
    const result = await signUp({
      fullName: "Nobody",
      email: `board-${randomUUID()}@example.test`,
      password: "a-long-enough-password",
      organizationName: "Imaginary Board School",
      organizationType: "SCHOOL",
      boardCode: "NOT-A-BOARD",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNKNOWN_BOARD");
  });
});

describe("what a school can see", () => {
  it("shows an ICSE school the ICSE tree and nothing else", async () => {
    const icse = boards.find((board) => board.code === "ICSE");
    expect(icse, "ICSE should be seeded as a shape").toBeDefined();

    const org = await makeOrg("ICSE");
    const board = await organizationBoard(org.organizationId);
    expect(board.code).toBe("ICSE");

    const grades = await listGradesWithSubjects(board.id);
    expect(grades.map((grade) => grade.number).sort((a, b) => a - b)).toEqual([
      9, 10,
    ]);

    const subjects = grades.flatMap((grade) =>
      grade.subjects.map((subject) => subject.name),
    );
    // Physics as its own subject is the ICSE shape; "Science" and "Hindi" are
    // the CBSE one. If the read had defaulted, this is what would have leaked.
    expect(subjects).toContain("Physics");
    expect(subjects).not.toContain("Science");
    expect(subjects).not.toContain("Hindi");
  });

  it("shows a CBSE school the CBSE tree", async () => {
    const org = await makeOrg("CBSE");
    const board = await organizationBoard(org.organizationId);
    const subjects = (await listGradesWithSubjects(board.id)).flatMap((grade) =>
      grade.subjects.map((subject) => subject.name),
    );
    expect(subjects).toContain("Science");
    expect(subjects).not.toContain("Physics");
  });

  it("refuses a class built from another board's grade", async () => {
    // The check that matters, because a grade id is a global id and a
    // hand-made request can name any of them. Without it, one school could
    // hold two disjoint syllabuses and no report about it would mean anything.
    const org = await makeOrg("ICSE");
    const cbse = boards.find((board) => board.code === "CBSE")!;
    const cbseGrades = await listGradesWithSubjects(cbse.id);
    const grade = cbseGrades.find((g) => g.number === 10)!;

    await expect(
      createClass(org, {
        name: "Class 10-A",
        gradeId: grade.id,
        subjectId: grade.subjects[0]!.id,
        academicYear: "2026-27",
      }),
    ).rejects.toBeInstanceOf(InvalidCurriculumSelection);
  });
});

describe("changing the board", () => {
  it("is allowed while the organisation is empty", async () => {
    const org = await makeOrg("CBSE");
    expect((await boardChangeBlockers(org.organizationId)).total).toBe(0);

    const result = await setOrganizationBoard(org, "ICSE");
    expect(result.ok).toBe(true);
    expect((await organizationBoard(org.organizationId)).code).toBe("ICSE");
  });

  it("is REFUSED once a class exists, and the board does not move", async () => {
    const org = await makeOrg("CBSE");
    const board = await organizationBoard(org.organizationId);
    const grades = await listGradesWithSubjects(board.id);
    const grade = grades.find((g) => g.number === 10)!;

    await createClass(org, {
      name: `Class 10-A ${randomUUID().slice(0, 4)}`,
      gradeId: grade.id,
      subjectId: grade.subjects[0]!.id,
      academicYear: "2026-27",
    });

    const result = await setOrganizationBoard(org, "ICSE");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("IN_USE");
      // The counts travel with the refusal: a refusal somebody cannot check is
      // one they argue with.
      expect(result.blockers?.classes).toBe(1);
      expect(result.message).toContain("1 class");
    }

    // The invariant this test exists for: nothing moved.
    expect((await organizationBoard(org.organizationId)).code).toBe("CBSE");
  });

  it("is a no-op, not a refusal, when the board is already that one", async () => {
    const org = await makeOrg("CBSE");
    const board = await organizationBoard(org.organizationId);
    const grades = await listGradesWithSubjects(board.id);
    const grade = grades.find((g) => g.number === 10)!;
    await createClass(org, {
      name: `Class 10-B ${randomUUID().slice(0, 4)}`,
      gradeId: grade.id,
      subjectId: grade.subjects[0]!.id,
      academicYear: "2026-27",
    });

    // Saving the form without changing the selection must not be an error.
    const result = await setOrganizationBoard(org, "CBSE");
    expect(result.ok).toBe(true);
  });

  it("refuses a board nobody has authored anything under", async () => {
    // Not a hypothetical: a board can be seeded as a shape long before its
    // syllabus exists, and moving a school onto one would leave them with an
    // empty class-creation form and no explanation.
    // Authored here on the platform connection — the app role has no insert
    // grant on the curriculum plane at all — and removed again, because this
    // database is never reset and a board is offered in every signup picker.
    const code = `TEST-${randomUUID().slice(0, 8).toUpperCase()}`;
    const empty = await platformPrisma.board.create({
      data: { code, name: `Test Board ${code}` },
    });
    try {
      const org = await makeOrg("CBSE");
      const result = await setOrganizationBoard(org, empty.code);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("EMPTY_BOARD");
    } finally {
      // Safe to delete: nothing points at it. An organization that had been
      // moved onto it would hold a foreign key and this would refuse — which
      // is the RESTRICT on the column doing its job.
      await platformPrisma.board.delete({ where: { id: empty.id } });
    }
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUp } from "@/core/identity/accounts";
import { classLimitMessage, classSeats, studentSeats } from "@/core/classes/limits";
import {
  ClassLimitReached,
  createClass,
  generateJoinCode,
  getClass,
  InvalidCurriculumSelection,
  listClasses,
  rotateJoinCode,
} from "@/core/classes";
import { parseRoster } from "@/core/roster/parse";
import { addStudents, dryRunRoster, removeStudent } from "@/core/roster/add";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";

afterAll(async () => {
  await prisma.$disconnect();
});

type Org = {
  organizationId: string;
  userId: string;
  role: string;
  gradeId: string;
  subjectId: string;
  otherGradeId: string;
};

async function makeOrg(): Promise<Org> {
  const result = await signUp({
    fullName: "Priya Raman",
    email: `teacher-${randomUUID()}@example.test`,
    password: "a-long-enough-password",
    organizationName: "Raman Maths Centre",
    organizationType: "TUITION_CENTRE",
    boardCode: "CBSE",
  });
  if (!result.ok) throw new Error("signUp failed");

  const grades = await prisma.grade.findMany({
    include: { subjects: true },
    orderBy: { number: "asc" },
  });
  const nine = grades.find((g) => g.number === 9)!;
  const ten = grades.find((g) => g.number === 10)!;

  return {
    organizationId: result.organizationId,
    userId: (await currentUserId(result.organizationId))!,
    role: result.role,
    gradeId: ten.id,
    subjectId: ten.subjects.find((s) => s.code === "MATH")!.id,
    otherGradeId: nine.id,
  };
}

async function currentUserId(organizationId: string) {
  return withTenant(organizationId, async (tx) => {
    const membership = await tx.membership.findFirst({ where: { role: "OWNER" } });
    return membership?.userId;
  });
}

/**
 * A mobile number and a roll number nobody has used before.
 *
 * Phone uniqueness is GLOBAL, not per-tenant, and this database is not reset
 * between runs. A hardcoded number passes on a fresh database and then fails
 * forever afterwards, because the product correctly refuses a number that
 * already has an account.
 */
function uniquePhone(): string {
  return `9${String(Math.floor(100_000_000 + Math.random() * 899_999_999))}`;
}

function uniqueRoll(): string {
  return `R${randomUUID().slice(0, 8)}`;
}

function actorOf(org: Org) {
  return {
    organizationId: org.organizationId,
    userId: org.userId,
    role: org.role,
  };
}

let A: Org;
let B: Org;

beforeAll(async () => {
  A = await makeOrg();
  B = await makeOrg();
});

describe("join codes", () => {
  it("avoids every character pair that is misread aloud", () => {
    // These codes are read out in a classroom and typed on a phone.
    const banned = /[OI1L0S5B8Z2]/;
    for (let i = 0; i < 300; i++) {
      expect(generateJoinCode()).not.toMatch(banned);
    }
  });

  it("is six characters", () => {
    expect(generateJoinCode()).toHaveLength(6);
  });

  it("does not repeat in a realistic sample", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i++) seen.add(generateJoinCode());
    expect(seen.size).toBeGreaterThan(2980);
  });
});

describe("creating a class", () => {
  it("creates it with a join code and the creator as primary teacher", async () => {
    const created = await createClass(actorOf(A), {
      name: "Class 10-A",
      gradeId: A.gradeId,
      subjectId: A.subjectId,
      academicYear: "2026-27",
    });

    expect(created.joinCode).toHaveLength(6);

    const teachers = await withTenant(A.organizationId, (tx) =>
      tx.classTeacher.findMany({ where: { classId: created.id } }),
    );
    expect(teachers).toHaveLength(1);
    expect(teachers[0]?.role).toBe("PRIMARY");
    expect(teachers[0]?.teacherUserId).toBe(A.userId);
  });

  it("refuses a subject that is not taught in that class year", async () => {
    // Without this check a Class 9 group could be filed against Class 10
    // Mathematics, and every mastery number downstream would point at the
    // wrong curriculum.
    await expect(
      createClass(actorOf(A), {
        name: "Class 9-A",
        gradeId: A.otherGradeId,
        subjectId: A.subjectId, // a Class 10 subject
        academicYear: "2026-27",
      }),
    ).rejects.toThrow(InvalidCurriculumSelection);
  });

  it("writes an audit entry", async () => {
    const created = await createClass(actorOf(A), {
      name: "Class 10-B",
      gradeId: A.gradeId,
      subjectId: A.subjectId,
      academicYear: "2026-27",
    });

    const entries = await withTenant(A.organizationId, (tx) =>
      tx.auditLog.findMany({
        where: { action: "class.created", entityId: created.id },
      }),
    );
    expect(entries).toHaveLength(1);
  });

  it("rotates a join code and invalidates the old one", async () => {
    const created = await createClass(actorOf(A), {
      name: "Class 10-C",
      gradeId: A.gradeId,
      subjectId: A.subjectId,
      academicYear: "2026-27",
    });
    const next = await rotateJoinCode(actorOf(A), created.id);
    expect(next).not.toBe(created.joinCode);
    expect(next).toHaveLength(6);
  });
});

describe("class tenancy", () => {
  it("does not show one organization another's classes", async () => {
    await createClass(actorOf(B), {
      name: "Bravo Class",
      gradeId: B.gradeId,
      subjectId: B.subjectId,
      academicYear: "2026-27",
    });

    const forA = await listClasses(A.organizationId);
    expect(forA.every((k) => k.name !== "Bravo Class")).toBe(true);
  });

  it("returns null for another organization's class by exact id", async () => {
    const created = await createClass(actorOf(B), {
      name: "Bravo Private",
      gradeId: B.gradeId,
      subjectId: B.subjectId,
      academicYear: "2026-27",
    });

    // The dangerous case: the caller already knows the id.
    expect(await getClass(A.organizationId, created.id)).toBeNull();
    expect(await getClass(B.organizationId, created.id)).not.toBeNull();
  });

  it("cannot rotate another organization's join code", async () => {
    const created = await createClass(actorOf(B), {
      name: "Bravo Code",
      gradeId: B.gradeId,
      subjectId: B.subjectId,
      academicYear: "2026-27",
    });
    const before = await getClass(B.organizationId, created.id);

    expect(await rotateJoinCode(actorOf(A), created.id)).toBe("");

    const after = await getClass(B.organizationId, created.id);
    expect(after?.joinCode).toBe(before?.joinCode);
  });
});

describe("adding students", () => {
  async function freshClass(org: Org, name: string) {
    return createClass(actorOf(org), {
      name,
      gradeId: org.gradeId,
      subjectId: org.subjectId,
      academicYear: "2026-27",
    });
  }

  it("adds a pasted list and enrols every student", async () => {
    const klass = await freshClass(A, `Roster ${randomUUID().slice(0, 6)}`);
    const roster = parseRoster("Arun Kumar\nMeera Nair\nRavi Shankar");

    const result = await addStudents(actorOf(A), klass.id, roster.students);
    expect(result.added).toBe(3);
    expect(result.skipped).toBe(0);

    const loaded = await getClass(A.organizationId, klass.id);
    expect(loaded?.students).toHaveLength(3);
    expect(loaded?.students.map((s) => s.fullName)).toContain("Meera Nair");
  });

  it("stores roll numbers and phones from a CSV", async () => {
    const klass = await freshClass(A, `CSV ${randomUUID().slice(0, 6)}`);
    const phone = uniquePhone();
    const ashaRoll = uniqueRoll();
    const roster = parseRoster(
      `Name,Roll,Phone\nAsha Rao,${ashaRoll},${phone}\nDev Patel,${uniqueRoll()},`,
    );

    await addStudents(actorOf(A), klass.id, roster.students);
    const loaded = await getClass(A.organizationId, klass.id);

    const asha = loaded?.students.find((s) => s.fullName === "Asha Rao");
    expect(asha?.rollNumber).toBe(ashaRoll);
    expect(asha?.phone).toBe(phone);
    expect(asha?.canSignIn).toBe(true);

    const dev = loaded?.students.find((s) => s.fullName === "Dev Patel");
    // No phone means no sign-in code, which means no test. Surfaced rather
    // than discovered on exam day.
    expect(dev?.canSignIn).toBe(false);
  });

  it("skips a student already in the class instead of duplicating them", async () => {
    const klass = await freshClass(A, `Dupe ${randomUUID().slice(0, 6)}`);
    await addStudents(actorOf(A), klass.id, parseRoster("Arun Kumar").students);

    const second = await addStudents(
      actorOf(A),
      klass.id,
      parseRoster("Arun Kumar\nNew Person").students,
    );

    expect(second.added).toBe(1);
    expect(second.skipped).toBe(1);
    expect(
      second.outcomes.find((o) => o.fullName === "Arun Kumar"),
    ).toMatchObject({ status: "skipped" });
  });

  it("adds a different student who shares a name, telling them apart by phone", async () => {
    // A name is not an identity. Refusing the second Arun Kumar by name alone
    // kept a real child off the roster.
    const klass = await freshClass(A, `Namesake ${randomUUID().slice(0, 6)}`);
    await addStudents(
      actorOf(A),
      klass.id,
      parseRoster(`Name,Phone\nArun Kumar,${uniquePhone()}`).students,
    );

    const second = await addStudents(
      actorOf(A),
      klass.id,
      parseRoster(`Name,Phone\nArun Kumar,${uniquePhone()}`).students,
    );
    expect(second.added).toBe(1);
    const outcome = second.outcomes[0];
    expect(outcome?.status).toBe("added");
    if (outcome?.status === "added") expect(outcome.warning).toMatch(/same name/);

    const loaded = await getClass(A.organizationId, klass.id);
    expect(loaded?.students.filter((s) => s.fullName === "Arun Kumar")).toHaveLength(2);
  });

  it("refuses the same phone twice in one list", async () => {
    const klass = await freshClass(A, `TwicePhone ${randomUUID().slice(0, 6)}`);
    const phone = uniquePhone();
    const result = await addStudents(
      actorOf(A),
      klass.id,
      parseRoster(`Name,Phone\nFirst Name,${phone}\nOther Name,${phone}`).students,
    );
    expect(result.added).toBe(1);
    expect(result.outcomes[1]).toMatchObject({ status: "skipped" });
  });

  it("refuses a phone that already has an account, and says how to proceed", async () => {
    const phone = uniquePhone();
    const first = await freshClass(A, `Phone ${randomUUID().slice(0, 6)}`);
    await addStudents(
      actorOf(A),
      first.id,
      parseRoster(`Name,Phone\nOriginal Student,${phone}`).students,
    );

    // A teacher must not be able to attach an arbitrary mobile number to their
    // roster — that is how you would harvest someone else's student. The
    // student joins the second class themselves, with the class code.
    const second = await freshClass(B, `Phone ${randomUUID().slice(0, 6)}`);
    const result = await addStudents(
      actorOf(B),
      second.id,
      parseRoster(`Name,Phone\nSame Number,${phone}`).students,
    );

    expect(result.added).toBe(0);
    const outcome = result.outcomes[0];
    expect(outcome?.status).toBe("skipped");
    if (outcome?.status === "skipped") {
      expect(outcome.reason).toMatch(/class code/);
      // It must not reveal which organization holds the number.
      expect(outcome.reason).not.toMatch(/Raman|centre|organisation's/i);
    }
  });

  it("refuses a roll number already used in the organisation", async () => {
    const klass = await freshClass(A, `Roll ${randomUUID().slice(0, 6)}`);
    const roll = uniqueRoll();
    await addStudents(
      actorOf(A),
      klass.id,
      parseRoster(`Name,Roll\nFirst Student,${roll}`).students,
    );

    const other = await freshClass(A, `Roll2 ${randomUUID().slice(0, 6)}`);
    const result = await addStudents(
      actorOf(A),
      other.id,
      parseRoster(`Name,Roll\nSecond Student,${roll}`).students,
    );

    expect(result.added).toBe(0);
    expect(result.outcomes[0]).toMatchObject({ status: "skipped" });
  });

  it("the dry run predicts exactly what the commit does", async () => {
    // A preview running different logic from the commit is a preview that
    // lies, and the teacher finds out after pressing the button.
    const klass = await freshClass(A, `Dry ${randomUUID().slice(0, 6)}`);
    await addStudents(actorOf(A), klass.id, parseRoster("Existing One").students);

    const roster = parseRoster("Existing One\nBrand New\nAlso New");
    const predicted = await dryRunRoster(
      A.organizationId,
      klass.id,
      roster.students,
    );
    const actual = await addStudents(actorOf(A), klass.id, roster.students);

    expect(predicted.map((o) => `${o.fullName}:${o.status}`)).toEqual(
      actual.outcomes.map((o) => `${o.fullName}:${o.status}`),
    );
  });

  it("writes nothing during a dry run", async () => {
    const klass = await freshClass(A, `DryNo ${randomUUID().slice(0, 6)}`);
    await dryRunRoster(
      A.organizationId,
      klass.id,
      parseRoster("Never Written\nAlso Never").students,
    );
    const loaded = await getClass(A.organizationId, klass.id);
    expect(loaded?.students).toHaveLength(0);
  });
});

describe("plan limits", () => {
  it("reads the class and student limits from the plan, and counts real rows", async () => {
    // A fresh organization with no subscription is on the free plan's shape.
    const org = await makeOrg();
    const before = await classSeats(org.organizationId);
    expect(before.used).toBe(0);
    // Whatever the plan says — the number is data, not code — it is a number
    // here, because the free plan has a class limit row.
    expect(typeof before.limit).toBe("number");

    const limit = before.limit!;
    for (let i = 0; i < limit; i++) {
      const seats = await classSeats(org.organizationId);
      await createClass(
        actorOf(org),
        {
          name: `Limit ${i} ${randomUUID().slice(0, 4)}`,
          gradeId: org.gradeId,
          subjectId: org.subjectId,
          academicYear: "2026-27",
        },
        seats,
      );
    }

    const full = await classSeats(org.organizationId);
    expect(full.remaining).toBe(0);
    await expect(
      createClass(
        actorOf(org),
        {
          name: "One too many",
          gradeId: org.gradeId,
          subjectId: org.subjectId,
          academicYear: "2026-27",
        },
        full,
      ),
    ).rejects.toThrow(ClassLimitReached);
    // A bad curriculum pairing is still reported as that, not as the plan.
    await expect(
      createClass(
        actorOf(org),
        {
          name: "Wrong pair",
          gradeId: org.otherGradeId,
          subjectId: org.subjectId,
          academicYear: "2026-27",
        },
        full,
      ),
    ).rejects.toThrow(InvalidCurriculumSelection);
    expect(classLimitMessage(full)).toMatch(new RegExp(`limit is ${limit}`));
  });

  it("skips the rows past the student limit, in the preview and the commit alike", async () => {
    const org = await makeOrg();
    const klass = await createClass(actorOf(org), {
      name: "Seats",
      gradeId: org.gradeId,
      subjectId: org.subjectId,
      academicYear: "2026-27",
    });
    const seats = { remaining: 2, reason: "Over your plan's student limit of 2." };
    const roster = parseRoster("One Student\nTwo Student\nThree Student");

    const predicted = await dryRunRoster(org.organizationId, klass.id, roster.students, seats);
    const actual = await addStudents(actorOf(org), klass.id, roster.students, seats);

    expect(actual.added).toBe(2);
    expect(actual.outcomes[2]).toMatchObject({ status: "skipped", reason: seats.reason });
    expect(predicted.map((o) => o.status)).toEqual(actual.outcomes.map((o) => o.status));
    expect((await studentSeats(org.organizationId)).used).toBe(2);
  });
});

describe("removing a student", () => {
  it("ends the enrolment without deleting the record", async () => {
    const klass = await createClass(actorOf(A), {
      name: `Remove ${randomUUID().slice(0, 6)}`,
      gradeId: A.gradeId,
      subjectId: A.subjectId,
      academicYear: "2026-27",
    });
    const result = await addStudents(
      actorOf(A),
      klass.id,
      parseRoster("Leaving Student").students,
    );
    const outcome = result.outcomes[0];
    if (outcome?.status !== "added") throw new Error("expected an added row");

    expect(await removeStudent(actorOf(A), klass.id, outcome.userId)).toBe(true);

    const loaded = await getClass(A.organizationId, klass.id);
    expect(loaded?.students).toHaveLength(0);

    // Enrolment is time-bounded, not deleted: a student who transfers mid-year
    // keeps their history.
    const enrolments = await withTenant(A.organizationId, (tx) =>
      tx.classEnrolment.findMany({ where: { classId: klass.id } }),
    );
    expect(enrolments).toHaveLength(1);
    expect(enrolments[0]?.status).toBe("REMOVED");
    expect(enrolments[0]?.leftAt).toBeInstanceOf(Date);
  });

  it("cannot remove a student from another organization's class", async () => {
    const klass = await createClass(actorOf(B), {
      name: `BravoRemove ${randomUUID().slice(0, 6)}`,
      gradeId: B.gradeId,
      subjectId: B.subjectId,
      academicYear: "2026-27",
    });
    const result = await addStudents(
      actorOf(B),
      klass.id,
      parseRoster("Bravo Student").students,
    );
    const outcome = result.outcomes[0];
    if (outcome?.status !== "added") throw new Error("expected an added row");

    expect(await removeStudent(actorOf(A), klass.id, outcome.userId)).toBe(false);

    const stillThere = await getClass(B.organizationId, klass.id);
    expect(stillThere?.students).toHaveLength(1);
  });
});

describe("curriculum plane", () => {
  it("is readable by every tenant", async () => {
    const [forA, forB] = await Promise.all([
      withTenant(A.organizationId, (tx) => tx.subject.count()),
      withTenant(B.organizationId, (tx) => tx.subject.count()),
    ]);
    expect(forA).toBeGreaterThan(0);
    expect(forA).toBe(forB);
  });

  it("is not writable by a tenant", async () => {
    // The app role has no insert grant. If a tenant could add subjects,
    // "Mathematics" would stop being the same row in every organization and
    // there would be no cross-tenant intelligence to build later.
    await expect(
      withTenant(A.organizationId, (tx) =>
        tx.subject.create({
          data: {
            gradeId: A.gradeId,
            code: "FAKE",
            name: "Invented Subject",
            shortName: "Fake",
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

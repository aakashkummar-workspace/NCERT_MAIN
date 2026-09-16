import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  generateForClass,
  generateReport,
  getReport,
  listReports,
  PAYLOAD_VERSION,
} from "@/core/reports";
import { childReport, childReports } from "@/core/parent/read";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { saveBranding } from "@/core/branding";
import { makeWorld, teacherOf, type World } from "./support/world";
import { grantReports, measuredWorld } from "./support/measured-world";

afterAll(async () => {
  await prisma.$disconnect();
});

const YEAR_START = new Date("2026-04-01T00:00:00Z");
const NOW = new Date();

/*
 * The world these suites need — a student measured on three concepts —
 * lives in ./support/measured-world.ts. It moved there when the exam-series
 * suite needed the same fixture: a report refuses below three measured, so
 * every suite that wants a report rather than a refusal builds one, and two
 * copies of a fixture this size drift inside a week.
 */

const period = { periodStart: YEAR_START, periodEnd: NOW };

describe("the plan is asked before the data", () => {
  it("tells a teacher on the free shape about their plan", async () => {
    // No subscription: the free fallback has no `parent_reports` row, and a
    // missing entitlement is "not included", never "unlimited".
    const world = await makeWorld();
    const result = await generateReport(teacherOf(world), {
      studentUserId: world.studentId,
      ...period,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-entitled");
    expect(result.message).toMatch(/plan/i);
  });
});

describe("a report refuses rather than being thin", () => {
  it("will not be written for a student with nothing measured", async () => {
    const world = await makeWorld();
    await grantReports(world.organizationId);

    const result = await generateReport(teacherOf(world), {
      studentUserId: world.studentId,
      ...period,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-enough-measured");

    // And nothing was written. A refused report must not leave a row behind.
    const stored = await withTenant(world.organizationId, (tx) =>
      tx.report.count({}),
    );
    expect(stored).toBe(0);
  });

  it("names who was skipped when a whole class is run", async () => {
    const { world } = await measuredWorld();
    const result = await generateForClass(teacherOf(world), {
      classId: world.classId,
      ...period,
    });
    if (!result.ok) throw new Error(result.message);

    // The other student sat nothing, so their report is refused — and named.
    // A teacher who gets 26 of 30 needs to know which four, before one of
    // those four's parents asks.
    const skipped = result.rows.filter((row) => row.reportId === null);
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0]!.fullName.length).toBeGreaterThan(0);
    expect(skipped[0]!.skipped).toMatch(/measured|test/i);

    const written = result.rows.filter((row) => row.reportId !== null);
    expect(written.length).toBeGreaterThan(0);
  });
});

describe("the payload is stamped and never recomputed", () => {
  it("keeps saying what it said, after the evidence moves", async () => {
    const { world } = await measuredWorld();
    const first = await generateReport(teacherOf(world), {
      studentUserId: world.studentId,
      ...period,
    });
    if (!first.ok) throw new Error(first.message);
    // Compared field by field rather than as a string: `payload` is a jsonb
    // column and Postgres does not preserve key order, so two identical
    // documents serialise differently. Nothing may depend on that order.
    const saidThen = JSON.parse(JSON.stringify(first.payload));

    // Move the mastery underneath the stamp, the way the interventions suite
    // moves it underneath a baseline.
    await withTenant(world.organizationId, (tx) =>
      tx.studentConceptMastery.updateMany({
        where: { studentUserId: world.studentId },
        data: { estimate: 0.99, band: "SECURE" },
      }),
    );

    const reread = await getReport(teacherOf(world), first.reportId);
    // A parent shown "62% across 4 of 9" in September must be able to bring
    // that sheet in December and have it still say that.
    expect(reread!.payload).toEqual(saidThen);
  });

  it("supersedes rather than overwriting", async () => {
    const { world } = await measuredWorld();
    const first = await generateReport(teacherOf(world), {
      studentUserId: world.studentId,
      ...period,
    });
    if (!first.ok) throw new Error(first.message);

    const second = await generateReport(teacherOf(world), {
      studentUserId: world.studentId,
      ...period,
    });
    if (!second.ok) throw new Error(second.message);
    expect(second.reportId).not.toBe(first.reportId);

    // Both rows survive: "what did we tell this parent in September" is a
    // question somebody asks.
    const rows = await listReports(teacherOf(world), {
      studentUserId: world.studentId,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.superseded).toBe(false);
    expect(rows[1]!.superseded).toBe(true);
    expect(await getReport(teacherOf(world), first.reportId)).not.toBeNull();
  });

  it("stamps the shape it was written in", async () => {
    const { world } = await measuredWorld();
    const result = await generateReport(teacherOf(world), {
      studentUserId: world.studentId,
      ...period,
    });
    if (!result.ok) throw new Error(result.message);
    const stored = await getReport(teacherOf(world), result.reportId);
    // A stored document outlives the code that wrote it. Held against the
    // constant rather than a literal: what must be true is that the stamp is
    // the shape this build writes, not that the number is still 1 — and a
    // literal here would have to be edited on every version, which is how a
    // test stops meaning anything.
    expect(stored!.payloadVersion).toBe(PAYLOAD_VERSION);
  });
});

describe("what a report may say", () => {
  it("carries no overall grade anywhere in the payload", async () => {
    const { world } = await measuredWorld();
    const result = await generateReport(teacherOf(world), {
      studentUserId: world.studentId,
      ...period,
    });
    if (!result.ok) throw new Error(result.message);

    const serialised = JSON.stringify(result.payload);
    // The one number that must not exist. A report is where the pressure to
    // add it is strongest, because a report looks like a report card.
    expect(serialised).not.toMatch(/"overallScore"|"overall"|"grade"/);
  });

  it("carries the coverage denominator", async () => {
    const { world } = await measuredWorld();
    const result = await generateReport(teacherOf(world), {
      studentUserId: world.studentId,
      ...period,
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.payload.coverage.measured).toBeGreaterThan(0);
    // Every figure travels with what it was computed over.
    expect(result.payload.summary).toMatch(/\d/);
  });

  it("holds no free text a student wrote", async () => {
    const { world } = await measuredWorld();
    const result = await generateReport(teacherOf(world), {
      studentUserId: world.studentId,
      ...period,
    });
    if (!result.ok) throw new Error(result.message);

    const answers = await withTenant(world.organizationId, (tx) =>
      tx.attemptAnswer.findMany({
        where: { attempt: { studentUserId: world.studentId } },
        select: { response: true },
      }),
    );
    const serialised = JSON.stringify(result.payload);
    for (const answer of answers) {
      const text = (answer.response as { value?: unknown } | null)?.value;
      if (typeof text === "string" && text.length > 3) {
        expect(serialised).not.toContain(text);
      }
    }
  });
});

describe("the parent door", () => {
  async function linkParent(world: World) {
    const parentUserId = randomUUID();
    await withTenant(world.organizationId, async (tx) => {
      await tx.user.createMany({
        data: [
          {
            id: parentUserId,
            fullName: "A Parent",
            phone: `9${String(Date.now()).slice(-9)}`,
          },
        ],
      });
      await tx.membership.createMany({
        data: [
          {
            id: randomUUID(),
            organizationId: world.organizationId,
            userId: parentUserId,
            role: "PARENT",
            status: "ACTIVE",
          },
        ],
      });
      await tx.parentStudentLink.createMany({
        data: [
          {
            id: randomUUID(),
            organizationId: world.organizationId,
            parentUserId,
            studentUserId: world.studentId,
            relationship: "GUARDIAN",
            consentGrantedAt: new Date(),
            scope: { performance: true },
          },
        ],
      });
    });
    return { organizationId: world.organizationId, userId: parentUserId };
  }

  it("lets a linked parent read their child's report", async () => {
    const { world } = await measuredWorld();
    const written = await generateReport(teacherOf(world), {
      studentUserId: world.studentId,
      ...period,
    });
    if (!written.ok) throw new Error(written.message);

    const parent = await linkParent(world);
    const rows = await childReports(parent, world.studentId);
    expect(rows).toHaveLength(1);

    const one = await childReport(parent, written.reportId);
    expect(one).not.toBeNull();
    expect(one!.payloadVersion).toBe(PAYLOAD_VERSION);
  });

  it("refuses a report about a child they are not linked to", async () => {
    const { world } = await measuredWorld();
    const written = await generateReport(teacherOf(world), {
      studentUserId: world.studentId,
      ...period,
    });
    if (!written.ok) throw new Error(written.message);

    // A parent in the same organization, linked to nobody.
    const stranger = randomUUID();
    await withTenant(world.organizationId, async (tx) => {
      await tx.user.createMany({
        data: [
          {
            id: stranger,
            fullName: "Another Parent",
            phone: `8${String(Date.now()).slice(-9)}`,
          },
        ],
      });
      await tx.membership.createMany({
        data: [
          {
            id: randomUUID(),
            organizationId: world.organizationId,
            userId: stranger,
            role: "PARENT",
            status: "ACTIVE",
          },
        ],
      });
    });

    // A report id is not a capability: the consent check runs on the child the
    // report is about, resolved from the row rather than taken from the caller.
    const actor = { organizationId: world.organizationId, userId: stranger };
    expect(await childReport(actor, written.reportId)).toBeNull();
    expect(await childReports(actor, world.studentId)).toHaveLength(0);
  });

  it("stops at a revoked link", async () => {
    const { world } = await measuredWorld();
    const written = await generateReport(teacherOf(world), {
      studentUserId: world.studentId,
      ...period,
    });
    if (!written.ok) throw new Error(written.message);

    const parent = await linkParent(world);
    expect(await childReport(parent, written.reportId)).not.toBeNull();

    await withTenant(world.organizationId, (tx) =>
      tx.parentStudentLink.updateMany({
        where: { parentUserId: parent.userId },
        data: { revokedAt: new Date() },
      }),
    );

    // Revocation is a stamp, not a delete — and it takes effect on every read.
    expect(await childReport(parent, written.reportId)).toBeNull();
  });
});

describe("tenancy", () => {
  it("shows one organization nothing of another's", async () => {
    const { world } = await measuredWorld();
    const written = await generateReport(teacherOf(world), {
      studentUserId: world.studentId,
      ...period,
    });
    if (!written.ok) throw new Error(written.message);

    const other = await makeWorld();
    expect(await getReport(teacherOf(other), written.reportId)).toBeNull();
    expect(await listReports(teacherOf(other))).toHaveLength(0);
  });
});

describe("the letterhead is stamped, not looked up", () => {
  async function onInstitutePlan(world: World) {
    const institute = await prisma.plan.findFirstOrThrow({ where: { code: "institute" } });
    await withTenant(world.organizationId, (tx) =>
      tx.subscription.updateMany({
        where: { organizationId: world.organizationId },
        data: { planId: institute.id, status: "ACTIVE" },
      }),
    );
  }

  it("keeps the principal it was written under after the school changes it", async () => {
    const { world } = await measuredWorld();
    await onInstitutePlan(world);
    const saved = await saveBranding(teacherOf(world), {
      details: { principalName: "Mrs. First", address: "1 School Road", signatories: ["Principal"] },
      theme: {},
    });
    if (!saved.ok) throw new Error(saved.message);

    const written = await generateReport(teacherOf(world), { studentUserId: world.studentId, ...period });
    if (!written.ok) throw new Error(written.message);

    await saveBranding(teacherOf(world), { details: { principalName: "Mr. Second" }, theme: {} });

    const stored = await getReport(teacherOf(world), written.reportId);
    expect(stored?.letterhead?.principalName).toBe("Mrs. First");
    expect(stored?.letterhead?.address).toBe("1 School Road");
    expect(stored?.letterhead?.signatories).toEqual(["Principal"]);
  });

  it("stamps nothing for a school that is not branded", async () => {
    // teacher_pro includes reports and not branding.
    const { world } = await measuredWorld();
    const written = await generateReport(teacherOf(world), { studentUserId: world.studentId, ...period });
    if (!written.ok) throw new Error(written.message);
    expect((await getReport(teacherOf(world), written.reportId))?.letterhead).toBeNull();
  });
});

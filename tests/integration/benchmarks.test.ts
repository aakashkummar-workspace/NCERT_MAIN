import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  benchmarkForConcept,
  contributeFor,
  contributionState,
  MIN_MEASURED_TO_CONTRIBUTE,
  MIN_SCHOOLS,
  refreshContributions,
  setContributing,
} from "@/core/benchmarks";
import { median } from "@/core/benchmarks/compare";
import { conceptBenchmarkRow } from "@/db/benchmarks";
import { recomputeMastery } from "@/core/mastery/ledger";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Cross-school concept benchmarks.
 *
 * Every claim here is a refusal, because this is the feature most easily built
 * into a lie: the floor is on SCHOOLS, nothing identifies a school, a school
 * contributes only if it agreed, and withdrawing deletes rather than freezes.
 *
 * Each test works on a FRESH concept id — a uuid no concept row uses. The
 * benchmark table deliberately has no foreign key to `concepts` (the same
 * cross-plane reason `concept_evidence` has none), so this gives every run a
 * clean aggregate of exactly the schools it created. Sharing a real concept
 * would mean asserting counts against whatever previous runs left behind,
 * which is the trap this suite would otherwise walk into first.
 */

/** A school, and nothing else: the aggregate only needs contribution rows. */
async function school(): Promise<World> {
  return makeWorld();
}

/**
 * Publish one school's figure directly.
 *
 * The aggregate is what is under test here, not the computation that feeds it
 * — `contributeFor` gets its own tests below. Written inside the tenant, as
 * the job writes it.
 */
async function contributes(
  world: World,
  conceptId: string,
  mean: number,
  students = 8,
) {
  await withTenant(world.organizationId, (tx) =>
    tx.conceptBenchmark.createMany({
      data: [
        {
          id: randomUUID(),
          organizationId: world.organizationId,
          conceptId,
          measuredStudents: students,
          meanEstimate: mean,
        },
      ],
    }),
  );
}

/** Evidence, then a recomputation — never a hand-written estimate. */
async function giveEvidence(
  organizationId: string,
  studentUserId: string,
  conceptId: string,
  score: number,
  rows = 6,
) {
  await withTenant(organizationId, async (tx) => {
    await tx.conceptEvidence.createMany({
      data: Array.from({ length: rows }, (_, index) => ({
        id: randomUUID(),
        organizationId,
        studentUserId,
        conceptId,
        source: "ASSESSMENT" as const,
        score,
        difficulty: "MEDIUM" as const,
        weight: 1,
        observedAt: new Date(Date.now() - index * 3600_000),
      })),
    });
    await recomputeMastery(tx, organizationId, studentUserId, conceptId);
  });
}

/** A student on this school's roster, with no class of their own. */
async function studentIn(organizationId: string) {
  const userId = randomUUID();
  await withTenant(organizationId, async (tx) => {
    await tx.user.createMany({
      data: [{ id: userId, fullName: `Benchmark ${userId.slice(0, 6)}`, status: "ACTIVE" }],
    });
    await tx.membership.createMany({
      data: [
        {
          id: randomUUID(),
          organizationId,
          userId,
          role: "STUDENT",
          status: "ACTIVE",
          joinedAt: new Date(),
        },
      ],
    });
  });
  return userId;
}

describe("the floor is on schools, and it refuses below it", () => {
  it("says nothing at all until enough schools contribute", async () => {
    const conceptId = randomUUID();
    const means = [0.4, 0.55, 0.6, 0.75];

    // One short of the floor.
    for (const mean of means) {
      await contributes(await school(), conceptId, mean);
    }
    const short = await benchmarkForConcept(conceptId, "Ratio", 0.5);
    expect(short.ok).toBe(false);
    if (short.ok) return;
    expect(short.reason).toBe("too-few-schools");
    // Said in words. Silence on a page reads as a bug, and "not enough data"
    // does not say what would be enough.
    expect(short.message).toMatch(new RegExp(`${MIN_SCHOOLS} schools`));

    // The data was there all along: the refusal is the FLOOR, not an empty
    // table. Asked with a floor of one, the same query answers — which is the
    // point of holding the SQL and the TypeScript against each other.
    const unfloored = await conceptBenchmarkRow(conceptId, 1);
    expect(unfloored?.schools).toBe(means.length);

    // And the floor in SQL is the same floor: asked with the real one, the
    // function returns no row rather than leaving it to the caller to filter.
    expect(await conceptBenchmarkRow(conceptId, MIN_SCHOOLS)).toBeNull();
  });

  it("answers once the floor is reached, with a median over school means", async () => {
    const conceptId = randomUUID();
    const means = [0.35, 0.5, 0.62, 0.7, 0.9];
    for (const mean of means) {
      // Deliberately different sizes: each school gets ONE vote, so the
      // 400-student school must not drag the median.
      await contributes(await school(), conceptId, mean, mean === 0.9 ? 400 : 4);
    }

    const result = await benchmarkForConcept(conceptId, "Ratio", 0.45);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.benchmark.schools).toBe(5);
    // The pure function and percentile_cont agree on the same input, which is
    // what lets the unit tests stand in for the database everywhere else.
    expect(result.benchmark.median).toBeCloseTo(median(means)!, 3);
    expect(result.benchmark.students).toBe(400 + 4 * 4);
    expect(result.verdict).toBe("behind");
  });
});

describe("no school is identifiable, ever", () => {
  it("returns nothing that names, ranks or counts down to a school", async () => {
    const conceptId = randomUUID();
    const schools: World[] = [];
    for (const mean of [0.3, 0.45, 0.6, 0.7, 0.85, 0.9]) {
      const one = await school();
      schools.push(one);
      await contributes(one, conceptId, mean);
    }

    const result = await benchmarkForConcept(conceptId, "Ratio", 0.5);
    if (!result.ok) throw new Error("expected a benchmark");
    const serialised = JSON.stringify(result);

    // Not one of the six organizations is in the payload — not its id, not its
    // name, not its slug. The function's return shape has no column for one,
    // so this asserts a property rather than a habit.
    for (const one of schools) {
      expect(serialised).not.toContain(one.organizationId);
    }
    const names = await prisma.organization.findMany({
      where: { id: { in: schools.map((one) => one.organizationId) } },
      select: { name: true, slug: true },
    });
    for (const row of names) {
      expect(serialised).not.toContain(row.slug);
      expect(serialised).not.toContain(row.name);
    }

    // The standing grep, on the serialised payload this time.
    for (const forbidden of [/rank/i, /league/i, /percentile/i, /position/i]) {
      expect(serialised).not.toMatch(forbidden);
    }
  });
});

describe("contributing is opt-in", () => {
  it("publishes nothing for a school that never agreed", async () => {
    const world = await makeWorld();
    const conceptId = randomUUID();
    const students = await Promise.all([
      studentIn(world.organizationId),
      studentIn(world.organizationId),
      studentIn(world.organizationId),
    ]);
    for (const studentUserId of students) {
      await giveEvidence(world.organizationId, studentUserId, conceptId, 0.5);
    }

    // The job is handed ids by a SQL function that filters on the stamp, so a
    // school that declined is not merely skipped — it is never offered.
    await refreshContributions();
    const rows = await withTenant(world.organizationId, (tx) =>
      tx.conceptBenchmark.count({}),
    );
    expect(rows).toBe(0);

    const state = await contributionState(world.organizationId);
    expect(state.contributing).toBe(false);
    expect(state.concepts).toBe(0);
  });

  it("publishes a mean and a count once it does, and only where enough is measured", async () => {
    const world = await makeWorld();
    const thick = randomUUID();
    const thin = randomUUID();

    for (const score of [0.2, 0.5, 0.8]) {
      await giveEvidence(world.organizationId, await studentIn(world.organizationId), thick, score);
    }
    // One student on the other concept: below the bar, so it contributes
    // nothing rather than contributing noise into everybody else's median.
    await giveEvidence(world.organizationId, await studentIn(world.organizationId), thin, 0.9);

    await setContributing(teacherOf(world), true);
    const report = await contributeFor(world.organizationId);
    expect(report.concepts).toBe(1);
    expect(report.skippedThin).toBeGreaterThanOrEqual(1);

    const rows = await withTenant(world.organizationId, (tx) =>
      tx.conceptBenchmark.findMany({}),
    );
    expect(rows.map((row) => row.conceptId)).toEqual([thick]);
    expect(rows[0]!.measuredStudents).toBeGreaterThanOrEqual(MIN_MEASURED_TO_CONTRIBUTE);
    // A mean over students, and nothing about which student.
    const mean = Number(rows[0]!.meanEstimate);
    expect(mean).toBeGreaterThan(0);
    expect(mean).toBeLessThan(1);
    expect(Object.keys(rows[0]!)).not.toContain("studentUserId");
  });

  it("stops contributing a concept it no longer measures enough of", async () => {
    const world = await makeWorld();
    const conceptId = randomUUID();
    for (const score of [0.3, 0.6, 0.9]) {
      await giveEvidence(world.organizationId, await studentIn(world.organizationId), conceptId, score);
    }
    await setContributing(teacherOf(world), true);
    await contributeFor(world.organizationId);

    // The evidence goes, and with it the estimates — a class moved on, a
    // concept was unlinked, a student left.
    await withTenant(world.organizationId, async (tx) => {
      await tx.conceptEvidence.deleteMany({ where: { conceptId } });
      await tx.studentConceptMastery.deleteMany({ where: { conceptId } });
    });
    await contributeFor(world.organizationId);

    // A stale mean left behind would go on moving other schools' medians long
    // after the class that produced it, and nothing could explain it.
    const rows = await withTenant(world.organizationId, (tx) =>
      tx.conceptBenchmark.count({}),
    );
    expect(rows).toBe(0);
  });

  it("deletes what a school published when it withdraws", async () => {
    const world = await makeWorld();
    const conceptId = randomUUID();
    await contributes(world, conceptId, 0.5);
    await setContributing(teacherOf(world), true);

    const result = await setContributing(teacherOf(world), false);
    // A withdrawal that leaves the numbers in is not a withdrawal, and "we
    // stopped updating it" is not an answer anybody accepts a year later.
    expect(result.removed).toBe(1);
    const rows = await withTenant(world.organizationId, (tx) =>
      tx.conceptBenchmark.count({}),
    );
    expect(rows).toBe(0);
    expect((await contributionState(world.organizationId)).contributing).toBe(false);

    // Both halves are audited, because "did our figures come out" is asked
    // after the fact.
    const audits = await withTenant(world.organizationId, (tx) =>
      tx.auditLog.findMany({ where: { action: { startsWith: "benchmarks." } } }),
    );
    expect(audits.map((row) => row.action).sort()).toEqual([
      "benchmarks.opted_in",
      "benchmarks.opted_out",
    ]);
  });
});

describe("contributing is not the price of reading", () => {
  it("shows the benchmark to a school that contributes nothing", async () => {
    const conceptId = randomUUID();
    for (const mean of [0.4, 0.5, 0.6, 0.7, 0.8]) {
      await contributes(await school(), conceptId, mean);
    }

    const reader = await makeWorld();
    expect((await contributionState(reader.organizationId)).contributing).toBe(false);

    // A school that declines still gets the product it paid for. Charging for
    // the same thing twice — once in money, once in data — is how a product
    // that says it is on the customer's side stops being.
    const result = await benchmarkForConcept(conceptId, "Ratio", 0.45);
    expect(result.ok).toBe(true);
  });
});

describe("tenancy", () => {
  it("shows a school its own contribution and nobody else's", async () => {
    const conceptId = randomUUID();
    const mine = await makeWorld();
    const theirs = await makeWorld();
    await contributes(mine, conceptId, 0.4);
    await contributes(theirs, conceptId, 0.8);

    const rows = await withTenant(mine.organizationId, (tx) =>
      tx.conceptBenchmark.findMany({}),
    );
    // One row: RLS shows this school exactly its own, which is what makes the
    // aggregate the only way to see across them.
    expect(rows.length).toBe(1);
    expect(Number(rows[0]!.meanEstimate)).toBeCloseTo(0.4, 3);

    expect((await contributionState(mine.organizationId)).concepts).toBe(1);
    expect((await contributionState(theirs.organizationId)).concepts).toBe(1);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { assignmentMarksCsv, classMarksCsv } from "@/core/results/export";
import {
  getPlayer,
  saveAnswers,
  startAttempt,
  submitAttempt,
  type AnswerPatch,
} from "@/core/attempts";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Marks, exported.
 *
 * The claims worth a database: an unmarked answer leaves the product as an
 * empty cell rather than a nought, no mastery figure is smuggled into a
 * spreadsheet, and taking a copy of a class's marks leaves an audit row.
 */

const YEAR = { from: new Date("2026-04-01T00:00:00Z"), to: new Date("2027-03-31T00:00:00Z") };

/** Sit the paper, answering everything — including the written question. */
async function sit(world: World) {
  const actor = studentOf(world);
  const started = await startAttempt(actor, world.assignmentId, randomUUID());
  if (!started.ok) throw new Error(started.message);
  const player = await getPlayer(actor, started.attemptId);
  const patches: AnswerPatch[] = player!.questions.map((question, index) => ({
    assessmentQuestionId: question.assessmentQuestionId,
    response:
      question.type === "MCQ"
        ? { kind: "choice" as const, keys: ["A"] }
        : question.type === "TRUE_FALSE"
          ? { kind: "boolean" as const, value: true }
          : { kind: "text" as const, value: "Three paragraphs nobody has read yet." },
    clientSeq: index + 1,
  }));
  await saveAnswers(actor, started.attemptId, patches);
  await submitAttempt(actor, started.attemptId);
  return started.attemptId;
}

const cells = (csv: string, row: number) =>
  csv.replace(/^﻿/, "").trimEnd().split("\r\n")[row]!.split(",");

describe("one paper's marks", () => {
  it("exports a student who never sat it as blank, never as zero", async () => {
    const world = await makeWorld();
    const file = await assignmentMarksCsv(teacherOf(world), world.assignmentId);
    expect(file).not.toBeNull();

    const header = cells(file!.csv, 0);
    expect(header).toContain("marks");
    expect(header).toContain("fully_marked");

    // Nobody has sat it, so every marks cell is empty — and an empty cell is
    // the whole point: 0 would say they got everything wrong.
    const marksColumn = header.indexOf("marks");
    const rows = file!.csv.replace(/^﻿/, "").trimEnd().split("\r\n").slice(1);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.split(",")[marksColumn]).toBe("");
  });

  it("marks a paper with a written answer as not fully marked", async () => {
    const world = await makeWorld({ withWritten: true });
    await sit(world);

    const file = await assignmentMarksCsv(teacherOf(world), world.assignmentId);
    const header = cells(file!.csv, 0);
    const sat = file!.csv
      .replace(/^﻿/, "")
      .trimEnd()
      .split("\r\n")
      .slice(1)
      .map((row) => row.split(","))
      .find((row) => row[header.indexOf("status")] === "submitted");

    // The score so far, AND the flag that says a person still owes marks on
    // it. The number alone would be read as final by the one system that
    // cannot ask.
    expect(sat?.[header.indexOf("fully_marked")]).toBe("no");
    expect(Number(sat?.[header.indexOf("marks_pending")])).toBeGreaterThan(0);
  });

  it("carries marks and never mastery", async () => {
    const world = await makeWorld();
    await sit(world);
    const file = await assignmentMarksCsv(teacherOf(world), world.assignmentId);
    for (const forbidden of ["mastery", "estimate", "band", "concept"]) {
      expect(file!.csv.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("leaves an audit row, because a copy of a class's marks left the product", async () => {
    const world = await makeWorld();
    await assignmentMarksCsv(teacherOf(world), world.assignmentId);

    const audits = await withTenant(world.organizationId, (tx) =>
      tx.auditLog.findMany({ where: { action: "results.exported" } }),
    );
    expect(audits.length).toBe(1);
    expect(audits[0]!.entityId).toBe(world.assignmentId);
  });
});

describe("a class's register", () => {
  it("is one row per student and two columns per paper", async () => {
    const world = await makeWorld();
    await sit(world);

    const file = await classMarksCsv(teacherOf(world), world.classId, YEAR);
    expect(file).not.toBeNull();
    const header = cells(file!.csv, 0);
    expect(header.slice(0, 2)).toEqual(["roll_number", "student"]);
    // Title and "out of" for the world's one paper.
    expect(header.length).toBe(4);

    const rows = file!.csv.replace(/^﻿/, "").trimEnd().split("\r\n").slice(1);
    expect(rows.length).toBe(2); // the world has two students
  });

  it("says when a paper is only part marked, rather than printing a final mark", async () => {
    const world = await makeWorld({ withWritten: true });
    await sit(world);

    const file = await classMarksCsv(teacherOf(world), world.classId, YEAR);
    expect(file!.csv).toContain("part marked");
  });
});

describe("tenancy", () => {
  it("shows one organization nothing of another's marks", async () => {
    const world = await makeWorld();
    const other = await makeWorld();
    expect(await assignmentMarksCsv(teacherOf(other), world.assignmentId)).toBeNull();
    expect(await classMarksCsv(teacherOf(other), world.classId, YEAR)).toBeNull();
  });
});

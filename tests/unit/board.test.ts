import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildSystem as buildGenerationSystem } from "@/ai/tasks/generate-questions";
import { buildSystem as buildValidationSystem } from "@/ai/tasks/validate-questions";
import { buildSystem as buildTutorSystem } from "@/ai/tasks/tutor";
import { buildSystem as buildCopilotSystem } from "@/ai/tasks/copilot";
import { buildSystem as buildInsightSystem } from "@/ai/tasks/class-insight";

/**
 * Multi-board, in the parts that are decidable without a database.
 *
 * The database half — that the board comes from the organization, that a
 * change is refused once work exists, that a class cannot be created against
 * another board's grade — is in tests/integration/board.test.ts, because every
 * one of those claims is about rows.
 */

const CBSE = "Central Board of Secondary Education";
const ICSE = "Indian Certificate of Secondary Education";

function generationContext(boardName: string) {
  return {
    organizationId: "org",
    userId: "user",
    boardName,
    subjectName: "Mathematics",
    gradeLabel: "Class 10",
    chapterTitle: "Triangles",
    outcomes: [
      { code: "SIM-2", statement: "Prove two triangles similar" },
      { code: "SIM-1", statement: "State the similarity criteria" },
    ],
    exemplars: [],
    count: 3,
    types: ["MCQ"],
    difficulty: "MEDIUM" as const,
    marks: 1,
    avoid: [],
  };
}

describe("the board in an AI prompt", () => {
  it("names the board it was given, not a hard-coded one", () => {
    const system = buildGenerationSystem(generationContext(ICSE));
    expect(system).toContain(ICSE);
    expect(system).not.toContain("CBSE");
  });

  it("is stable, so the prefix still caches", () => {
    // The cache breakpoint rule: the same inputs must produce a byte-identical
    // prefix, and the board name is stable per organization, so it cannot move
    // between two calls from the same school.
    const first = buildGenerationSystem(generationContext(ICSE));
    const second = buildGenerationSystem({
      ...generationContext(ICSE),
      // Below-the-line inputs changed; the prefix must not notice.
      count: 8,
      avoid: ["something already in the bank"],
      outcomes: [...generationContext(ICSE).outcomes].reverse(),
    });
    expect(first).toBe(second);
  });

  it("makes a second board a SECOND prefix, which is the cost we accepted", () => {
    // Stated as a test rather than as a comment, because it is the one
    // consequence of this decision somebody paying the bill would want to see
    // written down: two boards do not share a cached prefix.
    expect(buildGenerationSystem(generationContext(CBSE))).not.toBe(
      buildGenerationSystem(generationContext(ICSE)),
    );
  });

  it("carries the board into validation too", () => {
    const system = buildValidationSystem({
      organizationId: "org",
      userId: "user",
      boardName: ICSE,
      gradeLabel: "Class 10",
      subjectName: "Mathematics",
      chapterTitle: "Triangles",
      outcomes: [{ code: "SIM-1", statement: "State the criteria" }],
      questions: [],
    });
    expect(system).toContain(ICSE);
    expect(system).not.toContain("CBSE");
  });
});

describe("the three shared prompts", () => {
  /**
   * The tutor, the Copilot and the class note take no context: one system
   * prompt serves every school on every board. Naming a board up there would
   * split one cached prefix into one per board — on DEEP-tier rates, for the
   * Copilot — so the board travels in the request instead, below the
   * breakpoint. What must be true is that none of them ASSERTS a board.
   */
  it("assert no board in the cached prefix", () => {
    const prompts = [
      buildTutorSystem("HINT"),
      buildCopilotSystem(),
      buildInsightSystem(),
    ];
    for (const prompt of prompts) {
      expect(prompt).not.toContain("CBSE");
      expect(prompt).not.toContain("ICSE");
    }
  });

  it("stay byte-identical between calls", () => {
    expect(buildCopilotSystem()).toBe(buildCopilotSystem());
    expect(buildInsightSystem()).toBe(buildInsightSystem());
    expect(buildTutorSystem("HINT")).toBe(buildTutorSystem("HINT"));
  });
});

describe("the curriculum read", () => {
  /**
   * The default parameter that made this product CBSE-only.
   *
   * A source-text assertion, deliberately: the failure it guards against is
   * somebody restoring `boardCode = "CBSE"` as a convenience while fixing an
   * unrelated call site, and no behavioural test catches that — a defaulted
   * read returns a perfectly good answer, just about the wrong school.
   */
  it("has no defaulted board", () => {
    // Comments are stripped first: the file EXPLAINS the removed default at
    // length, and a test that could not tell the explanation from the thing
    // explained would have to be deleted the first time somebody documented it.
    const source = code(readFileSync("src/core/curriculum/index.ts", "utf8"));
    expect(source).not.toMatch(/board(Code|Id)\s*\??\s*:\s*string\s*=/);
    expect(source).not.toMatch(/board(Code|Id)\s*=\s*["']/);
  });

  it("is not reachable with a board from a request anywhere", () => {
    // The rule from CLAUDE.md, applied to the new column: the board comes from
    // the session's organization. The one exception is signup, where there is
    // no organization yet — and that route validates the code rather than
    // trusting it.
    const sources = [
      "src/core/curriculum/index.ts",
      "src/core/curriculum/picker.ts",
      "src/core/organizations/index.ts",
    ].map((path) => code(readFileSync(path, "utf8")));

    for (const source of sources) {
      expect(source).not.toContain("X-Board");
      expect(source).not.toContain("searchParams");
    }
  });
});

/** Source with comments removed, so a test reads code rather than prose. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

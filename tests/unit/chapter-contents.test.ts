import { describe, expect, it } from "vitest";
import { parseChapterContents } from "@/core/curriculum/chapter-contents";

const valid = {
  version: 1,
  source: { book: "jemh1", bookTitle: "Mathematics", chapter: 6 },
  title: "Triangles",
  pages: 26,
  author: null,
  form: null,
  overview: "Similar figures, similarity of triangles and the criteria for it.",
  sections: [
    {
      number: "6.2",
      title: "Similar Figures",
      points: ["All circles are similar."],
      subsections: [{ number: null, title: "", points: [] }],
    },
    { number: "6.3", title: "  ", points: [] },
  ],
  keyTerms: [{ term: "Similar", meaning: "Same shape" }, { term: "Orphan" }],
  keyResults: [{ label: "Theorem 6.1", statement: "Basic Proportionality Theorem" }],
  activities: ["Activity 1", 7],
  exercises: [{ name: "EXERCISE 6.1", questions: 3 }, { name: "EXERCISE 6.2", questions: -1 }],
  bookSummary: [],
  notes: null,
};

describe("parseChapterContents", () => {
  it("reads a version 1 block and drops malformed entries rather than drawing them", () => {
    const parsed = parseChapterContents(valid);
    expect(parsed).not.toBeNull();
    expect(parsed!.bookChapter).toBe(6);
    expect(parsed!.sections).toHaveLength(1);
    expect(parsed!.sections[0]?.subsections).toHaveLength(0);
    expect(parsed!.keyTerms).toEqual([{ term: "Similar", meaning: "Same shape" }]);
    expect(parsed!.activities).toEqual(["Activity 1"]);
    expect(parsed!.exercises).toEqual([
      { name: "EXERCISE 6.1", questions: 3 },
      { name: "EXERCISE 6.2", questions: null },
    ]);
  });

  it("refuses an unknown version, a missing overview or a non-object", () => {
    expect(parseChapterContents({ ...valid, version: 2 })).toBeNull();
    expect(parseChapterContents({ ...valid, overview: "" })).toBeNull();
    expect(parseChapterContents(null)).toBeNull();
    expect(parseChapterContents("contents")).toBeNull();
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bookLinkFor, describeBookLink, keywords, sectionAnchor } from "@/core/curriculum/book-link";
import type { ChapterContents } from "@/core/curriculum/chapter-contents";

/**
 * Run against the REAL imported contents of Class 10 Mathematics, because a
 * matcher tested only on words written for the test proves nothing about the
 * book it will actually be pointed at.
 */
type FileChapter = {
  bookChapter: number;
  title: string;
  overview: string;
  sections: { number: string; title: string; points: string[]; subsections?: [] }[];
};
const file = JSON.parse(
  readFileSync("prisma/chapter-contents/jemh1.json", "utf-8"),
) as { bookTitle: string; chapters: FileChapter[] };

function chapter(number: number): { contents: ChapterContents; title: string } {
  const raw = file.chapters.find((c) => c.bookChapter === number)!;
  return {
    title: raw.title,
    contents: {
      book: "jemh1",
      bookTitle: file.bookTitle,
      bookChapter: raw.bookChapter,
      pages: null,
      author: null,
      form: null,
      overview: raw.overview,
      sections: raw.sections.map((s) => ({
        number: s.number,
        title: s.title,
        points: s.points,
        subsections: [],
      })),
      keyTerms: [],
      keyResults: [],
      activities: [],
      exercises: [],
      bookSummary: [],
      notes: null,
    },
  };
}

describe("finding the section an idea lives in", () => {
  it("sends similarity criteria to 6.4, not to 6.3", () => {
    const { contents, title } = chapter(6);
    const link = bookLinkFor(contents, title, "Similarity of triangles", [
      "Uses the AA, SSS and SAS criteria to decide whether two triangles are similar",
    ]);
    expect(link.section?.number).toBe("6.4");
  });

  it("sends the nth term of an AP to 5.3", () => {
    const { contents, title } = chapter(5);
    const link = bookLinkFor(contents, title, "nth term of an AP", ["Finds the nth term of an arithmetic progression"]);
    expect(link.section?.number).toBe("5.3");
  });

  it("sends the distance formula to 7.2", () => {
    const { contents, title } = chapter(7);
    const link = bookLinkFor(contents, title, "Distance between two points", ["Calculates the distance between two points using the distance formula"]);
    expect(link.section?.number).toBe("7.2");
  });

  it("names no section whose heading shares none of the idea's own name", () => {
    // The statements match the tangents section's body at length; the name
    // is about the radius, and neither tangent section is headed with it.
    const { contents, title } = chapter(10);
    const link = bookLinkFor(contents, title, "Radius perpendicular at the point of contact", [
      "Proves that the tangent at any point of a circle is perpendicular to the radius through the point of contact",
    ]);
    expect(link.section).toBeNull();
  });

  it("falls back to the chapter when nothing is a clear match", () => {
    const { contents, title } = chapter(6);
    const link = bookLinkFor(contents, title, "Revision");
    expect(link.section).toBeNull();
    expect(describeBookLink(link)).toBe("Mathematics, chapter 6 (Triangles)");
  });

  it("never names the introduction or the summary", () => {
    const { contents, title } = chapter(6);
    const link = bookLinkFor(contents, title, "Summary introduction triangles similar figures");
    expect(link.section?.title ?? "").not.toMatch(/Introduction|Summary/);
  });
});

describe("the pieces", () => {
  it("stems plurals so triangles meets triangle, and drops filler", () => {
    expect([...keywords("Triangles and the triangle")]).toEqual(["triangle"]);
    expect(keywords("Explain what the student should find").size).toBe(0);
  });

  it("builds an anchor the syllabus page can carry", () => {
    expect(sectionAnchor("abc", "6.4")).toBe("ch-abc-s-6-4");
    expect(sectionAnchor("abc", null)).toBe("ch-abc");
  });
});

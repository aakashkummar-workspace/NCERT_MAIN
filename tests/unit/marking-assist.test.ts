import { describe, expect, it } from "vitest";
import { checkDraft } from "@/core/marking-assist/check";
import { MAX_ANSWER_IMAGE_BYTES, sniffAnswerImage } from "@/core/marking-assist/image";

const scheme = {
  maxMarks: 5,
  rows: [
    { id: "method", marks: 2 },
    { id: "working", marks: 2 },
    { id: "answer", marks: 1 },
  ],
};

const rows = (...marks: number[]) =>
  marks.map((value, index) => ({ index, marks: value, reason: `row ${index}` }));

describe("checking a drafted mark", () => {
  it("derives the total from the rows, ignoring the model's own sum", () => {
    const checked = checkDraft({ readable: true, criteria: rows(2, 1.5, 0), total: 5 }, scheme);
    expect(checked).toMatchObject({ ok: true, total: 3.5 });
    if (checked.ok) expect(checked.criteria!.map((row) => row.criterionId)).toEqual(["method", "working", "answer"]);
  });

  it("refuses a row marked above its worth rather than clamping it", () => {
    expect(checkDraft({ readable: true, criteria: rows(3, 1, 1), total: 5 }, scheme).ok).toBe(false);
  });

  it("refuses marks that are not in halves", () => {
    expect(checkDraft({ readable: true, criteria: rows(1.3, 1, 1), total: 3.3 }, scheme).ok).toBe(false);
  });

  it("refuses a row the scheme does not have, a row twice, and a row missed", () => {
    const extra = [...rows(1, 1, 1), { index: 3, marks: 1, reason: "" }];
    expect(checkDraft({ readable: true, criteria: extra, total: 4 }, scheme).ok).toBe(false);
    const twice = [{ index: 0, marks: 1, reason: "" }, { index: 0, marks: 1, reason: "" }, { index: 1, marks: 1, reason: "" }];
    expect(checkDraft({ readable: true, criteria: twice, total: 3 }, scheme).ok).toBe(false);
    expect(checkDraft({ readable: true, criteria: rows(1, 1), total: 2 }, scheme).ok).toBe(false);
  });

  it("carries no marks at all for an unreadable answer", () => {
    const checked = checkDraft({ readable: false, criteria: rows(2, 2, 1), total: 5 }, scheme);
    expect(checked).toEqual({ ok: true, readable: false, total: null, criteria: null });
  });

  it("holds a total to the question's marks when there is no scheme", () => {
    const open = { maxMarks: 3, rows: null };
    expect(checkDraft({ readable: true, criteria: [], total: 2.5 }, open)).toMatchObject({ ok: true, total: 2.5 });
    expect(checkDraft({ readable: true, criteria: [], total: 4 }, open).ok).toBe(false);
    expect(checkDraft({ readable: true, criteria: [], total: -1 }, open).ok).toBe(false);
  });
});

describe("what an answer photo may be", () => {
  it("is typed by its bytes", () => {
    expect(sniffAnswerImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ ok: true, mime: "image/jpeg" });
    expect(
      sniffAnswerImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toEqual({ ok: true, mime: "image/png" });
  });

  it("refuses SVG, empty files and oversized ones", () => {
    expect(sniffAnswerImage(new TextEncoder().encode("<svg></svg>")).ok).toBe(false);
    expect(sniffAnswerImage(new Uint8Array()).ok).toBe(false);
    const big = new Uint8Array(MAX_ANSWER_IMAGE_BYTES + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect(sniffAnswerImage(big).ok).toBe(false);
  });
});

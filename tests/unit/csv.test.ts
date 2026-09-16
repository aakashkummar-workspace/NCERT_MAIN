import { describe, expect, it } from "vitest";
import { csvFilename, toCsv } from "@/core/results/csv";

/**
 * The CSV formatter.
 *
 * The claim that matters is the one about null: an unmarked answer must reach a
 * spreadsheet as an empty cell, never as a zero, because the spreadsheet is
 * what becomes a report card.
 */

const body = (csv: string) => csv.replace(/^﻿/, "").trimEnd().split("\r\n");

describe("an empty cell is not a zero", () => {
  it("writes null and undefined as empty, and 0 as 0", () => {
    const [row] = body(toCsv([[null, undefined, 0]]));
    expect(row).toBe(",,0");
  });
});

describe("escaping", () => {
  it("quotes a field holding a comma, and doubles an inner quote", () => {
    const [row] = body(toCsv([[`Nair, Meera`, `She said "hello"`]]));
    expect(row).toBe(`"Nair, Meera","She said ""hello"""`);
  });

  it("quotes a field holding a newline rather than splitting the record", () => {
    // Records are separated by CRLF; a line break INSIDE a quoted field is part
    // of the value. A paper titled over two lines must not produce a second
    // student row in the register.
    const rows = body(toCsv([["one\ntwo", "end"]]));
    expect(rows.length).toBe(1);
    expect(rows[0]).toBe(`"one\ntwo",end`);
  });

  it("leaves an ordinary field alone", () => {
    expect(body(toCsv([["Arun Kumar", 17]]))[0]).toBe("Arun Kumar,17");
  });
});

describe("what a spreadsheet needs to open it correctly", () => {
  it("starts with a byte-order mark, or Excel mangles a Hindi name", () => {
    expect(toCsv([["नाम"]]).startsWith("﻿")).toBe(true);
  });

  it("ends every row with CRLF, as RFC 4180 says", () => {
    expect(toCsv([["a"], ["b"]])).toBe("﻿a\r\nb\r\n");
  });
});

describe("the filename", () => {
  it("is something findable in a downloads folder weeks later", () => {
    expect(csvFilename("Class 10-A", "Unit Test 2", "marks")).toBe(
      "class-10-a-unit-test-2-marks.csv",
    );
  });

  it("drops punctuation that a filesystem or a header would argue about", () => {
    expect(csvFilename(`St. Mary's / "Half Yearly"`)).toBe("st-marys-half-yearly.csv");
  });

  it("never returns a bare extension", () => {
    expect(csvFilename("!!!")).toBe("export.csv");
  });
});

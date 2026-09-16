import { describe, expect, it } from "vitest";
import { currentAcademicYear } from "@/core/curriculum";

describe("currentAcademicYear", () => {
  it("starts a new year in April, not January", () => {
    // India's school year runs April to March. A class created in February
    // belongs to the year that began the previous April; getting this wrong
    // files a whole term's results under the wrong year.
    expect(currentAcademicYear(new Date("2026-04-01T00:00:00Z"))).toBe("2026-27");
    expect(currentAcademicYear(new Date("2026-03-31T00:00:00Z"))).toBe("2025-26");
  });

  it("holds across the calendar boundary", () => {
    expect(currentAcademicYear(new Date("2026-12-31T00:00:00Z"))).toBe("2026-27");
    expect(currentAcademicYear(new Date("2027-01-01T00:00:00Z"))).toBe("2026-27");
  });

  it("pads the second year to two digits", () => {
    expect(currentAcademicYear(new Date("2099-06-01T00:00:00Z"))).toBe("2099-00");
  });
});

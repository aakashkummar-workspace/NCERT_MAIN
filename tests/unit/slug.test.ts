import { describe, expect, it } from "vitest";
import { slugify } from "@/core/identity/slug";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Sunrise Public School")).toBe("sunrise-public-school");
  });

  it("strips punctuation without leaving stray hyphens", () => {
    expect(slugify("  Priya's Maths & Science Centre!  ")).toBe(
      "priya-s-maths-science-centre",
    );
  });

  it("keeps non-Latin letters rather than emptying the slug", () => {
    // A Devanagari centre name must not become "org".
    expect(slugify("गणित केंद्र")).not.toBe("org");
  });

  it("falls back to org when nothing survives", () => {
    expect(slugify("!!!")).toBe("org");
    expect(slugify("")).toBe("org");
  });

  it("caps length", () => {
    expect(slugify("a".repeat(200)).length).toBeLessThanOrEqual(48);
  });
});

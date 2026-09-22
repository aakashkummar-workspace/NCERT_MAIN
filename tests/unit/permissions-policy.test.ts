import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

/**
 * The Permissions-Policy header decides what the browser lets the page use,
 * and a feature it forbids fails silently: `microphone=()` shipped for months
 * while voice input for written answers could never start, and no test looked.
 */
async function policy(): Promise<Map<string, string>> {
  const rules = (await nextConfig.headers!()) ?? [];
  const value = rules
    .flatMap((rule) => rule.headers)
    .find((header) => header.key === "Permissions-Policy")?.value;
  if (!value) throw new Error("No Permissions-Policy header is set.");
  return new Map(
    value.split(",").map((part) => {
      const [feature, allow] = part.trim().split("=");
      return [feature!, allow!];
    }),
  );
}

describe("the Permissions-Policy header", () => {
  it("lets this site use the microphone, because voice input needs it", async () => {
    expect((await policy()).get("microphone")).toBe("(self)");
  });

  it("keeps everything else it does not need switched off", async () => {
    const rules = await policy();
    // Photo answers use a file input with `capture`, which needs no camera
    // permission; nothing here reads a location.
    expect(rules.get("camera")).toBe("()");
    expect(rules.get("geolocation")).toBe("()");
  });
});

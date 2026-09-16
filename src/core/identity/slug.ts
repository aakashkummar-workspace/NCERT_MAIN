/**
 * Organisation slugs. Pure — no database, no server-only import — so it is
 * testable in isolation and reusable on either side of the wire.
 */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      // Unicode-aware: a Devanagari centre name must not collapse to "org".
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/, "") || "org"
  );
}

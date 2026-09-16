/**
 * What a logo upload may be.
 *
 * Pure, so the refusal is unit-tested without a request.
 *
 * ---------------------------------------------------------------------------
 * The type comes from the bytes, never from the browser
 * ---------------------------------------------------------------------------
 * A multipart part carries a Content-Type the uploader chose, and a filename
 * that is only a suggestion. Neither is evidence. The first bytes of the file
 * are, so the served type is decided from those and the declared one is
 * ignored — SECURITY_MODEL.md's upload rule, first applied here.
 *
 * ---------------------------------------------------------------------------
 * No SVG, and that is the decision rather than a gap
 * ---------------------------------------------------------------------------
 * SVG is the logo format a designer will hand a school, and it is a document
 * that can carry `<script>` and event handlers. Served from our origin it runs
 * as our origin — with a teacher's session cookie in reach. Sanitising SVG
 * correctly is a project with a CVE history of its own; refusing it costs the
 * office one "export as PNG".
 */

export const MAX_LOGO_BYTES = 512 * 1024;

export type LogoMime = "image/png" | "image/jpeg" | "image/webp";

export type LogoVerdict =
  | { ok: true; mime: LogoMime }
  | { ok: false; message: string };

export function sniffLogo(bytes: Uint8Array): LogoVerdict {
  if (bytes.byteLength === 0) {
    return { ok: false, message: "That file is empty." };
  }
  if (bytes.byteLength > MAX_LOGO_BYTES) {
    return {
      ok: false,
      message: `A logo can be at most ${MAX_LOGO_BYTES / 1024} KB. Export it at a smaller size — it is shown at about 40 pixels tall.`,
    };
  }

  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);

  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return { ok: true, mime: "image/png" };
  }
  if (starts(0xff, 0xd8, 0xff)) {
    return { ok: true, mime: "image/jpeg" };
  }
  // RIFF....WEBP
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { ok: true, mime: "image/webp" };
  }

  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) {
    return {
      ok: false,
      message: "SVG logos are not accepted, because an SVG file can contain code. Export it as a PNG instead.",
    };
  }

  return { ok: false, message: "A logo must be a PNG, JPEG or WebP image." };
}

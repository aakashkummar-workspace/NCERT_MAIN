/**
 * What an answer photo may be. Pure, so the refusals are unit-tested.
 *
 * The type comes from the first bytes, never from the upload's declared
 * Content-Type or filename — SECURITY_MODEL.md's upload rule, as for logos.
 * No SVG, no HEIC: the browser re-encodes to JPEG before it sends (see the
 * uploader), so anything else arriving here did not come from our screen.
 */

/** After the browser has shrunk it: a 1600-pixel JPEG is well under this. */
export const MAX_ANSWER_IMAGE_BYTES = 2 * 1024 * 1024;
/** A written answer runs to a page or two; three photos cover a long answer. */
export const MAX_IMAGES_PER_ANSWER = 3;

export type AnswerImageMime = "image/jpeg" | "image/png" | "image/webp";

export function sniffAnswerImage(
  bytes: Uint8Array,
): { ok: true; mime: AnswerImageMime } | { ok: false; message: string } {
  if (bytes.byteLength === 0) return { ok: false, message: "That photo is empty." };
  if (bytes.byteLength > MAX_ANSWER_IMAGE_BYTES) {
    return {
      ok: false,
      message: "That photo is too large. Take it again, a little further away.",
    };
  }
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  if (starts(0xff, 0xd8, 0xff)) return { ok: true, mime: "image/jpeg" };
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { ok: true, mime: "image/png" };
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { ok: true, mime: "image/webp" };
  }
  return { ok: false, message: "A photo must be a JPEG, PNG or WebP image." };
}

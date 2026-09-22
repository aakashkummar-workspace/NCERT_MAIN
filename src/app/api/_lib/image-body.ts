import { MAX_ANSWER_IMAGE_BYTES } from "@/core/marking-assist/image";

/**
 * The raw bytes of an uploaded photo, refused before reading when the
 * declared length is already too large — a 40 MB upload should not be read
 * into memory only to be told it is too big.
 *
 * The body is the image itself (the uploader sends a Blob), so there is no
 * multipart part to trust or distrust: the type is decided from the bytes.
 */
export async function readImageBody(
  request: Request,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; message: string }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_ANSWER_IMAGE_BYTES) {
    return { ok: false, message: "That photo is too large. Take it again, a little further away." };
  }
  const buffer = await request.arrayBuffer();
  return { ok: true, bytes: new Uint8Array(buffer) };
}

/** The response every answer photo is served with — the logo rules. */
export function imageResponse(image: { mime: string; bytes: Uint8Array }) {
  return new Response(Buffer.from(image.bytes), {
    status: 200,
    headers: {
      "Content-Type": image.mime,
      "Content-Length": String(image.bytes.byteLength),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
      // A child's handwriting: never in a shared cache.
      "Cache-Control": "private, max-age=3600",
    },
  });
}

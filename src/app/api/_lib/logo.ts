/**
 * The response every logo is served with.
 *
 * The type is the one sniffed at upload, `nosniff` stops a browser guessing a
 * different one, and the CSP means that even a file which somehow rendered as a
 * document could run nothing.
 *
 * A logo row never changes, so a signed-in URL is cacheable for as long as a
 * browser will keep it. The public one is not immutable in the same way: it
 * answers only while that logo is the school's CURRENT one and the plan still
 * includes branding, so it is cached for a day rather than a year.
 */
export function logoResponse(
  logo: { mime: string; bytes: Uint8Array },
  visibility: "private" | "public",
) {
  return new Response(Buffer.from(logo.bytes), {
    status: 200,
    headers: {
      "Content-Type": logo.mime,
      "Content-Length": String(logo.bytes.byteLength),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
      "Cache-Control":
        visibility === "private"
          ? "private, max-age=31536000, immutable"
          : "public, max-age=86400",
    },
  });
}

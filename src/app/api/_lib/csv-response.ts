/**
 * A CSV, as a download.
 *
 * `attachment` with the filename, so it lands in a downloads folder rather than
 * rendering as text in a tab; `no-store`, because a marks file is a snapshot of
 * a moment and a cached copy is a wrong answer to "what does the register say
 * now"; and `nosniff`, because the one thing a browser must not do with this is
 * decide it is something else.
 */
export function csvResponse(file: { filename: string; csv: string }): Response {
  return new Response(file.csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

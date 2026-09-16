"use client";

/**
 * Save this report.
 *
 * The browser's own print dialogue, which every platform turns into "Save as
 * PDF" — including a phone. `report.css` carries the print rules that make the
 * result a document rather than a screenshot of an app, so this button is the
 * whole of the "downloadable term report" the brief asks for.
 *
 * A server-side PDF library was the alternative: a large dependency producing a
 * file that ignores the reader's font size, on a path that must not fail, and
 * it would still need the same stylesheet to look like anything.
 */
export function PrintButton() {
  return (
    <button
      type="button"
      className="ui-button"
      data-variant="secondary"
      data-size="md"
      onClick={() => window.print()}
    >
      <span>Save or print</span>
    </button>
  );
}

/**
 * Turning rows into a CSV a school's own software will actually open.
 *
 * Pure, so the escaping is unit-tested without a database.
 *
 * ---------------------------------------------------------------------------
 * An empty cell is not a zero
 * ---------------------------------------------------------------------------
 * `null` becomes an empty cell and `0` becomes `0`, and the difference is the
 * whole point of this file: an unmarked three-mark answer exported as 0 tells a
 * spreadsheet the student got it wrong, and the spreadsheet is what becomes a
 * report card. It is the same rule the webhook payload follows at the same kind
 * of boundary — the last place anybody downstream could put the distinction
 * back.
 */

export type Cell = string | number | null | undefined | Date;

/** Excel on Windows reads a CSV as the system codepage unless it sees this. */
const BOM = "﻿";

const DATE = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});

function cell(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return DATE.format(value);
  const text = String(value);
  // A field is quoted when it holds a comma, a quote or a newline — and a
  // quote inside is doubled. A student's name can hold all three.
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Rows to a CSV document.
 *
 * CRLF line endings, because that is what RFC 4180 says and what a decade of
 * school office software expects.
 */
export function toCsv(rows: Cell[][]): string {
  return BOM + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

/**
 * A filename somebody can find again in their downloads folder six weeks later.
 *
 * Spaces and punctuation out, because this travels in a Content-Disposition
 * header and lands in a folder somebody will search by name.
 */
export function csvFilename(...parts: string[]): string {
  const slug = parts
    .join("-")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
  return `${slug || "export"}.csv`;
}

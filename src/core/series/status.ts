import { assignmentStatus, type Window } from "@/core/assignments/window";

/**
 * What a series is doing, derived from its papers.
 *
 * ---------------------------------------------------------------------------
 * Why there is no status column
 * ---------------------------------------------------------------------------
 * The same reason an assignment has none. Upcoming, running and finished are a
 * function of the papers' own windows and the current time; storing it would
 * mean a job flipping rows and, between ticks, a series whose status is a lie —
 * a class told the half-yearly is over while the last paper's window is open.
 *
 * Derived it cannot drift, needs no cron, and is the same answer on every
 * server. Pure — no database, no `server-only` — so the badge a teacher sees
 * in the browser and the figure the server renders are the same function.
 */

export type SeriesStatus =
  /** Named, and holding nothing yet. A real state, not an error. */
  | "EMPTY"
  /** Every paper still to open. */
  | "UPCOMING"
  /** A paper open now, or some finished with others still to come. */
  | "RUNNING"
  /** Every paper's window has shut. */
  | "FINISHED"
  /** Withdrawn. The papers are untouched; only the grouping is gone. */
  | "WITHDRAWN";

export function seriesStatus(
  series: { cancelledAt?: Date | null },
  papers: Window[],
  now = new Date(),
): SeriesStatus {
  if (series.cancelledAt) return "WITHDRAWN";

  // A cancelled paper is not part of what the series is doing. It is still
  // listed — a paper somebody called off is a fact about the term — but a
  // half-yearly whose last paper was cancelled has finished, not stalled.
  const live = papers
    .map((paper) => assignmentStatus(paper, now))
    .filter((status) => status !== "CANCELLED");

  if (live.length === 0) return "EMPTY";
  if (live.some((status) => status === "OPEN")) return "RUNNING";
  if (live.every((status) => status === "SCHEDULED")) return "UPCOMING";
  if (live.every((status) => status === "CLOSED")) return "FINISHED";
  // Some shut, some still to open: the series is under way even though nothing
  // is open at this exact minute — which is most of a half-yearly week.
  return "RUNNING";
}

/**
 * The span a series covers, from its papers.
 *
 * Null when it holds nothing. There is no stored schedule for the same reason
 * there is no stored status: the dates a teacher cares about are the windows
 * they already set on each paper, and a second copy is a second copy that
 * drifts.
 */
export function seriesSpan(
  papers: { opensAt: Date; closesAt: Date; cancelledAt?: Date | null }[],
): { from: Date; to: Date } | null {
  const live = papers.filter((paper) => !paper.cancelledAt);
  if (live.length === 0) return null;
  return {
    from: new Date(Math.min(...live.map((paper) => paper.opensAt.getTime()))),
    to: new Date(Math.max(...live.map((paper) => paper.closesAt.getTime()))),
  };
}

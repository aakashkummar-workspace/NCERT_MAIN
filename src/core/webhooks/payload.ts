import "server-only";
import { Prisma } from "@prisma/client";
import type { WebhookEvent } from "@prisma/client";
import { wireName } from "./events";

/**
 * What actually goes over the wire.
 *
 * ===========================================================================
 * THE RULE THIS FILE EXISTS FOR
 * ===========================================================================
 * **No personal information about a student beyond what the receiving system
 * already has.**
 *
 * An MIS knows its own children. It has their names, their admission numbers,
 * their guardians' phone numbers and their addresses, because the school typed
 * them in. It does not need any of that back from us, and sending it is not
 * "convenient" — it is a second copy of a child's contact details in a
 * different system, crossing the internet on a schedule, for no purpose that
 * could not be served by an id.
 *
 * So every payload here is IDS AND FIGURES:
 *
 *   - `studentUserId` — our uuid. The MIS matches it against whatever it stored
 *     when the roster was imported. If it did not store one, the answer is to
 *     fix the import, not to send names.
 *   - marks, totals, percentages, timestamps.
 *
 * And never:
 *
 *   - a name, a phone number, a guardian's number, an email, a roll number;
 *   - anything a student wrote — a free-text answer, a marker's comment on one,
 *     anything from the Mistake Bank or a tutor conversation. A written answer
 *     is a child's own words and has no business in an integration at all;
 *   - a mastery estimate. Not because it is secret, but because it is a
 *     judgement this product makes with its refusals attached — "not enough
 *     evidence yet" is half of what the number means — and a bare figure in
 *     somebody else's dashboard is exactly the ranking column this product
 *     refuses to print itself.
 *
 * `tests/integration/webhooks.test.ts` serialises a real `results.released`
 * body and greps it for a student's name and phone number, because a rule
 * stated in a comment is a rule that survives about two features.
 *
 * ---------------------------------------------------------------------------
 * Why anything is read here at all, rather than stamped by the trigger
 * ---------------------------------------------------------------------------
 * The outbox row is the transactional record that something HAPPENED, and its
 * stored payload is assembled by the trigger from the changed row alone — no
 * joins, nothing that has to be maintained in step with a feature.
 *
 * Marks are the one thing worth a second read. Forty score rows do not belong
 * inside the transaction that releases results — the same rule that keeps the
 * evidence ledger out of the submit transaction — and marks legitimately move
 * after release when a teacher re-marks a written answer. The freshest reading
 * at send time is the more correct one to hand an office, not merely the
 * cheaper one.
 */

export type DeliveredEvent = {
  /** The outbox row id. A receiver's idempotency key: the same event retried
   *  carries the same one, so a redelivery is recognisable as a redelivery. */
  id: string;
  type: string;
  /** When it happened, not when it was sent. */
  occurredAt: string;
  organizationId: string;
  data: Record<string, unknown>;
};

export type OutboxRow = {
  id: string;
  organizationId: string;
  topic: WebhookEvent;
  payload: Prisma.JsonValue;
  createdAt: Date;
};

/**
 * Build the body for one event, or null when there is nothing left to describe.
 *
 * Null is a refusal, not an error: the assignment was deleted, the row the
 * event was about is gone. The job records it as `gone` and does not retry,
 * because the next attempt would find the same nothing.
 */
export async function buildEventBody(
  tx: Prisma.TransactionClient,
  row: OutboxRow,
): Promise<DeliveredEvent | null> {
  const stamped =
    row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : {};

  const envelope = (data: Record<string, unknown>): DeliveredEvent => ({
    id: row.id,
    type: wireName(row.topic),
    occurredAt: row.createdAt.toISOString(),
    organizationId: row.organizationId,
    data,
  });

  switch (row.topic) {
    case "ASSESSMENT_PUBLISHED":
    case "STUDENT_ENROLLED":
      // Complete at the moment it happened, and deliberately so: both describe
      // a fact that does not move afterwards, so a second read could only
      // introduce a difference between what happened and what was sent.
      return envelope(stamped);

    case "RESULTS_RELEASED": {
      const assignmentId = stamped.assignmentId;
      if (typeof assignmentId !== "string") return null;

      const assignment = await tx.assignment.findUnique({
        where: { id: assignmentId },
        select: { id: true, assessmentId: true, classId: true },
      });
      if (!assignment) return null;

      const attempts = await tx.attempt.findMany({
        where: {
          assignmentId,
          status: { in: ["SUBMITTED", "SCORED", "RELEASED"] },
        },
        // An explicit projection, not a `select: false` on the fields we do not
        // want. A deny-list ships whatever the next migration adds to the
        // table; an allow-list makes a new column invisible here until somebody
        // decides it should be sent. Same reasoning as the AI layer's scrubber.
        select: {
          id: true,
          studentUserId: true,
          attemptNumber: true,
          rawScore: true,
          maxScore: true,
          percentage: true,
          submittedAt: true,
        },
        orderBy: [{ studentUserId: "asc" }, { attemptNumber: "asc" }],
      });

      // ---------------------------------------------------------------------
      // How many marks are still with the teacher
      // ---------------------------------------------------------------------
      // `rawScore` is what has been DECIDED so far, not a final mark. The
      // product already knows this and says so on the student's own result
      // page — "marked so far", with the outstanding marks named — precisely
      // because a partial total read as a final one is how somebody is shown a
      // failure for work nobody has read.
      //
      // Sending only `marksAwarded` would lose that distinction at the one
      // boundary where nobody can put it back: an MIS receives a number, prints
      // it on a report card, and there is no screen left to caveat it. So the
      // outstanding figure travels with the mark, and a receiver that wants to
      // import only finished papers has something to test.
      //
      // Note what is read to compute it: an answer's `max_marks` and whether it
      // has been given a mark. Never the response itself.
      const pending =
        attempts.length === 0
          ? []
          : await tx.attemptAnswer.groupBy({
              by: ["attemptId"],
              where: {
                attemptId: { in: attempts.map((attempt) => attempt.id) },
                awardedMarks: null,
                // A blank objective question is settled, not pending. Only an
                // answer somebody wrote and nobody has read is owed marks.
                response: { not: Prisma.DbNull },
              },
              _sum: { maxMarks: true },
            });

      const pendingBy = new Map(
        pending.map((row) => [row.attemptId, Number(row._sum.maxMarks ?? 0)]),
      );

      return envelope({
        ...stamped,
        results: attempts.map((attempt) => {
          const awaiting = pendingBy.get(attempt.id) ?? 0;
          return {
            attemptId: attempt.id,
            studentUserId: attempt.studentUserId,
            attemptNumber: attempt.attemptNumber,
            // Null is not zero, all the way out to the integration. A paper
            // nobody has scored at all carries null rather than 0.
            marksAwarded: decimal(attempt.rawScore),
            marksTotal: decimal(attempt.maxScore),
            percentage: decimal(attempt.percentage),
            /** Marks a person still has to give. Zero means the paper is done. */
            marksAwaitingMarking: awaiting,
            /** The flag a receiver should gate a report card on. */
            fullyMarked: awaiting === 0,
            submittedAt: attempt.submittedAt?.toISOString() ?? null,
          };
        }),
      });
    }
  }
}

/** Prisma Decimal to a JSON number, keeping null as null. */
function decimal(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value);
}

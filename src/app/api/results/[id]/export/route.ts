import { z } from "zod";
import { assignmentMarksCsv } from "@/core/results/export";
import { guard, notFound } from "../../../_lib/guard";
import { fail } from "../../../_lib/respond";
import { csvResponse } from "../../../_lib/csv-response";

export const runtime = "nodejs";

/**
 * One paper's marks, as CSV.
 *
 * A GET, because this is a link a teacher clicks and a file their browser
 * saves — and because the office will paste the URL into a bookmark. It is
 * still audited: `assignmentMarksCsv` writes the row, so "who took a copy of
 * 10-A's marks, and when" has an answer.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  // A malformed id is a 404, not a database error.
  if (!z.uuid().safeParse(id).success) return notFound("paper");

  const file = await assignmentMarksCsv(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    id,
  );
  if (!file) return notFound("paper");
  if (check.session.actor.role === "STUDENT" || check.session.actor.role === "PARENT") {
    // A whole class's marks is a teacher's document. The role gate is here as
    // well as on the page, because a route is reachable without the page.
    return fail("NOT_FOUND", "We could not find that.");
  }

  return csvResponse(file);
}

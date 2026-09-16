import { z } from "zod";
import { classMarksCsv } from "@/core/results/export";
import { guard, notFound } from "../../../_lib/guard";
import { fail } from "../../../_lib/respond";
import { csvResponse } from "../../../_lib/csv-response";

export const runtime = "nodejs";

/**
 * A class's marks register for a period, as CSV: one row per student, one
 * column per paper.
 *
 * The period comes from the query string because it is a VIEW of the register,
 * not a scope: the class is the class on the session's organization either way,
 * and an absent range means the current academic year rather than everything
 * ever — a register that grows a column for every paper since the school opened
 * is one nobody can read.
 */
const Range = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

/** 1 April, the Indian academic year, in IST. */
function yearStart(now: Date): Date {
  const year = now.getUTCMonth() + 1 >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return new Date(Date.UTC(year, 3, 1) - 5.5 * 3600_000);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;
  if (check.session.actor.role === "STUDENT" || check.session.actor.role === "PARENT") {
    return fail("NOT_FOUND", "We could not find that.");
  }

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound("class");

  const url = new URL(request.url);
  const parsed = Range.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  });
  if (!parsed.success) {
    return fail("VALIDATION_FAILED", "Dates must look like 2026-04-01T00:00:00Z.");
  }

  const now = new Date();
  const file = await classMarksCsv(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    id,
    {
      from: parsed.data.from ? new Date(parsed.data.from) : yearStart(now),
      to: parsed.data.to ? new Date(parsed.data.to) : now,
    },
  );
  if (!file) return notFound("class");

  return csvResponse(file);
}

import { z } from "zod";
import { DOMAINS, LEVELS, recordObservations } from "@/core/reports/holistic";
import { guard, notFound } from "../../../_lib/guard";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  entries: z
    .array(
      z.object({
        domain: z.enum(DOMAINS.map((domain) => domain.key) as [string, ...string[]]),
        level: z.enum(LEVELS as unknown as [string, ...string[]]),
        note: z.string().max(400).nullable().optional(),
      }),
    )
    .min(1)
    .max(DOMAINS.length),
});

/** A teacher's observations beyond marks, for the next term report. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound("student");

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const result = await recordObservations(
    check.session.actor,
    id,
    parsed.data.entries.map((entry) => ({
      domain: entry.domain as (typeof DOMAINS)[number]["key"],
      level: entry.level as (typeof LEVELS)[number],
      note: entry.note ?? null,
    })),
  );
  if (!result.ok) return fail("VALIDATION_FAILED", result.message);
  return ok({ saved: parsed.data.entries.length });
}

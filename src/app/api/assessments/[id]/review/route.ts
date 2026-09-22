import { z } from "zod";
import { decideReview, requestReview } from "@/core/assessments/review";
import { guard, notFound } from "../../../_lib/guard";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request") }),
  z.object({ action: z.literal("approve"), note: z.string().max(2000).nullable().optional() }),
  z.object({ action: z.literal("changes"), note: z.string().min(1).max(2000) }),
]);

/**
 * Send a draft for review, or decide one. Who may decide — an owner or admin
 * who did not write it — is checked in core/assessments/review.ts.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound("assessment");

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const actor = check.session.actor;
  const result =
    parsed.data.action === "request"
      ? await requestReview(actor, id)
      : await decideReview(
          actor,
          id,
          parsed.data.action === "approve" ? "APPROVED" : "CHANGES_REQUESTED",
          parsed.data.note ?? null,
        );
  if (!result.ok) return fail("CONFLICT", result.message);
  return ok({ ok: true });
}

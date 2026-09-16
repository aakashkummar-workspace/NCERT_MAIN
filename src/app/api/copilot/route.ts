import { z } from "zod";
import { ask, listConversations, MAX_QUESTION } from "@/core/copilot";
import { guard } from "../_lib/guard";
import { fail, failValidation, ok } from "../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  question: z.string().min(3).max(MAX_QUESTION),
  conversationId: z.string().uuid().optional(),
  classId: z.string().uuid().nullish(),
});

/** The teacher's own conversations, newest first. */
export async function GET() {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const conversations = await listConversations({
    organizationId: check.session.actor.organizationId,
    userId: check.session.actor.userId,
    role: check.session.actor.role,
  });
  return ok({ conversations });
}

/**
 * Ask a question.
 *
 * The one DEEP-tier route in the product. The plan gate is inside `runTask`,
 * which asks the entitlement before the budget and before the provider — so a
 * teacher whose plan does not include the Copilot is told about their plan
 * rather than about a dollar ceiling they have never heard of.
 */
export async function POST(request: Request) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const result = await ask(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    {
      question: parsed.data.question,
      conversationId: parsed.data.conversationId,
      classId: parsed.data.classId ?? null,
    },
  );
  if (!result.ok) {
    // A plan that does not include the Copilot, and nothing measured to reason
    // over, are refusals about the state of things — 409, as a report that
    // refuses for want of evidence is. Only a malformed question is a 400.
    const code =
      result.reason === "PLAN" || result.reason === "EMPTY"
        ? "CONFLICT"
        : result.reason === "NOT_FOUND"
          ? "NOT_FOUND"
          : "VALIDATION_FAILED";
    return fail(code, result.message);
  }

  return ok(result);
}

import { z } from "zod";
import { setOrganizationBoard } from "@/core/organizations";
import { guard } from "../../_lib/guard";
import { fail, failValidation, ok } from "../../_lib/respond";

export const runtime = "nodejs";

/**
 * Change the board this organization teaches.
 *
 * The board code in the body is a CHOICE, not a scope: the organization being
 * changed is the one on the session, and there is no parameter that could name
 * another. `setOrganizationBoard` resolves the code against the boards table
 * and refuses outright once any class, question or paper exists — see the note
 * there for why that is a refusal and not a warning.
 */
const Body = z.object({
  boardCode: z.string().trim().min(2).max(20),
});

export async function POST(request: Request) {
  const check = await guard("organization:update");
  if (!check.ok) return check.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const result = await setOrganizationBoard(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    parsed.data.boardCode,
  );

  if (!result.ok) {
    // A refusal because work already exists is a 409: the request was
    // well-formed and the state of the organization is what says no.
    if (result.code === "IN_USE") return fail("CONFLICT", result.message);
    return fail("VALIDATION_FAILED", result.message);
  }

  return ok({ board: { code: result.board.code, name: result.board.name } });
}

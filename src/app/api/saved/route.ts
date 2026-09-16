import { z } from "zod";
import { listSavedQuestions, saveQuestion } from "@/core/saved";
import { guardStudent } from "../_lib/student";
import { failValidation, ok } from "../_lib/respond";
import { notFound } from "../_lib/guard";

export const runtime = "nodejs";

/**
 * A student's saved questions.
 *
 * There is no `studentId` anywhere in this API, for the reason the Mistake Bank
 * has none: the list is the session's own, and a parameter naming whose list
 * would be the first crack in that.
 */

const Body = z.object({ questionId: z.string() });

export async function GET() {
  const check = await guardStudent();
  if (!check.ok) return check.response;

  const list = await listSavedQuestions(
    check.session.actor.organizationId,
    check.session.actor.userId,
  );
  return ok(list);
}

export async function POST(request: Request) {
  const check = await guardStudent();
  if (!check.ok) return check.response;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  // Not seen, not real and malformed all answer the same: a different answer
  // for "exists but you have not seen it" would confirm the id.
  const result = await saveQuestion(check.session.actor, parsed.data.questionId);
  if (!result.ok) return notFound("question");
  return ok({ saved: true });
}

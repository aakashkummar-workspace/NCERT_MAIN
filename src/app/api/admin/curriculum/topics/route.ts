import { z } from "zod";
import { addTopic } from "@/core/curriculum/admin";
import { guardPlatform } from "../../../_lib/platform";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  chapterId: z.uuid(),
  title: z.string().trim().min(2, "Give the topic a name.").max(160),
});

export async function POST(request: Request) {
  const check = await guardPlatform();
  if (!check.ok) return check.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const created = await addTopic(
    {
      userId: check.session.actor.userId,
      organizationId: check.session.actor.organizationId,
    },
    parsed.data.chapterId,
    parsed.data.title,
  );
  if (!created) return fail("NOT_FOUND", "We could not find that chapter.");

  return ok(created);
}

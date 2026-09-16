import { z } from "zod";
import { getSession } from "@/core/identity/context";
import { setOwnLocale } from "@/core/student/locale";
import { LOCALES } from "@/i18n";
import { fail, failValidation, ok } from "../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({ locale: z.enum(LOCALES) });

/**
 * Change my interface language.
 *
 * "Me" is the session's user and nobody else: there is no user id in the body,
 * the path or a header, so there is no request shape that sets another
 * person's language. Any signed-in role may call it — it is their own row —
 * though today only the student bar offers the choice.
 *
 * It changes the interface, never the questions; see `setOwnLocale`.
 */
export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return fail("UNAUTHENTICATED", "Sign in to change your language.");

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const result = await setOwnLocale(
    { organizationId: session.actor.organizationId, userId: session.actor.userId },
    parsed.data.locale,
  );
  if (!result.ok) {
    return fail("INTERNAL", "We could not save your language just now. Please try again.");
  }
  return ok({ locale: result.locale });
}

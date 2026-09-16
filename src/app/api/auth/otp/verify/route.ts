import { cookies } from "next/headers";
import { z } from "zod";
import { verifyLoginCode } from "@/core/identity/student-auth";
import { SESSION_COOKIE, sessionCookieOptions } from "@/core/identity/session";
import { fail, ok, requestMeta } from "../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  phone: z.string().min(6).max(20),
  code: z.string().min(4).max(8),
});

const BAD_CODE = "Enter the 6-digit code.";

export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    // A code of the wrong length is a typing slip, and it belongs beside the
    // code box rather than as "Check the highlighted fields" over nothing.
    return fail("VALIDATION_FAILED", BAD_CODE, { fields: { code: BAD_CODE } });
  }

  const result = await verifyLoginCode(
    parsed.data.phone,
    parsed.data.code,
    requestMeta(request),
  );
  if (!result.ok) {
    // One sentence for a wrong code, an expired one and a number with no
    // account — telling them apart would tell a stranger whether a child is a
    // student here. But "Ask for a new one" alone sent somebody whose number
    // is simply not on a roster round the same loop forever: a new code, the
    // same refusal. So the sentence names the other possibility too, without
    // saying which one is true.
    const message = result.message.startsWith("That code did not work")
      ? "That code did not work. Check you typed it correctly, or ask for a new one. If it keeps happening, check with your teacher that this is the number they have for you."
      : result.message;
    return fail("UNAUTHENTICATED", message, { fields: { code: message } });
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));

  return ok({ role: result.role });
}

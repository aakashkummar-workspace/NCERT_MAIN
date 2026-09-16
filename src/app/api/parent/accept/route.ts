import { z } from "zod";
import { acceptWithCode } from "@/core/parent/link";
import { cookies } from "next/headers";
import { SESSION_COOKIE, sessionCookieOptions } from "@/core/identity/session";
import { fail, failValidation, ok, requestMeta } from "../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  token: z.string().min(10).max(200),
  phone: z.string().min(10).max(15),
  code: z.string().min(4).max(8),
  fullName: z.string().max(120).optional(),
});

/**
 * Verify, create the account, record the consent, and sign them in.
 *
 * One call, because the halves of it are all states nobody wants to own: a
 * verified phone with no account, an account with no consent, a consent with no
 * session. The last of those is a parent who has proved who they are and still
 * cannot get in.
 */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const result = await acceptWithCode(
    parsed.data.token,
    parsed.data.phone,
    parsed.data.code,
    { fullName: parsed.data.fullName, ...requestMeta(request) },
  );
  if (!result.ok) return fail("VALIDATION_FAILED", result.message);

  const store = await cookies();
  store.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));

  return ok({ ok: true, studentUserId: result.studentUserId });
}

import { cookies } from "next/headers";
import { z } from "zod";
import { signIn } from "@/core/identity/accounts";
import {
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/core/identity/session";
import { fail, failValidation, ok, requestMeta } from "../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  identifier: z.string().trim().min(1, "Enter your email."),
  password: z.string().min(1, "Enter your password."),
});

export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const result = await signIn(parsed.data, requestMeta(request));

  if (!result.ok) {
    // 401 for both a wrong password and an unknown account: distinguishing them
    // is an account-enumeration oracle.
    return fail("UNAUTHENTICATED", result.message);
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));

  return ok({ organizationId: result.organizationId, role: result.role });
}

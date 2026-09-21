import { cookies } from "next/headers";
import { z } from "zod";
import { CARD_REFUSED, signInWithCard } from "@/core/identity/login-cards";
import { SESSION_COOKIE, sessionCookieOptions } from "@/core/identity/session";
import { fail, ok, requestMeta } from "../../_lib/respond";

export const runtime = "nodejs";

/**
 * Sign in with a printed card.
 *
 * The code arrives in the body, never the URL: the QR code on a card points at
 * `/signin/card#CODE`, and a fragment is not sent to the server, so the code
 * stays out of access logs and proxies the way a query string would not.
 */
const Body = z.object({ code: z.string().min(1).max(40) });

export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return fail("VALIDATION_FAILED", CARD_REFUSED, { fields: { code: CARD_REFUSED } });
  }

  const result = await signInWithCard(parsed.data.code, requestMeta(request));
  if (!result.ok) {
    return fail("UNAUTHENTICATED", result.message, { fields: { code: result.message } });
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));
  return ok({ role: result.role });
}

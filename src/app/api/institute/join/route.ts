import { cookies } from "next/headers";
import { z } from "zod";
import { acceptStaffInvitation } from "@/core/identity/staff-invitation";
import { MAX_PASSWORD_LENGTH } from "@/core/identity/password";
import { SESSION_COOKIE, sessionCookieOptions } from "@/core/identity/session";
import { fail, failValidation, ok, requestMeta } from "../../_lib/respond";

export const runtime = "nodejs";

const Body = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("signin"),
    token: z.string().min(10).max(200),
    email: z.string().trim().max(254),
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  }),
  z.object({
    mode: z.literal("create"),
    token: z.string().min(10).max(200),
    email: z.string().trim().max(254),
    password: z.string().max(MAX_PASSWORD_LENGTH),
    fullName: z.string().trim().max(120),
  }),
]);

/**
 * Accept a staff invitation: sign in or create the account, join, and land in
 * the organization that sent it.
 *
 * No session is required, and none is read: the invitation token is what
 * names the organization, and the role comes from the invitation row — never
 * from this body. There is deliberately no `role` field here to send.
 */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const { token, ...input } = parsed.data;
  const result = await acceptStaffInvitation(token, input, requestMeta(request));
  if (!result.ok) return fail("VALIDATION_FAILED", result.message);

  const store = await cookies();
  store.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));

  return ok({ organizationId: result.organizationId, role: result.role });
}

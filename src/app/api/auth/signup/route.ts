import { cookies } from "next/headers";
import { z } from "zod";
import { signUp } from "@/core/identity/accounts";
import { MIN_PASSWORD_LENGTH } from "@/core/identity/password";
import {
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/core/identity/session";
import { fail, failValidation, ok, requestMeta } from "../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  fullName: z.string().trim().min(2, "Tell us your name.").max(120),
  email: z.string().trim().toLowerCase().email("That does not look like an email address."),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
    .max(200),
  organizationName: z
    .string()
    .trim()
    .min(2, "Give your organisation a name — your own name is fine.")
    .max(120),
  organizationType: z.enum([
    "SOLO_TEACHER",
    "TUITION_CENTRE",
    "COACHING_INSTITUTE",
    "SCHOOL",
  ]),
  // The one board that arrives in a request body, and it is not an
  // authorization decision: there is no session and no organization yet, so
  // this IS the declaration. signUp() resolves it against the boards table
  // rather than trusting it. Every read afterwards takes the board from the
  // session's organization.
  boardCode: z.string().trim().min(2).max(20),
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

  const result = await signUp(parsed.data, requestMeta(request));

  if (!result.ok) {
    if (result.code === "TAKEN") return fail("CONFLICT", result.message);
    if (result.code === "UNKNOWN_BOARD") {
      return fail("VALIDATION_FAILED", result.message);
    }
    return fail("INTERNAL", result.message);
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));

  return ok({ organizationId: result.organizationId, role: result.role });
}

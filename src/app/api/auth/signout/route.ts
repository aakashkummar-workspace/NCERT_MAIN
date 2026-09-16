import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { signOut } from "@/core/identity/accounts";
import { getSession } from "@/core/identity/context";
import {
  SESSION_COOKIE,
  clearedSessionCookieOptions,
} from "@/core/identity/session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const session = await getSession();
  if (session) {
    await signOut(session.sessionId, session.actor.organizationId);
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, "", clearedSessionCookieOptions);

  // A form post, so redirect rather than returning JSON nobody will read.
  // Back to the door they came in by: a student sent to the teacher sign-in
  // page is being asked for a password they have never had.
  const role = session?.actor.role;
  const back = role === "STUDENT" || role === "PARENT" ? "/signin/student/" : "/signin/";
  return NextResponse.redirect(new URL(back, request.url), 303);
}

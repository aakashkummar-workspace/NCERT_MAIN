import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { ZodError } from "zod";

/**
 * The one error shape, everywhere. API_SPEC.md section 1.
 *
 * `message` is shown to a user, so it is written for one: what happened, what
 * survived, and what to do next. `code` is stable and is what clients branch
 * on. `requestId` appears in the response header and in every log line for the
 * request.
 */

export type ErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function fail(
  code: ErrorCode,
  message: string,
  details?: unknown,
  requestId = randomUUID(),
) {
  return NextResponse.json(
    { error: { code, message, details, requestId } },
    { status: STATUS[code], headers: { "x-request-id": requestId } },
  );
}

/**
 * Turns a Zod failure into per-field messages the form can render beside the
 * inputs, rather than one sentence at the top that makes the user hunt.
 */
export function failValidation(error: ZodError) {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !fields[key]) fields[key] = issue.message;
  }
  return fail("VALIDATION_FAILED", "Check the highlighted fields.", { fields });
}

/**
 * Request metadata for audit rows. The IP comes from the proxy header on
 * managed hosting; the raw socket address is not reachable in a route handler.
 */
export function requestMeta(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  return {
    ip: forwarded?.split(",")[0]?.trim() ?? undefined,
    userAgent: request.headers.get("user-agent") ?? undefined,
  };
}

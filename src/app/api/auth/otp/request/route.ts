import { z } from "zod";
import { requestLoginCode } from "@/core/identity/student-auth";
import { normalisePhone } from "@/core/roster/parse";
import { fail, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({ phone: z.string().max(40) });

/**
 * The sentence for a number we cannot send to, attached to the FIELD.
 *
 * It used to arrive as Zod's "Check the highlighted fields." with nothing
 * highlighted — the form has one field, and no field was named in a shape the
 * form read — or, for a well-formed-looking number that did not normalise, as
 * a RATE_LIMITED error, which is not what had happened.
 */
const BAD_NUMBER =
  "Enter the 10-digit mobile number your teacher has for you.";

export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success || normalisePhone(parsed.data.phone) === null) {
    return fail("VALIDATION_FAILED", BAD_NUMBER, { fields: { phone: BAD_NUMBER } });
  }

  const result = await requestLoginCode(parsed.data.phone);
  if (!result.ok) return fail("RATE_LIMITED", result.message);

  // `sent` is now the truth rather than a constant.
  //
  // It read `sent: true` unconditionally while nothing was being sent at all,
  // so the screen told every student to check a phone that was never going to
  // buzz. Issuing a code and delivering one are different acts, and a caller
  // that cannot tell them apart cannot say anything true to the person waiting.
  //
  // Still a 200: the code EXISTS and its clock is running, so this is not an
  // error the client should retry into. The screen decides what to say.
  //
  // devCode is present outside production only. A code in a production log is
  // a credential in a production log.
  return ok({
    sent: result.delivered,
    devCode: result.devCode,
    devRegistered: result.devRegistered,
  });
}

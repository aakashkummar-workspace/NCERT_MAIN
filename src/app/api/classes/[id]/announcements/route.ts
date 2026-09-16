import { z } from "zod";
import {
  ANNOUNCEMENT_MAX_LENGTH,
  createAnnouncement,
  isUuid,
  listAnnouncementsForClass,
} from "@/core/announcements";
import { guard, notFound } from "../../../_lib/guard";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

/**
 * A class's announcements, for its teachers.
 *
 * Neither the author nor the organization is read from the request: both come
 * from the session. The class id in the path is only which class, and a
 * malformed one is a 404 like a missing one.
 */

const Body = z.object({
  // Measured again after trimming in core; this bound only stops a megabyte
  // arriving at the parser.
  body: z.string().max(ANNOUNCEMENT_MAX_LENGTH * 2),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  if (!isUuid(id)) return notFound("class");

  const list = await listAnnouncementsForClass(check.session.actor.organizationId, id);
  if (!list) return notFound("class");
  return ok(list);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  if (!isUuid(id)) return notFound("class");

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const result = await createAnnouncement(check.session.actor, id, parsed.data.body);
  if (!result.ok) {
    switch (result.reason) {
      case "not-found":
        return notFound("class");
      case "forbidden":
        return fail("FORBIDDEN", result.message);
      case "invalid":
        return fail("VALIDATION_FAILED", result.message, {
          fields: { body: result.message },
        });
      case "duplicate":
        return fail("CONFLICT", result.message);
    }
  }
  return ok({ announcement: result.announcement }, { status: 201 });
}

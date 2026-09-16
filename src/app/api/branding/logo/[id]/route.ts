import { z } from "zod";
import { readLogo } from "@/core/branding";
import { getSession } from "@/core/identity/context";
import { logoResponse } from "../../../_lib/logo";
import { fail } from "../../../_lib/respond";

export const runtime = "nodejs";

/**
 * A school's logo, for anybody signed in to that school.
 *
 * Every role, parents and students included — a logo is not student data, and
 * a report a parent reads carries one. Tenant scoping does the rest: another
 * school's logo id finds nothing and answers exactly like an id that never
 * existed.
 *
 * Not gated on the plan. A report stamped while the school was branded must
 * still draw its letterhead after the plan lapses; the document was true on the
 * day it was written.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return fail("UNAUTHENTICATED", "Please sign in and try again.");

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("NOT_FOUND", "We could not find that.");

  const logo = await readLogo(session.actor.organizationId, id);
  if (!logo) return fail("NOT_FOUND", "We could not find that.");

  return logoResponse(logo, "private");
}

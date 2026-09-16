import { getClass } from "@/core/classes";
import { guard, notFound } from "../../_lib/guard";
import { ok } from "../../_lib/respond";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  const found = await getClass(check.session.actor.organizationId, id);
  if (!found) return notFound("class");

  return ok(found);
}

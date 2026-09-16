import { rotateJoinCode } from "@/core/classes";
import { guard, notFound } from "../../../_lib/guard";
import { ok } from "../../../_lib/respond";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  const joinCode = await rotateJoinCode(check.session.actor, id);
  if (!joinCode) return notFound("class");

  return ok({ joinCode });
}

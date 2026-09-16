import { linkedStudents } from "@/core/parent/read";
import { guardParent } from "../../_lib/parent";
import { ok } from "../../_lib/respond";

export const runtime = "nodejs";

/**
 * The children this parent may see.
 *
 * No parameter, and deliberately: the list comes from consented, unrevoked
 * links on the session's own user. There is no shape of this request that could
 * name somebody else's child.
 */
export async function GET() {
  const check = await guardParent();
  if (!check.ok) return check.response;

  const children = await linkedStudents({
    organizationId: check.session.actor.organizationId,
    userId: check.session.actor.userId,
  });
  return ok({ children });
}

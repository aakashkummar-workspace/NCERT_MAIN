import { z } from "zod";
import { helpSoFar } from "@/core/tutor";
import { guardStudent } from "../../_lib/student";
import { ok } from "../../_lib/respond";

export const runtime = "nodejs";

const EMPTY = { sessionId: null, maxLevel: null, canEscalate: true, turns: [] };

/**
 * What has already been said about this question, to this student.
 *
 * Never 404s on an absent session — "you have not asked about this yet" is a
 * normal state and the panel opens on it, so an error would make the ordinary
 * case the exceptional one.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ questionId: string }> },
) {
  const check = await guardStudent();
  if (!check.ok) return check.response;

  const { questionId } = await params;
  // A malformed id is a client bug, and the column is a uuid — Prisma would
  // throw rather than find nothing. Same empty answer either way.
  if (!z.string().uuid().safeParse(questionId).success) return ok(EMPTY);

  const history = await helpSoFar(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
    },
    questionId,
  );

  return ok(history ?? EMPTY);
}

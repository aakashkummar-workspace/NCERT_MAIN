import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { getPlayer } from "@/core/attempts";
import { Player } from "./Player";

export const metadata: Metadata = { title: "Test" };

// A paper in progress is never served from a cache: the remaining time is part
// of the payload.
export const dynamic = "force-dynamic";

export default async function AttemptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin/student");
  if (session.actor.role !== "STUDENT") redirect("/teacher");

  const { id } = await params;
  const player = await getPlayer(
    {
      organizationId: session.actor.organizationId,
      userId: session.actor.userId,
    },
    id,
  );
  if (!player) notFound();

  // A finished sitting has no player. Sending them to the result rather than
  // to an error is the honest answer to "what happened to my test?".
  if (player.status !== "IN_PROGRESS") redirect(`/student/results/${id}`);

  return (
    <Player
      initial={{
        attemptId: player.attemptId,
        title: player.title,
        // Serialised here rather than passed as Date objects, so the client
        // owns exactly one representation of time and there is no chance of a
        // Date and a string being compared to each other.
        serverTime: player.serverTime.toISOString(),
        expiresAt: player.expiresAt.toISOString(),
        remainingMs: player.remainingMs,
        totalMarks: player.totalMarks,
        readAloud: player.readAloud,
        questions: player.questions,
      }}
    />
  );
}

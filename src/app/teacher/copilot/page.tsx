import { z } from "zod";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { getConversation, listConversations } from "@/core/copilot";
import { can, currentPlan } from "@/core/billing/entitlements";
import { AppShell } from "@/ui/AppShell";
import { PageHeader } from "@/ui";
import { Copilot } from "./Copilot";

export const metadata: Metadata = { title: "AI Copilot" };

export const dynamic = "force-dynamic";

export default async function CopilotPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");

  const actor = {
    organizationId: session.actor.organizationId,
    userId: session.actor.userId,
    role: session.actor.role,
  };

  const { c: raw } = await searchParams;
  // A malformed conversation id is no conversation, not a database error.
  const c = raw && z.uuid().safeParse(raw).success ? raw : undefined;
  const [conversations, current, entitled, plan] = await Promise.all([
    listConversations(actor),
    c ? getConversation(actor, c) : Promise.resolve(null),
    can(actor.organizationId, "copilot_questions_per_month"),
    currentPlan(actor.organizationId),
  ]);

  // Known before the page renders, so the suggestions and the box are not
  // offered to be pressed and then refused.
  const blocked = entitled.allowed
    ? null
    : entitled.reason === "limit-reached"
      ? `This month's ${entitled.limit} Copilot questions on the ${plan?.name ?? "current"} plan are used up. Earlier answers stay readable.`
      : `The Copilot is not included in the ${plan?.name ?? "current"} plan.`;

  return (
    <AppShell
      currentPath="/teacher/copilot"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      {/*
        The heading stays "AI Copilot" even inside a conversation. Using the
        first question as the h1 printed it twice — once as the title and again
        as the opening turn a few lines below. Which conversation this is shows
        in the sidebar, highlighted, where it is not competing with itself.
      */}
      <PageHeader
        title="AI Copilot"
        description={
          current
            ? undefined
            : "Ask about your classes. It reads only your own marked work."
        }
      />

      <div className="ui-copilot-layout">
        <Copilot
          blocked={blocked}
          conversationId={c ?? null}
          initialTurns={
            current?.turns.map((turn) => ({
              id: turn.id,
              role: turn.role,
              content: turn.content,
              citations: turn.citations,
              actions: turn.actions,
            })) ?? []
          }
        />

        {conversations.length > 0 && (
          <aside className="ui-copilot-history">
            <h2 className="ui-section-heading">Earlier</h2>
            <ul>
              {conversations.map((conversation) => (
                <li key={conversation.id}>
                  <Link
                    href={`/teacher/copilot?c=${conversation.id}`}
                    data-current={conversation.id === c || undefined}
                  >
                    <span>{conversation.title}</span>
                    <span className="ui-copilot-history-meta tabular">
                      {conversation.turns}{" "}
                      {conversation.turns === 1 ? "question" : "questions"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {/*
              Kept, and said so. A question asked on Friday is one a teacher
              wants the answer to again on Monday, and re-asking it costs a
              DEEP-tier call — the thread is a cost control as much as a
              convenience.
            */}
            <p className="ui-hint">
              Answers are kept, so you can come back to one rather than asking
              again.
            </p>
          </aside>
        )}
      </div>
    </AppShell>
  );
}

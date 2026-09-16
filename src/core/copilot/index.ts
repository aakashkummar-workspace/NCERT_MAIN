import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";
import { can } from "@/core/billing/entitlements";
import { askCopilot } from "@/ai/tasks/copilot";
import { organizationBoard } from "@/core/organizations";
import { buildContext, mentioned, rehydrate } from "./context";

/**
 * Asking the Copilot, and keeping what it said.
 *
 * ---------------------------------------------------------------------------
 * The order of operations is the security property
 * ---------------------------------------------------------------------------
 *   1. Build the context inside `withTenant`, with students as handles.
 *   2. Call the model. It sees handles and no names.
 *   3. Re-hydrate the answer, here, from a map that never left the process.
 *   4. Store the re-hydrated text.
 *
 * Step 3 before step 4 is deliberate: a stored answer full of `STU_a41f0c` is
 * one a teacher cannot read a week later, and re-hydrating at render time would
 * mean carrying the identity map forever.
 *
 * ---------------------------------------------------------------------------
 * The teacher's question is stored but never summarised into the ledger
 * ---------------------------------------------------------------------------
 * It is their own prose and may well name a student. It goes to the provider —
 * it has to, it is the question — and it is kept in the conversation so they
 * can read the thread. What it does not do is land in `ai_generations.input_summary`,
 * which is read by a platform admin during an incident and has no business
 * holding a teacher's sentence about a named child.
 */

export type Actor = { organizationId: string; userId: string; role: string };

/** A question longer than this is a document, and costs like one. */
export const MAX_QUESTION = 1000;

/** Turns of history sent back. Enough for a follow-up, bounded for cost. */
export const HISTORY_TURNS = 6;

export type AskResult =
  | {
      ok: true;
      conversationId: string;
      answer: string;
      citations: string[];
      suggestedActions: { label: string; rationale: string }[];
      insufficientEvidence: boolean;
      students: { studentUserId: string; fullName: string }[];
      costMicros: number;
    }
  | {
      ok: false;
      /**
       * Why, so the route can answer with the right status. PLAN and EMPTY are
       * refusals about the state of things — 409, the same as a report that
       * refuses for want of evidence — and not a malformed request.
       */
      reason: "INVALID" | "PLAN" | "NOT_FOUND" | "EMPTY" | "FAILED";
      message: string;
    };

export async function ask(
  actor: Actor,
  input: { question: string; conversationId?: string; classId?: string | null },
  now = new Date(),
): Promise<AskResult> {
  const question = input.question.trim();
  if (question.length < 3) {
    return { ok: false, reason: "INVALID", message: "Ask a question and I will have a look." };
  }
  if (question.length > MAX_QUESTION) {
    return {
      ok: false,
      reason: "INVALID",
      message: `That is longer than I can take in one go — keep it under ${MAX_QUESTION} characters.`,
    };
  }

  // The plan, before anything else — before the conversation lookup and well
  // before the several queries that build the context.
  //
  // Same ordering rule the gateway uses for plan-before-budget, and for the
  // same reason: "your plan does not include this" and "there is nothing
  // measured yet" are different facts, and a teacher on Free hearing the second
  // is told their data is the problem when their plan is. The gateway checks
  // this again and is the authority; this exists to produce the right sentence
  // and to not spend six queries reaching it.
  const entitled = await can(actor.organizationId, "copilot_questions_per_month");
  if (!entitled.allowed) {
    return {
      ok: false,
      reason: "PLAN",
      message:
        entitled.reason === "limit-reached"
          ? `You have used all ${entitled.limit} Copilot questions on your plan this month. They reset on the first.`
          : "The Copilot is not part of your plan. Get in touch and we will move you.",
    };
  }

  // Resolve the conversation next, so a bad id costs nothing.
  let conversationId = input.conversationId ?? null;
  let classId = input.classId ?? null;
  let history: { role: "user" | "assistant"; content: string }[] = [];

  if (conversationId) {
    const found = await withTenant(actor.organizationId, async (tx) => {
      const conversation = await tx.copilotConversation.findFirst({
        // Scoped to the teacher's own id on top of the tenant policy: a
        // colleague has no business reading what somebody asked about a class.
        where: { id: conversationId!, teacherUserId: actor.userId },
      });
      if (!conversation) return null;

      const messages = await tx.copilotMessage.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: "desc" },
        take: HISTORY_TURNS,
      });
      return { conversation, messages: messages.reverse() };
    });
    if (!found) {
      return { ok: false, reason: "NOT_FOUND", message: "We could not find that conversation." };
    }

    classId = found.conversation.classId;
    history = found.messages.map((message) => ({
      role: message.role === "USER" ? ("user" as const) : ("assistant" as const),
      content: message.content,
    }));
  }

  const context = await buildContext(
    { organizationId: actor.organizationId, userId: actor.userId },
    classId,
    now,
  );

  if (context.empty) {
    // Refused before the call, not after. There is nothing to reason over, and
    // paying DEEP-tier rates to be told so is the worst possible outcome.
    return {
      ok: false,
      reason: "EMPTY",
      message:
        "There is nothing measured yet on any of your classes. Once a paper has been sat and marked, this can tell you something worth acting on — until then it would only be guessing.",
    };
  }

  const teacherName = await withTenant(actor.organizationId, (tx) =>
    tx.user.findFirst({
      where: { id: actor.userId },
      select: { fullName: true },
    }),
  );

  const board = await organizationBoard(actor.organizationId);

  const outcome = await askCopilot({
    organizationId: actor.organizationId,
    userId: actor.userId,
    boardName: board.name,
    // The teacher's own name, so the answer can address them. Not a student's,
    // and the scrubber's NEVER list would throw on one anyway.
    teacherName: teacherName?.fullName ?? "the teacher",
    facts: context.facts,
    history,
    question,
  });

  if (!outcome.ok) {
    // The gateway's user-facing message, never the provider's text.
    return { ok: false, reason: "FAILED", message: outcome.message };
  }

  // Put the people back, before anything is stored or shown.
  const answer = rehydrate(outcome.value.answer, context.identities);
  const citations = outcome.value.citations.map((citation) =>
    rehydrate(citation, context.identities),
  );
  const actions = outcome.value.suggestedActions.map((action) => ({
    label: rehydrate(action.label, context.identities),
    rationale: rehydrate(action.rationale, context.identities),
  }));
  const students = mentioned(outcome.value.answer, context.identities);

  const saved = await withTenant(actor.organizationId, async (tx) => {
    if (!conversationId) {
      const created = await tx.copilotConversation.create({
        data: {
          id: randomUUID(),
          organizationId: actor.organizationId,
          teacherUserId: actor.userId,
          // From the question itself. A title is not worth a second call.
          title: question.slice(0, 200),
          classId,
          createdAt: now,
          lastMessageAt: now,
        },
      });
      conversationId = created.id;
    } else {
      await tx.copilotConversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: now },
      });
    }

    await tx.copilotMessage.createMany({
      data: [
        {
          id: randomUUID(),
          organizationId: actor.organizationId,
          conversationId: conversationId!,
          role: "USER",
          content: question,
          createdAt: now,
        },
        {
          id: randomUUID(),
          organizationId: actor.organizationId,
          conversationId: conversationId!,
          role: "ASSISTANT",
          content: answer,
          citations: { citations, actions, sources: context.sources } as never,
          generationId: outcome.generationId,
          costMicros: outcome.costMicros,
          // A millisecond later, so the ordering is stable on read.
          createdAt: new Date(now.getTime() + 1),
        },
      ],
    });

    return conversationId!;
  });

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "copilot.asked",
    entityType: "copilot_conversation",
    entityId: saved,
    // Shape, not content. The question is a teacher's own prose about a named
    // child; an audit row is read by a platform admin during an incident.
    after: {
      generationId: outcome.generationId,
      costMicros: outcome.costMicros,
      insufficientEvidence: outcome.value.insufficientEvidence,
    },
  });

  return {
    ok: true,
    conversationId: saved,
    answer,
    citations,
    suggestedActions: actions,
    insufficientEvidence: outcome.value.insufficientEvidence,
    students,
    costMicros: outcome.costMicros,
  };
}

export type ConversationRow = {
  id: string;
  title: string;
  classId: string | null;
  lastMessageAt: Date;
  turns: number;
};

export async function listConversations(
  actor: Actor,
  take = 20,
): Promise<ConversationRow[]> {
  return withTenant(actor.organizationId, async (tx) => {
    const conversations = await tx.copilotConversation.findMany({
      where: { teacherUserId: actor.userId },
      orderBy: { lastMessageAt: "desc" },
      take,
    });
    if (conversations.length === 0) return [];

    const counts = await tx.copilotMessage.groupBy({
      by: ["conversationId"],
      where: {
        conversationId: { in: conversations.map((row) => row.id) },
        role: "USER",
      },
      _count: true,
    });
    const byConversation = new Map(
      counts.map((row) => [row.conversationId, row._count]),
    );

    return conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      classId: conversation.classId,
      lastMessageAt: conversation.lastMessageAt,
      turns: byConversation.get(conversation.id) ?? 0,
    }));
  });
}

export type Turn = {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  citations: string[];
  actions: { label: string; rationale: string }[];
  createdAt: Date;
};

export async function getConversation(
  actor: Actor,
  conversationId: string,
): Promise<{ title: string; classId: string | null; turns: Turn[] } | null> {
  return withTenant(actor.organizationId, async (tx) => {
    const conversation = await tx.copilotConversation.findFirst({
      where: { id: conversationId, teacherUserId: actor.userId },
    });
    if (!conversation) return null;

    const messages = await tx.copilotMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });

    return {
      title: conversation.title,
      classId: conversation.classId,
      turns: messages.map((message) => {
        const payload = (message.citations ?? {}) as {
          citations?: string[];
          actions?: { label: string; rationale: string }[];
        };
        return {
          id: message.id,
          role: message.role as "USER" | "ASSISTANT",
          content: message.content,
          citations: payload.citations ?? [],
          actions: payload.actions ?? [],
          createdAt: message.createdAt,
        };
      }),
    };
  });
}

import "server-only";
import { z } from "zod";
import { runTask, type TaskOutcome } from "../gateway";

/**
 * The Teacher Copilot.
 *
 * ---------------------------------------------------------------------------
 * Last in the plan, and for a reason worth restating
 * ---------------------------------------------------------------------------
 * IMPLEMENTATION_PLAN.md puts this in week 20: *"Highest cost per call — last,
 * once the data it reasons over is trustworthy."* Both halves matter. It is the
 * only DEEP-tier feature at `xhigh` effort, so a loop here is expensive in a way
 * nothing else is; and it reasons over mastery, gaps and interventions, which
 * only became worth reasoning over once each of them learned to refuse.
 *
 * A Copilot built in week 4 would have confidently averaged four students and
 * called it a class. Everything upstream now hands it nulls where it should,
 * and the system prompt's job is to make sure it repeats them rather than
 * filling them in.
 *
 * ---------------------------------------------------------------------------
 * It never sees a student's name
 * ---------------------------------------------------------------------------
 * The context arrives with students as `STU_a41f0c` handles, and the answer is
 * re-hydrated after the call. The model is told to use the handles verbatim,
 * because a model that paraphrases `STU_a41f0c` as "the first student" produces
 * an answer nothing can put a name back into.
 */

export const CopilotAnswer = z.object({
  /**
   * The answer, in prose, addressed to the teacher.
   *
   * Student handles appear verbatim; they are swapped for real names before
   * this reaches a screen.
   */
  answer: z.string().min(1).max(4000),
  /**
   * What the answer rests on — the specific figures used, quoted from the
   * context. A teacher acting across a whole cohort has to be able to check it.
   */
  citations: z.array(z.string().min(3).max(300)).max(8),
  /**
   * Concrete next steps, or none. An empty list is a normal outcome: not every
   * question has an action behind it, and inventing one is how a teacher learns
   * to skip this section.
   */
  suggestedActions: z
    .array(
      z.object({
        label: z.string().min(3).max(120),
        /** Why this, in one sentence built from the figures. */
        rationale: z.string().min(10).max(300),
      }),
    )
    .max(4),
  /**
   * True when the context did not contain enough to answer.
   *
   * A first-class outcome rather than a failure. The most expensive mistake
   * this feature can make is a confident answer built on four students, and the
   * only defence is making "I cannot tell you that" an ordinary thing to say.
   */
  insufficientEvidence: z.boolean(),
});

export type CopilotAnswer = z.infer<typeof CopilotAnswer>;

export type CopilotTurn = { role: "user" | "assistant"; content: string };

export type CopilotRequest = {
  organizationId: string;
  userId: string;
  /** The teacher's own name, so the answer can address them. Not a student's. */
  teacherName: string;
  /** The board this school teaches. Below the breakpoint — see buildSystem. */
  boardName: string;
  facts: string;
  history: CopilotTurn[];
  question: string;
};

/**
 * The cacheable prefix: the brief and the rules, both stable.
 *
 * The FACTS deliberately do not live here. They change between turns — a
 * teacher marking a paper mid-conversation changes them — and a volatile block
 * above the breakpoint invalidates the prefix on every single turn, which on
 * the DEEP tier is the most expensive way in this codebase to get nothing.
 */
export function buildSystem(): string {
  return `You are a teaching assistant inside Sahayak, an assessment platform used by Class 9 and 10 teachers in India. A teacher is asking you about their own classes.

The board this school teaches is named at the top of the FACTS. It is there rather than up here on purpose: this prompt is shared by every school on every board, and a board name in the prefix would split one cached prefix into one per board — on the most expensive tier in the product. Read the board from the facts and never assume one.

You are given a block of FACTS assembled from their data. Answer only from it.

HOW TO HANDLE THE NUMBERS

Every mastery figure in the facts carries the number of students it was computed over. Use that number in your answer whenever you quote the figure — "62% across 18 of 24 measured" is useful and "62%" on its own is misleading, because the teacher cannot tell whether it describes their class.

Where the facts say there is not enough evidence, say so. Do not estimate, do not average the students who happen to have been measured and present it as the class, and do not describe a trend from a single sitting. If the question cannot be answered from what is here, set insufficientEvidence to true and say what would need to happen — usually that a paper needs marking, or that more of the class needs to sit something.

Being unable to answer is a normal outcome and is much better than a confident wrong one. A teacher who reteaches a lesson on your say-so and finds the class already knew it does not ask you again.

STUDENTS

Students appear as handles like STU_a41f0c. Use those handles EXACTLY as written whenever you refer to a student — they are substituted for real names before the teacher sees your answer. Never invent a handle, never shorten one, and never describe a student as "the first one" or "student 3", because that cannot be turned back into a person.

WHAT A GOOD ANSWER LOOKS LIKE

Short. A teacher reads this between classes. Lead with the answer, not with a restatement of the question.

Specific. Name the concept and the class. "Similarity of triangles in 10-B" rather than "some topics in one of your classes".

Honest about what it does not cover. If the facts describe one class and the question was about all of them, say which one you answered about.

Every citation is a figure quoted from the facts, close to verbatim, so the teacher can find the row it came from. Do not cite things you did not use.

Suggested actions are things the teacher can do this week, each with the figure that justifies it. An empty list is fine and common. Never suggest ranking or comparing teachers — the platform does not produce that number and it is not a defensible one.`;
}

export function buildRequest(request: CopilotRequest): string {
  const history =
    request.history.length === 0
      ? ""
      : `\n\nEARLIER IN THIS CONVERSATION\n${request.history
          .map((turn) => `${turn.role === "user" ? "Teacher" : "You"}: ${turn.content}`)
          .join("\n\n")}`;

  return `BOARD: ${request.boardName}\n\nFACTS\n${request.facts}${history}\n\nThe teacher, ${request.teacherName}, asks:\n${request.question}`;
}

export async function askCopilot(
  request: CopilotRequest,
): Promise<TaskOutcome<CopilotAnswer>> {
  return runTask({
    organizationId: request.organizationId,
    userId: request.userId,
    feature: "TEACHER_COPILOT",
    // The one DEEP-tier feature. AI_ARCHITECTURE.md: "anything a teacher will
    // act on across a whole cohort".
    tier: "DEEP",
    effort: "xhigh",
    system: buildSystem(),
    messages: [{ role: "user", content: buildRequest(request) }],
    schema: CopilotAnswer,
    schemaName: "CopilotAnswer",
    maxTokens: 2000,
    input: {
      // The question itself is the teacher's own words and may name a student,
      // so it is NOT in the ledger summary. What is stored is its shape.
      questionLength: request.question.length,
      historyTurns: request.history.length,
      factsLength: request.facts.length,
    },
    safeFields: ["questionLength", "historyTurns", "factsLength"],
    // Metered on its own key. A teacher's question must not eat the generation
    // allowance they bought to write papers with — two different promises.
    entitlementKey: "copilot_questions_per_month",
  });
}

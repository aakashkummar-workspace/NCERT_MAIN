import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { studyPlan, type PlanItemKind } from "@/core/plan";
import { StudentShell } from "@/ui/StudentShell";
import { EmptyState, PageHeader } from "@/ui";

export const metadata: Metadata = { title: "What to do next" };

// Derived from the clock and from evidence, both of which move. A cached plan
// would tell a student to sit a paper whose window shut an hour ago.
export const dynamic = "force-dynamic";

/**
 * The study plan.
 *
 * Called "What to do next" rather than "Study plan", because the second is a
 * document and the first is an instruction — and a student opening this page
 * has one question, not a filing need.
 *
 * There are no checkboxes. An item leaves this list when the evidence moves and
 * on nothing else, exactly as a learning gap closes and a mistake resolves. A
 * plan you can tick off measures how tidy you are.
 */

/** What each kind of item is, in two words, above the instruction. */
const KIND_LABEL: Record<PlanItemKind, string> = {
  // Named as what it is: somebody asked. That is a different kind of reason
  // from the products own "worth doing".
  "assigned-practice": "Set by your teacher",
  "resume-test": "Unfinished",
  "sit-test": "Due",
  "revise-for-test": "Before your test",
  "fix-mistakes": "Outstanding",
  practise: "Worth doing",
};

export default async function PlanPage() {
  const session = await getSession();
  if (!session) redirect("/signin/student");
  if (session.actor.role !== "STUDENT") redirect("/teacher");

  const plan = await studyPlan({
    organizationId: session.actor.organizationId,
    userId: session.actor.userId,
  });


  return (
    <StudentShell
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        eyebrow={<Link href="/student">Home</Link>}
        title="What to do next"
        description={
          plan.ok
            ? "In order. Start at the top — nothing below it is more urgent."
            : undefined
        }
      />

      {!plan.ok ? (
        <EmptyState
          title={
            plan.reason === "all-clear"
              ? "You are up to date"
              : "Nothing here yet"
          }
          body={plan.message}
        />
      ) : (
        <ol className="ui-plan">
          {plan.items.map((item, index) => (
            <li
              key={`${item.kind}-${item.href}-${index}`}
              className="ui-plan-item"
              data-kind={item.kind}
              data-deadline={item.deadline || undefined}
            >
              {/*
                Numbered, and the number is the point. This is the one list in
                the product where order carries information: the second item is
                second because the first matters more, not because it happened
                to sort that way.
              */}
              <span className="ui-plan-rank tabular" aria-hidden="true">
                {index + 1}
              </span>

              <div className="ui-plan-body">
                <p className="ui-plan-kind">{KIND_LABEL[item.kind]}</p>
                <h2 className="ui-plan-title">{item.title}</h2>
                {/*
                  Built from the numbers that put it here. A plan a student
                  cannot interrogate is one they stop following the first time
                  it is wrong — the same reason every practice card carries its
                  rationale.
                */}
                <p className="ui-plan-why">{item.why}</p>
              </div>

              <Link
                href={item.href}
                className="ui-button"
                data-variant={index === 0 ? "primary" : "secondary"}
                data-size="md"
              >
                <span>{item.actionLabel}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}

      {plan.ok && (
        <p className="ui-hint" style={{ marginTop: 20 }}>
          {/*
            Said out loud, because the alternative is a student who does the
            work, comes back, and finds the same list — and concludes the page
            does not know they did it. Same disclosure the Mistake Bank makes
            about why a correct retry does not close a card.
          */}
          This list works itself out as you go. Nothing here gets ticked off by
          hand — an item leaves when the work behind it is done, which is the
          only version of this that can tell you the truth.
        </p>
      )}
    </StudentShell>
  );
}

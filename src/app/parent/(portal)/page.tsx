import { brandedPageMetadata } from "@/app/_branding/surface";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/core/identity/context";
import { childView, linkedStudents } from "@/core/parent/read";
import { digestState } from "@/core/digest";
import { whatsappConfigured } from "@/whatsapp/gateway";
import { WhatsappDigestToggle } from "./WhatsappDigestToggle";
import { ParentShell } from "@/ui/ParentShell";
import { Badge, EmptyState, PageHeader, type Tone } from "@/ui";

export const generateMetadata = brandedPageMetadata("Your child");

export const dynamic = "force-dynamic";

const BAND_TONE: Record<string, Tone> = {
  SECURE: "success",
  DEVELOPING: "primary",
  FRAGILE: "warning",
  CRITICAL: "danger",
  INSUFFICIENT: "neutral",
};

const BAND_WORD: Record<string, string> = {
  SECURE: "Secure",
  DEVELOPING: "Getting there",
  FRAGILE: "Shaky",
  CRITICAL: "Needs help",
  INSUFFICIENT: "Not measured yet",
};

export default async function ParentHome({
  searchParams,
}: {
  searchParams: Promise<{ child?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin/student");
  if (session.actor.role !== "PARENT") redirect("/");

  const actor = {
    organizationId: session.actor.organizationId,
    userId: session.actor.userId,
  };
  const children = await linkedStudents(actor);

  if (children.length === 0) {
    return (
      <ParentShell
        fullName={session.fullName}
        organizationName={session.organizationName}
      >
        <EmptyState
          title="Nothing linked yet"
          body="When a teacher invites you to see a child's progress, it appears here. If you were sent a link, open it again — it may not have been finished."
        />
      </ParentShell>
    );
  }

  const { child: requested } = await searchParams;
  // The query string names a child, and the list is what permits one. A value
  // that is not on the list falls back to the first rather than erroring —
  // there is nothing to tell a parent about a child that is not theirs.
  const selected =
    children.find((row) => row.studentUserId === requested) ?? children[0]!;

  const view = await childView(actor, selected.studentUserId);
  if (!view) redirect("/parent");

  const firstName = view.fullName.split(/\s+/)[0] ?? view.fullName;
  // Offered only where a provider is configured: a switch that promises
  // messages nobody will send is worse than no switch.
  const digestOn = whatsappConfigured() ? await digestState(actor, selected.studentUserId) : null;

  return (
    <ParentShell
      fullName={session.fullName}
      organizationName={session.organizationName}
      switcher={
        children.length > 1 ? (
          <nav className="ui-child-switcher" aria-label="Choose a child">
            {children.map((row) => (
              <Link
                key={row.studentUserId}
                href={`/parent?child=${row.studentUserId}`}
                data-current={
                  row.studentUserId === selected.studentUserId || undefined
                }
              >
                {row.fullName.split(/\s+/)[0]}
              </Link>
            ))}
          </nav>
        ) : undefined
      }
    >
      <PageHeader
        title={view.fullName}
        description={view.className ?? undefined}
      />

      {/*
        The sentence, or nothing. A parent is the audience least equipped to
        discount a confident paragraph and most likely to act on one, so below
        the evidence threshold there is no paragraph at all.
      */}
      {view.summary ? (
        <p className="ui-parent-summary">{view.summary}</p>
      ) : (
        <p className="ui-parent-summary" data-tone="quiet">
          There is not enough marked work yet to say how {firstName} is doing.
          This fills in as tests are set and marked — it is not a comment on{" "}
          {firstName}.
        </p>
      )}

      {view.attention.length > 0 && (
        <section className="ui-parent-section">
          <h2 className="ui-section-heading">Where the help would go</h2>
          <ul className="ui-parent-concepts">
            {view.attention.map((row) => (
              <li key={row.conceptId}>
                <span className="ui-parent-concept-name">{row.conceptName}</span>
                <Badge tone={BAND_TONE[row.band] ?? "neutral"}>
                  {BAND_WORD[row.band] ?? row.band}
                </Badge>
              </li>
            ))}
          </ul>
          {/*
            Said out loud. A parent who reads a weak topic as a verdict on the
            child rather than a place to help is the outcome this page most has
            to avoid.
          */}
          <p className="ui-hint">
            These are topics, not marks out of ten. They move as {firstName}{" "}
            does more work, and the teacher sees the same list.
          </p>
        </section>
      )}

      {view.strengths.length > 0 && (
        <section className="ui-parent-section">
          <h2 className="ui-section-heading">Going well</h2>
          <ul className="ui-parent-concepts">
            {view.strengths.map((row) => (
              <li key={row.conceptId}>
                <span className="ui-parent-concept-name">{row.conceptName}</span>
                <Badge tone={BAND_TONE[row.band] ?? "neutral"}>
                  {BAND_WORD[row.band] ?? row.band}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="ui-parent-section">
        <h2 className="ui-section-heading">Tests taken</h2>
        {view.sittings.length === 0 ? (
          <p className="ui-hint">{firstName} has not sat anything yet.</p>
        ) : (
          <ul className="ui-parent-sittings">
            {view.sittings.map((sitting) => (
              <li key={sitting.attemptId}>
                <span>
                  <span className="ui-parent-sitting-title">{sitting.title}</span>
                  <span className="ui-parent-sitting-meta">
                    {sitting.subjectName}
                    {" · "}
                    {new Intl.DateTimeFormat("en-IN", {
                      dateStyle: "medium",
                      timeZone: "Asia/Kolkata",
                    }).format(sitting.satAt)}
                  </span>
                </span>
                {/*
                  Null until the teacher releases it — the same rule, through
                  the same function, as the child's own page. A parent seeing a
                  mark first turns a result into an ambush.
                */}
                {/*
                  Null is not zero, here too. A written answer nobody has read
                  yet is "marked so far" with the marks still owed named — the
                  words on the child's own result page — never "0 / 5".
                */}
                <span className="ui-parent-sitting-score tabular">
                  {!sitting.marks ? (
                    "Not released"
                  ) : sitting.marks.awaitingMarking === 0 &&
                    sitting.marks.awarded !== null ? (
                    `${sitting.marks.awarded} / ${sitting.marks.total}`
                  ) : (
                    <span
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-end",
                        textAlign: "right",
                        gap: 2,
                      }}
                    >
                      {sitting.marks.awarded === null
                        ? "Not marked yet"
                        : `${sitting.marks.awarded} / ${sitting.marks.total} marked so far`}
                      {sitting.marks.awaitingMarking > 0 && (
                        <span className="ui-parent-sitting-meta">
                          {sitting.marks.awaitingMarking}{" "}
                          {new Intl.PluralRules("en-IN").select(
                            sitting.marks.awaitingMarking,
                          ) === "one"
                            ? "mark is"
                            : "marks are"}{" "}
                          still with the teacher
                        </span>
                      )}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        The way through to term reports. A link rather than a nav entry: the
        parent shell has one bar on purpose, and a report is something you go
        and find a few times a term rather than a place you live.
      */}
      <p className="ui-plan-link" style={{ marginTop: 18 }}>
        <Link href="/parent/reports">See term reports</Link>
      </p>

      {digestOn !== null && (
        <div style={{ marginTop: 18 }}>
          <WhatsappDigestToggle
            studentUserId={selected.studentUserId}
            firstName={firstName}
            initial={digestOn}
          />
        </div>
      )}

      <p className="ui-hint" style={{ marginTop: 18 }}>
        {/*
          Stated, not buried in a policy. A child who believes a parent reads
          every question they ask stops asking questions — and a parent who is
          told plainly what they cannot see is far less likely to go looking.
        */}
        You can see {firstName}&rsquo;s progress and test results. You cannot see
        their answers, their practice, or the questions they ask for help with —
        that is deliberate, so {firstName} can get things wrong somewhere.
      </p>
    </ParentShell>
  );
}

import { brandedPageMetadata } from "@/app/_branding/surface";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getSession } from "@/core/identity/context";
import type { StudentAssignment } from "@/core/attempts/student-view";
import {
  studentDashboard,
  type AnnouncementsSection,
  type ConceptsSection,
  type EffortSection,
  type FeedbackNotice,
  type LatestResult,
  type MistakesSection,
  type PlanSection,
  type ReadinessSection,
  type Section,
} from "@/core/student/dashboard";
import { kolkataDaysAgo } from "@/core/student/rules";
import type { SavedSummary } from "@/core/saved";
import type { ProgressViewer } from "@/core/parent/read";
import { createTranslator, DEFAULT_LOCALE, type Locale, type Translator } from "@/i18n";
import { requestLocale } from "@/i18n/server";
import { StudentShell } from "@/ui/StudentShell";
import { Badge, EmptyState, PageHeader } from "@/ui";
import { StartTest } from "./StartTest";
import { JoinClass } from "./JoinClass";

export const generateMetadata = brandedPageMetadata("My tests");

// Nothing here is cached: "open" and "closed" are read from the clock, and a
// student refreshing at the moment a window opens must see it open.
export const dynamic = "force-dynamic";

const TONE = {
  OPEN: "success",
  SCHEDULED: "primary",
  CLOSED: "neutral",
  CANCELLED: "neutral",
} as const;

/**
 * Home, at a glance.
 *
 * ---------------------------------------------------------------------------
 * The papers first, and everything else is a card that links somewhere
 * ---------------------------------------------------------------------------
 * A paper with a window closing is the most urgent thing a student can have,
 * so the open tests lead on every width. Everything else — the latest result,
 * what to do next, concepts, feedback — is a compact card whose job is to say
 * one thing and send the student to the page that says the rest. A home page
 * that tried to BE the progress page and the plan and the mistake bank would
 * be all three of them, badly, above the paper they came to sit.
 *
 * ---------------------------------------------------------------------------
 * What is deliberately not here
 * ---------------------------------------------------------------------------
 * No overall score, no percentage the estimator refused, no rank, no streak,
 * and no timetable. Every one of those has been asked for on some other
 * surface and refused there for reasons that apply more strongly on the first
 * screen a fifteen-year-old sees every day. The concept card carries COUNTS
 * and a name; the effort card counts what they did, never how often they were
 * right.
 *
 * ---------------------------------------------------------------------------
 * Order
 * ---------------------------------------------------------------------------
 * On a desk: a main column (tests, latest result, up next, finished papers)
 * and a side column. On a phone the two columns dissolve into one list in
 * priority order — see "Student dashboard" in student.css — because a side
 * column that simply follows the main one would put announcements below every
 * finished paper of the year.
 */
export default async function StudentHome() {
  const session = await getSession();
  if (!session) redirect("/signin/student");
  if (session.actor.role !== "STUDENT") redirect("/teacher");

  const now = new Date();
  const [dashboard, locale] = await Promise.all([
    studentDashboard(session.actor.organizationId, session.actor.userId, now),
    requestLocale(session.locale),
  ]);
  const t = createTranslator(locale);

  // Curriculum and teacher-authored text is English whatever the interface
  // language is — paper titles, concept names, the plan's sentences — and says
  // so to a screen reader, rather than being read in a Hindi voice.
  const content = locale === DEFAULT_LOCALE ? undefined : DEFAULT_LOCALE;

  const assignments = dashboard.tests.ok ? dashboard.tests.data : [];
  const live = assignments.filter(
    (a) => a.status === "OPEN" || a.status === "SCHEDULED",
  );
  const past = assignments.filter(
    (a) => a.status === "CLOSED" || a.status === "CANCELLED",
  );

  const firstName = session.fullName.split(/\s+/)[0] ?? session.fullName;
  const ui = { t, locale, content, now };

  return (
    <StudentShell
      fullName={session.fullName}
      organizationName={session.organizationName}
      width="wide"
    >
      <div lang={locale === DEFAULT_LOCALE ? undefined : locale}>
        <PageHeader
          title={t("home.hello", { name: firstName })}
          description={live.length > 0 ? t("home.intro.live") : t("home.intro.none")}
        />

        <JoinClass />

        <div className="ui-sd">
          <div className="ui-sd-main">
            <TestsSection
              ui={ui}
              failed={!dashboard.tests.ok}
              total={assignments.length}
              live={live}
            />
            <LatestResultCard ui={ui} section={dashboard.latestResult} />
            <UpNextCard ui={ui} section={dashboard.plan} />
            {past.length > 0 && <FinishedSection ui={ui} past={past} />}
          </div>

          <div className="ui-sd-side">
            <ConceptsCard ui={ui} section={dashboard.concepts} />
            <FixCard ui={ui} section={dashboard.mistakes} />
            <FeedbackCard ui={ui} section={dashboard.feedback} />
            <AnnouncementsCard ui={ui} section={dashboard.announcements} />
            <EffortCard ui={ui} section={dashboard.effort} />
            <SavedCard ui={ui} section={dashboard.saved} />
            <ReadinessCard ui={ui} section={dashboard.readiness} />
            <ViewersCard ui={ui} section={dashboard.viewers} />
          </div>
        </div>
      </div>
    </StudentShell>
  );
}

type Ui = {
  t: Translator;
  locale: Locale;
  /** `lang` for English content inside a translated page; undefined in English. */
  content: string | undefined;
  now: Date;
};

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/**
 * One dashboard card. A real `<h2>`, not the Card component's `<h3>`: the
 * cards sit directly under the page's `<h1>`, and a heading outline that skips
 * a level is one a screen-reader user navigating by heading cannot trust.
 */
function Panel({
  id,
  title,
  action,
  quiet,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  /** Nothing to say yet. On a phone such a card sinks below the ones that do. */
  quiet?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className="ui-card ui-sd-card"
      data-sd={id}
      data-quiet={quiet || undefined}
      aria-labelledby={`sd-${id}`}
    >
      <header className="ui-sd-card-head">
        <h2 id={`sd-${id}`} className="ui-sd-card-title">
          {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

/**
 * A section that could not be read. Said quietly and never as an empty state:
 * "you have nothing saved" and "we could not check" are opposite facts.
 */
function Failed({ ui }: { ui: Ui }) {
  return (
    <p className="ui-sd-failed" role="status">
      {ui.t("home.sectionFailed")}
    </p>
  );
}

/** A compact empty state: what is missing, why it matters, where to go. */
function Quiet({ title, body, action }: { title?: string; body: string; action?: ReactNode }) {
  return (
    <div className="ui-sd-empty">
      {title && <p className="ui-sd-empty-title">{title}</p>}
      <p className="ui-sd-empty-body">{body}</p>
      {action}
    </div>
  );
}

function CardLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="ui-sd-link">
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Main column
// ---------------------------------------------------------------------------

function TestsSection({
  ui,
  failed,
  total,
  live,
}: {
  ui: Ui;
  failed: boolean;
  total: number;
  live: StudentAssignment[];
}) {
  const { t } = ui;
  return (
    <section className="ui-sd-tests" data-sd="tests" aria-labelledby="sd-tests">
      <h2 id="sd-tests" className="ui-section-heading ui-sd-heading">
        {t("home.tests.heading")}
      </h2>

      {failed ? (
        <Failed ui={ui} />
      ) : total === 0 ? (
        <EmptyState title={t("home.tests.emptyTitle")} body={t("home.tests.emptyBody")} />
      ) : live.length === 0 ? (
        <p className="ui-sd-none-open">{t("home.tests.noneOpen")}</p>
      ) : (
        <div className="ui-tests">
          {live.map((assignment) => (
            // The id is what the study plan's "Start" links to. Starting a paper
            // happens here, on the device, so the plan sends them to the card
            // rather than to a page of its own.
            <article
              key={assignment.assignmentId}
              id={`test-${assignment.assignmentId}`}
              className="ui-test"
            >
              <div className="ui-test-head">
                <div>
                  <h3 className="ui-test-title" lang={ui.content}>
                    {assignment.title}
                  </h3>
                  <p className="ui-test-sub" lang={ui.content}>
                    {assignment.subjectName} · {assignment.className}
                  </p>
                </div>
                <Badge tone={TONE[assignment.status]}>
                  {assignment.status === "OPEN" ? t("home.test.open") : t("home.test.scheduled")}
                </Badge>
              </div>

              <dl className="ui-test-facts">
                <div>
                  <dt>{t("home.test.questions")}</dt>
                  <dd className="tabular">{assignment.questionCount}</dd>
                </div>
                <div>
                  <dt>{t("home.test.marks")}</dt>
                  <dd className="tabular">{assignment.totalMarks}</dd>
                </div>
                <div>
                  <dt>{t("home.test.time")}</dt>
                  <dd className="tabular">
                    {t("home.test.minutes", { count: assignment.durationMinutes })}
                  </dd>
                </div>
                <div>
                  <dt>{t("home.test.attempts")}</dt>
                  <dd className="tabular">
                    {t("home.test.attemptsOf", {
                      used: assignment.attemptsUsed,
                      max: assignment.maxAttempts,
                    })}
                  </dd>
                </div>
              </dl>

              <p className="ui-test-window" lang={ui.content}>
                {assignment.window}
              </p>

              <div className="ui-test-actions">
                {assignment.onPaper ? (
                  <p className="ui-hint" lang={ui.content}>
                    {t("home.test.onPaper")}
                  </p>
                ) : (
                  <StartTest
                    assignmentId={assignment.assignmentId}
                    canStart={assignment.canStart}
                    resuming={assignment.inProgressAttemptId !== null}
                    inProgressAttemptId={assignment.inProgressAttemptId}
                  />
                )}
                {assignment.resultVisible && assignment.finishedAttemptId && (
                  <Link
                    href={`/student/results/${assignment.finishedAttemptId}`}
                    className="ui-button"
                    data-variant="ghost"
                    data-size="lg"
                  >
                    <span>{t("home.test.seeResult")}</span>
                  </Link>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function FinishedSection({ ui, past }: { ui: Ui; past: StudentAssignment[] }) {
  const { t } = ui;
  return (
    <section className="ui-sd-finished" data-sd="finished" aria-labelledby="sd-finished">
      <h2 id="sd-finished" className="ui-section-heading ui-sd-heading">
        {t("home.finished.heading")}
      </h2>
      <div className="ui-tests">
        {past.map((assignment) => (
          <article key={assignment.assignmentId} className="ui-test">
            <div className="ui-test-head">
              <div>
                <h3 className="ui-test-title" lang={ui.content}>
                  {assignment.title}
                </h3>
                <p className="ui-test-sub" lang={ui.content}>
                  {assignment.subjectName} · {assignment.className}
                </p>
              </div>
              <Badge tone={TONE[assignment.status]}>
                {assignment.status === "CANCELLED" ? t("home.test.cancelled") : t("home.test.closed")}
              </Badge>
            </div>

            <p className="ui-test-window">
              {assignment.attemptsUsed === 0 ? (
                t("home.test.notTaken")
              ) : (
                <span lang={ui.content}>{assignment.window}</span>
              )}
            </p>

            {assignment.finishedAttemptId && (
              <div className="ui-test-actions">
                {assignment.resultVisible ? (
                  <Link
                    href={`/student/results/${assignment.finishedAttemptId}`}
                    className="ui-button"
                    data-variant="secondary"
                    data-size="lg"
                  >
                    <span>{t("home.test.seeResult")}</span>
                  </Link>
                ) : (
                  // Said plainly, because "no result" and "not yet released"
                  // mean very different things to a student waiting on one.
                  <p className="ui-test-pending">{t("home.test.notReleased")}</p>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function LatestResultCard({ ui, section }: { ui: Ui; section: Section<LatestResult | null> }) {
  const { t } = ui;
  if (!section.ok) {
    return (
      <Panel id="result" title={t("home.result.heading")}>
        <Failed ui={ui} />
      </Panel>
    );
  }
  const result = section.data;
  if (!result) {
    return (
      <Panel id="result" title={t("home.result.heading")} quiet>
        <Quiet title={t("home.result.emptyTitle")} body={t("home.result.emptyBody")} />
      </Panel>
    );
  }

  const { marks } = result;
  return (
    <Panel id="result" title={t("home.result.heading")}>
      <p className="ui-sd-result-title" lang={ui.content}>
        {result.title}
      </p>

      <div className="ui-sd-result-marks">
        {/*
          Null is not zero. With nothing marked there is no number at all —
          "0 / 5" on a home page reads as a failed test rather than an unread
          one. With some marked, the number is labelled "marked so far" and
          the marks still with the teacher are named beside it.
        */}
        {marks.kind === "unmarked" ? (
          <span className="ui-sd-result-unmarked">{t("home.result.unmarked")}</span>
        ) : (
          <span className="ui-sd-result-score tabular" aria-label={`${t("home.result.marksLabel")}: ${marks.awarded} / ${marks.total}`}>
            {marks.awarded}
            <span className="ui-sd-result-outof"> / {marks.total}</span>
          </span>
        )}
        {marks.kind === "so-far" && (
          <span className="ui-sd-result-sofar">{t("home.result.soFar")}</span>
        )}
      </div>

      {marks.kind !== "final" && (
        <Badge tone="warning">{t("home.result.pending", { count: marks.pending })}</Badge>
      )}

      <p className="ui-sd-line">
        {!result.reviewable
          ? t("home.result.answersLater")
          : result.toReview > 0
            ? t("home.result.toReview", { count: result.toReview })
            : marks.kind === "final"
              ? t("home.result.fullMarks")
              : null}
      </p>

      <div className="ui-sd-actions">
        <Link
          href={`/student/results/${result.attemptId}`}
          className="ui-button"
          data-variant="secondary"
          data-size="md"
        >
          <span>{result.reviewable ? t("home.result.seeAnswers") : t("home.result.seeResult")}</span>
        </Link>
        {result.reviewable && result.toReview > 0 && (
          <CardLink href="/student/mistakes">{t("home.result.thingsToFix")}</CardLink>
        )}
      </div>
    </Panel>
  );
}

function UpNextCard({ ui, section }: { ui: Ui; section: Section<PlanSection> }) {
  const { t } = ui;
  if (!section.ok) {
    return (
      <Panel id="plan" title={t("home.plan.heading")}>
        <Failed ui={ui} />
      </Panel>
    );
  }
  const plan = section.data;
  if (!plan.ok) {
    // The plan's own two refusals, in its own words: "nothing yet" and "all
    // clear" are opposite facts and the plan already says which.
    return (
      <Panel id="plan" title={t("home.plan.heading")}>
        <p className="ui-sd-line" lang={ui.content}>
          {plan.message}
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      id="plan"
      title={t("home.plan.heading")}
      action={<CardLink href="/student/plan">{t("home.plan.whole", { count: plan.total })}</CardLink>}
    >
      {/*
        An ORDER, never a timetable: a rank, an instruction, the reason, and
        a way in. No dates, no durations. The rank is drawn because on this
        one list the order carries information.
      */}
      <ol className="ui-sd-plan">
        {plan.items.map((item, index) => (
          <li key={`${item.kind}-${item.href}`} className="ui-sd-plan-item">
            <span className="ui-sd-plan-rank tabular" aria-hidden="true">
              {index + 1}
            </span>
            <div className="ui-sd-plan-body" lang={ui.content}>
              <p className="ui-sd-plan-title">{item.title}</p>
              <p className="ui-sd-plan-why">{item.why}</p>
            </div>
            <Link
              href={item.href}
              className="ui-button"
              data-variant={index === 0 ? "primary" : "secondary"}
              data-size="sm"
            >
              <span lang={ui.content}>{item.actionLabel}</span>
            </Link>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Side column
// ---------------------------------------------------------------------------

function ConceptsCard({ ui, section }: { ui: Ui; section: Section<ConceptsSection> }) {
  const { t } = ui;
  const title = t("home.concepts.heading");
  if (!section.ok) {
    return (
      <Panel id="concepts" title={title}>
        <Failed ui={ui} />
      </Panel>
    );
  }
  const { subjects } = section.data;
  if (subjects.length === 0) {
    return (
      <Panel id="concepts" title={title} quiet>
        <Quiet title={t("home.concepts.emptyTitle")} body={t("home.concepts.emptyBody")} />
      </Panel>
    );
  }

  return (
    <Panel
      id="concepts"
      title={title}
      action={<CardLink href="/student/progress">{t("home.concepts.all")}</CardLink>}
    >
      <ul className="ui-sd-subjects">
        {subjects.map((subject) => {
          const measured = subject.secure + subject.almostThere + subject.needsPractice;
          return (
            <li key={subject.subjectName} className="ui-sd-subject">
              <p className="ui-sd-subject-name" lang={ui.content}>
                {subject.subjectName}
              </p>
              {/*
                Counts, each with its word beside it — colour is a swatch and
                never the only encoding. No percentages and no overall figure:
                the moment these become one number it is the composite the
                product refuses everywhere else.
              */}
              <ul className="ui-sd-bands">
                <Band band="secure" label={t("home.concepts.secure")} count={subject.secure} />
                <Band band="developing" label={t("home.concepts.almost")} count={subject.almostThere} />
                <Band band="fragile" label={t("home.concepts.practice")} count={subject.needsPractice} />
                <Band band="unknown" label={t("home.concepts.unknown")} count={subject.notEnoughEvidence} />
              </ul>
              {subject.weakest ? (
                <p className="ui-sd-weakest">
                  <span>{t("home.concepts.startWith")} </span>
                  <strong lang={ui.content}>{subject.weakest.conceptName}</strong>
                  {subject.weakest.canPractise && (
                    <>
                      {" "}
                      <CardLink href={`/student/practice?conceptId=${subject.weakest.conceptId}`}>
                        {t("home.concepts.practise")}
                      </CardLink>
                    </>
                  )}
                </p>
              ) : (
                <p className="ui-sd-weakest">
                  {measured > 0 ? t("home.concepts.allSecure") : t("home.concepts.noneMeasured")}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function Band({ band, label, count }: { band: string; label: string; count: number }) {
  return (
    <li className="ui-sd-band" data-band={band}>
      <span className="ui-sd-band-swatch" aria-hidden="true" />
      <span className="ui-sd-band-count tabular">{count}</span>
      <span className="ui-sd-band-label">{label}</span>
    </li>
  );
}

function FixCard({ ui, section }: { ui: Ui; section: Section<MistakesSection> }) {
  const { t } = ui;
  const title = t("home.fix.heading");
  if (!section.ok) {
    return (
      <Panel id="fix" title={title}>
        <Failed ui={ui} />
      </Panel>
    );
  }
  const { open, resolvedThisWeek } = section.data;
  if (open === 0 && resolvedThisWeek === 0) {
    return (
      <Panel id="fix" title={title} quiet>
        <Quiet title={t("home.fix.emptyTitle")} body={t("home.fix.emptyBody")} />
      </Panel>
    );
  }
  return (
    <Panel id="fix" title={title} action={<CardLink href="/student/mistakes">{t("home.fix.link")}</CardLink>}>
      <p className="ui-sd-count tabular">{t("home.fix.open", { count: open })}</p>
      {resolvedThisWeek > 0 && (
        <p className="ui-sd-line">{t("home.fix.resolved", { count: resolvedThisWeek })}</p>
      )}
    </Panel>
  );
}

function FeedbackCard({ ui, section }: { ui: Ui; section: Section<FeedbackNotice | null> }) {
  const { t } = ui;
  const title = t("home.feedback.heading");
  if (!section.ok) {
    return (
      <Panel id="feedback" title={title}>
        <Failed ui={ui} />
      </Panel>
    );
  }
  const notice = section.data;
  if (!notice) {
    return (
      <Panel id="feedback" title={title} quiet>
        <Quiet title={t("home.feedback.emptyTitle")} body={t("home.feedback.emptyBody")} />
      </Panel>
    );
  }
  return (
    <Panel id="feedback" title={title}>
      <p className="ui-sd-feedback-new">
        <Badge tone="primary">{t("home.feedback.new", { title: notice.title })}</Badge>
      </p>
      {/*
        The teacher's words only when the result page would show them. Before
        the answers open, the comment was never sent to this page at all — the
        read model takes it from `studentResult`, which withholds it.
      */}
      {notice.reviewable && notice.snippet ? (
        <blockquote className="ui-sd-quote" lang={ui.content}>
          {notice.snippet}
        </blockquote>
      ) : (
        <p className="ui-sd-line">{t("home.feedback.locked")}</p>
      )}
      {notice.morePapers > 0 && (
        <p className="ui-sd-line">{t("home.feedback.more", { count: notice.morePapers })}</p>
      )}
      <div className="ui-sd-actions">
        <CardLink href={`/student/results/${notice.attemptId}`}>{t("home.feedback.read")}</CardLink>
      </div>
    </Panel>
  );
}

function AnnouncementsCard({ ui, section }: { ui: Ui; section: Section<AnnouncementsSection> }) {
  const { t } = ui;
  const title = t("home.announcements.heading");
  if (!section.ok) {
    return (
      <Panel id="announcements" title={title}>
        <Failed ui={ui} />
      </Panel>
    );
  }
  const { items, truncated } = section.data;
  if (items.length === 0) {
    return (
      <Panel id="announcements" title={title} quiet>
        <Quiet title={t("home.announcements.emptyTitle")} body={t("home.announcements.emptyBody")} />
      </Panel>
    );
  }
  const relative = new Intl.RelativeTimeFormat(ui.locale, { numeric: "auto" });
  return (
    <Panel id="announcements" title={title}>
      <ul className="ui-sd-notes">
        {items.map((item) => (
          <li key={item.id} className="ui-sd-note">
            <p className="ui-sd-note-meta">
              <span lang={ui.content}>{item.className}</span>
              {" · "}
              <time dateTime={item.createdAt.toISOString()}>
                {relative.format(-kolkataDaysAgo(item.createdAt, ui.now), "day")}
              </time>
            </p>
            <p className="ui-sd-note-body" lang={ui.content}>
              {item.body}
            </p>
          </li>
        ))}
      </ul>
      {/* A truncated list says so. */}
      {truncated && (
        <p className="ui-sd-line">{t("home.announcements.truncated", { count: items.length })}</p>
      )}
    </Panel>
  );
}

function EffortCard({ ui, section }: { ui: Ui; section: Section<EffortSection> }) {
  const { t } = ui;
  const title = t("home.effort.heading");
  if (!section.ok) {
    return (
      <Panel id="effort" title={title}>
        <Failed ui={ui} />
      </Panel>
    );
  }
  const effort = section.data;
  const nothing =
    effort.setsFinished === 0 && effort.questionsAnswered === 0 && effort.mistakesFixed === 0;
  return (
    <Panel id="effort" title={title} quiet={nothing}>
      {/* The window is named on the card: rolling days, not a week that resets. */}
      <p className="ui-sd-window">{t("home.effort.window", { count: effort.days })}</p>
      {nothing ? (
        <Quiet
          body={t("home.effort.emptyBody")}
          action={<CardLink href="/student/practice">{t("home.effort.start")}</CardLink>}
        />
      ) : (
        // Effort only. No right-answer rate beside these, and no streak.
        <dl className="ui-sd-effort">
          <div>
            <dt>{t("home.effort.sets")}</dt>
            <dd className="tabular">{effort.setsFinished}</dd>
          </div>
          <div>
            <dt>{t("home.effort.answered")}</dt>
            <dd className="tabular">{effort.questionsAnswered}</dd>
          </div>
          <div>
            <dt>{t("home.effort.fixed")}</dt>
            <dd className="tabular">{effort.mistakesFixed}</dd>
          </div>
        </dl>
      )}
    </Panel>
  );
}

function SavedCard({ ui, section }: { ui: Ui; section: Section<SavedSummary> }) {
  const { t } = ui;
  const title = t("home.saved.heading");
  if (!section.ok) {
    return (
      <Panel id="saved" title={title}>
        <Failed ui={ui} />
      </Panel>
    );
  }
  const saved = section.data;
  if (saved.total === 0) {
    return (
      <Panel id="saved" title={title} quiet>
        <Quiet title={t("home.saved.emptyTitle")} body={t("home.saved.emptyBody")} />
      </Panel>
    );
  }
  return (
    <Panel id="saved" title={title} action={<CardLink href="/student/saved">{t("home.saved.all")}</CardLink>}>
      <p className="ui-sd-count tabular">{t("home.saved.count", { count: saved.total })}</p>
      <ul className="ui-sd-stems">
        {saved.recent.map((row) => (
          // Truncated by CSS, not by cutting the string: the whole stem is in
          // the page for a screen reader and for the browser's own search.
          <li key={row.questionId} className="ui-sd-stem" lang={ui.content}>
            {row.stem}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function ReadinessCard({ ui, section }: { ui: Ui; section: Section<ReadinessSection> }) {
  const { t } = ui;
  const title = t("home.readiness.heading");
  if (!section.ok) {
    return (
      <Panel id="readiness" title={title}>
        <Failed ui={ui} />
      </Panel>
    );
  }
  const readiness = section.data;
  if (readiness.state === "no-syllabus") {
    return (
      <Panel id="readiness" title={title} quiet>
        <Quiet title={t("home.readiness.emptyTitle")} body={t("home.readiness.emptyBody")} />
      </Panel>
    );
  }
  return (
    <Panel
      id="readiness"
      title={title}
      action={<CardLink href="/student/readiness">{t("home.readiness.open")}</CardLink>}
    >
      {/*
        Coverage, and the readiness page's own headline — never a readiness
        percentage, which is the composite that page exists to refuse.
      */}
      <p className="ui-sd-count">
        {t("home.readiness.tested", {
          tested: readiness.testedChapters,
          total: readiness.totalChapters,
        })}
      </p>
      <p className="ui-sd-line" lang={ui.content}>
        {readiness.line}
      </p>
    </Panel>
  );
}

function ViewersCard({ ui, section }: { ui: Ui; section: Section<ProgressViewer[]> }) {
  const { t } = ui;
  const title = t("home.viewers.heading");
  if (!section.ok) {
    return (
      <Panel id="viewers" title={title}>
        <Failed ui={ui} />
      </Panel>
    );
  }
  const viewers = section.data;
  return (
    <Panel id="viewers" title={title} quiet={viewers.length === 0}>
      {viewers.length === 0 ? (
        <p className="ui-sd-line">{t("home.viewers.none")}</p>
      ) : (
        <ul className="ui-sd-viewers">
          {viewers.map((viewer, index) => (
            <li key={`${viewer.status}-${index}`} className="ui-sd-viewer">
              <p className="ui-sd-viewer-who">
                {relationshipLabel(t, viewer.relationship)}
                {viewer.phoneHint && (
                  <>
                    {" · "}
                    <span className="tabular">{viewer.phoneHint}</span>
                  </>
                )}
              </p>
              <p className="ui-sd-viewer-status">
                <Badge tone={viewer.status === "ACTIVE" ? "success" : "neutral"}>
                  {viewer.status === "ACTIVE" ? t("home.viewers.active") : t("home.viewers.invited")}
                </Badge>
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="ui-sd-fine">{t("home.viewers.scope")}</p>
    </Panel>
  );
}

function relationshipLabel(t: Translator, relationship: string): string {
  switch (relationship) {
    case "MOTHER":
      return t("relationship.MOTHER");
    case "FATHER":
      return t("relationship.FATHER");
    default:
      return t("relationship.GUARDIAN");
  }
}

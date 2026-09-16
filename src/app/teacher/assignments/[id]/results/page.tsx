import { z } from "zod";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { assignmentResults, itemAnalysis } from "@/core/results";
import { AppShell } from "@/ui/AppShell";
import { Badge, Card, Grid, PageHeader, StatCard, Stack, type Tone } from "@/ui";
import { ReleaseButton } from "./ReleaseButton";

export const metadata: Metadata = { title: "Results" };

export const dynamic = "force-dynamic";

const ROW_TONE: Record<string, Tone> = {
  NOT_STARTED: "neutral",
  IN_PROGRESS: "primary",
  SUBMITTED: "success",
  EXPIRED: "warning",
};

const ROW_LABEL: Record<string, string> = {
  NOT_STARTED: "Not started",
  IN_PROGRESS: "Sitting now",
  SUBMITTED: "Submitted",
  EXPIRED: "Ran out of time",
};

export default async function ResultsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");

  const { id } = await params;
  // A malformed id is a page that does not exist, not a database error.
  if (!z.uuid().safeParse(id).success) notFound();
  const [results, analysis] = await Promise.all([
    assignmentResults(session.actor.organizationId, id),
    itemAnalysis(session.actor.organizationId, id),
  ]);
  if (!results) notFound();

  const attention = (analysis?.items ?? []).filter((item) => item.needsAttention);

  return (
    <AppShell
      currentPath="/teacher/assessments"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        eyebrow={
          <>
            <Link href={`/teacher/assignments/${id}`}>{results.className}</Link>
          </>
        }
        title={results.title}
        description={`${results.submitted} of ${results.expected} sat this paper.`}
        actions={
          <>
            {results.awaitingMarking > 0 && (
              <Link
                href={`/teacher/assignments/${id}/marking`}
                className="ui-button"
                data-variant="primary"
              >
                <span>
                  Mark {results.awaitingMarking}{" "}
                  {results.awaitingMarking === 1 ? "paper" : "papers"}
                </span>
              </Link>
            )}
            <ReleaseButton
              assignmentId={id}
              releasedAt={results.resultsReleasedAt?.toISOString() ?? null}
              policy={results.resultsPolicy}
              awaitingMarking={results.awaitingMarking}
            />
          </>
        }
      />

      {/*
        Four figures, and every one of them is computed over fully marked papers
        only — with the count in the caption rather than leaving a teacher to
        assume it is all of them. Below the threshold `core/` returns null for
        all four and this renders em dashes, because four cards reading "0%"
        off a single marked paper says the class failed when in truth nobody
        has marked it.
      */}
      <Grid>
        <StatCard
          label="Class average"
          value={results.mean === null ? undefined : `${results.mean}%`}
          context={captionFor(results)}
          emptyReason={captionFor(results)}
        />
        <StatCard
          label="Median"
          value={results.median === null ? undefined : `${results.median}%`}
          emptyReason={captionFor(results)}
        />
        <StatCard
          label="Highest"
          value={results.highest === null ? undefined : `${results.highest}%`}
          emptyReason={captionFor(results)}
        />
        <StatCard
          label="Lowest"
          value={results.lowest === null ? undefined : `${results.lowest}%`}
          emptyReason={captionFor(results)}
        />
      </Grid>

      <div className="ui-class-layout" style={{ marginTop: 20 }}>
        <Stack>
          <Card
            title={`Students (${results.expected})`}
            description="The latest sitting for each student."
          >
            <ul className="ui-result-rows">
              {results.rows.map((row) => (
                <li key={row.studentUserId}>
                  <span className="ui-result-name">{row.fullName}</span>
                  {row.pendingMarks > 0 && (
                    <Badge tone="warning">
                      {/*
                        Marks, not papers or answers: "4 to mark" beside
                        "Mark 7 papers" read as four papers.
                      */}
                      {row.pendingMarks} {row.pendingMarks === 1 ? "mark" : "marks"} still to award
                    </Badge>
                  )}
                  <Badge tone={ROW_TONE[row.status] ?? "neutral"}>
                    {ROW_LABEL[row.status]}
                  </Badge>
                  <span className="ui-row-score tabular">
                    {/*
                      An em dash, never a zero. A student who has not sat the
                      paper and a student who scored nothing are opposite facts,
                      and only one of them is about the student.
                    */}
                    {row.rawScore === null
                      ? "—"
                      : `${row.rawScore} / ${row.maxScore}`}
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          {analysis && analysis.items.length > 0 && (
            <Card
              title="Question by question"
              description="How much of the marks available the class actually earned."
            >
              <ol className="ui-items">
                {analysis.items.map((item) => (
                  <li key={item.assessmentQuestionId} className="ui-item">
                    <div className="ui-item-head">
                      <span className="ui-item-position tabular">
                        Q{item.position}
                      </span>
                      <span className="ui-item-stem">{item.stem}</span>
                      <span className="ui-item-facility tabular">
                        {item.facility === null
                          ? "—"
                          : `${Math.round(item.facility * 100)}%`}
                      </span>
                    </div>

                    {item.facility !== null && (
                      <div
                        className="ui-facility"
                        role="img"
                        aria-label={`${Math.round(item.facility * 100)} per cent of the marks available`}
                      >
                        <span
                          className="ui-facility-fill"
                          data-low={item.needsAttention || undefined}
                          style={{ width: `${Math.round(item.facility * 100)}%` }}
                        />
                      </div>
                    )}

                    {item.pending > 0 && (
                      <p className="ui-item-note">
                        {item.pending}{" "}
                        {item.pending === 1 ? "answer is" : "answers are"} still
                        to be marked, so there is no figure yet.
                      </p>
                    )}

                    {item.options && (
                      <ul className="ui-choices">
                        {item.options.map((option) => (
                          <li
                            key={option.key}
                            data-correct={option.isCorrect || undefined}
                          >
                            <span className="ui-choice-key">{option.key}</span>
                            <span className="ui-choice-text">{option.text}</span>
                            <span className="ui-choice-count tabular">
                              {option.chosen}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {item.topDistractor && (
                      // The most useful sentence on the page: not "this was
                      // hard" but "they believe this specific wrong thing".
                      <p className="ui-item-note" data-tone="warning">
                        More students chose <strong>{item.topDistractor.key}</strong>{" "}
                        than the right answer. That is a misconception to teach
                        against, not a hard question.
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </Card>
          )}
        </Stack>

        <Stack>
          <Card title="Where the class stands">
            <dl className="ui-facts">
              <dt>Expected</dt>
              <dd className="tabular">{results.expected}</dd>
              <dt>Submitted</dt>
              <dd className="tabular">{results.submitted}</dd>
              <dt>Sitting now</dt>
              <dd className="tabular">{results.inProgress}</dd>
              <dt>Not started</dt>
              <dd className="tabular">{results.notStarted}</dd>
              <dt>Awaiting marking</dt>
              <dd className="tabular">{results.awaitingMarking}</dd>
            </dl>
          </Card>

          {attention.length > 0 && (
            <Card
              title="Worth a lesson"
              description="Questions where the class earned under 40% of the marks."
            >
              <ul className="ui-attention">
                {attention.map((item) => (
                  <li key={item.assessmentQuestionId}>
                    <span className="ui-item-position tabular">Q{item.position}</span>
                    <span>{item.stem}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </Stack>
      </div>
    </AppShell>
  );
}

/**
 * Names the denominator, always.
 *
 * "62%" and "62% across 18 of 24 papers" are different claims, and a teacher
 * deciding whether to reteach a chapter needs the second one. When there is no
 * figure, it says which of the three reasons applies rather than leaving a
 * teacher to work out whether the class did badly or nobody has marked it.
 */
function captionFor(results: {
  counted: number;
  submitted: number;
  awaitingMarking: number;
  enoughToSummarise: boolean;
}): string {
  if (results.submitted === 0) return "Nobody has sat this yet.";
  if (results.counted === 0) return "No paper is fully marked yet.";
  if (!results.enoughToSummarise) {
    return `Only ${results.counted} of ${results.submitted} papers are marked — too few to describe the class.`;
  }
  if (results.awaitingMarking === 0) {
    return `Across all ${results.counted} papers.`;
  }
  return `Across ${results.counted} of ${results.submitted} papers — the rest are still being marked.`;
}

import Link from "next/link";
import type { ClassPaper } from "@/core/assignments/class-papers";
import { Badge, Card } from "@/ui";

/**
 * The papers set for this class, newest window first.
 *
 * Every figure is a count somebody can act on, and each one links to the page
 * where it is dealt with: writing now to the live view, answers to mark to the
 * marking board, everything else to the results. There is no score column —
 * see core/assignments/class-papers.
 */

const STATUS: Record<ClassPaper["status"], { label: string; tone: "success" | "primary" | "neutral" | "warning" }> = {
  OPEN: { label: "Open", tone: "success" },
  SCHEDULED: { label: "Scheduled", tone: "primary" },
  CLOSED: { label: "Closed", tone: "neutral" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

const formatWhen = (date: Date) =>
  new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(date);

export function ClassPapers({
  classId,
  papers,
  total,
}: {
  classId: string;
  papers: ClassPaper[];
  total: number;
}) {
  return (
    <Card
      title={`Papers (${total})`}
      description="Everything set for this class, the latest first."
      action={
        <Link
          href={`/teacher/assessments?new=1&class=${classId}`}
          className="ui-button"
          data-variant="ghost"
          data-size="sm"
        >
          <span>Set a paper</span>
        </Link>
      }
    >
      {papers.length === 0 ? (
        <p className="ui-hint" style={{ margin: 0 }}>
          No paper has been set for this class yet. Build one and assign it to
          this class, and it appears here with who has handed it in.
        </p>
      ) : (
        <ul className="ui-class-papers">
          {papers.map((paper) => {
            const status = STATUS[paper.status];
            const window =
              paper.status === "SCHEDULED"
                ? `Opens ${formatWhen(paper.opensAt)}`
                : paper.status === "OPEN"
                  ? `Closes ${formatWhen(paper.closesAt)}`
                  : `Closed ${formatWhen(paper.closesAt)}`;
            return (
              <li key={paper.assignmentId}>
                <div className="ui-class-paper-main">
                  <Link
                    href={`/teacher/assignments/${paper.assignmentId}`}
                    className="ui-class-paper-title"
                  >
                    {paper.title}
                  </Link>
                  <span className="ui-class-paper-meta">
                    <Badge tone={status.tone}>{status.label}</Badge>
                    {paper.status !== "CANCELLED" && <span>{window}</span>}
                  </span>
                </div>

                {paper.status !== "CANCELLED" && paper.status !== "SCHEDULED" && (
                  <div className="ui-class-paper-facts">
                    <span className="tabular">
                      {paper.handedIn} of {paper.expected} handed in
                    </span>
                    {paper.writing > 0 && (
                      <Link href={`/teacher/assignments/${paper.assignmentId}/monitor`}>
                        <Badge tone="success">{paper.writing} writing now</Badge>
                      </Link>
                    )}
                    {paper.answersToMark > 0 ? (
                      <Link href={`/teacher/assignments/${paper.assignmentId}/marking`}>
                        <Badge tone="warning">
                          {paper.answersToMark}{" "}
                          {paper.answersToMark === 1 ? "answer" : "answers"} to mark
                        </Badge>
                      </Link>
                    ) : null}
                    {paper.handedIn > 0 && (
                      <Link href={`/teacher/assignments/${paper.assignmentId}/results`}>
                        {paper.resultsReleasedAt ? "Results released" : "Results not released"}
                      </Link>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {total > papers.length && (
        <p className="ui-hint" style={{ margin: "12px 0 0" }}>
          Showing the latest {papers.length} of {total}. Every paper is under{" "}
          <Link href="/teacher/assessments">Assessments</Link>.
        </p>
      )}
    </Card>
  );
}

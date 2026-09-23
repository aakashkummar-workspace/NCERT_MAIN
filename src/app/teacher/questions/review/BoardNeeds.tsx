import Link from "next/link";
import { Badge, Card } from "@/ui";
import type { SubjectNeeds } from "@/core/questions/board-needs";

const TYPE_WORD: Record<string, string> = {
  MCQ: "multiple choice",
  MULTI_SELECT: "multi-select",
  TRUE_FALSE: "true / false",
  NUMERIC: "numeric",
  FILL_BLANK: "fill the blank",
  ASSERTION_REASON: "assertion–reason",
  VSA: "very short answer",
  SA: "short answer",
  LA: "long answer",
  CASE_STUDY: "case study",
};

/**
 * Where to start: what one board paper still needs, per subject.
 *
 * Counts and a link, never a "review these for me" button — the queue still
 * shows one question at a time and nothing here approves anything. A section
 * with drafts waiting is listed first, because that is the one a reviewer's
 * next twenty minutes would actually unlock.
 */
export function BoardNeeds({
  needs,
  href,
  subjectLabel,
}: {
  needs: SubjectNeeds[];
  href: (next: { subjectId?: string; type?: string }) => string;
  subjectLabel: (subjectId: string) => string;
}) {
  const short = needs.filter((subject) => !subject.ready);
  if (short.length === 0) return null;
  // Only the subjects a reviewer can do something about are listed. The rest
  // are a COUNT: ten subjects of four sections each is forty lines saying the
  // same thing, and a console is not a dump — the same reason the concept
  // console's "measures nothing yet" alert states a number rather than names.
  const actionable = short.filter((subject) =>
    subject.sections.some((section) => section.drafts > 0 && section.approved < section.wanted),
  );
  const rest = short.length - actionable.length;

  return (
    <Card
      title="What a board paper still needs"
      description="Per subject, the sections one board-pattern paper could not fill from your approved bank. Reviewing the drafts waiting for a section is what fills it; sections you already have enough for are left out."
    >
      {actionable.map((subject) => (
        <div key={subject.subjectId} className="ui-rq-needs-subject">
          <p className="ui-rq-needs-title">
            <strong>{subjectLabel(subject.subjectId)}</strong>{" "}
            <span className="ui-hint">· {subject.patternLabel}</span>
          </p>
          <ul className="ui-rq-needs-list">
            {subject.sections
              .filter((section) => section.approved < section.wanted)
              .map((section) => {
              const missing = section.wanted - section.approved;
              return (
                <li key={section.names}>
                  <span className="ui-rq-needs-section">
                    Section {section.names} · {section.title.toLowerCase()} ({section.marksEach}{" "}
                    {section.marksEach === 1 ? "mark" : "marks"})
                  </span>
                  <span className="tabular">
                    {section.approved} of {section.wanted} approved
                  </span>
                  {missing === 0 ? (
                    <Badge tone="success">Enough for one paper</Badge>
                  ) : section.drafts > 0 ? (
                    <Link href={href({ subjectId: subject.subjectId, type: section.type })}>
                      Review {section.drafts} waiting {TYPE_WORD[section.type] ?? "draft"}{" "}
                      {section.drafts === 1 ? "draft" : "drafts"}
                    </Link>
                  ) : (
                    <span className="ui-hint">
                      {missing} more needed, and none written yet — these have to be added to the bank.
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {rest > 0 && (
        <p className="ui-hint" style={{ margin: actionable.length > 0 ? "14px 0 0" : 0 }}>
          {rest === short.length
            ? `${rest} ${rest === 1 ? "subject cannot" : "subjects cannot"} fill a board paper from your approved bank, and ${rest === 1 ? "it has" : "they have"} no drafts waiting.`
            : `${rest} other ${rest === 1 ? "subject is" : "subjects are"} short too, with no drafts waiting.`}{" "}
          Those questions have to be written — the review queue cannot supply what nobody has added.{" "}
          <Link href="/teacher/questions/generate/">Generate drafts</Link> or write them by hand.
        </p>
      )}
    </Card>
  );
}

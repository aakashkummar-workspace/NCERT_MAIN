import Link from "next/link";
import type { Metadata } from "next";
import { reviewOverview, type ReviewCounts } from "@/core/curriculum/review";
import { Alert, PageHeader, Stack } from "@/ui";

export const metadata: Metadata = { title: "Review" };

function Progress({ counts }: { counts: ReviewCounts }) {
  if (counts.total === 0) return <span className="ui-cr-cell ui-hint">—</span>;
  const percent = Math.round((counts.reviewed / counts.total) * 100);
  return (
    <span className="ui-cr-cell" data-done={counts.reviewed === counts.total || undefined}>
      <span className="tabular">
        {counts.reviewed} of {counts.total}
      </span>
      <span className="ui-cr-bar" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </span>
    </span>
  );
}

export default async function ReviewPage() {
  const { subjects, librarySource } = await reviewOverview();

  return (
    <Stack>
      <PageHeader
        title="Review the imported curriculum"
        description="Every outcome, concept and question tag from the NCERT import is a draft until a subject teacher approves it here. Mastery figures, gaps and reports all run on them."
      />
      {!librarySource && (
        <Alert tone="warning">
          No question library is configured (QUESTION_LIBRARY_SOURCE), so there are no question tags to review.
        </Alert>
      )}
      <div
        className="ui-cr-table-wrap"
        tabIndex={0}
        role="region"
        aria-label="Review progress by subject"
      >
        <table className="ui-cr-table">
          <thead>
            <tr>
              <th scope="col">Subject</th>
              <th scope="col">Outcomes reviewed</th>
              <th scope="col">Concepts reviewed</th>
              <th scope="col">Question tags reviewed</th>
            </tr>
          </thead>
          <tbody>
            {subjects.map((subject) => (
              <tr key={subject.id}>
                <th scope="row">
                  <Link href={`/admin/review/${subject.id}`}>
                    {subject.gradeLabel} · {subject.name}
                  </Link>
                </th>
                <td>
                  <Progress counts={subject.outcomes} />
                </td>
                <td>
                  <Progress counts={subject.concepts} />
                </td>
                <td>
                  <Progress counts={subject.tags} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Stack>
  );
}

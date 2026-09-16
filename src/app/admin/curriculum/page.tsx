import Link from "next/link";
import type { Metadata } from "next";
import { curriculumOverview } from "@/core/curriculum/admin";
import { conceptCoverage } from "@/core/curriculum/concepts";
import { Alert, Badge, PageHeader, Stack } from "@/ui";

export const metadata: Metadata = { title: "Curriculum" };

export default async function CurriculumPage() {
  // Every board, not the console user's own: this is the platform's tool, and
  // authoring is done once here for every school on every board.
  const [boards, coverage] = await Promise.all([
    curriculumOverview(),
    conceptCoverage(),
  ]);
  const needing = boards.reduce(
    (sum, board) =>
      sum +
      board.grades.reduce(
        (g, grade) =>
          g +
          grade.subjects.reduce(
            (s, subject) => s + subject.chaptersNeedingOutcomes,
            0,
          ),
        0,
      ),
    0,
  );

  return (
    <Stack>
      <PageHeader
        eyebrow="Platform"
        title="Curriculum"
        description="The tree every organisation reads. Chapters came from the NCERT contents; learning outcomes are authored here."
      />

      {needing > 0 && (
        <Alert tone="warning" title={`${needing} chapters have no learning outcomes`}>
          An outcome statement is not a label — it is the only grounding a
          generated question will have, so a chapter without one cannot produce
          questions worth a teacher&rsquo;s time. Class 10 Mathematics, chapter 6
          is authored as the worked example.
        </Alert>
      )}

      {coverage.uncovered.length > 0 && (
        // The second, quieter hole. An outcome with no concept produces
        // questions that are written, approved, sat and marked — and inform
        // nothing, because mastery is measured per concept. Nothing else on
        // any screen says so, and an analytics page that is empty for reasons
        // nobody can explain is the failure this prevents.
        <Alert
          tone="warning"
          title={`${coverage.uncovered.length} outcomes are not covered by a concept`}
        >
          Mastery is measured per concept, not per outcome — the same idea is
          tested by outcomes in several chapters, and measuring per outcome
          fragments the evidence. An answer to a question filed under one of
          these {coverage.uncovered.length} outcomes is scored and shown to the
          student, and informs no estimate at all.{" "}
          {coverage.coveredOutcomes} of {coverage.outcomes} are covered by{" "}
          {coverage.concepts} {coverage.concepts === 1 ? "concept" : "concepts"}.{" "}
          {/*
            Until this link existed the console could state this hole and do
            nothing about it: concepts could only be seeded, so the number was
            a report on a problem nobody using the product could fix.
          */}
          <Link href="/admin/curriculum/concepts">Author concepts</Link>.
        </Alert>
      )}

      {boards.map((board) => (
        <section key={board.id}>
          <h2 className="ui-platform-heading">{board.name}</h2>

          {board.grades.length === 0 && (
            // Seeded shape, no content. Said out loud rather than left as an
            // empty heading: a board nobody has authored is a known hole, and
            // a school on it can create no classes at all.
            <p className="ui-hint">
              No grades or subjects are authored under {board.code} yet, so no
              organisation can teach it. Seed its grades and subjects first.
            </p>
          )}

          {board.grades.map((grade) => (
            <div key={grade.id}>
              <h3 className="ui-platform-heading">{grade.label}</h3>
              <div className="ui-subject-grid">
                {grade.subjects.map((subject) => (
                  <Link
                    key={subject.id}
                    href={`/admin/curriculum/${subject.id}`}
                    className="ui-subject-card"
                  >
                    <span className="ui-subject-name">{subject.name}</span>
                    <span className="ui-subject-meta">
                      {subject.chapterCount}{" "}
                      {subject.chapterCount === 1 ? "chapter" : "chapters"}
                    </span>
                    {subject.chapterCount === 0 ? (
                      <Badge tone="neutral">No chapters yet</Badge>
                    ) : subject.chaptersNeedingOutcomes === 0 ? (
                      <Badge tone="success">All chapters authored</Badge>
                    ) : (
                      <Badge tone="warning">
                        {subject.chaptersNeedingOutcomes} need outcomes
                      </Badge>
                    )}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </section>
      ))}
    </Stack>
  );
}

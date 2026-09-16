import Link from "next/link";
import type { Metadata } from "next";
import { listConcepts, uncoveredOutcomes } from "@/core/curriculum/concept-admin";
import { conceptCoverage } from "@/core/curriculum/concepts";
import { Alert, Badge, PageHeader, Stack } from "@/ui";
import { NewConcept } from "./NewConcept";
import { SuggestConcepts } from "./SuggestConcepts";
import { curriculumOverview } from "@/core/curriculum/admin";

export const metadata: Metadata = { title: "Concepts" };

export const dynamic = "force-dynamic";

/**
 * The concept plane.
 *
 * This screen is the answer to the quietest and most expensive hole in the
 * product: mastery is measured per CONCEPT, questions are filed against
 * OUTCOMES, and until now nothing could create the link between them outside a
 * seed file. So an outcome could be authored, questioned, sat, marked and
 * released, and inform no estimate at all — the product working perfectly while
 * the intelligent half of it has nothing to say.
 *
 * ---------------------------------------------------------------------------
 * Grouped by subject, because a full syllabus is hundreds of these
 * ---------------------------------------------------------------------------
 * The first version rendered every concept as one flat list and ran to fifteen
 * thousand pixels — findable only with the browser's own search. A console is
 * not a dump. Concepts are grouped by the subject their outcomes belong to,
 * exactly as the curriculum console groups chapters, and the ones that measure
 * nothing yet are pulled out at the top: they are the work, not the archive.
 */
export default async function ConceptsPage() {
  const [concepts, uncovered, coverage, tree] = await Promise.all([
    listConcepts(),
    uncoveredOutcomes(undefined, 50),
    conceptCoverage(),
    curriculumOverview(),
  ]);

  // Only subjects that actually have uncovered outcomes are worth drafting
  // against — offering the rest is offering a button that refuses. Matched by
  // ID: matching by name offered ICSE "Mathematics" because CBSE Mathematics
  // had work left, and that run could only ever refuse.
  const uncoveredSubjects = new Set(
    (await uncoveredOutcomes(undefined, 2000)).map((row) => row.subjectId),
  );
  const draftableSubjects = tree
    .flatMap((board) =>
      board.grades.flatMap((grade) =>
        grade.subjects.map((subject) => ({
          id: subject.id,
          // The board is in the label because two boards both have a
          // "Class 10 Mathematics", and a drafting run against the wrong one
          // proposes concepts for a syllabus nobody asked about.
          label: `${board.code} ${grade.label} ${subject.name}`,
          name: subject.name,
        })),
      ),
    )
    .filter((subject) => uncoveredSubjects.has(subject.id));

  const unmeasurable = concepts.filter((concept) => concept.outcomeCount === 0);
  const measurable = concepts.filter((concept) => concept.outcomeCount > 0);

  // A concept's outcomes can span subjects — that is the point of a concept —
  // so it appears under each, rather than being forced into one.
  const bySubject = new Map<string, typeof concepts>();
  for (const concept of measurable) {
    for (const subject of concept.subjects) {
      const list = bySubject.get(subject) ?? [];
      list.push(concept);
      bySubject.set(subject, list);
    }
  }
  const subjects = [...bySubject.keys()].sort();

  return (
    <Stack>
      <PageHeader
        eyebrow={<Link href="/admin/curriculum">Curriculum</Link>}
        title="Concepts"
        description="What a mastery figure is attached to. A concept has no organisation — every school reads the same one, which is what makes cross-tenant intelligence possible and why every change here is audited."
      />

      <Alert
        tone={coverage.coveredOutcomes === coverage.outcomes ? "info" : "warning"}
        title={`${coverage.coveredOutcomes} of ${coverage.outcomes} outcomes are covered by ${coverage.concepts} ${coverage.concepts === 1 ? "concept" : "concepts"}`}
      >
        An answer to a question filed under an uncovered outcome is scored and
        shown to the student, and moves no estimate. Everything downstream —
        analytics, gaps, practice, the study plan and term reports — is keyed on
        concepts, so this number is the ceiling on all of it.
      </Alert>

      <NewConcept />

      <SuggestConcepts subjects={draftableSubjects} />

      {unmeasurable.length > 0 && (
        // The count, not the names. With a hundred of these the alert became
        // longer than the page it was warning about — and an alert nobody can
        // read is an alert nobody reads.
        <Alert
          tone="warning"
          title={`${unmeasurable.length} ${unmeasurable.length === 1 ? "concept measures" : "concepts measure"} nothing yet`}
        >
          Nothing can be measured through a concept with no outcomes linked.
          They are listed first below.
        </Alert>
      )}

      {unmeasurable.length > 0 && (
        <section>
          <h2 className="ui-platform-heading">Not measurable yet</h2>
          <ConceptList concepts={unmeasurable.slice(0, 60)} />
          {unmeasurable.length > 60 && (
            // A truncated list says it is truncated — the same rule the audit
            // view follows, and for the same reason.
            <p className="ui-hint">
              Showing 60 of {unmeasurable.length}.
            </p>
          )}
        </section>
      )}

      {subjects.map((subject) => (
        <section key={subject}>
          <h2 className="ui-platform-heading">
            {subject}{" "}
            <span className="ui-concept-meta tabular">
              {bySubject.get(subject)!.length}
            </span>
          </h2>
          <ConceptList
            concepts={[...bySubject.get(subject)!].sort((a, b) =>
              a.name.localeCompare(b.name),
            )}
          />
        </section>
      ))}

      {concepts.length === 0 && (
        <p className="ui-hint">
          None yet. Nothing in this product can measure anything until there is
          at least one.
        </p>
      )}

      {uncovered.length > 0 && (
        <section>
          {/*
            The worklist. `conceptCoverage()` has always put the NUMBER on the
            console; this puts the rows in front of the person who can fix them,
            which is the difference between knowing and being able to act.
          */}
          <h2 className="ui-platform-heading">Outcomes nothing measures</h2>
          <p className="ui-hint" style={{ marginBottom: 12 }}>
            Open a concept and link these, or create one for the idea they
            share. The same idea is usually tested by outcomes in several
            chapters — that is exactly why mastery is per concept and not per
            outcome.
            {coverage.uncovered.length > uncovered.length && (
              <>
                {" "}
                {/*
                  A truncated list says it is truncated — the same rule the
                  audit view follows. Without it an author works through fifty
                  rows, sees the list empty, and believes the job is done.
                */}
                <strong>
                  Showing {uncovered.length} of {coverage.uncovered.length}.
                </strong>
              </>
            )}
          </p>
          <ul className="ui-uncovered-list">
            {uncovered.map((outcome) => (
              <li key={outcome.id}>
                <span className="ui-uncovered-code tabular">{outcome.code}</span>
                <span className="ui-uncovered-statement">{outcome.statement}</span>
                <span className="ui-uncovered-where">
                  {outcome.gradeLabel} {outcome.subjectName} · {outcome.chapterTitle}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Stack>
  );
}

function ConceptList({
  concepts,
}: {
  concepts: {
    id: string;
    name: string;
    subjects: string[];
    outcomeCount: number;
    prerequisiteCount: number;
  }[];
}) {
  return (
    <ul className="ui-concept-list">
      {concepts.map((concept) => (
        <li key={`${concept.id}`}>
          <Link href={`/admin/curriculum/concepts/${concept.id}`}>
            <span className="ui-concept-name">
              {concept.name}
              {concept.outcomeCount === 0 && (
                <Badge tone="warning">not measurable</Badge>
              )}
            </span>
            <span className="ui-concept-meta">
              {concept.subjects.length > 0
                ? concept.subjects.join(" · ")
                : "no subject yet"}
            </span>
            <span className="ui-concept-meta tabular">
              {concept.outcomeCount}{" "}
              {concept.outcomeCount === 1 ? "outcome" : "outcomes"}
              {concept.prerequisiteCount > 0 &&
                ` · ${concept.prerequisiteCount} prereq`}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

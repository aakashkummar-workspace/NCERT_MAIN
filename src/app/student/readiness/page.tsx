import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { examReadiness, type MeasuredConcept } from "@/core/readiness";
import { StudentShell } from "@/ui/StudentShell";
import { PageHeader } from "@/ui";

export const metadata: Metadata = { title: "Exam readiness" };

// Derived from evidence at read time, stored nowhere. A cached copy of this
// page would tell a student a chapter is untested the morning after they sat a
// paper on it — same reason the plan and an assignment's status are computed
// rather than kept.
export const dynamic = "force-dynamic";

/**
 * Exam readiness.
 *
 * ---------------------------------------------------------------------------
 * Coverage is the headline, and usually it is the whole page
 * ---------------------------------------------------------------------------
 * The figures at the top come first in both states — picture and refusal —
 * because the denominator is the context for everything under it. A page that
 * led with "5 secure" and buried "of 6 chapters out of 51" would let somebody
 * three weeks from their boards read a year's confidence into two papers.
 *
 * ---------------------------------------------------------------------------
 * There is no readiness percentage on this page
 * ---------------------------------------------------------------------------
 * `core/readiness` has no field for one, so this file could not print one if it
 * wanted to. The note at the foot says so out loud, because a fifteen-year-old
 * who came here for a number and found none deserves to be told it is a
 * decision rather than a gap — and because the next person asked to "just add
 * the percentage" should find the reason written down.
 *
 * ---------------------------------------------------------------------------
 * The untested list is framed as what has been SET, not as a failure
 * ---------------------------------------------------------------------------
 * Forty chapters listed under a heading a student reads as their own fault is
 * the fastest way to make this page one they never open again. Nothing on that
 * list is anything they did; it is what nobody has asked them about yet, and
 * every sentence around it says so.
 */

const BAND_WORD: Record<MeasuredConcept["band"], string> = {
  SECURE: "Secure",
  DEVELOPING: "Developing",
  FRAGILE: "Fragile",
  CRITICAL: "Needs work",
};

function percent(estimate: number): string {
  return `${Math.round(estimate * 100)}%`;
}

/** "8 answers" — the number a student can weigh the figure against. */
function answers(count: number): string {
  return `${count} ${count === 1 ? "answer" : "answers"}`;
}

export default async function ReadinessPage() {
  const session = await getSession();
  if (!session) redirect("/signin/student");
  if (session.actor.role !== "STUDENT") redirect("/teacher");

  const readiness = await examReadiness({
    organizationId: session.actor.organizationId,
    userId: session.actor.userId,
  });

  const { coverage } = readiness;
  const manySubjects = readiness.subjects.length > 1;

  return (
    <StudentShell
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        eyebrow={<Link href="/student/progress">My progress</Link>}
        title="Exam readiness"
        description="How much of your syllabus anyone has actually looked at, and what your answers say about the parts they have."
      />

      {/* ------------------------------------------------- Coverage first --
          Hidden only when there is no syllabus at all. "0 of 0 chapters",
          three times, above a sentence explaining that we do not know which
          subjects they sit, reads as a broken page rather than an honest one —
          and an em dash is the rule for a figure that does not exist, not a
          zero. Here the whole block is the thing that does not exist yet. */}
      {coverage.totalChapters > 0 && (
        <section className="ui-readiness-coverage" aria-labelledby="coverage-heading">
          <h2 id="coverage-heading" className="ui-readiness-heading">
            How much has been looked at
          </h2>
          <ul className="ui-readiness-figures">
            <li className="ui-readiness-figure">
              <p className="ui-readiness-count tabular">
                {coverage.testedChapters}
                <span className="ui-readiness-of"> of {coverage.totalChapters}</span>
              </p>
              <p className="ui-readiness-figure-label">
                chapters have been on a test you sat
              </p>
            </li>
            <li className="ui-readiness-figure">
              <p className="ui-readiness-count tabular">
                {coverage.measuredChapters}
                <span className="ui-readiness-of"> of {coverage.totalChapters}</span>
              </p>
              <p className="ui-readiness-figure-label">
                have enough answers behind them to say anything
              </p>
            </li>
            <li className="ui-readiness-figure">
              <p className="ui-readiness-count tabular">
                {coverage.measuredConcepts}
                <span className="ui-readiness-of"> of {coverage.totalConcepts}</span>
              </p>
              <p className="ui-readiness-figure-label">
                ideas in {manySubjects ? "your subjects" : readiness.subjects[0] ?? "your subject"}{" "}
                are measured
              </p>
            </li>
          </ul>
        </section>
      )}

      {!readiness.ok ? (
        /*
          The refusal, and it is the common case rather than an error state.
          Styled as a statement, not as a warning: nothing has gone wrong, and
          a red panel would tell a student that something had.
        */
        <section className="ui-readiness-refusal">
          <h2 className="ui-readiness-refusal-title">{readiness.headline}</h2>
          <p className="ui-readiness-refusal-body">{readiness.message}</p>
          {/*
            The action has to match the refusal. Offering "practise something"
            to somebody who is in no class sends them to a page that can only
            refuse them again — the second refusal in a row is the one that
            teaches a student the product does not work.
          */}
          <div className="ui-readiness-actions">
            {readiness.subjects.length === 0 ? (
              <Link href="/student" className="ui-button" data-variant="primary">
                <span>Join a class</span>
              </Link>
            ) : coverage.measuredConcepts === 0 ? (
              // Nothing measured means practice has nothing to recommend and
              // the plan has nothing to order but papers — both would be a
              // second refusal. The one thing that moves this page is sitting
              // a test, and the tests are on Home.
              <Link href="/student" className="ui-button" data-variant="primary">
                <span>See your tests</span>
              </Link>
            ) : (
              <>
                <Link href="/student/plan" className="ui-button" data-variant="primary">
                  <span>What to do next</span>
                </Link>
                <Link
                  href="/student/practice"
                  className="ui-button"
                  data-variant="secondary"
                >
                  <span>Practise something</span>
                </Link>
              </>
            )}
          </div>
        </section>
      ) : (
        <>
          <section className="ui-readiness-standing">
            <h2 className="ui-readiness-heading">
              Of the {coverage.measuredConcepts} ideas measured
            </h2>
            {/*
              Three counts, never one number. Colour is never the only
              encoding either — every band carries its word beside the figure,
              so the row survives a colourblind reader and a bad screen.
            */}
            <ul className="ui-readiness-bands">
              <li data-band="SECURE">
                <span className="ui-readiness-band-count tabular">
                  {readiness.standing.secure}
                </span>
                <span className="ui-readiness-band-word">secure</span>
              </li>
              <li data-band="DEVELOPING">
                <span className="ui-readiness-band-count tabular">
                  {readiness.standing.developing}
                </span>
                <span className="ui-readiness-band-word">developing</span>
              </li>
              <li data-band="CRITICAL">
                <span className="ui-readiness-band-count tabular">
                  {readiness.standing.needsWork}
                </span>
                <span className="ui-readiness-band-word">need work</span>
              </li>
            </ul>
            <p className="ui-readiness-summary">{readiness.summary}</p>
            {readiness.caveat && (
              <p className="ui-readiness-caveat">{readiness.caveat}</p>
            )}
          </section>

          {readiness.attention.length > 0 && (
            <section>
              <h2 className="ui-readiness-heading">Worth your time first</h2>
              <ul className="ui-readiness-concepts">
                {readiness.attention.map((concept) => (
                  <li key={concept.conceptId} className="ui-readiness-concept">
                    <div className="ui-readiness-concept-body">
                      <p className="ui-readiness-concept-name">
                        {concept.conceptName}
                      </p>
                      {/*
                        The figure it came from, in the sentence. A number a
                        student cannot interrogate is one they stop trusting
                        the first time it feels wrong — the same reason every
                        practice recommendation carries its rationale.
                      */}
                      <p className="ui-readiness-concept-figure">
                        {BAND_WORD[concept.band]} · about {percent(concept.estimate)}{" "}
                        right over {answers(concept.evidenceCount)}
                      </p>
                    </div>
                    <Link
                      href={`/student/practice?conceptId=${concept.conceptId}`}
                      className="ui-button"
                      data-variant="secondary"
                      data-size="md"
                    >
                      <span>Practise</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {readiness.strengths.length > 0 && (
            <section>
              <h2 className="ui-readiness-heading">Holding up</h2>
              <ul className="ui-readiness-concepts">
                {readiness.strengths.map((concept) => (
                  <li
                    key={concept.conceptId}
                    className="ui-readiness-concept"
                    data-quiet="true"
                  >
                    <div className="ui-readiness-concept-body">
                      <p className="ui-readiness-concept-name">
                        {concept.conceptName}
                      </p>
                      <p className="ui-readiness-concept-figure">
                        About {percent(concept.estimate)} right over{" "}
                        {answers(concept.evidenceCount)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {/* ------------------------------------------- What nobody has asked -- */}
      {readiness.untested.length > 0 && (
        <section>
          <h2 className="ui-readiness-heading">
            Not on any test you have sat ({readiness.untested.length})
          </h2>
          <p className="ui-readiness-note">
            {/*
              Whose gap this is, said before the list rather than after it. A
              student scrolling forty chapter titles under a heading they read
              as an accusation closes the page, and they would be closing it on
              the most useful thing here — the list to take to a teacher.
            */}
            This is about what has been set, not about you. Nothing here counts
            against you anywhere in this product; it is simply the part of the
            syllabus nobody has asked you about yet.
          </p>
          <ul className="ui-readiness-chapters">
            {readiness.untested.map((chapter) => (
              <li key={chapter.chapterId} className="ui-readiness-chapter">
                <span className="ui-readiness-chapter-number tabular">
                  {chapter.number}
                </span>
                <span className="ui-readiness-chapter-title">{chapter.title}</span>
                {manySubjects && (
                  <span className="ui-readiness-chapter-subject">
                    {chapter.subjectName}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {readiness.thin.length > 0 && (
        <section>
          <h2 className="ui-readiness-heading">
            Asked about, not enough to say yet ({readiness.thin.length})
          </h2>
          <p className="ui-readiness-note">
            {/*
              A third state, and it has to be nameable. "Tested" and "measured"
              are different facts: a couple of questions on a chapter is a
              sitting, not a measurement, and calling it either of the other
              two would be a small lie in both directions.
            */}
            A test has covered {readiness.thin.length === 1 ? "this" : "these"},
            but not enough answers on any one idea in{" "}
            {readiness.thin.length === 1 ? "it" : "them"} to stand behind a
            figure yet.
          </p>
          <ul className="ui-readiness-chapters">
            {readiness.thin.map((chapter) => (
              <li key={chapter.chapterId} className="ui-readiness-chapter">
                <span className="ui-readiness-chapter-number tabular">
                  {chapter.number}
                </span>
                <span className="ui-readiness-chapter-title">{chapter.title}</span>
                {manySubjects && (
                  <span className="ui-readiness-chapter-subject">
                    {chapter.subjectName}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="ui-readiness-footnote">
        There is no single readiness score on this page, and there will not be
        one. A percentage across every idea would move whenever the syllabus
        moved rather than when you did, it would be decided mostly by which
        chapters happened to be tested, and it would hide the only two things
        you can act on — which idea, and which chapter nobody has asked you
        about.
      </p>
    </StudentShell>
  );
}

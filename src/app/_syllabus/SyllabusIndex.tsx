import type { SyllabusGrade } from "@/core/curriculum/syllabus";
import type { ChapterContents } from "@/core/curriculum/chapter-contents";
import { Badge } from "@/ui";

/** What the chapter contains, as read from the NCERT book. */
function BookContents({ contents }: { contents: ChapterContents }) {
  // Hindi books are coded ih… / jh…; their contents are written in Hindi.
  const lang = /^[ij]h/.test(contents.book) ? "hi-IN" : "en-IN";
  const byline = [contents.form, contents.author].filter(Boolean).join(" · ");
  return (
    <div className="ui-syl-book" lang={lang}>
      <p className="ui-syl-book-source">
        From the book: {contents.bookTitle}, chapter {contents.bookChapter}
        {contents.pages ? ` · ${contents.pages} pages` : ""}
        {byline ? ` · ${byline}` : ""}
      </p>
      <p className="ui-syl-book-overview">{contents.overview}</p>

      {contents.sections.length > 0 && (
        <ol className="ui-syl-sections">
          {contents.sections.map((section, index) => (
            <li key={index}>
              <p className="ui-syl-section-title">
                {section.number && <span className="tabular">{section.number} </span>}
                {section.title}
              </p>
              {section.points.length > 0 && (
                <ul className="ui-syl-points">
                  {section.points.map((point, i) => (
                    <li key={i}>{point}</li>
                  ))}
                </ul>
              )}
              {section.subsections.length > 0 && (
                <ol className="ui-syl-sections" data-level="2">
                  {section.subsections.map((sub, i) => (
                    <li key={i}>
                      <p className="ui-syl-section-title">
                        {sub.number && <span className="tabular">{sub.number} </span>}
                        {sub.title}
                      </p>
                      {sub.points.length > 0 && (
                        <ul className="ui-syl-points">
                          {sub.points.map((point, j) => (
                            <li key={j}>{point}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </li>
          ))}
        </ol>
      )}

      {contents.keyTerms.length > 0 && (
        <div className="ui-syl-book-part">
          <h5 className="ui-syl-part-title">Key terms</h5>
          <dl className="ui-syl-defs">
            {contents.keyTerms.map((item, i) => (
              <div key={i}>
                <dt>{item.term}</dt>
                <dd>{item.meaning}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {contents.keyResults.length > 0 && (
        <div className="ui-syl-book-part">
          <h5 className="ui-syl-part-title">Key results and facts</h5>
          <dl className="ui-syl-defs">
            {contents.keyResults.map((item, i) => (
              <div key={i}>
                <dt>{item.label}</dt>
                <dd>{item.statement}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {(contents.activities.length > 0 || contents.exercises.length > 0) && (
        <div className="ui-syl-book-part">
          <h5 className="ui-syl-part-title">Activities and exercises</h5>
          <ul className="ui-syl-tags">
            {contents.activities.map((activity, i) => (
              <li key={`a${i}`}>{activity}</li>
            ))}
            {contents.exercises.map((exercise, i) => (
              <li key={`e${i}`} className="tabular">
                {exercise.name}
                {exercise.questions !== null &&
                  ` (${exercise.questions} ${exercise.questions === 1 ? "question" : "questions"})`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {contents.bookSummary.length > 0 && (
        <div className="ui-syl-book-part">
          <h5 className="ui-syl-part-title">The chapter&rsquo;s own summary</h5>
          <ul className="ui-syl-points">
            {contents.bookSummary.map((point, i) => (
              <li key={i}>{point}</li>
            ))}
          </ul>
        </div>
      )}

      {contents.notes && <p className="ui-hint">{contents.notes}</p>}
    </div>
  );
}

/**
 * The subject-wise chapter index, shared by the teacher and student pages.
 *
 * Built from native <details> so it opens with a tap and a keyboard, costs no
 * client JavaScript, and prints: the print stylesheet opens every chapter, so
 * Save as PDF produces the whole index rather than a column of closed rows.
 */
export function SyllabusIndex({
  grades,
  highlight,
  highlightLabel,
}: {
  grades: SyllabusGrade[];
  /** Subject ids to mark, e.g. the subjects of a student's own classes. */
  highlight?: Set<string>;
  highlightLabel?: string;
}) {
  return (
    <div className="ui-syl">
      <nav className="ui-syl-jump" aria-label="Jump to a subject">
        {grades.map((grade) => (
          <div key={grade.id} className="ui-syl-jump-row">
            <span className="ui-syl-jump-grade">{grade.label}</span>
            {grade.subjects.map((subject) => (
              <a key={subject.id} href={`#subject-${subject.id}`} className="ui-syl-chip">
                {subject.name}
              </a>
            ))}
          </div>
        ))}
      </nav>

      {grades.map((grade) => (
        <section key={grade.id} className="ui-syl-grade" aria-labelledby={`grade-${grade.id}`}>
          <h2 id={`grade-${grade.id}`} className="ui-syl-grade-title">
            {grade.label}
          </h2>

          {grade.subjects.map((subject) => (
            <section
              key={subject.id}
              id={`subject-${subject.id}`}
              className="ui-syl-subject"
              aria-labelledby={`subject-title-${subject.id}`}
            >
              <header className="ui-syl-subject-head">
                <h3 id={`subject-title-${subject.id}`} className="ui-syl-subject-title">
                  {subject.name}
                  {highlight?.has(subject.id) && (
                    <Badge tone="primary">{highlightLabel ?? "Yours"}</Badge>
                  )}
                </h3>
                <p className="ui-syl-subject-meta tabular">
                  {subject.chapters.length === 0
                    ? "Chapters not added yet"
                    : `${subject.chapters.length} ${subject.chapters.length === 1 ? "chapter" : "chapters"} · ${subject.outcomeCount} learning outcomes · ${subject.questionCount} questions`}
                </p>
              </header>

              {subject.chapters.length > 0 && (
                <ol className="ui-syl-chapters">
                  {subject.chapters.map((chapter) => (
                    <li key={chapter.id}>
                      <details className="ui-syl-chapter">
                        <summary>
                          <span className="ui-syl-chapter-number tabular">{chapter.number}</span>
                          <span className="ui-syl-chapter-title" lang="en-IN">
                            {chapter.title}
                          </span>
                          <span className="ui-syl-chapter-meta tabular">
                            {chapter.topics.length} {chapter.topics.length === 1 ? "topic" : "topics"}
                            {" · "}
                            {chapter.questionCount} {chapter.questionCount === 1 ? "question" : "questions"}
                          </span>
                        </summary>

                        <div className="ui-syl-chapter-body">
                          {chapter.contents && <BookContents contents={chapter.contents} />}
                          {chapter.contents && chapter.topics.length > 0 && (
                            <h4 className="ui-syl-part-title">Learning outcomes</h4>
                          )}
                          {chapter.topics.length === 0 ? (
                            <p className="ui-hint">No learning outcomes written for this chapter yet.</p>
                          ) : (
                            chapter.topics.map((topic, index) => (
                              <div key={index} className="ui-syl-topic">
                                <h4 className="ui-syl-topic-title" lang="en-IN">
                                  {topic.title}
                                </h4>
                                {topic.outcomes.length === 0 ? (
                                  <p className="ui-hint">No learning outcomes written yet.</p>
                                ) : (
                                  <ul className="ui-syl-outcomes">
                                    {topic.outcomes.map((outcome) => (
                                      <li key={outcome.code}>
                                        <span className="ui-syl-outcome-code tabular">{outcome.code}</span>
                                        <span className="ui-syl-outcome-text" lang="en-IN">
                                          {outcome.statement}
                                        </span>
                                        {!outcome.reviewed && (
                                          <span className="ui-syl-draft">draft</span>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            ))
                          )}
                        </div>
                      </details>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          ))}
        </section>
      ))}
    </div>
  );
}

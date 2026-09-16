/**
 * A question paper, laid out for A4.
 *
 * ---------------------------------------------------------------------------
 * Its props are declared here, not imported from core
 * ---------------------------------------------------------------------------
 * `src/ui` may not import `@/core/*` — the same rule `ReportSheet` follows.
 * The shape is structural and `core/assessments/paper.ts` satisfies it.
 *
 * ---------------------------------------------------------------------------
 * Two documents, never one with a toggle
 * ---------------------------------------------------------------------------
 * `PaperSheet` is what a class holds and it has no field for an answer;
 * `AnswerKeySheet` is the teacher's copy. A single component with
 * `showAnswers` would put both one prop away from each other, and the failure
 * is thirty photocopies of the answer key.
 *
 * The blank space after a written question is sized from its marks, because
 * that is the only signal in the data about how much is expected. A one-mark
 * VSA gets a line; a five-mark LA gets most of a page. Getting this wrong is
 * what makes a printed paper feel machine-made.
 */

export type PaperSheetQuestion = {
  position: number;
  marks: number;
  type: string;
  stem: string;
  options: { key: string; text: string }[] | null;
};

export type PaperSheetHeader = {
  schoolName: string;
  logoUrl: string | null;
  title: string;
  subjectName: string;
  gradeLabel: string;
  className: string | null;
  durationMinutes: number;
  totalMarks: number;
  questionMarks: number;
};

/** The written types, which need answer space rather than options. */
const WRITTEN = new Set(["VSA", "SA", "LA", "CASE_STUDY", "NUMERIC", "FILL_BLANK"]);

/** Ruled lines for a written answer: enough for the marks, capped at a page. */
function lines(marks: number): number {
  return Math.min(14, Math.max(2, Math.round(marks * 2.5)));
}

function Header({ header }: { header: PaperSheetHeader }) {
  return (
    <header className="ui-paper-head">
      <div className="ui-paper-school">
        {header.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="ui-paper-logo" src={header.logoUrl} alt="" />
        )}
        <span className="ui-paper-school-name">{header.schoolName}</span>
      </div>

      <h1 className="ui-paper-title">{header.title}</h1>
      <p className="ui-paper-meta">
        {header.gradeLabel} · {header.subjectName}
        {header.className ? ` · ${header.className}` : ""}
      </p>

      <div className="ui-paper-figures">
        <span>Time: {header.durationMinutes} minutes</span>
        <span>Maximum marks: {header.totalMarks}</span>
      </div>

      {/*
        Said on the sheet rather than silently reconciled. A blueprint of 20
        marks carrying 18 marks of questions is a paper somebody has to fix
        before it is sat, and the person holding the printout is the one who
        can — a teacher checking the photocopies the evening before.
      */}
      {header.questionMarks !== header.totalMarks && (
        <p className="ui-paper-warning">
          The questions below carry {header.questionMarks} marks, not{" "}
          {header.totalMarks}. Check the paper before it is sat.
        </p>
      )}
    </header>
  );
}

export function PaperSheet({
  header,
  questions,
  instructions,
}: {
  header: PaperSheetHeader;
  questions: PaperSheetQuestion[];
  instructions?: string | null;
}) {
  return (
    <article className="ui-paper">
      <Header header={header} />

      {/* Filled in by hand, because a printed paper is handed to a room. */}
      <div className="ui-paper-fields">
        <span>Name</span>
        <span>Roll no.</span>
        <span>Date</span>
      </div>

      <section className="ui-paper-instructions">
        <h2>General instructions</h2>
        <ol>
          <li>All questions are compulsory.</li>
          <li>Marks for each question are shown against it.</li>
          <li>Write your answers in the space provided.</li>
          {instructions && <li>{instructions}</li>}
        </ol>
      </section>

      <ol className="ui-paper-questions">
        {questions.map((question) => (
          <li key={question.position} className="ui-paper-question">
            <div className="ui-paper-question-head">
              <span className="ui-paper-number tabular">{question.position}.</span>
              <span className="ui-paper-stem">{question.stem}</span>
              <span className="ui-paper-marks tabular">[{question.marks}]</span>
            </div>

            {question.options && question.options.length > 0 && (
              <ol className="ui-paper-options">
                {question.options.map((option) => (
                  <li key={option.key}>
                    <span className="ui-paper-option-key">({option.key})</span>
                    <span>{option.text}</span>
                  </li>
                ))}
              </ol>
            )}

            {question.type === "TRUE_FALSE" && !question.options && (
              <p className="ui-paper-truefalse">True / False</p>
            )}

            {WRITTEN.has(question.type) && (
              <div className="ui-paper-answer-space" aria-hidden="true">
                {Array.from({ length: lines(question.marks) }, (_, index) => (
                  <span key={index} className="ui-paper-rule" />
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>

      <footer className="ui-paper-foot">End of question paper</footer>
    </article>
  );
}

export type AnswerKeySheetQuestion = PaperSheetQuestion & {
  answerLabel: string | null;
  explanation: string | null;
  difficulty: string;
  rubric: { criteria: { label: string; marks: number }[] } | null;
};

export function AnswerKeySheet({
  header,
  questions,
}: {
  header: PaperSheetHeader;
  questions: AnswerKeySheetQuestion[];
}) {
  return (
    <article className="ui-paper" data-key="true">
      <Header header={header} />
      {/* On the sheet itself, not only on the screen that printed it. A page
          that leaves the printer loses everything the screen said. */}
      <p className="ui-paper-key-banner">
        Answer key and mark scheme — teacher&rsquo;s copy. Not for distribution.
      </p>

      <ol className="ui-paper-questions">
        {questions.map((question) => (
          <li key={question.position} className="ui-paper-question">
            <div className="ui-paper-question-head">
              <span className="ui-paper-number tabular">{question.position}.</span>
              <span className="ui-paper-stem">{question.stem}</span>
              <span className="ui-paper-marks tabular">[{question.marks}]</span>
            </div>

            <dl className="ui-paper-key">
              <dt>Answer</dt>
              <dd>
                {question.answerLabel ? (
                  <strong>{question.answerLabel}</strong>
                ) : (
                  // A written answer has no key, and saying "—" would read as
                  // an omission. It is marked against the scheme below, or by
                  // judgement where there is none.
                  <span className="ui-paper-key-none">
                    Marked by hand{question.rubric ? " against the scheme below" : ""}
                  </span>
                )}
              </dd>

              {question.options && question.options.length > 0 && (
                <>
                  <dt>Options</dt>
                  <dd>
                    {question.options
                      .map((option) => `(${option.key}) ${option.text}`)
                      .join("   ")}
                  </dd>
                </>
              )}

              {question.rubric && question.rubric.criteria.length > 0 && (
                <>
                  <dt>Mark scheme</dt>
                  <dd>
                    <ul className="ui-paper-rubric">
                      {question.rubric.criteria.map((criterion) => (
                        <li key={criterion.label}>
                          <span>{criterion.label}</span>
                          <span className="tabular">{criterion.marks}</span>
                        </li>
                      ))}
                    </ul>
                  </dd>
                </>
              )}

              {question.explanation && (
                <>
                  <dt>Why</dt>
                  <dd>{question.explanation}</dd>
                </>
              )}
            </dl>
          </li>
        ))}
      </ol>

      <footer className="ui-paper-foot">End of answer key</footer>
    </article>
  );
}

import type { AnswerKey, Option } from "@/core/questions/validate";
import type { Rubric } from "@/core/questions/rubric";
import { Badge } from "@/ui";

/**
 * A question as a teacher reads it: the stem, the options with the correct one
 * marked, the answer key, the explanation, the hint and the mark scheme.
 *
 * One component for the question page and the review queue, so a reviewer
 * approving a draft sees exactly what the question page would have shown —
 * two renderers would eventually disagree about what a question says.
 */
export type ViewableQuestion = {
  stem: string;
  options: Option[] | null;
  answerKey: AnswerKey;
  explanation: string | null;
  hint: string | null;
  rubric: Rubric | null;
};

export function QuestionView({ question }: { question: ViewableQuestion }) {
  const hasCorrectOption = (question.options ?? []).some((option) => option.isCorrect);

  return (
    <>
      <p className="ui-question-full">{question.stem}</p>

      {question.options && question.options.length > 0 && (
        <ul className="ui-answer-list">
          {question.options.map((option) => (
            <li key={option.key} data-correct={option.isCorrect || undefined}>
              <span className="ui-answer-key">{option.key}</span>
              <span>{option.text}</span>
              {option.isCorrect && <Badge tone="success">Correct</Badge>}
            </li>
          ))}
        </ul>
      )}

      {question.answerKey?.kind === "boolean" && (
        <p className="ui-answer-plain">
          Answer: <strong>{question.answerKey.correct ? "True" : "False"}</strong>
        </p>
      )}
      {question.answerKey?.kind === "numeric" && (
        <p className="ui-answer-plain">
          Answer: <strong className="tabular">{question.answerKey.value}</strong>{" "}
          <span className="tabular">plus or minus {question.answerKey.tolerance}</span>
        </p>
      )}
      {question.answerKey?.kind === "text" && (
        <p className="ui-answer-plain">
          Accepted: <strong>{question.answerKey.accepted.join(", ")}</strong>
        </p>
      )}
      {!question.answerKey && !hasCorrectOption && (
        <p className="ui-answer-plain">
          Marked by a person — there is no automatic answer key for this type.
        </p>
      )}

      {question.explanation && (
        <div className="ui-explanation">
          <span className="ui-explanation-label">Explanation</span>
          <p>{question.explanation}</p>
        </div>
      )}

      {question.hint && (
        <div className="ui-explanation">
          <span className="ui-explanation-label">Hint</span>
          <p>{question.hint}</p>
        </div>
      )}

      {question.rubric && (
        <div className="ui-explanation">
          <span className="ui-explanation-label">Mark scheme</span>
          <ul className="ui-check-list">
            {question.rubric.criteria.map((criterion) => (
              <li key={criterion.id}>
                <Badge tone="neutral">
                  <span className="tabular">{criterion.marks}</span>
                </Badge>
                <span>
                  <strong>{criterion.label}</strong>
                  {criterion.descriptor ? ` — ${criterion.descriptor}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

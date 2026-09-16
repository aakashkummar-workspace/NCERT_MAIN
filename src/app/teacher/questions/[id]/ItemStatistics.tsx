import { Alert, Badge, Card, type Tone } from "@/ui";
import type { QuestionItemStats } from "@/core/itemstats";

/**
 * How a question actually behaved, beside how it was declared.
 *
 * Presentational and serialisable — everything is decided in
 * `core/itemstats/compute.ts`, so a figure the product refused to stand behind
 * cannot reach this file. Below the threshold the payload has no `pValue` field
 * at all, which means the "no figures yet" branch is not a rule somebody has to
 * remember: it is the only branch that type-checks.
 */

const DIFFICULTY_LABEL: Record<string, string> = {
  EASY: "Easy",
  MEDIUM: "Medium",
  HARD: "Hard",
};

const DISCRIMINATION_LABEL: Record<string, string> = {
  NEGATIVE: "Negative",
  POOR: "Poor",
  FAIR: "Fair",
  GOOD: "Good",
  EXCELLENT: "Excellent",
};

const DISCRIMINATION_TONE: Record<string, Tone> = {
  NEGATIVE: "danger",
  POOR: "warning",
  FAIR: "neutral",
  GOOD: "success",
  EXCELLENT: "success",
};

const percent = (value: number) => `${Math.round(value * 100)}%`;
const signed = (value: number) =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}`;

export function ItemStatistics({ data }: { data: QuestionItemStats }) {
  const { stats } = data;

  const excluded = (
    <ul className="ui-is-notes">
      <li>
        Counted from this wording only — version {data.version}
        {data.versionCount > 1 ? ` of ${data.versionCount}` : ""}. An approved
        question cannot be edited in place, so answers given to an earlier
        wording describe a question that no longer exists.
        {data.earlierVersionResponses > 0 && (
          <>
            {" "}
            {data.earlierVersionResponses} answer
            {data.earlierVersionResponses === 1 ? "" : "s"} to earlier wordings
            {data.earlierVersionResponses === 1 ? " is" : " are"} not counted
            here.
          </>
        )}
      </li>
      {data.awaitingMarking > 0 && (
        <li>
          {data.awaitingMarking} paper
          {data.awaitingMarking === 1 ? " is" : "s are"} held back because
          marking is outstanding on {data.awaitingMarking === 1 ? "it" : "them"}
          . An unmarked written answer counted as wrong would be a claim about a
          question nobody has read.
        </li>
      )}
      {data.repeatSittings > 0 && (
        <li>
          {data.repeatSittings} re-sitting
          {data.repeatSittings === 1 ? " is" : "s are"} not counted. A student
          meeting this question a second time is showing you what they remember.
        </li>
      )}
      <li>
        Exam answers only. Practice is untimed and unwatched with the
        explanation a tap away, so counting it here would measure persistence.
      </li>
    </ul>
  );

  if (!stats.enough) {
    return (
      <Card title="How it actually behaved">
        <p className="ui-is-refusal">
          <strong className="tabular">
            {stats.responses} of {stats.needed}
          </strong>{" "}
          answers needed before there are figures worth showing.
        </p>
        <p className="ui-is-blurb">
          {stats.reason === "no-responses"
            ? "Nobody has sat this question in a marked paper yet."
            : `Below ${stats.needed} answers a p-value can be a whole difficulty band out by chance, and the strong and weak groups are small enough that one student moves the discrimination index by more than the gap between "poor" and "good". A provisional number here would be read as a number, so there is none.`}
        </p>
        <p className="ui-is-blurb">
          These are counted from your own students only — one school never sees
          another&apos;s answers — so a question used once with a single class
          usually reaches this on its second or third paper.
        </p>
        {excluded}
      </Card>
    );
  }

  const declaredLabel = DIFFICULTY_LABEL[stats.declaredDifficulty];
  const observedLabel = DIFFICULTY_LABEL[stats.observedDifficulty];

  return (
    <Card title="How it actually behaved">
      {stats.keySuspect && (
        // The loudest thing this module can say. A negative discrimination
        // means the students who did best on the paper did worst on this
        // question — which is almost always a wrong answer key, and until
        // somebody looks, every student who knew the material is being marked
        // down for knowing it.
        <Alert tone="danger" title="Worth checking the answer key">
          <ul className="ui-is-notes">
            {stats.discriminationBand === "NEGATIVE" && (
              <li>
                The students who did best on the paper did <strong>worse</strong>{" "}
                on this question than the students who did worst
                ({percent(stats.upperMean)} against {percent(stats.lowerMean)}).
              </li>
            )}
            {(stats.options ?? [])
              .filter((option) => option.outperformsKey)
              .map((option) => (
                <li key={option.key}>
                  More students chose <strong>{option.key}</strong> than chose
                  the marked answer. Either a misconception worth teaching to, or
                  the key is on the wrong option.
                </li>
              ))}
          </ul>
        </Alert>
      )}

      <div className="ui-is-figures">
        <div className="ui-is-figure">
          <span className="ui-is-label">Got it right</span>
          <span className="ui-is-value tabular">{percent(stats.pValue)}</span>
          <span className="ui-is-context">
            of the marks available, across {stats.responses} answers
          </span>
        </div>
        <div className="ui-is-figure">
          <span className="ui-is-label">Separates the class</span>
          <span className="ui-is-value tabular">
            {signed(stats.discrimination)}
          </span>
          <span className="ui-is-context">
            top {stats.groupSize} at {percent(stats.upperMean)}, bottom{" "}
            {stats.groupSize} at {percent(stats.lowerMean)}
          </span>
        </div>
        <div className="ui-is-figure">
          <span className="ui-is-label">Agrees with the paper</span>
          <span className="ui-is-value tabular" data-empty={stats.pointBiserial === null || undefined}>
            {stats.pointBiserial === null ? "—" : signed(stats.pointBiserial)}
          </span>
          <span className="ui-is-context">
            {stats.pointBiserial === null
              ? "everybody scored the same, so there is nothing to correlate"
              : "how far getting this right goes with doing well on the rest"}
          </span>
        </div>
      </div>

      <p className="ui-is-band">
        <Badge tone={DISCRIMINATION_TONE[stats.discriminationBand] ?? "neutral"}>
          {DISCRIMINATION_LABEL[stats.discriminationBand]} discrimination
        </Badge>
      </p>

      {/* Observed difficulty sits BESIDE the declared one and never replaces
          it. Difficulty weights every piece of evidence inside the mastery
          estimator, so a figure that quietly rewrote this column would move
          every gap, plan and report downstream of it — with no record of the
          teacher's original judgement. The teacher decides; this only asks. */}
      <div className="ui-is-difficulty" data-disagrees={stats.difficultyDisagrees || undefined}>
        <div>
          <span className="ui-is-label">You marked it</span>
          <span className="ui-is-difficulty-value">{declaredLabel}</span>
        </div>
        <span className="ui-is-versus" aria-hidden="true">
          ·
        </span>
        <div>
          <span className="ui-is-label">The answers read</span>
          <span className="ui-is-difficulty-value">{observedLabel}</span>
        </div>
      </div>
      <p className="ui-is-blurb">
        {stats.difficultyDisagrees
          ? `Your setting still stands and nothing has been changed — it is what marking and progress are weighted on. A high "got it right" can mean the question is easy, and equally that the class had just been taught it, or that the stem gives the answer away. Only you can tell those apart.`
          : "Your setting and the answers agree. Nothing to do."}
      </p>

      {stats.options && stats.options.length > 0 && (
        <div className="ui-is-options">
          <span className="ui-is-label">Where the answers went</span>
          <ul>
            {stats.options.map((option) => (
              <li
                key={option.key}
                data-correct={option.isCorrect || undefined}
                data-dead={option.dead || undefined}
              >
                <span className="ui-is-option-key">{option.key}</span>
                <span className="ui-is-option-text">
                  {option.text}
                  {option.isCorrect && <Badge tone="success">Key</Badge>}
                  {option.dead && <Badge tone="warning">Never chosen</Badge>}
                </span>
                <span
                  className="ui-is-bar"
                  role="img"
                  aria-label={`${option.chosen} of ${stats.responses} chose ${option.key}`}
                >
                  <span style={{ width: `${Math.round(option.share * 100)}%` }} />
                </span>
                <span className="ui-is-option-count tabular">
                  {option.chosen}
                  <span className="ui-is-option-split">
                    {option.upperChosen}↑ {option.lowerChosen}↓
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className="ui-is-blurb">
            ↑ is the strongest {stats.groupSize} papers and ↓ the weakest. A
            distractor nobody picks is doing no work — the question is offering
            fewer real choices than it looks like it does.
          </p>
        </div>
      )}

      {excluded}
    </Card>
  );
}

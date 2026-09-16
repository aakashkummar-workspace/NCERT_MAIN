import "server-only";
import { withTenant } from "@/db/tenant";
import { hasOptions, type QuestionType } from "@/core/questions/validate";
import {
  computeItemStats,
  type Difficulty,
  type ItemResponse,
  type ItemStats,
  type OptionInput,
} from "./compute";

/**
 * The reader for classical item statistics.
 *
 * Assembles the responses to ONE question version and hands them to the pure
 * function next door. Everything that decides anything lives in `compute.ts`;
 * this file only decides which responses are admissible, and every one of those
 * decisions is a rule the rest of the product already follows.
 *
 * ---------------------------------------------------------------------------
 * Nothing is written, here or anywhere
 * ---------------------------------------------------------------------------
 * No table, no migration, no cache, no cron. The figures are derived on every
 * read of one question's detail page — the same choice the study plan makes and
 * the same choice an assignment's status makes, for the same reason: a stored
 * statistic is stale the instant the next paper is marked, and keeping it fresh
 * needs either a job (rows that are a lie between ticks) or a hook on the
 * marking path (a hot path made slower to serve a page almost nobody has open).
 * This is a page a teacher opens deliberately, one question at a time.
 *
 * And, restating the header of `compute.ts` because it is the constraint that
 * matters most: **the observed difficulty computed here is never written back
 * to `questions.difficulty`.** It is shown beside the teacher's own judgement.
 * Overwriting it would silently re-weight every mastery figure in the product —
 * `WEIGHTS` in `core/mastery/estimate.ts` is keyed on that column — and would
 * do it with no audit trail and no way to get the teacher's intent back.
 *
 * ---------------------------------------------------------------------------
 * The four admissibility rules
 * ---------------------------------------------------------------------------
 *  1. **One question VERSION.** An approved question is immutable and editing
 *     creates version n+1, so responses to the old wording describe a question
 *     that no longer exists. `attempt_answers.question_version_id` records what
 *     the student was actually served, which is exactly what makes this
 *     possible. Responses to earlier versions are counted and reported as a
 *     number, so a teacher who edited a well-measured question can see why the
 *     statistics went away.
 *  2. **Fully marked attempts only.** The rule `core/results` states: a
 *     statistic over half-marked papers is not a smaller statistic, it is a
 *     wrong one. An unmarked written answer counted as zero is a lie about a
 *     question nobody has read. The count excluded travels with the figures.
 *  3. **Assessment responses only, never practice.** This one is structural
 *     rather than a filter: practice answers live in `practice_answers` and
 *     never touch `attempt_answers`, so there is nothing here to exclude. It is
 *     still worth stating, because the reason is a product decision rather than
 *     a schema accident — practice is untimed, unwatched, with the explanation
 *     one tap away, and already discounted to 0.4 as evidence. A p-value mixing
 *     the two measures persistence, not difficulty.
 *  4. **Per tenant.** Questions are tenant-owned and `withTenant` is the only
 *     path, so this is enforced by RLS rather than by a `where` clause. Two
 *     centres holding the same question learn nothing about each other's bank —
 *     which is deliberate, and which is also why the threshold is hard for a
 *     small school to reach. See the note on MIN_RESPONSES.
 *
 * And a fifth, which is this module's own: **the first sitting per student per
 * assignment.** A student allowed two attempts at the same paper meets the same
 * item twice, and the second meeting measures whether they remember the answer
 * key. Counting it would inflate the p-value on precisely the questions a
 * teacher lets a class re-sit.
 *
 * Note what that rule stops at, deliberately. The same student meeting the same
 * question again on a DIFFERENT paper weeks later still counts. It is the same
 * memory effect in weaker form, and excluding it was considered and rejected:
 * reusing a good question across a term is exactly how a school of one class
 * ever reaches thirty responses, and a threshold nobody can reach produces no
 * statistics at all rather than slightly conservative ones. Re-sitting the same
 * paper on the same afternoon is a different thing, and that is what is
 * excluded.
 */

export type { ItemStats } from "./compute";
export { MIN_RESPONSES } from "./compute";

export type QuestionItemStats = {
  questionId: string;
  /** The version these figures describe. Statistics attach to the version. */
  version: number;
  versionId: string;
  versionCount: number;
  type: QuestionType;
  marks: number;
  stats: ItemStats;
  /**
   * Responses to earlier wordings of this question. Not counted, and reported
   * so that "it used to have statistics" has an answer.
   */
  earlierVersionResponses: number;
  /** Sittings held back because a person still has marking to do on them. */
  awaitingMarking: number;
  /** Second and later sittings of the same paper by the same student. */
  repeatSittings: number;
};

type RawOption = { key: string; text: string; isCorrect?: boolean };
type RawResponse = { kind?: string; keys?: string[] } | null;

export async function questionItemStats(
  organizationId: string,
  questionId: string,
): Promise<QuestionItemStats | null> {
  return withTenant(organizationId, async (tx) => {
    const question = await tx.question.findFirst({
      where: { id: questionId, deletedAt: null },
      include: { versions: { orderBy: { version: "desc" } } },
    });
    if (!question) return null;

    const current = question.versions[0];
    if (!current) return null;

    const earlierVersionIds = question.versions
      .slice(1)
      .map((version) => version.id);

    const earlierVersionResponses =
      earlierVersionIds.length === 0
        ? 0
        : await tx.attemptAnswer.count({
            where: { questionVersionId: { in: earlierVersionIds } },
          });

    // Which sittings touched this exact version. Two steps rather than one
    // join, because whether a sitting counts depends on ALL of its answers —
    // one unmarked written answer three questions later disqualifies the paper.
    const touching = await tx.attemptAnswer.findMany({
      where: { questionVersionId: current.id },
      select: { attemptId: true },
    });
    const attemptIds = [...new Set(touching.map((row) => row.attemptId))];

    const attempts =
      attemptIds.length === 0
        ? []
        : await tx.attempt.findMany({
            where: { id: { in: attemptIds }, status: { not: "IN_PROGRESS" } },
            include: {
              answers: {
                select: {
                  id: true,
                  questionVersionId: true,
                  awardedMarks: true,
                  maxMarks: true,
                  response: true,
                },
              },
            },
            // Oldest sitting first, so the "first attempt per student" rule
            // below keeps the right one. Explicit because Postgres is free to
            // return rows in a different order on the next read, and a figure
            // that moves on unchanged data is a figure nobody can compare.
            orderBy: [{ attemptNumber: "asc" }, { startedAt: "asc" }],
          });

    const declared = question.difficulty as Difficulty;
    const type = question.type as QuestionType;

    const responses: ItemResponse[] = [];
    let awaitingMarking = 0;
    let repeatSittings = 0;
    const seen = new Set<string>();

    for (const attempt of attempts) {
      const key = `${attempt.assignmentId}:${attempt.studentUserId}`;
      if (seen.has(key)) {
        repeatSittings++;
        continue;
      }
      // Claimed before the checks below, not after. If a student's FIRST
      // sitting is held back for marking, their second must not quietly take
      // its place — by then they have seen the item once, which is the thing
      // this rule exists to keep out.
      seen.add(key);

      // A paper with marking outstanding is held back whole. The predicate is
      // the one `assignmentResults` uses for `fullyMarked`: an answer with no
      // marks AND no response is a blank the student left, which is settled at
      // zero and waiting on nobody.
      const pending = attempt.answers.some(
        (answer) => answer.awardedMarks === null && answer.response !== null,
      );
      if (pending) {
        awaitingMarking++;
        continue;
      }

      const item = attempt.answers.find(
        (answer) => answer.questionVersionId === current.id,
      );
      if (!item) continue;

      // The paper's totals are summed from its own answers rather than read
      // from `attempt.rawScore`, so the item score and the paper score cannot
      // disagree — the denominator of the rest-score below is the same
      // arithmetic as its numerator. Within a fully marked paper a null award
      // is necessarily a blank, which is zero.
      let rawScore = 0;
      let maxScore = 0;
      for (const answer of attempt.answers) {
        rawScore += Number(answer.awardedMarks ?? 0);
        maxScore += Number(answer.maxMarks);
      }

      const itemAwarded = Number(item.awardedMarks ?? 0);
      const itemMax = Number(item.maxMarks);
      if (itemMax <= 0 || maxScore <= 0) continue;

      const restMax = maxScore - itemMax;
      const response = item.response as RawResponse;

      responses.push({
        id: item.id,
        score: itemAwarded / itemMax,
        totalScore: rawScore / maxScore,
        restScore: restMax > 0 ? (rawScore - itemAwarded) / restMax : null,
        chosenKeys: hasOptions(type)
          ? response?.kind === "choice"
            ? (response.keys ?? [])
            : []
          : null,
      });
    }

    const options: OptionInput[] | null = hasOptions(type)
      ? ((current.options as RawOption[] | null) ?? []).map((option) => ({
          key: option.key,
          text: option.text,
          isCorrect: option.isCorrect === true,
        }))
      : null;

    return {
      questionId: question.id,
      version: current.version,
      versionId: current.id,
      versionCount: question.versions.length,
      type,
      marks: question.marks,
      stats: computeItemStats(responses, declared, options),
      earlierVersionResponses,
      awaitingMarking,
      repeatSittings,
    };
  });
}

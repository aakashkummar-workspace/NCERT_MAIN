import "server-only";
import { withTenant } from "@/db/tenant";
import { organizationsWithUnclassifiedMistakes } from "@/db/maintenance";
import { classifyMistakes, type Classifiable } from "@/ai/tasks/classify-mistakes";

/**
 * The nightly typing pass.
 *
 * ---------------------------------------------------------------------------
 * Batched, and one tenant at a time
 * ---------------------------------------------------------------------------
 * Two constraints shape this loop and neither is negotiable.
 *
 * RLS shows a query exactly one organization, so a job written the obvious way
 * would classify the first customer's mistakes and silently abandon everybody
 * else's. `src/db/maintenance.ts` is the only module allowed to enumerate
 * across tenants, and it hands back ids — never rows.
 *
 * And the calls are batched because this is the highest-volume AI operation in
 * the product. Twenty mistakes in one call share one cached system prefix; the
 * same twenty as separate calls pay for that prefix twenty times, which is most
 * of the difference between a $3 line and a $14 one.
 *
 * ---------------------------------------------------------------------------
 * Nothing here is on a blocking path
 * ---------------------------------------------------------------------------
 * A student whose mistake was never typed still sees the question, their
 * answer, the marks and the explanation. The type is the extra, and the card
 * says plainly that nothing has looked at it yet rather than inventing a
 * heading. So every failure below is counted and moved past.
 */

/** One call. Twenty is where the shared prefix stops paying for itself. */
const BATCH = 20;

/** Per tenant per run. A backlog drains over several nights, not in one bill. */
const MAX_PER_ORGANIZATION = 200;

export type ClassifyReport = {
  organizations: number;
  considered: number;
  classified: number;
  /** Typed UNSURE by the model, or left alone because it refused. */
  undecided: number;
  failed: number;
};

export async function classifyPendingMistakes(
  options: { organizationIds?: string[]; now?: Date } = {},
): Promise<ClassifyReport> {
  const now = options.now ?? new Date();
  const organizationIds =
    options.organizationIds ?? (await organizationsWithUnclassifiedMistakes());

  const report: ClassifyReport = {
    organizations: organizationIds.length,
    considered: 0,
    classified: 0,
    undecided: 0,
    failed: 0,
  };

  for (const organizationId of organizationIds) {
    const outcome = await classifyForOrganization(organizationId, now);
    report.considered += outcome.considered;
    report.classified += outcome.classified;
    report.undecided += outcome.undecided;
    report.failed += outcome.failed;
  }

  return report;
}

async function classifyForOrganization(
  organizationId: string,
  now: Date,
): Promise<Omit<ClassifyReport, "organizations">> {
  const pending = await withTenant(organizationId, async (tx) => {
    const mistakes = await tx.studentMistake.findMany({
      where: { typeSource: "PENDING" },
      orderBy: { occurredAt: "desc" },
      take: MAX_PER_ORGANIZATION,
    });
    if (mistakes.length === 0) return [];

    const [versions, answers, questions] = await Promise.all([
      tx.questionVersion.findMany({
        where: {
          id: {
            in: mistakes.flatMap((m) =>
              m.questionVersionId ? [m.questionVersionId] : [],
            ),
          },
        },
      }),
      tx.attemptAnswer.findMany({
        where: { id: { in: mistakes.map((m) => m.attemptAnswerId) } },
        select: { id: true, response: true },
      }),
      tx.question.findMany({
        where: { id: { in: mistakes.map((m) => m.questionId) } },
        select: { id: true, type: true, subjectId: true },
      }),
    ]);

    const versionById = new Map(versions.map((v) => [v.id, v]));
    const answerById = new Map(answers.map((a) => [a.id, a]));
    const questionById = new Map(questions.map((q) => [q.id, q]));

    return mistakes.map((mistake) => ({
      mistake,
      version: mistake.questionVersionId
        ? (versionById.get(mistake.questionVersionId) ?? null)
        : null,
      answer: answerById.get(mistake.attemptAnswerId) ?? null,
      question: questionById.get(mistake.questionId) ?? null,
    }));
  });

  const report = { considered: 0, classified: 0, undecided: 0, failed: 0 };
  if (pending.length === 0) return report;

  // Grouped by subject, so one call's prefix describes one subject. Mixing
  // Mathematics and Science into a batch would need a system prompt that
  // describes both, which is longer, less specific and cached less often.
  const bySubject = new Map<string, typeof pending>();
  for (const item of pending) {
    if (!item.version || !item.question) continue;
    const key = item.question.subjectId;
    bySubject.set(key, [...(bySubject.get(key) ?? []), item]);
  }

  for (const [subjectId, items] of bySubject) {
    const context = await subjectContext(organizationId, subjectId);

    for (let start = 0; start < items.length; start += BATCH) {
      const slice = items.slice(start, start + BATCH);
      report.considered += slice.length;

      const classifiable: Classifiable[] = slice.map((item) => {
        const options = (item.version!.options ?? null) as
          | { key: string; text: string; isCorrect: boolean }[]
          | null;
        return {
          stem: item.version!.stem,
          type: item.question!.type,
          options,
          given: describeResponse(item.answer?.response, options),
          correct: describeCorrect(options, item.version!.answerKey),
          conceptName: null,
        };
      });

      const outcome = await classifyMistakes({
        organizationId,
        // The run is nobody's press of a button. The student is deliberately
        // not named as the requester: their id is not what asked for this, and
        // the ledger should say the system did.
        userId: slice[0]!.mistake.studentUserId,
        boardName: context.boardName,
        gradeLabel: context.gradeLabel,
        subjectName: context.subjectName,
        mistakes: classifiable,
      });

      if (!outcome.ok) {
        // Left PENDING, deliberately. It will be picked up tomorrow, and in
        // the meantime the student's card says nothing has looked at it —
        // which is true, and better than a type nobody stands behind.
        report.failed += slice.length;
        continue;
      }

      for (const verdict of outcome.value.verdicts) {
        const item = slice[verdict.index];
        // A model that renumbers would land its verdict on somebody else's
        // mistake, which is worse than no verdict at all. Discarded.
        if (!item) continue;

        if (verdict.type === "UNSURE") {
          // Recorded as looked-at-and-undecided, not left pending, or the job
          // pays to be told "I cannot tell" every night forever.
          await withTenant(organizationId, (tx) =>
            tx.studentMistake.update({
              where: { id: item.mistake.id },
              data: {
                mistakeType: "UNCLASSIFIED",
                typeSource: "MODEL",
                typeReason: null,
                updatedAt: now,
              },
            }),
          );
          report.undecided++;
          continue;
        }

        const type = verdict.type;
        await withTenant(organizationId, (tx) =>
          tx.studentMistake.update({
            where: { id: item.mistake.id },
            data: {
              mistakeType: type,
              typeSource: "MODEL",
              typeReason: verdict.note,
              updatedAt: now,
            },
          }),
        );
        report.classified++;
      }
    }
  }

  return report;
}

async function subjectContext(
  organizationId: string,
  subjectId: string,
): Promise<{ subjectName: string; gradeLabel: string; boardName: string }> {
  // The curriculum plane: readable by everybody, writable by nobody in the app
  // role. Reached through withTenant like any other read, which costs nothing
  // and keeps one path.
  const subject = await withTenant(organizationId, (tx) =>
    tx.subject.findFirst({
      where: { id: subjectId },
      select: {
        name: true,
        grade: { select: { label: true, board: { select: { name: true } } } },
      },
    }),
  );
  return {
    subjectName: subject?.name ?? "the subject",
    gradeLabel: subject?.grade.label ?? "Class 10",
    // Read from the chapter's own tree rather than assumed. The fallback is a
    // neutral phrase, never a board name: naming the wrong board in a prompt is
    // worse than naming none.
    boardName: subject?.grade.board.name ?? "an Indian school board",
  };
}

/** What the student put, in words rather than as stored JSON. */
function describeResponse(
  response: unknown,
  options: { key: string; text: string }[] | null,
): string | null {
  if (!response || typeof response !== "object") return null;
  const value = response as Record<string, unknown>;

  if (value.kind === "choice" && Array.isArray(value.keys)) {
    const keys = value.keys as string[];
    if (keys.length === 0) return null;
    return keys
      .map((key) => {
        const option = options?.find((candidate) => candidate.key === key);
        return option ? `${key}. ${option.text}` : key;
      })
      .join("  ·  ");
  }
  if (value.kind === "boolean") return value.value === true ? "True" : "False";
  if (value.kind === "numeric") return String(value.value ?? "");
  if (value.kind === "text") return String(value.value ?? "").slice(0, 600);
  // Sat on paper: something was written, and the words are on the script.
  // Saying "blank" here would tell the classifier they did not try.
  if (value.kind === "paper") return "(written on a paper script, which is not held here)";
  return null;
}

function describeCorrect(
  options: { key: string; text: string; isCorrect: boolean }[] | null,
  answerKey: unknown,
): string | null {
  if (options && options.length > 0) {
    const correct = options.filter((option) => option.isCorrect);
    if (correct.length > 0) {
      return correct.map((option) => `${option.key}. ${option.text}`).join("  ·  ");
    }
  }
  if (answerKey && typeof answerKey === "object") {
    const key = answerKey as Record<string, unknown>;
    if (key.kind === "boolean") return key.correct === true ? "True" : "False";
    if (key.kind === "numeric" && typeof key.value === "number") return String(key.value);
    if (key.kind === "text" && Array.isArray(key.accepted)) {
      return (key.accepted as string[]).join("  ·  ");
    }
  }
  return null;
}

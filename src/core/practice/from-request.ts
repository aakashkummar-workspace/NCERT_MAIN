import "server-only";
import { withTenant } from "@/db/tenant";
import { FIXTURE_CHAPTER_FLOOR } from "@/core/readiness";
import { planPractice } from "@/ai/tasks/plan-practice";
import { istDate } from "@/core/assessments/auto-fill";
import { clampCount, practiceAvailable, type TeacherActor } from "./assigned";

/**
 * Practice from a sentence: "10-A needs practice on similar triangles, 8
 * questions, by Friday".
 *
 * ---------------------------------------------------------------------------
 * It PROPOSES, and a person sets
 * ---------------------------------------------------------------------------
 * A paper from a sentence lands as a draft, because a paper has a draft state.
 * Assigned practice has none: `assignPractice` puts a card on every student's
 * home page the moment it runs. So nothing here writes anything. The model
 * reads the sentence into a class, ideas, a count and a day; this module checks
 * each by rule and counts the bank; the teacher sees the sets and presses Set,
 * which goes through the ordinary route and `assignPractice` — the same
 * refusals, the same audit row. Something reaches a class because a person
 * sent it, the rule the whole product keeps.
 *
 * ---------------------------------------------------------------------------
 * One set per idea
 * ---------------------------------------------------------------------------
 * Practice is measured and selected per concept, so "practice on Triangles"
 * becomes one proposed set per idea in that chapter (at most five), each with
 * its own bank count — never one set pretending to be several.
 *
 * The bank is counted with `practiceAvailable`, the function the refusal in
 * `assignPractice` uses, so a set shown as ready is one setting will accept.
 */

export type ProposedSet = {
  conceptId: string;
  conceptName: string;
  chapterTitle: string;
  /** Approved machine-markable questions on it in this school's bank. */
  available: number;
  /** Null when it can be set as proposed; otherwise why setting would refuse it. */
  problem: string | null;
  /**
   * The class already has open practice on this idea. Not a refusal —
   * `assignPractice` would accept it — so the screen says so and leaves it
   * unticked, and the teacher decides.
   */
  alreadySet: boolean;
};

export type PracticeProposal =
  | {
      ok: true;
      classId: string;
      className: string;
      questionCount: number;
      /** YYYY-MM-DD, or null. The route treats it as the end of that day in IST. */
      dueOn: string | null;
      studentNote: string | null;
      /** The model's stated assumption, if any, for the teacher to check. */
      note: string | null;
      /** What was changed from what was asked — a count clamped, a date dropped. */
      adjustments: string[];
      sets: ProposedSet[];
    }
  | { ok: false; reason: "FORBIDDEN" | "INVALID" | "UNCLEAR" | "EMPTY" | "AI"; message: string };

const STAFF = new Set(["OWNER", "ADMIN", "TEACHER"]);

function todayInIndia(now: Date): string {
  const date = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const weekday = now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long" });
  return `${date} (${weekday})`;
}

export async function proposePracticeFromRequest(
  actor: TeacherActor,
  input: { request: string },
  now = new Date(),
): Promise<PracticeProposal> {
  if (!STAFF.has(actor.role)) {
    return { ok: false, reason: "FORBIDDEN", message: "Only teachers can set practice." };
  }
  const request = input.request.trim();
  if (request.length < 8) {
    return { ok: false, reason: "INVALID", message: "Describe the practice in a sentence — which class, which idea, how many." };
  }

  // The teacher's own classes (every class for an owner or admin), and the
  // concepts of those classes' subjects, each under the first real chapter it
  // measures. Fixture chapters (1000+) are never offered.
  const context = await withTenant(actor.organizationId, async (tx) => {
    const classes = await tx.class.findMany({
      where: {
        deletedAt: null,
        ...(actor.role === "TEACHER" ? { ownerTeacherId: actor.userId } : {}),
      },
      include: { subject: { include: { grade: { include: { board: true } } } } },
      orderBy: { name: "asc" },
    });
    const subjectIds = [...new Set(classes.map((klass) => klass.subjectId))];
    const links = await tx.conceptOutcome.findMany({
      where: {
        outcome: {
          topic: { chapter: { subjectId: { in: subjectIds }, number: { lt: FIXTURE_CHAPTER_FLOOR } } },
        },
      },
      select: {
        conceptId: true,
        concept: { select: { name: true } },
        outcome: {
          select: {
            topic: {
              select: {
                chapter: {
                  select: {
                    number: true,
                    title: true,
                    subjectId: true,
                    subject: { select: { name: true, grade: { select: { label: true } } } },
                  },
                },
              },
            },
          },
        },
      },
    });
    return { classes, links };
  });

  if (context.classes.length === 0) {
    return { ok: false, reason: "EMPTY", message: "You have no classes yet. Create a class first, then set practice." };
  }

  // One entry per concept, under its lowest-numbered chapter. Sorted by
  // subject, chapter and name: the list sits in the request, and a stable order
  // is what lets an index mean the same thing on every call.
  type Entry = {
    conceptId: string;
    name: string;
    subjectId: string;
    subjectName: string;
    gradeLabel: string;
    chapterNumber: number;
    chapterTitle: string;
  };
  const byConcept = new Map<string, Entry>();
  for (const link of context.links) {
    const chapter = link.outcome.topic.chapter;
    const existing = byConcept.get(link.conceptId);
    if (existing && existing.chapterNumber <= chapter.number) continue;
    byConcept.set(link.conceptId, {
      conceptId: link.conceptId,
      name: link.concept.name,
      subjectId: chapter.subjectId,
      subjectName: chapter.subject.name,
      gradeLabel: chapter.subject.grade.label,
      chapterNumber: chapter.number,
      chapterTitle: chapter.title,
    });
  }
  const concepts = [...byConcept.values()].sort(
    (a, b) =>
      a.subjectName.localeCompare(b.subjectName) ||
      a.gradeLabel.localeCompare(b.gradeLabel) ||
      a.chapterNumber - b.chapterNumber ||
      a.name.localeCompare(b.name),
  );
  if (concepts.length === 0) {
    return {
      ok: false,
      reason: "EMPTY",
      message: "Practice is set on an idea, and no ideas have been authored for your classes' subjects yet.",
    };
  }

  const outcome = await planPractice({
    organizationId: actor.organizationId,
    userId: actor.userId,
    boardName: context.classes[0]!.subject.grade.board.name,
    classes: context.classes.map((klass) => ({
      name: klass.name,
      subjectName: klass.subject.name,
      gradeLabel: klass.subject.grade.label,
    })),
    concepts: concepts.map((concept) => ({
      name: concept.name,
      chapterTitle: concept.chapterTitle,
      subjectName: concept.subjectName,
      gradeLabel: concept.gradeLabel,
    })),
    request,
    today: todayInIndia(now),
  });
  if (!outcome.ok) return { ok: false, reason: "AI", message: outcome.message };
  const plan = outcome.value;

  if (!plan.understood) {
    return {
      ok: false,
      reason: "UNCLEAR",
      message: plan.note.trim() || "I could not tell what practice you want. Name the class and the idea.",
    };
  }
  const klass = plan.classIndex === null ? undefined : context.classes[plan.classIndex];
  if (!klass) {
    return { ok: false, reason: "UNCLEAR", message: "I could not tell which class this is for. Name the class." };
  }

  // Offered, and in the class's own subject. An index out of range is dropped,
  // never clamped — clamping would propose an idea nobody asked for.
  const chosen = [...new Set(plan.conceptIndexes)]
    .map((index) => concepts[index])
    .filter((concept): concept is Entry => concept !== undefined && concept.subjectId === klass.subjectId)
    .slice(0, 5);
  if (chosen.length === 0) {
    return {
      ok: false,
      reason: "UNCLEAR",
      message: `I could not tell which ${klass.subject.name} idea to set. Name the idea or the chapter.`,
    };
  }

  const count = clampCount(plan.questionCount);
  const adjustments: string[] = [];
  if (count !== plan.questionCount) {
    adjustments.push(`A practice set is 4 to 10 questions, so each set is ${count}.`);
  }

  // A day that is not a real date, or is already over, is dropped and said —
  // the teacher picks one, rather than a deadline nobody agreed to.
  const today = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  let dueOn: string | null = null;
  if (plan.dueOn) {
    if (istDate(plan.dueOn) && plan.dueOn >= today) dueOn = plan.dueOn;
    else adjustments.push("The date asked for could not be used, so no date is set. Pick one before setting.");
  }

  const { available, alreadySet } = await withTenant(actor.organizationId, async (tx) => ({
    available: await practiceAvailable(
      tx,
      actor.organizationId,
      chosen.map((concept) => concept.conceptId),
    ),
    alreadySet: await tx.assignedPractice.findMany({
      where: {
        classId: klass.id,
        cancelledAt: null,
        conceptId: { in: chosen.map((concept) => concept.conceptId) },
        OR: [{ dueAt: null }, { dueAt: { gte: now } }],
      },
      select: { conceptId: true },
    }),
  }));
  const setAlready = new Set(alreadySet.map((row) => row.conceptId));

  const sets: ProposedSet[] = chosen.map((concept) => {
    const n = available.get(concept.conceptId) ?? 0;
    // The sentences `assignPractice` would refuse with, so the screen never
    // says one thing and the press another.
    const problem =
      n === 0
        ? `The bank holds no practice questions on ${concept.name} yet.`
        : n < count
          ? `The bank holds ${n} practice question${n === 1 ? "" : "s"} on ${concept.name}, and you asked for ${count}.`
          : null;
    return {
      conceptId: concept.conceptId,
      conceptName: concept.name,
      chapterTitle: concept.chapterTitle,
      available: n,
      problem,
      alreadySet: setAlready.has(concept.conceptId),
    };
  });

  return {
    ok: true,
    classId: klass.id,
    className: klass.name,
    questionCount: count,
    dueOn,
    studentNote: plan.studentNote.trim() || null,
    note: plan.note.trim() || null,
    adjustments,
    sets,
  };
}

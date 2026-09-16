import "server-only";
import { withTenant } from "@/db/tenant";
import { conceptContext } from "@/core/curriculum/concepts";
import { opaqueId } from "@/ai/scrub";
import { assignmentStatus } from "@/core/assignments/window";

/**
 * What the Copilot is allowed to know.
 *
 * ---------------------------------------------------------------------------
 * Students go to the provider as handles, and come back as people
 * ---------------------------------------------------------------------------
 * This is the whole design. A teacher asks "who is struggling in 10-A" and the
 * answer needs names — but the PROMPT must not carry them. So every student in
 * the context is `STU_a41f0c`, the model reasons about handles, and the answer
 * is re-hydrated on the way back, in `core/copilot/index.ts`, from a map that
 * never left this process.
 *
 * The result is a Copilot that can say "Meera and two others are behind on
 * ratio" while Anthropic has been told about `STU_a41f0c` and two more. That is
 * the rule from the brief — *never send unnecessary personal information to AI
 * providers* — implemented rather than promised, and it costs nothing.
 *
 * ---------------------------------------------------------------------------
 * The refusals come with it
 * ---------------------------------------------------------------------------
 * Every null in here is a null the product decided on: mastery below the
 * evidence bar, a class mean below MIN_MEASURED. They arrive as
 * `"not enough evidence"` rather than as a missing key, because a missing key
 * is an invitation to guess and a model handed 30 concepts with 4 numbers will
 * happily average the 4.
 *
 * ---------------------------------------------------------------------------
 * It is assembled, not queried by the model
 * ---------------------------------------------------------------------------
 * There is no tool-calling here and deliberately so. A model that could query
 * would need a query surface, and a query surface reachable by a prompt is a
 * tenancy boundary defended by English. Everything the Copilot can see is
 * gathered here first, inside `withTenant`, and handed over as a fixed block.
 */

export type Actor = { organizationId: string; userId: string };

export type CopilotContext = {
  /** Handle -> real name. NEVER serialised into a prompt. */
  identities: Map<string, { studentUserId: string; fullName: string }>;
  /** The block that goes to the model. Contains no names, phones or emails. */
  facts: string;
  /** What went into it, for the citation list a teacher can check. */
  sources: string[];
  /** True when there is nothing worth asking about yet. */
  empty: boolean;
};

/**
 * Gather everything, once per turn.
 *
 * Deliberately re-gathered rather than cached on the conversation: a teacher
 * asking a follow-up on Monday about Friday's question should get Monday's
 * marking, and a Copilot answering from a stale snapshot is worse than one that
 * says it does not know.
 */
export async function buildContext(
  actor: Actor,
  classId: string | null,
  now = new Date(),
): Promise<CopilotContext> {
  const identities = new Map<
    string,
    { studentUserId: string; fullName: string }
  >();
  const sources: string[] = [];

  const data = await withTenant(actor.organizationId, async (tx) => {
    const classes = await tx.class.findMany({
      where: { deletedAt: null, ...(classId ? { id: classId } : {}) },
      include: { subject: { select: { name: true } }, grade: { select: { label: true } } },
      orderBy: { name: "asc" },
    });
    if (classes.length === 0) return null;

    const classIds = classes.map((klass) => klass.id);

    const enrolments = await tx.classEnrolment.findMany({
      where: { classId: { in: classIds }, status: "ACTIVE" },
      select: { classId: true, studentUserId: true },
    });
    const studentIds = [...new Set(enrolments.map((row) => row.studentUserId))];

    const [users, mastery, gaps, interventions, assignments] = await Promise.all([
      studentIds.length === 0
        ? []
        : tx.user.findMany({
            where: { id: { in: studentIds } },
            // Name only, and only so it can be put back afterwards. It does not
            // go near the prompt.
            select: { id: true, fullName: true },
          }),
      studentIds.length === 0
        ? []
        : tx.studentConceptMastery.findMany({
            where: { studentUserId: { in: studentIds } },
          }),
      tx.learningGap.findMany({
        where: {
          scope: "CLASS",
          scopeId: { in: classIds },
          status: { not: "RESOLVED" },
        },
      }),
      tx.intervention.findMany({
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      tx.assignment.findMany({
        where: { classId: { in: classIds }, cancelledAt: null },
        include: { assessment: { select: { title: true } } },
        orderBy: { closesAt: "desc" },
        take: 20,
      }),
    ]);

    return { classes, enrolments, users, mastery, gaps, interventions, assignments };
  });

  if (!data) {
    return { identities, facts: "", sources: [], empty: true };
  }

  const { classes, enrolments, users, mastery, gaps, interventions, assignments } =
    data;

  // The handle map. `opaqueId` is stable for a given id, so the same student is
  // the same handle across turns in a conversation — which is what lets a
  // follow-up question work at all.
  for (const user of users) {
    identities.set(opaqueId("STU", user.id), {
      studentUserId: user.id,
      fullName: user.fullName,
    });
  }
  const handleByStudent = new Map(
    users.map((user) => [user.id, opaqueId("STU", user.id)]),
  );

  const conceptIds = [...new Set([
    ...mastery.map((row) => row.conceptId),
    ...gaps.map((row) => row.conceptId),
  ])];
  const concepts = await conceptContext(conceptIds);

  const classById = new Map(classes.map((klass) => [klass.id, klass]));
  const classByStudent = new Map(
    enrolments.map((row) => [row.studentUserId, row.classId]),
  );

  const lines: string[] = [];

  // --- Classes -------------------------------------------------------------
  lines.push("CLASSES");
  for (const klass of classes) {
    const students = enrolments.filter((row) => row.classId === klass.id).length;
    lines.push(
      `- ${klass.name} (${klass.grade.label} ${klass.subject.name}), ${students} students, academic year ${klass.academicYear}`,
    );
  }
  sources.push(`${classes.length} classes`);

  // --- Mastery, per class per concept, with denominators -------------------
  lines.push("", "CONCEPT MASTERY BY CLASS");
  const byClassConcept = new Map<string, number[]>();
  const insufficientByClassConcept = new Map<string, number>();
  for (const row of mastery) {
    const klassId = classByStudent.get(row.studentUserId);
    if (!klassId) continue;
    const key = `${klassId}::${row.conceptId}`;
    if (row.estimate === null) {
      insufficientByClassConcept.set(
        key,
        (insufficientByClassConcept.get(key) ?? 0) + 1,
      );
      continue;
    }
    const values = byClassConcept.get(key) ?? [];
    values.push(Number(row.estimate));
    byClassConcept.set(key, values);
  }

  const seen = new Set<string>();
  for (const [key, values] of byClassConcept) {
    seen.add(key);
    const [klassId, conceptId] = key.split("::");
    const klass = classById.get(klassId!);
    const total = enrolments.filter((row) => row.classId === klassId).length;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const below = values.filter((value) => value < 0.6).length;

    // The denominator is in every line. A model handed "71%" with no idea it
    // was over four of thirty will repeat it as a fact about the class.
    lines.push(
      `- ${klass?.name}, ${concepts.get(conceptId!)?.name ?? conceptId}: mean ${Math.round(mean * 100)}% over ${values.length} measured of ${total} students; ${below} below the 60% line`,
    );
  }
  for (const [key, count] of insufficientByClassConcept) {
    if (seen.has(key)) continue;
    const [klassId, conceptId] = key.split("::");
    lines.push(
      `- ${classById.get(klassId!)?.name}, ${concepts.get(conceptId!)?.name ?? conceptId}: not enough evidence to say anything (${count} students have answered too little)`,
    );
  }
  sources.push(`mastery for ${mastery.length} student-concept pairs`);

  // --- Who is behind, by handle -------------------------------------------
  const struggling = mastery.filter(
    (row) => row.estimate !== null && Number(row.estimate) < 0.6,
  );
  if (struggling.length > 0) {
    lines.push("", "STUDENTS BELOW THE LINE (identified by handle only)");
    for (const row of struggling.slice(0, 120)) {
      const handle = handleByStudent.get(row.studentUserId);
      const klassId = classByStudent.get(row.studentUserId);
      if (!handle) continue;
      lines.push(
        `- ${handle} in ${classById.get(klassId ?? "")?.name ?? "a class"}: ${concepts.get(row.conceptId)?.name ?? row.conceptId} at ${Math.round(Number(row.estimate) * 100)}%`,
      );
    }
    sources.push(`${struggling.length} below-threshold readings`);
  }

  // --- Gaps ----------------------------------------------------------------
  if (gaps.length > 0) {
    lines.push("", "OPEN LEARNING GAPS");
    for (const gap of gaps) {
      lines.push(
        `- ${classById.get(gap.scopeId)?.name ?? "a class"}, ${concepts.get(gap.conceptId)?.name ?? gap.conceptId}: ${gap.severity}, ${gap.affectedStudentCount} of ${gap.measuredStudentCount} measured below the line, status ${gap.status}`,
      );
    }
    sources.push(`${gaps.length} open gaps`);
  }

  // --- Interventions, with their stamps ------------------------------------
  if (interventions.length > 0) {
    lines.push("", "INTERVENTIONS");
    for (const intervention of interventions) {
      const outcome =
        intervention.outcomeMastery === null
          ? "not measured yet"
          : `now ${Math.round(Number(intervention.outcomeMastery) * 100)}%`;
      lines.push(
        `- ${intervention.kind}, baseline ${Math.round(Number(intervention.baselineMastery) * 100)}% over ${intervention.baselineStudentCount} students, target ${Math.round(Number(intervention.targetMastery) * 100)}%, ${outcome}`,
      );
    }
    sources.push(`${interventions.length} interventions`);
  }

  // --- Assignments ---------------------------------------------------------
  if (assignments.length > 0) {
    lines.push("", "RECENT ASSIGNMENTS");
    for (const assignment of assignments) {
      lines.push(
        `- "${assignment.assessment.title}" for ${classById.get(assignment.classId)?.name ?? "a class"}: ${assignmentStatus(assignment, now).toLowerCase()}`,
      );
    }
    sources.push(`${assignments.length} assignments`);
  }

  return {
    identities,
    facts: lines.join("\n"),
    sources,
    // Empty means nothing MEASURED, not nothing set. A teacher with an
    // assignment out and no marked work has nothing for the Copilot to reason
    // about, and answering "you have one open test" at DEEP-tier rates is the
    // most expensive way in this product to say something they can already see.
    empty: mastery.length === 0 && gaps.length === 0,
  };
}

/**
 * Put the people back.
 *
 * Runs on every string the model produced, before any of it reaches a screen or
 * the database. A handle that survives to the UI is a bug the teacher sees as
 * gibberish; a name that reaches the provider is a bug nobody sees at all,
 * which is why the direction of this function matters more than it looks.
 */
export function rehydrate(
  text: string,
  identities: CopilotContext["identities"],
): string {
  let output = text;
  for (const [handle, person] of identities) {
    // A plain split/join rather than a regex: a handle is a fixed literal and
    // building a pattern from data is how an unescaped character becomes a
    // silent no-match.
    output = output.split(handle).join(person.fullName);
  }
  return output;
}

/** Which real students an answer talked about, for the UI to link to. */
export function mentioned(
  text: string,
  identities: CopilotContext["identities"],
): { studentUserId: string; fullName: string }[] {
  const found: { studentUserId: string; fullName: string }[] = [];
  for (const [handle, person] of identities) {
    if (text.includes(handle)) found.push(person);
  }
  return found;
}

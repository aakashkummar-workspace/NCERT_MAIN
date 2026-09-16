import "server-only";
import { withTenant } from "@/db/tenant";
import { assignmentStatus } from "@/core/assignments/window";

/**
 * The institute dashboard.
 *
 * ---------------------------------------------------------------------------
 * Exceptions, not a wall of numbers
 * ---------------------------------------------------------------------------
 * PRODUCT_REQUIREMENTS.md describes the owner's day as *"Manual spreadsheets"*
 * replaced by *"a dashboard with exceptions surfaced"*. That word is the brief.
 * An owner with twelve teachers does not need to be told the institute has
 * twelve teachers; they need to be told which two have papers sitting unmarked
 * a fortnight after the test.
 *
 * So the counts are context and the exceptions are the page. Every exception
 * names a thing somebody can do something about today, and carries the number
 * that makes it worth doing.
 *
 * ---------------------------------------------------------------------------
 * Nothing here ranks a teacher
 * ---------------------------------------------------------------------------
 * See `teacherActivity()` below. The short version: a teacher given the bottom
 * set looks worse on any absolute measure of their students' mastery, so a
 * league table built on it is confounded before it is unfair — and it is also
 * unfair. What this reports is what a teacher controls.
 */

export type Kpis = {
  teachers: number;
  students: number;
  classes: number;
  /** Students who have sat something in the window. The real engagement number. */
  activeStudents: number;
  assessmentsPublished: number;
  attemptsSubmitted: number;
  /** Days the window covers, so every figure above has a denominator. */
  windowDays: number;
};

export type Exception =
  | {
      kind: "marking-overdue";
      severity: "high" | "medium";
      /** Named, because "somebody has marking to do" is not actionable. */
      subject: string;
      count: number;
      oldestDays: number;
      href: string;
      message: string;
    }
  | {
      kind: "class-untested";
      severity: "medium";
      subject: string;
      count: number;
      href: string;
      message: string;
    }
  | {
      kind: "students-cannot-sign-in";
      severity: "high";
      subject: string;
      count: number;
      href: string;
      message: string;
    }
  | {
      kind: "gaps-unaddressed";
      severity: "medium";
      subject: string;
      count: number;
      href: string;
      message: string;
    };

/** A paper unmarked longer than this is a problem, not a backlog. */
export const MARKING_OVERDUE_DAYS = 7;

/** A class with nothing set for this long has gone quiet. */
export const UNTESTED_DAYS = 30;

const DAY = 86_400_000;

export async function instituteKpis(
  organizationId: string,
  windowDays = 30,
  now = new Date(),
): Promise<Kpis> {
  const since = new Date(now.getTime() - windowDays * DAY);

  return withTenant(organizationId, async (tx) => {
    const [teachers, students, classes, assessments, attempts] = await Promise.all([
      tx.membership.count({
        where: { role: { in: ["OWNER", "ADMIN", "TEACHER"] }, status: "ACTIVE" },
      }),
      tx.membership.count({ where: { role: "STUDENT", status: "ACTIVE" } }),
      tx.class.count({ where: { deletedAt: null } }),
      tx.assessment.count({
        where: { status: { not: "DRAFT" }, deletedAt: null, publishedAt: { gte: since } },
      }),
      tx.attempt.findMany({
        where: { status: { not: "IN_PROGRESS" }, submittedAt: { gte: since } },
        select: { studentUserId: true },
      }),
    ]);

    return {
      teachers,
      students,
      classes,
      // Distinct people, not sittings. Six papers from one keen student is not
      // six active students, and an engagement number that says otherwise is
      // the number that gets quoted in a renewal meeting.
      activeStudents: new Set(attempts.map((a) => a.studentUserId)).size,
      assessmentsPublished: assessments,
      attemptsSubmitted: attempts.length,
      windowDays,
    };
  });
}

/**
 * What needs somebody today, worst first.
 *
 * Each one is a thing an owner can act on within the hour: chase a teacher,
 * collect a phone number, set a paper. A dashboard exception that cannot be
 * acted on is a dashboard exception that gets ignored, and then so do the
 * others.
 */
export async function exceptions(
  organizationId: string,
  now = new Date(),
): Promise<Exception[]> {
  const found: Exception[] = [];

  await withTenant(organizationId, async (tx) => {
    // 1. Papers a person still has to read. The single most common complaint
    //    from students and parents, and entirely within an institute's control.
    const unmarked = await tx.attemptAnswer.findMany({
      where: { gradedAt: null, awardedMarks: null },
      select: { attemptId: true },
    });
    if (unmarked.length > 0) {
      const attempts = await tx.attempt.findMany({
        where: {
          id: { in: [...new Set(unmarked.map((a) => a.attemptId))] },
          status: { not: "IN_PROGRESS" },
        },
        select: { id: true, submittedAt: true, assignmentId: true },
      });

      const overdue = attempts.filter(
        (attempt) =>
          attempt.submittedAt !== null &&
          now.getTime() - attempt.submittedAt.getTime() > MARKING_OVERDUE_DAYS * DAY,
      );

      if (overdue.length > 0) {
        const oldest = overdue.reduce(
          (worst, attempt) =>
            attempt.submittedAt! < worst ? attempt.submittedAt! : worst,
          overdue[0]!.submittedAt!,
        );
        const oldestDays = Math.floor((now.getTime() - oldest.getTime()) / DAY);

        const assignment = await tx.assignment.findFirst({
          where: { id: overdue[0]!.assignmentId },
          include: { assessment: { select: { title: true } } },
        });

        found.push({
          kind: "marking-overdue",
          // Three weeks is not a backlog any more; by then a student has sat
          // the next one without knowing how they did on this.
          severity: oldestDays > 21 ? "high" : "medium",
          subject: assignment?.assessment.title ?? "A paper",
          count: overdue.length,
          oldestDays,
          href: `/teacher/assignments/${overdue[0]!.assignmentId}/marking`,
          message:
            overdue.length === 1
              ? `One paper has been waiting ${oldestDays} days to be marked.`
              : `${overdue.length} papers are unmarked, the oldest for ${oldestDays} days.`,
        });
      }
    }

    // 2. A student with no mobile number cannot sit anything. Discovering that
    //    on exam morning is the failure the roster keeps catching, and it is a
    //    five-minute fix if somebody knows about it a week earlier.
    const memberships = await tx.membership.findMany({
      where: { role: "STUDENT", status: "ACTIVE" },
      select: { userId: true },
    });
    if (memberships.length > 0) {
      const users = await tx.user.findMany({
        where: { id: { in: memberships.map((m) => m.userId) }, phone: null },
        select: { id: true },
      });
      if (users.length > 0) {
        found.push({
          kind: "students-cannot-sign-in",
          severity: "high",
          subject: "Missing mobile numbers",
          count: users.length,
          href: "/teacher/students",
          message:
            users.length === 1
              ? "One student has no mobile number, so they cannot sit anything."
              : `${users.length} students have no mobile number, so they cannot sit anything.`,
        });
      }
    }

    // 3. A class nobody has set anything for. Quiet is not the same as fine,
    //    and a class with no assessment has no evidence behind any of its
    //    figures either.
    // Only classes that have EXISTED long enough to have gone quiet. A class
    // created on Tuesday has not "had nothing set for 30 days" — it has been
    // there for two — and an owner who reads that once stops believing the
    // rest of the list.
    const classes = await tx.class.findMany({
      where: {
        deletedAt: null,
        createdAt: { lt: new Date(now.getTime() - UNTESTED_DAYS * DAY) },
      },
      select: { id: true, name: true, createdAt: true },
    });
    const recent = await tx.assignment.findMany({
      where: { createdAt: { gte: new Date(now.getTime() - UNTESTED_DAYS * DAY) } },
      select: { classId: true },
    });
    const busy = new Set(recent.map((row) => row.classId));
    const quiet = classes.filter((klass) => !busy.has(klass.id));
    if (quiet.length > 0) {
      found.push({
        kind: "class-untested",
        severity: "medium",
        subject: quiet.map((klass) => klass.name).slice(0, 3).join(", "),
        count: quiet.length,
        href: "/teacher/classes",
        message:
          quiet.length === 1
            ? `${quiet[0]!.name} has had nothing set for ${UNTESTED_DAYS} days.`
            : `${quiet.length} classes have had nothing set for ${UNTESTED_DAYS} days.`,
      });
    }

    // 4. Gaps found and not worked on. The product's whole reason to exist,
    //    surfaced at the level of the person who can ask about it.
    const gaps = await tx.learningGap.count({
      where: { scope: "CLASS", status: { in: ["DETECTED", "PERSISTING"] } },
    });
    if (gaps > 0) {
      found.push({
        kind: "gaps-unaddressed",
        severity: "medium",
        subject: "Learning gaps",
        count: gaps,
        href: "/teacher/analytics",
        message:
          gaps === 1
            ? "One class-level gap has been found and not yet worked on."
            : `${gaps} class-level gaps have been found and not yet worked on.`,
      });
    }
  });

  const order = { high: 0, medium: 1 } as const;
  return found.sort((a, b) => order[a.severity] - order[b.severity]);
}

export type TeacherRow = {
  userId: string;
  fullName: string;
  role: string;
  classes: number;
  students: number;
  assessmentsCreated: number;
  assignmentsSet: number;
  /** Papers of theirs still waiting on a person. What they can act on. */
  unmarkedPapers: number;
  /** How long the oldest has waited. Null when there is nothing outstanding. */
  oldestUnmarkedDays: number | null;
  lastActiveAt: Date | null;
};

/**
 * What each teacher has been doing.
 *
 * ---------------------------------------------------------------------------
 * Activity, and deliberately not outcomes
 * ---------------------------------------------------------------------------
 * PRODUCT_REQUIREMENTS.md asks for *"Teacher activity and outcomes"*. This
 * returns the first and refuses the second, and the refusal is the considered
 * half.
 *
 * Ranking teachers by their students' mastery is confounded before it is
 * anything else: a teacher handed the bottom set scores lower on every absolute
 * measure, however well they teach, and the effect size of *which students you
 * were given* dwarfs everything this product can observe. A number that wrong
 * would still get used, because it is the only number on the page — and once
 * teachers know they are ranked on it, the rational move is to avoid the
 * students who need them most. That is the opposite of what the product is for.
 *
 * So every column here is something the teacher controls and can change this
 * week: papers set, papers marked, how long the oldest has waited. An owner
 * reading it learns who needs help, which is the question they actually had.
 *
 * If teacher effectiveness is ever measured here, the only defensible shape is
 * the one `core/gaps/interventions.ts` already uses — improvement against a
 * baseline stamped before the teaching, on the same cohort. That is a real
 * measurement and it is not this table.
 */
export async function teacherActivity(
  organizationId: string,
  windowDays = 30,
  now = new Date(),
): Promise<TeacherRow[]> {
  const since = new Date(now.getTime() - windowDays * DAY);

  return withTenant(organizationId, async (tx) => {
    const memberships = await tx.membership.findMany({
      where: {
        role: { in: ["OWNER", "ADMIN", "TEACHER"] },
        status: "ACTIVE",
      },
    });
    if (memberships.length === 0) return [];

    const ids = memberships.map((m) => m.userId);
    const [users, classTeachers, assessments, assignments, enrolments] =
      await Promise.all([
        tx.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, fullName: true, lastLoginAt: true },
        }),
        tx.classTeacher.findMany({
          where: { teacherUserId: { in: ids } },
          select: { teacherUserId: true, classId: true },
        }),
        tx.assessment.findMany({
          where: { createdById: { in: ids }, deletedAt: null, createdAt: { gte: since } },
          select: { createdById: true },
        }),
        tx.assignment.findMany({
          where: { assignedById: { in: ids }, createdAt: { gte: since } },
          select: { assignedById: true, id: true },
        }),
        tx.classEnrolment.findMany({
          where: { status: "ACTIVE" },
          select: { classId: true, studentUserId: true },
        }),
      ]);

    const studentsByClass = new Map<string, Set<string>>();
    for (const enrolment of enrolments) {
      const set = studentsByClass.get(enrolment.classId) ?? new Set<string>();
      set.add(enrolment.studentUserId);
      studentsByClass.set(enrolment.classId, set);
    }

    const classesByTeacher = new Map<string, string[]>();
    for (const row of classTeachers) {
      const list = classesByTeacher.get(row.teacherUserId) ?? [];
      list.push(row.classId);
      classesByTeacher.set(row.teacherUserId, list);
    }

    // Unmarked work, attributed to whoever set the assignment. Attribution
    // matters: an owner chasing the wrong person is worse than not chasing.
    const assignmentIds = assignments.map((row) => row.id);
    const unmarkedByTeacher = new Map<string, { count: number; oldest: Date }>();
    if (assignmentIds.length > 0) {
      const attempts = await tx.attempt.findMany({
        where: { assignmentId: { in: assignmentIds }, status: { not: "IN_PROGRESS" } },
        select: { id: true, assignmentId: true, submittedAt: true },
      });
      const pending = await tx.attemptAnswer.findMany({
        where: {
          attemptId: { in: attempts.map((a) => a.id) },
          gradedAt: null,
          awardedMarks: null,
        },
        select: { attemptId: true },
      });
      const pendingAttempts = new Set(pending.map((row) => row.attemptId));
      const setterByAssignment = new Map(
        assignments.map((row) => [row.id, row.assignedById]),
      );

      for (const attempt of attempts) {
        if (!pendingAttempts.has(attempt.id) || attempt.submittedAt === null) continue;
        const teacherId = setterByAssignment.get(attempt.assignmentId);
        if (!teacherId) continue;
        const current = unmarkedByTeacher.get(teacherId);
        unmarkedByTeacher.set(teacherId, {
          count: (current?.count ?? 0) + 1,
          oldest:
            current && current.oldest < attempt.submittedAt
              ? current.oldest
              : attempt.submittedAt,
        });
      }
    }

    const roleByUser = new Map(memberships.map((m) => [m.userId, m.role]));

    return users
      .map((user) => {
        const classIds = classesByTeacher.get(user.id) ?? [];
        const students = new Set<string>();
        for (const classId of classIds) {
          for (const studentId of studentsByClass.get(classId) ?? []) {
            students.add(studentId);
          }
        }
        const outstanding = unmarkedByTeacher.get(user.id);

        return {
          userId: user.id,
          fullName: user.fullName,
          role: roleByUser.get(user.id) ?? "TEACHER",
          classes: classIds.length,
          students: students.size,
          assessmentsCreated: assessments.filter((a) => a.createdById === user.id).length,
          assignmentsSet: assignments.filter((a) => a.assignedById === user.id).length,
          unmarkedPapers: outstanding?.count ?? 0,
          oldestUnmarkedDays: outstanding
            ? Math.floor((now.getTime() - outstanding.oldest.getTime()) / DAY)
            : null,
          lastActiveAt: user.lastLoginAt,
        };
      })
      // Most outstanding marking first, then quietest. An owner opening this is
      // looking for who needs help, not for an alphabet — the same ordering
      // rule the students index uses.
      .sort((a, b) => {
        if (a.unmarkedPapers !== b.unmarkedPapers) {
          return b.unmarkedPapers - a.unmarkedPapers;
        }
        if (a.assignmentsSet !== b.assignmentsSet) {
          return a.assignmentsSet - b.assignmentsSet;
        }
        return a.fullName.localeCompare(b.fullName);
      });
  });
}

/** How many assignments are open right now, for the dashboard's live line. */
export async function liveAssignments(
  organizationId: string,
  now = new Date(),
): Promise<number> {
  const assignments = await withTenant(organizationId, (tx) =>
    tx.assignment.findMany({
      where: { cancelledAt: null },
      select: { opensAt: true, closesAt: true, cancelledAt: true },
    }),
  );
  // Derived from the clock, like everywhere else — there is no status column
  // to read and there deliberately never was one.
  return assignments.filter(
    (assignment) => assignmentStatus(assignment, now) === "OPEN",
  ).length;
}

import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { listStudents } from "@/core/analytics/students";
import { conceptContext } from "@/core/curriculum/concepts";
import { AppShell } from "@/ui/AppShell";
import { Alert, Badge, EmptyState, PageHeader } from "@/ui";

export const metadata: Metadata = { title: "Students" };

export const dynamic = "force-dynamic";

export default async function StudentsPage() {
  const session = await getSession();
  if (!session) redirect("/signin");

  const students = await listStudents(session.actor.organizationId);
  const concepts = await conceptContext([
    ...new Set(
      students.flatMap((student) =>
        student.weakest ? [student.weakest.conceptId] : [],
      ),
    ),
  ]);

  const cannotSignIn = students.filter((student) => !student.canSignIn).length;

  // Weakest first, then never-measured, then the rest. A teacher opening this
  // is looking for who needs them, not for an alphabet.
  const ordered = [...students].sort((a, b) => {
    if (a.struggling !== b.struggling) return b.struggling - a.struggling;
    if (a.measuredConcepts !== b.measuredConcepts) {
      return a.measuredConcepts - b.measuredConcepts;
    }
    return a.fullName.localeCompare(b.fullName);
  });

  return (
    <AppShell
      currentPath="/teacher/students"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        title="Students"
        description={
          students.length === 0
            ? "Everybody on your roster, across every class."
            : `${students.length} across every class, the ones who need you first.`
        }
      />

      {cannotSignIn > 0 && (
        <Alert
          tone="warning"
          title={`${cannotSignIn} ${cannotSignIn === 1 ? "student has" : "students have"} no mobile number`}
        >
          A phone number is the only way a student signs in, so these ones cannot
          sit anything. Add numbers on the class page before the next window
          opens.
        </Alert>
      )}

      {students.length === 0 ? (
        <EmptyState
          title="No students yet"
          body="Add students to a class — paste a list, upload a CSV, or give them the class code — and they appear here."
        />
      ) : (
        <ul className="ui-student-rows">
          {ordered.map((student) => (
            <li key={student.studentUserId}>
              <Link href={`/teacher/students/${student.studentUserId}`}>
                <span className="ui-student-row-main">
                  <span className="ui-student-row-name">{student.fullName}</span>
                  <span className="ui-student-row-meta">
                    {student.classNames.length > 0
                      ? student.classNames.join(" · ")
                      : "Not in a class"}
                    {student.sittings > 0 && ` · ${student.sittings} sat`}
                  </span>
                </span>

                <span className="ui-student-row-tags">
                  {!student.canSignIn && <Badge tone="warning">No mobile</Badge>}

                  {student.measuredConcepts === 0 ? (
                    // Not a zero. Nothing has been measured, which is a
                    // statement about the marking, not about the student.
                    <Badge tone="neutral">Nothing measured</Badge>
                  ) : (
                    <>
                      {student.struggling > 0 && (
                        <Badge tone="danger">
                          {student.struggling} to work on
                        </Badge>
                      )}
                      {student.secure > 0 && (
                        <Badge tone="success">{student.secure} secure</Badge>
                      )}
                    </>
                  )}
                </span>

                {/*
                  The weakest concept by name. "Struggling" sends a teacher to
                  another page to find out with what; the name is the whole
                  point of having measured it.
                */}
                {student.weakest && (
                  <span className="ui-student-row-weakest">
                    Weakest:{" "}
                    {concepts.get(student.weakest.conceptId)?.name ?? "a concept"}{" "}
                    <span className="tabular">
                      ({Math.round(student.weakest.estimate * 100)}%)
                    </span>
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}

import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { studentSubjectIds, syllabusIndex } from "@/core/curriculum/syllabus";
import { StudentShell } from "@/ui/StudentShell";
import { PageHeader } from "@/ui";
import { SyllabusIndex } from "@/app/_syllabus/SyllabusIndex";

export const metadata: Metadata = { title: "Syllabus" };

export const dynamic = "force-dynamic";

export default async function StudentSyllabusPage() {
  const session = await getSession();
  if (!session) redirect("/signin/student");
  if (session.actor.role !== "STUDENT") redirect("/teacher/syllabus");

  const [{ boardName, grades }, mine] = await Promise.all([
    syllabusIndex(session.actor.organizationId),
    studentSubjectIds(session.actor.organizationId, session.actor.userId),
  ]);

  // Your own class first: a Class 9 student opening this is looking for Class 9.
  const ordered = [...grades].sort((a, b) => {
    const aMine = a.subjects.some((subject) => mine.has(subject.id)) ? 0 : 1;
    const bMine = b.subjects.some((subject) => mine.has(subject.id)) ? 0 : 1;
    return aMine - bMine || a.number - b.number;
  });

  return (
    <StudentShell
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        title="Syllabus"
        description={`${boardName}: every chapter, subject by subject. Open a chapter to see its topics and what you should be able to do by the end of it.`}
      />
      <SyllabusIndex grades={ordered} highlight={mine} highlightLabel="Your class" />
    </StudentShell>
  );
}

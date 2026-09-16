import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { syllabusIndex } from "@/core/curriculum/syllabus";
import { AppShell } from "@/ui/AppShell";
import { PageHeader } from "@/ui";
import { SyllabusIndex } from "@/app/_syllabus/SyllabusIndex";

export const metadata: Metadata = { title: "Syllabus" };

export const dynamic = "force-dynamic";

export default async function TeacherSyllabusPage() {
  const session = await getSession();
  if (!session) redirect("/signin");

  const { boardName, grades } = await syllabusIndex(session.actor.organizationId);
  const chapters = grades.reduce(
    (sum, grade) => sum + grade.subjects.reduce((s, subject) => s + subject.chapters.length, 0),
    0,
  );

  return (
    <AppShell
      currentPath="/teacher/syllabus"
      fullName={session.fullName}
      organizationName={session.organizationName}
      breadcrumbs={[{ label: "Syllabus" }]}
    >
      <PageHeader
        title="Syllabus"
        description={`${boardName}: every chapter of every subject, ${chapters} in all, with its topics, learning outcomes and the approved questions in your bank. Print this page to save it as a PDF.`}
      />
      <SyllabusIndex grades={grades} />
    </AppShell>
  );
}

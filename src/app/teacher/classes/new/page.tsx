import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { currentAcademicYear, listGradesWithSubjects } from "@/core/curriculum";
import { organizationBoard } from "@/core/organizations";
import { AppShell } from "@/ui/AppShell";
import { PageHeader } from "@/ui";
import { CreateClassForm } from "./CreateClassForm";

export const metadata: Metadata = { title: "Create a class" };

export default async function NewClassPage() {
  const session = await getSession();
  if (!session) redirect("/signin");

  // Only this board's grades and subjects are offered. A class is a row in one
  // board's tree from the moment it exists, so this is the last point at which
  // the choice can be made correctly.
  const board = await organizationBoard(session.actor.organizationId);
  const grades = await listGradesWithSubjects(board.id);

  return (
    <AppShell
      currentPath="/teacher/classes"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <div style={{ maxWidth: 620 }}>
        <PageHeader
          eyebrow="New class"
          title="Create a class"
          description={`A class is one group you teach, for one subject. Two subjects for the same students are two classes — that is what lets mastery be measured per subject. Grades and subjects come from ${board.name}, the board on your organisation.`}
        />
        <CreateClassForm
          grades={grades}
          defaultAcademicYear={currentAcademicYear()}
        />
      </div>
    </AppShell>
  );
}

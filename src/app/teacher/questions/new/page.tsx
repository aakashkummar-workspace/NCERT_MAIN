import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { questionPickerOptions } from "@/core/curriculum/picker";
import { AppShell } from "@/ui/AppShell";
import { PageHeader } from "@/ui";
import { QuestionEditor } from "../QuestionEditor";

export const metadata: Metadata = { title: "Write a question" };

export default async function NewQuestionPage() {
  const session = await getSession();
  if (!session) redirect("/signin");

  const { subjects, chapters, outcomes } = await questionPickerOptions();

  return (
    <AppShell
      currentPath="/teacher/questions"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        eyebrow={<Link href="/teacher/questions">Question Bank</Link>}
        title="Write a question"
        description="Saved as a draft. Approve it when you are happy, and it becomes available to every assessment you build."
      />
      <QuestionEditor
        initial={{
          type: "MCQ",
          // Never defaulted. The first chapter in the list belonged to Class 9
          // Social Science, so a question saved without a chapter was filed
          // there silently — scored correctly, and evidence for the wrong
          // syllabus forever. The teacher chooses.
          subjectId: "",
          chapterId: null,
          difficulty: "MEDIUM",
          marks: 1,
          stem: "",
          options: null,
          answerKey: null,
          explanation: null,
          hint: null,
          outcomeIds: [],
        }}
        subjects={subjects}
        chapters={chapters}
        outcomes={outcomes}
      />
    </AppShell>
  );
}

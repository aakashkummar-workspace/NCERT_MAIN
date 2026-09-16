import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { questionPickerOptions } from "@/core/curriculum/picker";
import { AppShell } from "@/ui/AppShell";
import { Alert, PageHeader } from "@/ui";
import { GenerateForm } from "./GenerateForm";

export const metadata: Metadata = { title: "Generate questions" };

export const dynamic = "force-dynamic";

export default async function GeneratePage() {
  const session = await getSession();
  if (!session) redirect("/signin");

  const picker = await questionPickerOptions();

  // Only chapters with authored outcomes. A chapter without them has nothing to
  // ground a generator in, and offering it would produce plausible questions
  // about a title — the output that wastes an evening.
  const usable = picker.chapters.filter((chapter) => chapter.outcomeCount > 0);

  return (
    <AppShell
      currentPath="/teacher/questions"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        eyebrow={<Link href="/teacher/questions">Question Bank</Link>}
        title="Generate questions"
        description="Drafts, grounded in the chapter's learning outcomes and in questions you have already approved."
        actions={
          <Link href="/teacher/questions/new" className="ui-button" data-variant="secondary">
            <span>Write one instead</span>
          </Link>
        }
      />

      <Alert tone="info" title="Everything generated arrives as a draft">
        Nothing here can put a question in front of a student. Each draft goes
        through the same checks your own typing does, and then waits for you to
        approve it — the ones that fail those checks are dropped before you see
        them.
      </Alert>

      {usable.length === 0 ? (
        <Alert tone="warning" title="No chapter is ready for this yet">
          Generation is grounded in a chapter&rsquo;s learning outcomes, and none
          of your subjects has any authored yet. A chapter title alone produces
          questions that look right and test the wrong thing.
        </Alert>
      ) : (
        <GenerateForm chapters={usable} />
      )}
    </AppShell>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { listSavedQuestions } from "@/core/saved";
import { StudentShell } from "@/ui/StudentShell";
import { PageHeader } from "@/ui";
import { SavedList } from "./SavedList";

export const metadata: Metadata = { title: "Saved questions" };

export const dynamic = "force-dynamic";

/**
 * Saved questions — a student's own bookmarks.
 *
 * The stem and the option text, and nothing that says which option is right.
 * Each row links to where the question can be reviewed, and the answer is shown
 * there, behind the gate that page already keeps. A saved page that printed the
 * answer would be a second copy of that gate, and the one that eventually gets
 * it wrong.
 */
export default async function SavedPage() {
  const session = await getSession();
  if (!session) redirect("/signin/student");
  if (session.actor.role !== "STUDENT") redirect("/teacher");

  const saved = await listSavedQuestions(
    session.actor.organizationId,
    session.actor.userId,
  );

  return (
    <StudentShell
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        eyebrow={<Link href="/student">Home</Link>}
        title="Saved questions"
        description={
          saved.rows.length === 0
            ? undefined
            : "Newest first. Only you can see this list."
        }
      />

      <SavedList
        rows={saved.rows.map((row) => ({
          questionId: row.questionId,
          stem: row.stem,
          options: row.options,
          subjectName: row.subjectName,
          chapterTitle: row.chapterTitle,
          savedLabel: new Intl.DateTimeFormat("en-IN", {
            dateStyle: "medium",
            timeZone: "Asia/Kolkata",
          }).format(row.savedAt),
          review: row.review,
        }))}
      />

      {saved.truncated && (
        <p className="ui-hint ui-saved-truncated">
          Showing your {saved.rows.length} most recent. Older saved questions are
          kept, but not listed here — unsave a few to see them.
        </p>
      )}
    </StudentShell>
  );
}

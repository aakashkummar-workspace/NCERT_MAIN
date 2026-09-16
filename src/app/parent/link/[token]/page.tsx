import type { Metadata } from "next";
import { previewInvitation } from "@/core/parent/link";
import { EmptyState } from "@/ui";
import { Accept } from "./Accept";

export const metadata: Metadata = { title: "See your child's progress" };

export const dynamic = "force-dynamic";

const RELATIONSHIP: Record<string, string> = {
  FATHER: "father",
  MOTHER: "mother",
  GUARDIAN: "guardian",
};

/**
 * The invitation link.
 *
 * Opened by somebody with no account, so it renders outside every shell and
 * shows only what identifies the invitation: the child's name, the centre's
 * name, and a masked hint of the number the code will go to. Anyone holding
 * the URL sees this much, and nothing about the child's work is in it.
 */
export default async function ParentLinkPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const preview = await previewInvitation(decodeURIComponent(token));

  if (!preview.ok) {
    return (
      <main className="ui-accept-page">
        <EmptyState
          title="This link is not valid any more"
          body="Links expire after a week, work only once, and stop working if the centre cancels them or takes access away. If you already accepted this one, sign in instead — otherwise ask the centre for a new one."
        />
      </main>
    );
  }

  const relationship = RELATIONSHIP[preview.relationship] ?? "guardian";

  return (
    <main className="ui-accept-page">
      <div className="ui-accept-card">
        <p className="ui-accept-eyebrow">{preview.organizationName}</p>
        <h1 className="ui-accept-title">
          See how {preview.studentName} is doing
        </h1>
        <p className="ui-accept-body">
          You have been invited as {preview.studentName}&rsquo;s {relationship}.
          Verify your number and you will be able to see their progress and test
          results.
        </p>

        {/*
          What consent is FOR, stated before it is given, in the words of the
          thing rather than a policy link. A parent agreeing to something they
          were not told the shape of has not agreed to anything.
        */}
        <ul className="ui-accept-scope">
          <li data-yes="true">Their progress by topic, and how it is changing</li>
          <li data-yes="true">Tests they have taken, once the teacher releases the marks</li>
          <li>Not their answers, or what they wrote</li>
          <li>Not their practice, or the questions they ask for help with</li>
          <li>Not any other child</li>
        </ul>

        <Accept
          token={decodeURIComponent(token)}
          studentName={preview.studentName}
          phoneHint={preview.phoneHint}
        />

        <p className="ui-accept-foot">
          The centre can take this access away at any time, and so can you — ask
          them. {preview.studentName}&rsquo;s teachers can see that you are
          linked. This link works once.
        </p>
      </div>
    </main>
  );
}

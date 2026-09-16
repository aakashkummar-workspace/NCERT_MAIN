import type { Metadata } from "next";
import Link from "next/link";
import { previewStaffInvitation } from "@/core/identity/staff-invitation";
import { EmptyState } from "@/ui";
import { JoinForm } from "./JoinForm";

export const metadata: Metadata = { title: "Join your colleagues" };

export const dynamic = "force-dynamic";

const ROLE: Record<string, string> = {
  OWNER: "an owner",
  ADMIN: "an admin",
  TEACHER: "a teacher",
};

/**
 * A staff invitation link.
 *
 * Opened by somebody with no session in this organization — often with no
 * account at all — so it renders outside every shell and shows only what
 * identifies the invitation: the organization's name, the role, and the
 * address it was sent to. Anybody holding the URL sees that much, which is
 * why it is that much and no more.
 */
export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token: raw } = await params;
  const token = decodeURIComponent(raw);
  const preview = await previewStaffInvitation(token);

  if (!preview.ok) {
    return (
      <main className="ui-accept-page">
        <EmptyState
          title="This invitation is not valid any more"
          body="An invitation works once and expires after two weeks, and it stops working if it is cancelled. If you have already joined, sign in. Otherwise ask whoever invited you for a new one."
          actions={
            <Link href="/signin" className="ui-button" data-variant="secondary">
              <span>Sign in</span>
            </Link>
          }
        />
      </main>
    );
  }

  return (
    <main className="ui-accept-page">
      <div className="ui-accept-card">
        <p className="ui-accept-eyebrow">{preview.organizationName}</p>
        <h1 className="ui-accept-title">Join {preview.organizationName}</h1>
        <p className="ui-accept-body">
          You have been invited to join as {ROLE[preview.role] ?? "a member of staff"}.
          The invitation was sent to <strong>{preview.email}</strong>, and that is
          the address you join with.
        </p>

        <JoinForm
          token={token}
          email={preview.email}
          accountExists={preview.accountExists}
        />

        <p className="ui-accept-foot">
          This link works once and expires two weeks after it was sent.
        </p>
      </div>
    </main>
  );
}

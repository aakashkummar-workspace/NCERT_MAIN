import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { teacherActivity } from "@/core/institute/kpis";
import { listStaff, pendingStaffInvites } from "@/core/institute/members";
import { Badge, PageHeader, type Tone } from "@/ui";
import { InviteStaff } from "./InviteStaff";
import { StaffActions } from "./StaffActions";

export const metadata: Metadata = { title: "Teachers" };

export const dynamic = "force-dynamic";

const ROLE_TONE: Record<string, Tone> = {
  OWNER: "primary",
  ADMIN: "primary",
  TEACHER: "neutral",
};

export default async function TeachersPage() {
  const session = await getSession();
  if (!session) redirect("/signin");

  const organizationId = session.actor.organizationId;
  const [staff, invites, activity] = await Promise.all([
    listStaff(organizationId),
    pendingStaffInvites(organizationId),
    teacherActivity(organizationId),
  ]);

  const activityById = new Map(activity.map((row) => [row.userId, row]));
  const active = staff.filter((row) => row.status === "ACTIVE");
  const suspended = staff.filter((row) => row.status !== "ACTIVE");

  return (
    <>
      <PageHeader
        title="Teachers"
        description="Who teaches here, what they have set, and what is waiting on them."
      />

      <InviteStaff canMakeOwner={session.actor.role === "OWNER"} />

      {invites.length > 0 && (
        <section style={{ marginTop: 20 }}>
          <h2 className="ui-section-heading">Invited, not yet joined</h2>
          <ul className="ui-staff-rows">
            {invites.map((invite) => (
              <li key={invite.id} className="ui-staff-row">
                <span className="ui-staff-main">
                  <span className="ui-staff-name">{invite.email}</span>
                  <span className="ui-staff-meta">
                    {invite.role.toLowerCase()}
                    {invite.expired
                      ? " · this invitation has expired"
                      : ` · expires ${new Intl.DateTimeFormat("en-IN", {
                          dateStyle: "medium",
                          timeZone: "Asia/Kolkata",
                        }).format(invite.expiresAt)}`}
                  </span>
                </span>
                {/*
                  Expired invitations are shown rather than filtered out: an
                  owner who sent one a month ago and sees nothing assumes they
                  never sent it, and sends another.
                */}
                <Badge tone={invite.expired ? "warning" : "neutral"}>
                  {invite.expired ? "Expired" : "Pending"}
                </Badge>
                <StaffActions kind="invite" id={invite.id} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section style={{ marginTop: 20 }}>
        <h2 className="ui-section-heading">Teaching here</h2>
        <ul className="ui-staff-rows">
          {active.map((member) => {
            const row = activityById.get(member.userId);
            return (
              <li key={member.membershipId} className="ui-staff-row">
                <span className="ui-staff-main">
                  <span className="ui-staff-name">{member.fullName}</span>
                  <span className="ui-staff-meta">
                    {member.email ?? "no email"}
                    {row && row.classes > 0 && ` · ${row.classes} classes`}
                    {row && row.students > 0 && ` · ${row.students} students`}
                  </span>
                </span>

                {/*
                  Activity, never outcomes. What each of these counts is
                  something the teacher controls and can change this week — see
                  the note on teacherActivity().
                */}
                <span className="ui-staff-activity tabular">
                  {row ? `${row.assignmentsSet} set · ${row.assessmentsCreated} written` : "—"}
                </span>

                {row && row.unmarkedPapers > 0 ? (
                  <Badge tone={(row.oldestUnmarkedDays ?? 0) > 21 ? "danger" : "warning"}>
                    {row.unmarkedPapers} to mark
                    {row.oldestUnmarkedDays !== null &&
                      ` · ${row.oldestUnmarkedDays}d`}
                  </Badge>
                ) : (
                  <Badge tone="success">Marking clear</Badge>
                )}

                <Badge tone={ROLE_TONE[member.role] ?? "neutral"}>
                  {member.role.toLowerCase()}
                </Badge>

                <StaffActions
                  kind="member"
                  id={member.membershipId}
                  role={member.role}
                  name={member.fullName}
                  isSelf={member.userId === session.actor.userId}
                  canMakeOwner={session.actor.role === "OWNER"}
                />
              </li>
            );
          })}
        </ul>
      </section>

      {suspended.length > 0 && (
        <section style={{ marginTop: 20 }}>
          <h2 className="ui-section-heading">No longer here</h2>
          <ul className="ui-staff-rows">
            {suspended.map((member) => (
              <li key={member.membershipId} className="ui-staff-row" data-muted="true">
                <span className="ui-staff-main">
                  <span className="ui-staff-name">{member.fullName}</span>
                  <span className="ui-staff-meta">
                    {/*
                      Kept, not deleted. Their papers and their marking still
                      point at them, and "who marked this" is asked a year later.
                    */}
                    Access removed · their work is still here and still theirs
                  </span>
                </span>
                <Badge tone="neutral">Removed</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

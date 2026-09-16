import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { can, currentPlan } from "@/core/billing/entitlements";
import { listClasses } from "@/core/classes";
import { listBoards } from "@/core/curriculum";
import { boardChangeBlockers, organizationBoard } from "@/core/organizations";
import { editorState } from "@/core/branding";
import { BrandingEditor } from "@/app/institute/branding/BrandingEditor";
import { BoardCard } from "./BoardCard";
import { AppShell } from "@/ui/AppShell";
import { Alert, Badge, Card, PageHeader, Stack } from "@/ui";

export const metadata: Metadata = { title: "Settings" };

export const dynamic = "force-dynamic";

/**
 * The keys a person can be told about in words they would use.
 *
 * A key with no entry here is still shown, spelled out from the key itself —
 * a capability added next month appearing as "custom reports" is better than
 * it not appearing at all.
 */
const ENTITLEMENT_LABEL: Record<string, string> = {
  max_classes: "Classes",
  max_students: "Students",
  ai_generations_per_month: "AI question drafts a month",
  copilot_questions_per_month: "Copilot questions a month",
  tutor_hints_per_month: "Tutor hints a month",
  analytics: "Class analytics",
  parent_reports: "Term reports for parents",
  admin_console: "Institute console",
  white_label: "School branding and letterhead",
};

function label(key: string): string {
  return ENTITLEMENT_LABEL[key] ?? key.replace(/_/g, " ");
}

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/signin");
  // The console is gated by role AND plan, the same two checks /institute/layout makes.
  const consoleOpen =
    (session.actor.role === "OWNER" || session.actor.role === "ADMIN") &&
    (await can(session.actor.organizationId, "admin_console")).allowed;
  // Branding is edited here as well as in the console, because Settings is
  // where an owner looks for it first. Owners and admins only — the same
  // `organization:update` the save route guards — and only where the plan
  // includes it: not an upsell, the console's rule.
  const branding =
    session.actor.role === "OWNER" || session.actor.role === "ADMIN"
      ? await editorState(session.actor.organizationId)
      : null;
  const brandingOpen = Boolean(branding?.entitled);

  const [plan, classes, board, boards, blockers] = await Promise.all([
    currentPlan(session.actor.organizationId),
    listClasses(session.actor.organizationId),
    organizationBoard(session.actor.organizationId),
    listBoards(),
    boardChangeBlockers(session.actor.organizationId),
  ]);

  const students = classes.reduce((sum, klass) => sum + klass.studentCount, 0);

  return (
    <AppShell
      currentPath="/teacher/settings"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        title="Settings"
        description="Your account, your organisation, and what your plan includes."
      />

      <div className="ui-class-layout">
        <Stack>
          <Card title="Your plan" description={plan ? plan.name : undefined}>
            {!plan ? (
              <p className="ui-hint">
                No plan is configured on this deployment.
              </p>
            ) : (
              <>
                <div className="ui-row" style={{ gap: 10, marginBottom: 14 }}>
                  <Badge tone={plan.status === "ACTIVE" ? "success" : "primary"}>
                    {plan.status === "TRIALING" ? "Free" : plan.status.toLowerCase()}
                  </Badge>
                  {plan.pricePaise > 0 && (
                    <span className="tabular">
                      ₹{(plan.pricePaise / 100).toFixed(0)} a{" "}
                      {plan.interval.toLowerCase()}
                    </span>
                  )}
                </div>

                <ul className="ui-entitlements">
                  {plan.entitlements.map((entitlement) => {
                    const spent =
                      entitlement.limit !== null && entitlement.used >= entitlement.limit;
                    return (
                      <li key={entitlement.key} data-spent={spent || undefined}>
                        <span className="ui-entitlement-name">
                          {label(entitlement.key)}
                        </span>
                        <span className="ui-entitlement-value tabular">
                          {/*
                            A null limit is a capability with no count — it is
                            on. A number is a real ceiling, shown as a ceiling,
                            and as usage once any has been spent.
                          */}
                          {entitlement.limit === null
                            ? "Included"
                            : entitlement.used > 0
                              ? `${entitlement.used} of ${entitlement.limit} used`
                              : entitlement.limit}
                        </span>
                      </li>
                    );
                  })}
                </ul>

                <p className="ui-hint" style={{ marginTop: 14 }}>
                  {/*
                    Counts reset monthly, and saying so is cheaper than a
                    support message asking when the five come back.
                  */}
                  Monthly counts reset on the first. There is no way to buy more
                  from inside the app yet — get in touch and we will move you.
                </p>
              </>
            )}
          </Card>

          <Card
            title="Your board"
            description="Where every grade, subject and chapter you can reach comes from."
          >
            <BoardCard
              current={{ code: board.code, name: board.name, authored: true }}
              boards={boards.map((option) => ({
                code: option.code,
                name: option.name,
                authored: option.gradeCount > 0,
              }))}
              locked={blockers.total > 0 ? blockers : null}
            />
          </Card>

          <Card title="Your organisation">
            <dl className="ui-facts">
              <dt>Name</dt>
              <dd>{session.organizationName}</dd>
              <dt>Classes</dt>
              <dd className="tabular">{classes.length}</dd>
              <dt>Students</dt>
              <dd className="tabular">{students}</dd>
            </dl>
            <p className="ui-hint" style={{ marginTop: 14 }}>
              {consoleOpen ? (
                <>
                  Invite colleagues and manage the organisation from the{" "}
                  <Link href="/institute">institute console</Link>.
                  {brandingOpen && (
                    <>
                      {" "}
                      Your school&rsquo;s name, logo, colours and letterhead are{" "}
                      <a href="#branding">below</a>.
                    </>
                  )}
                </>
              ) : (
                <>
                  Inviting colleagues and managing the organisation are in the
                  institute console, on plans that include it.
                </>
              )}
            </p>
          </Card>
        </Stack>

        <Stack>
          <Card title="You">
            <dl className="ui-facts">
              <dt>Name</dt>
              <dd>{session.fullName}</dd>
              <dt>Role</dt>
              <dd>{session.actor.role.toLowerCase()}</dd>
            </dl>

            <form
              action="/api/auth/signout/"
              method="post"
              style={{ marginTop: 16 }}
            >
              <button type="submit" className="ui-button" data-variant="secondary">
                <span>Sign out</span>
              </button>
            </form>
          </Card>

          <Card title="Appearance">
            <p style={{ margin: 0, fontSize: 14, color: "var(--text-secondary)" }}>
              Light or dark follows your device unless you choose otherwise. The
              toggle sits beside Sign out — at the bottom of the side menu, or at
              the top of the page on a phone — and the choice is kept on this
              device only.
            </p>
          </Card>

          {session.isPlatformAdmin && (
            <Alert tone="info" title="You are a platform administrator">
              The <Link href="/admin/curriculum">platform console</Link> reaches every
              organisation. Changes there apply to all of them.
            </Alert>
          )}
        </Stack>
      </div>

      {branding?.entitled && (
        <section id="branding" className="ui-settings-branding" aria-labelledby="branding-heading">
          <h2 id="branding-heading" className="ui-section-heading">
            School branding
          </h2>
          <p className="ui-hint">
            Your school&rsquo;s name, logo and colours on every screen your teachers,
            students and parents use, and your letterhead on printed reports.
          </p>
          <BrandingEditor initial={branding} />
        </section>
      )}
    </AppShell>
  );
}

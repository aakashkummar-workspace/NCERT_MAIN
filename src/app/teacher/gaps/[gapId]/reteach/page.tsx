import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { z } from "zod";
import { getSession } from "@/core/identity/context";
import { reteachBrief } from "@/core/gaps/reteach";
import { PrintButton } from "@/app/teacher/reports/PrintButton";
import { AppShell } from "@/ui/AppShell";
import { Alert, Badge, Card, PageHeader, Stack } from "@/ui";

export const metadata: Metadata = { title: "Reteach brief" };
export const dynamic = "force-dynamic";

/**
 * The lesson between a gap and its re-measurement. See core/gaps/reteach.ts.
 *
 * For the teacher only — it names the students who are behind. The worksheet
 * is a separate page, because that one goes to the class.
 */
export default async function ReteachPage({ params }: { params: Promise<{ gapId: string }> }) {
  const session = await getSession();
  if (!session) redirect("/signin");
  const { gapId } = await params;
  if (!z.uuid().safeParse(gapId).success) notFound();

  const brief = await reteachBrief(session.actor.organizationId, gapId);
  if (!brief) notFound();

  const worksheetHref = `/teacher/gaps/${gapId}/reteach/worksheet?q=${brief.worksheetIds.join(",")}`;

  return (
    <AppShell
      currentPath="/teacher/analytics"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        eyebrow={
          <Link href={`/teacher/analytics/${brief.classId}/gaps#gap-${gapId}`}>
            {brief.className} · gaps
          </Link>
        }
        title={`Reteach: ${brief.conceptName}`}
        description={`${brief.affected} of ${brief.measured} measured students below the line, averaging ${Math.round(brief.meanEstimate * 100)}%.`}
        actions={<Badge tone="warning">{brief.severity}</Badge>}
      />

      <div className="ui-reteach-actions">
        <PrintButton />
        {brief.worksheetIds.length > 0 && (
          <Link href={worksheetHref} className="ui-button" data-variant="primary" data-size="md">
            <span>Worksheet ({brief.worksheetIds.length} questions)</span>
          </Link>
        )}
      </div>

      <Stack>
        {brief.rootCause && (
          <Alert tone="warning" title={`Start with ${brief.rootCause.name}`}>
            The class is weak on {brief.rootCause.name} too, and this idea builds on it.
            Teaching that first is likely to be worth more than reteaching this.
          </Alert>
        )}

        <Card title="Where it is in the book">
          {brief.book ? (
            <p style={{ margin: 0 }}>
              <Link href={brief.book.href}>{brief.book.label}</Link>
              {!brief.book.section && (
                <span className="ui-hint">
                  {" "}
                  — the chapter; no single section is clearly this idea.
                </span>
              )}
            </p>
          ) : (
            <p className="ui-hint" style={{ margin: 0 }}>
              This chapter&rsquo;s contents have not been read from the book yet.
            </p>
          )}
        </Card>

        <Card
          title="What secure looks like"
          description="The syllabus's own outcomes for this idea. A student who can do these is there."
        >
          {brief.outcomes.length === 0 ? (
            <p className="ui-hint">No outcomes are linked to this concept.</p>
          ) : (
            <ul className="ui-reteach-list">
              {brief.outcomes.map((outcome) => (
                <li key={outcome}>{outcome}</li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="What they chose"
          description="Wrong answers several students in this class picked on this idea — each one names a specific misunderstanding."
        >
          {brief.misconceptions.length === 0 ? (
            <p className="ui-hint">
              No wrong answer was shared by two or more students, so there is no
              common misunderstanding to name — the class is wrong in different
              ways, or the evidence is from written answers.
            </p>
          ) : (
            <ul className="ui-reteach-list">
              {brief.misconceptions.map((item, index) => (
                <li key={index}>
                  <p style={{ margin: "0 0 4px" }}>{item.stem}</p>
                  <p style={{ margin: 0 }}>
                    <strong className="tabular">
                      {item.students} of {item.answered}
                    </strong>{" "}
                    chose <strong>({item.chosen.key}) {item.chosen.text}</strong>
                    {item.correct && (
                      <span className="ui-hint">
                        {" "}
                        — the answer is ({item.correct.key}) {item.correct.text}
                      </span>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title={`Who (${brief.struggling.length})`}
          description="Below the line on this idea now — not when the gap was first found."
        >
          {brief.struggling.length === 0 ? (
            <p className="ui-hint">Nobody is below the line on current evidence.</p>
          ) : (
            <ul className="ui-reteach-who">
              {brief.struggling.map((student) => (
                <li key={student.studentUserId}>
                  <Link href={`/teacher/students/${student.studentUserId}`}>{student.fullName}</Link>
                  <span className="tabular ui-hint"> {student.percent}%</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Afterwards">
          <p style={{ margin: 0 }}>
            Once it has been retaught, record it and measure it from the{" "}
            <Link href={`/teacher/analytics/${brief.classId}/gaps#gap-${gapId}`}>gap card</Link> — a
            short paper for the students below the line tells you whether it landed.
            {brief.worksheetIds.length === 0 &&
              " There are no approved questions on this idea for a worksheet yet; write or generate some first."}
          </p>
        </Card>
      </Stack>
    </AppShell>
  );
}

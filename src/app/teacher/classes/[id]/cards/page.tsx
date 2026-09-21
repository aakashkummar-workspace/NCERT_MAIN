import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { z } from "zod";
import { getSession } from "@/core/identity/context";
import { getClass } from "@/core/classes";
import { cardStatusForClass } from "@/core/identity/login-cards";
import { brandFor } from "@/app/_branding/surface";
import { AppShell } from "@/ui/AppShell";
import { PageHeader } from "@/ui";
import { CardsPrinter } from "./CardsPrinter";

export const metadata: Metadata = { title: "Sign-in cards" };
export const dynamic = "force-dynamic";

/**
 * Printed sign-in cards for a class. See core/identity/login-cards.ts.
 *
 * The page never shows a code on load, because no code is stored to show. A
 * code exists only in the response to pressing Print, which is why printing
 * is also issuing — and the page says so before anybody presses it.
 */
export default async function ClassCardsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const organizationId = session.actor.organizationId;

  const [klass, status, brand] = await Promise.all([
    getClass(organizationId, id),
    cardStatusForClass(organizationId, id),
    brandFor(organizationId),
  ]);
  if (!klass || !status) notFound();

  const statusOf = new Map(status.map((row) => [row.studentUserId, row]));
  const students = klass.students.map((student) => {
    const card = statusOf.get(student.userId);
    return {
      userId: student.userId,
      fullName: student.fullName,
      rollNumber: student.rollNumber,
      hasPhone: Boolean(student.phone),
      cardHint: card?.hint ?? null,
      cardIssuedAt: card?.issuedAt?.toISOString() ?? null,
      cardLastUsedAt: card?.lastUsedAt?.toISOString() ?? null,
    };
  });

  return (
    <AppShell
      currentPath="/teacher/classes"
      fullName={session.fullName}
      organizationName={session.organizationName}
      breadcrumbs={[
        { label: "Classes", href: "/teacher/classes" },
        { label: klass.name, href: `/teacher/classes/${klass.id}` },
        { label: "Sign-in cards" },
      ]}
    >
      <PageHeader
        eyebrow={<Link href={`/teacher/classes/${klass.id}`}>{klass.name}</Link>}
        title="Sign-in cards"
        description="A printed card lets a student sign in without a phone — on a lab computer, a family phone, or anything with a browser."
      />
      <CardsPrinter
        classId={klass.id}
        className={klass.name}
        schoolName={brand?.name ?? session.organizationName}
        students={students}
      />
    </AppShell>
  );
}

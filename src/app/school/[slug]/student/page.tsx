import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { cache } from "react";
import { getSession } from "@/core/identity/context";
import { publicBrand } from "@/core/branding/public";
import { brandMetadataFor } from "@/app/_branding/surface";
import { createTranslator } from "@/i18n";
import { requestLocale } from "@/i18n/server";
import { StudentSignInView } from "@/app/signin/student/StudentSignInView";

/** A school's own student and parent sign-in page: `/school/<slug>/student`. */

const brandOf = cache((slug: string) => publicBrand(slug));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const brand = await brandOf((await params).slug);
  if (!brand) return {};
  const t = createTranslator(await requestLocale());
  return {
    ...brandMetadataFor(brand),
    title: { absolute: `${t("signin.student.pageTitle")} · ${brand.name}` },
  };
}

export default async function SchoolStudentSignInPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const brand = await brandOf((await params).slug);
  if (!brand) notFound();

  const session = await getSession();
  if (session) {
    redirect(
      session.actor.role === "STUDENT" ? "/student" : session.actor.role === "PARENT" ? "/parent" : "/teacher",
    );
  }

  return <StudentSignInView locale={await requestLocale()} brand={brand} />;
}

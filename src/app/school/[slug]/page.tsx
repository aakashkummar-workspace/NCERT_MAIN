import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { cache } from "react";
import { getSession } from "@/core/identity/context";
import { publicBrand } from "@/core/branding/public";
import { brandMetadataFor } from "@/app/_branding/surface";
import { TeacherSignInView } from "@/app/signin/TeacherSignInView";

/**
 * A school's own sign-in page: `/school/<slug>`.
 *
 * The link a school puts on its website, its WhatsApp group and its circulars,
 * so the first screen a parent or a new teacher sees carries the school's name
 * rather than a product they have never heard of.
 *
 * An unknown slug, an unbranded school and a school whose plan does not include
 * branding all 404, identically — see `core/branding/public.ts`.
 */

const brandOf = cache((slug: string) => publicBrand(slug));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const brand = await brandOf((await params).slug);
  if (!brand) return {};
  const branded = brandMetadataFor(brand);
  // `absolute`, or the root template appends "· Sahayak" to a school's own page.
  return { ...branded, title: { absolute: `Sign in · ${brand.name}` } };
}

export default async function SchoolSignInPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const brand = await brandOf((await params).slug);
  if (!brand) notFound();

  if (await getSession()) redirect("/teacher");

  return <TeacherSignInView brand={brand} />;
}

import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { createTranslator } from "@/i18n";
import { requestLocale } from "@/i18n/server";
import { StudentSignInView } from "./StudentSignInView";

/**
 * The title is translated too, and it is the easiest one to forget.
 *
 * A static `export const metadata` cannot be — it is evaluated without a
 * request — so it becomes `generateMetadata`, which can await the locale. The
 * tab title is the first Hindi word a student sees and the last one anybody
 * checks.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator(await requestLocale());
  return { title: t("signin.student.pageTitle") };
}

/** See `StudentSignInView` for why students sign in this way. */
export default async function StudentSignInPage() {
  const session = await getSession();
  if (session) {
    redirect(
      session.actor.role === "STUDENT" ? "/student" : session.actor.role === "PARENT" ? "/parent" : "/teacher",
    );
  }

  return <StudentSignInView locale={await requestLocale()} brand={null} />;
}

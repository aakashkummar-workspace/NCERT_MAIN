import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { TeacherSignInView } from "./TeacherSignInView";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage() {
  if (await getSession()) redirect("/teacher");

  return <TeacherSignInView brand={null} />;
}

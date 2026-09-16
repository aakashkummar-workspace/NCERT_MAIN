import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { listBoards } from "@/core/curriculum";
import { SignUpForm } from "./SignUpForm";

export const metadata: Metadata = { title: "Create your account" };

export default async function SignUpPage() {
  if (await getSession()) redirect("/teacher");

  // A board with nothing authored under it is listed and disabled rather than
  // hidden: "ICSE, not authored yet" is a real state of this product, and a
  // school that teaches it should see that we know it exists.
  const boards = (await listBoards()).map((board) => ({
    code: board.code,
    name: board.name,
    authored: board.gradeCount > 0,
  }));

  return (
    <div className="ui-auth">
      <div className="ui-auth-panel">
        <div className="ui-auth-inner">
          <div className="ui-brand" style={{ padding: 0, marginBottom: 30 }}>
            <span className="ui-brand-mark" aria-hidden="true">
              S
            </span>
            <span className="ui-brand-name">Sahayak</span>
          </div>

          <h1 className="ui-page-title">Create your account</h1>
          <p className="ui-page-description">
            Free to start. No card needed. You will have a class and your first
            test in about ten minutes.
          </p>

          <SignUpForm boards={boards} />

          <p className="ui-auth-foot">
            Already have an account? <Link href="/signin">Sign in</Link>
          </p>
        </div>
      </div>

      <aside className="ui-auth-aside">
        <div>
          <div className="ui-page-eyebrow">What this is for</div>
          <h2 style={{ fontSize: 21, lineHeight: 1.35, maxWidth: "22ch" }}>
            A mock test tells you a score. This tells you what to teach next.
          </h2>
        </div>

        <div className="ui-loop">
          <div className="ui-loop-step">
            <span className="ui-loop-num">1</span>
            <span>
              <strong>Assess.</strong> Build a test from your board&rsquo;s
              syllabus, or generate one and approve every question yourself.
            </span>
          </div>
          <div className="ui-loop-step">
            <span className="ui-loop-num">2</span>
            <span>
              <strong>Diagnose.</strong> See which concepts your class has
              actually secured — and which ones the numbers cannot yet say.
            </span>
          </div>
          <div className="ui-loop-step">
            <span className="ui-loop-num">3</span>
            <span>
              <strong>Act.</strong> Turn a weak concept into targeted practice
              for the students who need it, in one click.
            </span>
          </div>
          <div className="ui-loop-step">
            <span className="ui-loop-num">4</span>
            <span>
              <strong>Measure.</strong> Re-test and compare against the baseline
              we stamped when you started.
            </span>
          </div>
        </div>
      </aside>
    </div>
  );
}

import Link from "next/link";
import type { PublicBrand } from "@/core/branding/public";
import { BrandMark } from "@/ui/Brand";
import { BrandStyle } from "@/ui/BrandStyle";
import { SignInForm } from "./SignInForm";

/**
 * The staff sign-in page, as Sahayak or as a school.
 *
 * One view for `/signin` and `/school/<slug>`, so the branded page cannot drift
 * into a second sign-in form with its own bugs. What changes with a brand is
 * presentation and where the links go — never how signing in works. The
 * identifier decides which school somebody lands in, exactly as it does on the
 * plain page; the slug in the URL chooses the logo and nothing else.
 */
export function TeacherSignInView({ brand }: { brand: PublicBrand | null }) {
  return (
    <div className="ui-auth">
      <BrandStyle css={brand?.css ?? null} />
      <div className="ui-auth-panel">
        <div className="ui-auth-inner">
          <div className="ui-brand" style={{ padding: 0, marginBottom: 30 }}>
            <BrandMark brand={brand} />
            <span className="ui-brand-name">{brand ? brand.name : "Sahayak"}</span>
          </div>

          <h1 className="ui-page-title">Sign in</h1>
          <p className="ui-page-description">
            Welcome back. Pick up where your class left off.
          </p>

          <SignInForm />

          <p className="ui-auth-foot">
            {/* A school's own page does not offer to create a new organization:
                somebody arriving from St. Mary's link who presses it founds a
                second, empty St. Mary's. */}
            {!brand && (
              <>
                New here? <Link href="/signup">Create an account</Link>
                <br />
              </>
            )}
            Are you a student?{" "}
            <Link href={brand ? `/school/${brand.slug}/student` : "/signin/student"}>
              Sign in with phone OTP
            </Link>
          </p>

          {brand && !brand.hidePoweredBy && <p className="ui-powered-by">Powered by Sahayak</p>}
        </div>
      </div>

      <aside className="ui-auth-aside">
        <div>
          <div className="ui-page-eyebrow">{brand ? brand.name : "Sahayak"}</div>
          <h2 style={{ fontSize: 21, lineHeight: 1.35, maxWidth: "24ch" }}>
            {brand?.tagline ??
              "Assess, find the gaps, practise what matters, measure the improvement."}
          </h2>
          <p
            style={{
              fontSize: 14,
              color: "var(--text-secondary)",
              marginTop: 14,
              maxWidth: "34ch",
            }}
          >
            {brand?.website ? (
              <a href={brand.website} rel="noopener noreferrer">
                {new URL(brand.website).host}
              </a>
            ) : (
              "For Class 9 and 10 teachers."
            )}
          </p>
        </div>
      </aside>
    </div>
  );
}

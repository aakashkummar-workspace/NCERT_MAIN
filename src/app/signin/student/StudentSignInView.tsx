import Link from "next/link";
import { HtmlLang } from "@/i18n/HtmlLang";
import type { PublicBrand } from "@/core/branding/public";
import { CODE_TTL_MS } from "@/core/identity/student-auth";
import { createTranslator } from "@/i18n";
import type { Locale } from "@/i18n/locales";
import { BrandMark } from "@/ui/Brand";
import { BrandStyle } from "@/ui/BrandStyle";
import { StudentSignIn } from "./StudentSignIn";

/**
 * Students sign in with a phone number and a one-time code.
 *
 * No password, deliberately. A fourteen-year-old sharing a family phone will
 * forget one, and a password reset needs an email address most of them do not
 * have. The teacher already holds the phone number on the roster, so the
 * number is the identity we can actually verify.
 *
 * One view for `/signin/student` and `/school/<slug>/student`. A brand changes
 * the name, the colours and where the staff link goes; the code flow is the
 * same component either way, so a school's page cannot sign anybody in
 * differently.
 *
 * ---------------------------------------------------------------------------
 * The worked example for the i18n seam
 * ---------------------------------------------------------------------------
 * This is the first surface to go through `t()`, and it is the right first one
 * for the same reason it has no password: it is where a student who reads
 * Hindi meets this product, before they have an account to hold a preference.
 *
 * `requestLocale()` is called with no stored preference, because a signed-in
 * visitor is redirected before this renders — there is no `User.locale` to
 * read on a sign-in page, by construction. So the `Accept-Language` header
 * decides, which is exactly the case the second rung exists for.
 *
 * ---------------------------------------------------------------------------
 * What a Hindi student actually gets
 * ---------------------------------------------------------------------------
 * A Hindi interface and English questions. Curriculum content is authored by
 * teachers on the shared, locale-free curriculum plane and this seam does not
 * touch it. See the note at the top of `src/i18n/index.ts` — it is a real
 * limitation, not an oversight, and it is not fixed by more plumbing.
 */
export function StudentSignInView({
  locale,
  brand,
}: {
  locale: Locale;
  brand: PublicBrand | null;
}) {
  const t = createTranslator(locale);

  return (
    <div className="ui-auth">
      <BrandStyle css={brand?.css ?? null} />
      <div className="ui-auth-panel">
        <div className="ui-auth-inner">
          <div className="ui-brand" style={{ padding: 0, marginBottom: 30 }}>
            <BrandMark brand={brand} />
            {/* Not translated, and not an omission: a wordmark is the same word
                in every language. See the note in src/i18n/messages/en-IN.ts.
                A school's name is its own wordmark, for the same reason. */}
            <span className="ui-brand-name">{brand ? brand.name : "Sahayak"}</span>
          </div>

          <HtmlLang lang={locale} />
          <h1 className="ui-page-title">{t("signin.title")}</h1>
          <p className="ui-page-description">{t("signin.description")}</p>

          <StudentSignIn
            locale={locale}
            // From the constant the issuer actually uses, never a literal 5.
            // A TTL that changed in one place and not the other would tell a
            // student their code is good for longer than it is.
            codeValidMinutes={Math.round(CODE_TTL_MS / 60_000)}
          />

          <p className="ui-auth-foot">
            {t("signin.teacherPrompt")}{" "}
            <Link href={brand ? `/school/${brand.slug}` : "/signin"}>
              {t("signin.teacherLink")}
            </Link>
          </p>

          {brand && !brand.hidePoweredBy && <p className="ui-powered-by">Powered by Sahayak</p>}
        </div>
      </div>

      <aside className="ui-auth-aside">
        <div>
          <div className="ui-page-eyebrow">{brand ? brand.name : "Sahayak"}</div>
          <h2 style={{ fontSize: 21, lineHeight: 1.35, maxWidth: "24ch" }}>
            {brand?.tagline ?? t("signin.aside.headline")}
          </h2>
          {!brand?.tagline && (
            <p
              style={{
                fontSize: 14,
                color: "var(--text-secondary)",
                marginTop: 14,
                maxWidth: "34ch",
              }}
            >
              {t("signin.aside.subtitle")}
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}

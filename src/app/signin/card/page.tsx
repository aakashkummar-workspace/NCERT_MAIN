import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { getSession } from "@/core/identity/context";
import { CARD_SESSION_MS } from "@/core/identity/login-cards";
import { createTranslator } from "@/i18n";
import { HtmlLang } from "@/i18n/HtmlLang";
import { requestLocale } from "@/i18n/server";
import { BrandMark } from "@/ui/Brand";
import { CardSignIn } from "./CardSignIn";

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator(await requestLocale());
  return { title: t("signin.card.pageTitle") };
}

/**
 * Sign in with a printed card — see core/identity/login-cards.ts.
 *
 * The QR code on a card opens THIS page with the code in the fragment
 * (`/signin/card#K7QM3XPD9W2B`). A fragment never reaches the server, so the
 * code is not in an access log; the form reads it on the device and posts it.
 *
 * A signed-in visitor is NOT redirected here, unlike the phone page. A card is
 * made for a shared computer, and the likeliest person scanning one on a
 * signed-in machine is the next student in the queue — so the page signs the
 * card's owner in, replacing whoever was there, rather than sending them into
 * somebody else's account.
 */
export default async function CardSignInPage() {
  const session = await getSession();
  const locale = await requestLocale();
  const t = createTranslator(locale);
  // A teacher on their own laptop is sent home rather than signed out by a
  // stray scan; only a student session is ever replaced.
  if (session && session.actor.role !== "STUDENT") redirect("/teacher");

  return (
    <div className="ui-auth">
      <div className="ui-auth-panel">
        <div className="ui-auth-inner">
          <div className="ui-brand" style={{ padding: 0, marginBottom: 30 }}>
            <BrandMark brand={null} />
            <span className="ui-brand-name">Sahayak</span>
          </div>

          <HtmlLang lang={locale} />
          <h1 className="ui-page-title">{t("signin.card.pageTitle")}</h1>
          <p className="ui-page-description">{t("signin.card.description")}</p>

          <CardSignIn locale={locale} sessionHours={Math.round(CARD_SESSION_MS / 3_600_000)} />

          <p className="ui-auth-foot">
            <Link href="/signin/student">{t("signin.card.usePhone")}</Link>
          </p>
        </div>
      </div>
      <aside className="ui-auth-aside">
        <div>
          <div className="ui-page-eyebrow">Sahayak</div>
          <h2 style={{ fontSize: 21, lineHeight: 1.35, maxWidth: "24ch" }}>
            {t("signin.aside.headline")}
          </h2>
        </div>
      </aside>
    </div>
  );
}

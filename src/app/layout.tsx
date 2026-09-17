import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { NavigationProgress } from "@/ui/NavigationProgress";
import { Inter, Noto_Sans, Nunito_Sans } from "next/font/google";
import "./globals.css";
import "@/ui/ui.css";
import "@/ui/student.css";
import "@/ui/results.css";
import "@/ui/institute.css";
import "@/ui/report.css";
import "@/ui/paper.css";
import "@/ui/live.css";
import "@/ui/readiness.css";
import "@/ui/webhooks.css";
import "@/ui/voice.css";
import "@/ui/itemstats.css";
import "@/ui/curriculum-review.css";
import "@/ui/syllabus.css";
import "@/ui/question-bank.css";
import "@/ui/landing.css";
import "@/ui/announcements.css";
import "@/ui/branding.css";

/**
 * Inter, self-hosted by next/font. Not a Google Fonts <link>: that is a
 * render-blocking request to a third party on every page load, and students on
 * 3G pay for it. Self-hosting also keeps the font working when a network blocks
 * fonts.gstatic.com, which some school networks do.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

/**
 * The two faces a school's theme may choose instead (core/branding/theme.ts).
 *
 * `preload: false` is the whole cost control. Declaring a face here only emits
 * its @font-face rules; the files are fetched when some element actually uses
 * the family, which happens only on a school that picked it. Preloading would
 * put two unused font downloads on every student's 3G page load.
 */
const notoSans = Noto_Sans({
  subsets: ["latin", "devanagari"],
  display: "swap",
  variable: "--font-noto-sans",
  preload: false,
});

const nunitoSans = Nunito_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-nunito-sans",
  preload: false,
});

export const metadata: Metadata = {
  title: {
    default: "Sahayak",
    template: "%s · Sahayak",
  },
  description:
    "AI assessment and personalised learning for CBSE Class 9 and 10. Assess, find the gaps, practise what matters, measure the improvement.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Never disable zoom. A student reading questions for three hours may need it.
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // English, because every surface but one is rendered in English whatever the
  // browser asks for. Taking this from Accept-Language here would label the
  // whole teacher workspace Hindi for a Hindi-speaking browser — a worse lie
  // than the one it fixes. A page that IS translated corrects it with
  // <HtmlLang> from @/i18n/HtmlLang, from the locale it actually rendered in.
  return (
    <html
      lang="en-IN"
      className={`${inter.variable} ${notoSans.variable} ${nunitoSans.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/*
          Applies the stored theme before first paint. Without this, a viewer
          who chose dark sees a white flash on every navigation. It only ever
          sets or removes one attribute.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('sahayak-theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}`,
          }}
        />
      </head>
      <body>
        {/* Suspense because it reads the search params; it renders nothing until a click. */}
        <Suspense fallback={null}>
          <NavigationProgress />
        </Suspense>
        {children}
      </body>
    </html>
  );
}

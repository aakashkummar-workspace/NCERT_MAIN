import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/core/identity/context";
import { ThemeToggle } from "@/ui/ThemeToggle";
import {
  SparklesIcon,
  CheckIcon,
  ArrowRightIcon,
  BrainIcon,
  TargetIcon,
  ZapIcon,
  BookOpenIcon,
  RefreshCwIcon,
  AwardIcon,
} from "@/ui/icons";
import { InteractiveDemo } from "./InteractiveDemo";
import { CurriculumExplorer } from "./CurriculumExplorer";
import { unstable_cache } from "next/cache";
import { publicCurriculum } from "@/core/curriculum/admin";

/**
 * The public syllabus changes when somebody authors curriculum, not per
 * visitor, and reading it is a full chapter-and-outcome query to a database a
 * network hop away — about a second on every landing-page view. Ten minutes
 * stale on the marketing page is invisible; a second of blank screen is not.
 */
const cachedPublicCurriculum = unstable_cache(publicCurriculum, ["public-curriculum"], {
  revalidate: 600,
});

export default async function Home() {
  const session = await getSession();

  // If already signed in, fast route to their workspace
  if (session) {
    switch (session.actor.role) {
      case "STUDENT":
        redirect("/student");
      case "PARENT":
        redirect("/parent");
      default:
        redirect("/teacher");
    }
  }

  // Read from the curriculum plane, not typed into the page: the chapter lists
  // and outcome counts a visitor sees are the ones the product holds.
  const curriculum = await cachedPublicCurriculum();

  return (
    <div className="ui-landing">
      {/* ---------------- Sticky Header ---------------- */}
      <header className="ui-landing-header">
        <div className="ui-landing-header-inner">
          <Link href="/" className="ui-landing-brand">
            <div className="ui-landing-logo-badge" aria-hidden="true">
              S
            </div>
            <div className="ui-landing-brand-text">
              <span className="ui-landing-brand-title">Sahayak</span>
              <span className="ui-landing-brand-tag">CBSE 9 & 10 · AI Learning</span>
            </div>
          </Link>

          <nav className="ui-landing-nav-links" aria-label="Main Navigation">
            <a href="#how-it-works" className="ui-landing-nav-link">
              How it Works
            </a>
            <a href="#demo" className="ui-landing-nav-link">
              Interactive Demo
            </a>
            <a href="#curriculum" className="ui-landing-nav-link">
              Curriculum
            </a>
            <a href="#pricing" className="ui-landing-nav-link">
              Pricing
            </a>
          </nav>

          <div className="ui-landing-nav-actions">
            <ThemeToggle />
            {/*
              The section links are hidden below 768px, which left a phone with
              no way to reach them. A <details> menu needs no script and works
              with a keyboard: Enter on the summary opens it.
            */}
            <details className="ui-landing-menu">
              <summary className="ui-button" data-variant="secondary" data-size="sm">
                <span>Menu</span>
              </summary>
              <nav className="ui-landing-menu-panel" aria-label="Main navigation, compact">
                <a href="#how-it-works">How it works</a>
                <a href="#demo">Interactive demo</a>
                <a href="#curriculum">Curriculum</a>
                <a href="#pricing">Pricing</a>
                <Link href="/signin">Teacher sign in</Link>
                <Link href="/signin/student">Student or parent sign in</Link>
              </nav>
            </details>
            <Link
              href="/signin"
              className="ui-button ui-landing-signin"
              data-variant="secondary"
              data-size="sm"
            >
              <span>Sign in</span>
            </Link>
            <Link
              href="/signup"
              className="ui-button"
              data-variant="primary"
              data-size="sm"
            >
              <span>Get started</span>
            </Link>
          </div>
        </div>
      </header>

      <main id="main">
        {/* ---------------- Hero Section ---------------- */}
        <section className="ui-landing-hero">
          <div className="ui-landing-hero-inner">
            <div className="ui-landing-pill">
              <SparklesIcon size={14} />
              <span>Assessment is the Diagnostic · Learning is What Follows</span>
            </div>

            <h1 className="ui-landing-h1">
              Personalised CBSE Learning{" "}
              <span className="ui-landing-h1-accent">
                Driven by Measured Evidence
              </span>
            </h1>

            <p className="ui-landing-lead">
              Transform assessments into precision learning for CBSE Class 9 & 10
              Maths and Science. Detect exact conceptual gaps, generate targeted
              remedial papers in one click, and help students master fragile ideas
              with Socratic AI tutoring.
            </p>

            <div className="ui-landing-hero-ctas">
              <Link
                href="/signup"
                className="ui-button"
                data-variant="primary"
                data-size="lg"
              >
                <span>Start Free as a Teacher</span>
                <ArrowRightIcon size={16} />
              </Link>
              <a
                href="#demo"
                className="ui-button"
                data-variant="secondary"
                data-size="lg"
              >
                <span>Try Live Demo Question</span>
              </a>
              <Link
                href="/signin/student"
                className="ui-button"
                data-variant="ghost"
                data-size="lg"
              >
                <span>Student Join by Code</span>
              </Link>
            </div>

            <div className="ui-landing-metrics-strip">
              <div className="ui-landing-metric-item">
                <span className="ui-landing-metric-val">100% CBSE</span>
                <span className="ui-landing-metric-label">Curriculum Aligned</span>
              </div>
              <div className="ui-landing-metric-item">
                <span className="ui-landing-metric-val">5-Band</span>
                <span className="ui-landing-metric-label">Mastery Calibration</span>
              </div>
              <div className="ui-landing-metric-item">
                <span className="ui-landing-metric-val">3-Rung</span>
                <span className="ui-landing-metric-label">Socratic AI Tutor</span>
              </div>
              <div className="ui-landing-metric-item">
                <span className="ui-landing-metric-val">Zero</span>
                <span className="ui-landing-metric-label">Lost Answers Guarantee</span>
              </div>
            </div>
          </div>
        </section>

        {/* ---------------- The Continuous Loop ---------------- */}
        <section id="how-it-works" className="ui-landing-section">
          <div className="ui-landing-section-header">
            <div className="ui-landing-eyebrow">The Pedagogical Engine</div>
            <h2 className="ui-landing-section-title">
              Closing the Loop from Wrong Answer to Proven Mastery
            </h2>
            <p className="ui-landing-section-desc">
              Generic test platforms stop when marks are counted. Sahayak treats
              submission as step one of an intelligent six-stage improvement loop.
            </p>
          </div>

          <div className="ui-landing-stepper-grid">
            <div className="ui-landing-step-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="ui-landing-step-num">1</span>
                <BookOpenIcon size={20} />
              </div>
              <h3 className="ui-landing-step-title">Assess</h3>
              <p className="ui-landing-step-body">
                Teachers assemble balanced blueprint tests from the CBSE question bank
                or generate curriculum-vetted items with the AI draft assistant.
              </p>
            </div>

            <div className="ui-landing-step-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="ui-landing-step-num">2</span>
                <BrainIcon size={20} />
              </div>
              <h3 className="ui-landing-step-title">Diagnose</h3>
              <p className="ui-landing-step-body">
                The evidence ledger evaluates concept mastery per topic. It carries
                confidence intervals and explicitly refuses to show false scores when
                data is sparse.
              </p>
            </div>

            <div className="ui-landing-step-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="ui-landing-step-num">3</span>
                <TargetIcon size={20} />
              </div>
              <h3 className="ui-landing-step-title">Recommend</h3>
              <p className="ui-landing-step-body">
                Automated learning gap detection surfaces specific misconceptions
                across classes and populates a student&apos;s personal Mistake Bank.
              </p>
            </div>

            <div className="ui-landing-step-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="ui-landing-step-num">4</span>
                <ZapIcon size={20} />
              </div>
              <h3 className="ui-landing-step-title">Practise</h3>
              <p className="ui-landing-step-body">
                Untimed practice sets with immediate explanations and a 3-tier AI tutor
                that scaffolds hints and methods without revealing the answer key.
              </p>
            </div>

            <div className="ui-landing-step-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="ui-landing-step-num">5</span>
                <RefreshCwIcon size={20} />
              </div>
              <h3 className="ui-landing-step-title">Reassess</h3>
              <p className="ui-landing-step-body">
                One click builds a calibrated remedial paper scoped precisely to the
                struggling group, stamping baseline mastery before the intervention.
              </p>
            </div>

            <div className="ui-landing-step-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="ui-landing-step-num">6</span>
                <AwardIcon size={20} />
              </div>
              <h3 className="ui-landing-step-title">Measure</h3>
              <p className="ui-landing-step-body">
                Track measured before-and-after improvement. A closed gap is backed by
                verifiable performance data on fresh concept assessments.
              </p>
            </div>
          </div>
        </section>

        {/* ---------------- Interactive Demo ---------------- */}
        <section id="demo" className="ui-landing-section" style={{ background: "var(--surface-raised)", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
          <div className="ui-landing-section-header">
            <div className="ui-landing-eyebrow">Try It Live</div>
            <h2 className="ui-landing-section-title">
              Experience the Diagnostic in Action
            </h2>
            <p className="ui-landing-section-desc">
              Pick an answer to see what a student is shown, and what the product
              does — and does not — conclude from a single response.
            </p>
          </div>

          <InteractiveDemo />
        </section>

        {/* ---------------- Curriculum Explorer ---------------- */}
        <section id="curriculum" className="ui-landing-section">
          <div className="ui-landing-section-header">
            <div className="ui-landing-eyebrow">The CBSE Syllabus</div>
            <h2 className="ui-landing-section-title">
              Built Specifically for Class 9 & 10
            </h2>
            <p className="ui-landing-section-desc">
              Chapters from the current NCERT books, with learning outcomes and the
              concepts mastery is measured on. This is read live from the product.
            </p>
          </div>

          <CurriculumExplorer subjects={curriculum} />
        </section>

        {/* ---------------- Dual Density / Persona Highlights ---------------- */}
        <section className="ui-landing-section" style={{ background: "var(--surface-raised)", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
          <div className="ui-landing-section-header">
            <div className="ui-landing-eyebrow">Tailored Experiences</div>
            <h2 className="ui-landing-section-title">
              One Unified System · Three Thoughtful Densities
            </h2>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 24, maxWidth: 1100, margin: "0 auto" }}>
            <div className="ui-landing-step-card">
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--accent)", textTransform: "uppercase" }}>
                Teacher Workspace
              </span>
              <h3 style={{ fontSize: 20, fontWeight: 700, margin: "4px 0 8px" }}>
                High-Density Command Center
              </h3>
              <p style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                6-step blueprint builder, live submission monitors, student-by-concept
                mastery grids, subjective rubric grading with keyboard shortcuts, and
                an AI copilot that synthesizes class insights.
              </p>
              <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "flex", flexDirection: "column", gap: 8, fontSize: 13.5 }}>
                <li style={{ display: "flex", gap: 8, alignItems: "center" }}><CheckIcon size={16} className="ui-landing-feature-check" /> 15-minute test creation workflow</li>
                <li style={{ display: "flex", gap: 8, alignItems: "center" }}><CheckIcon size={16} className="ui-landing-feature-check" /> One-click remedial paper generation</li>
                <li style={{ display: "flex", gap: 8, alignItems: "center" }}><CheckIcon size={16} className="ui-landing-feature-check" /> Privacy-first: no student PII sent to AI</li>
              </ul>
            </div>

            <div className="ui-landing-step-card">
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--success)", textTransform: "uppercase" }}>
                Student Experience
              </span>
              <h3 style={{ fontSize: 20, fontWeight: 700, margin: "4px 0 8px" }}>
                Calm, Low-Anxiety Player
              </h3>
              <p style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                Distraction-free test player, zero-motion mode during exams, offline
                auto-save resilience on patchy mobile data, and an unhurried Mistake
                Bank with Socratic AI assistance.
              </p>
              <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "flex", flexDirection: "column", gap: 8, fontSize: 13.5 }}>
                <li style={{ display: "flex", gap: 8, alignItems: "center" }}><CheckIcon size={16} className="ui-landing-feature-check" /> Offline queue: zero answers lost</li>
                <li style={{ display: "flex", gap: 8, alignItems: "center" }}><CheckIcon size={16} className="ui-landing-feature-check" /> 3-tier Socratic tutor: hints without spoilers</li>
                <li style={{ display: "flex", gap: 8, alignItems: "center" }}><CheckIcon size={16} className="ui-landing-feature-check" /> Chapter-wise exam readiness visualizer</li>
              </ul>
            </div>

            <div className="ui-landing-step-card">
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--warning)", textTransform: "uppercase" }}>
                Parent & Institute
              </span>
              <h3 style={{ fontSize: 20, fontWeight: 700, margin: "4px 0 8px" }}>
                Plain Language & Oversight
              </h3>
              <p style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                Parents who accept a teacher&rsquo;s invitation see progress by topic and
                released results in plain language — never their child&rsquo;s answers.
                Institutes compare batch performance with denominators attached and no
                toxic teacher league tables.
              </p>
              <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "flex", flexDirection: "column", gap: 8, fontSize: 13.5 }}>
                <li style={{ display: "flex", gap: 8, alignItems: "center" }}><CheckIcon size={16} className="ui-landing-feature-check" /> Single-child or sibling switcher</li>
                <li style={{ display: "flex", gap: 8, alignItems: "center" }}><CheckIcon size={16} className="ui-landing-feature-check" /> Printable term progress report cards</li>
                <li style={{ display: "flex", gap: 8, alignItems: "center" }}><CheckIcon size={16} className="ui-landing-feature-check" /> Multi-batch comparative analytics</li>
              </ul>
            </div>
          </div>
        </section>

        {/* ---------------- Pricing ---------------- */}
        <section id="pricing" className="ui-landing-section">
          <div className="ui-landing-section-header">
            <div className="ui-landing-eyebrow">Predictable Pricing</div>
            <h2 className="ui-landing-section-title">
              Plans Built for Every Scale
            </h2>
            <p className="ui-landing-section-desc">
              Every plan reads the same CBSE Class 9 & 10 syllabus. No hidden fees or
              lock-ins.
            </p>
          </div>

          <div className="ui-landing-pricing-grid">
            <div className="ui-landing-price-card">
              <h3 className="ui-landing-plan-name">Free Starter</h3>
              <p className="ui-landing-plan-desc">
                Ideal for individual teachers starting with one class or tuition batch.
              </p>
              <div className="ui-landing-price-num">
                <span>₹0</span>
                <span className="ui-landing-price-period">/ forever</span>
              </div>
              <ul className="ui-landing-features-list">
                <li className="ui-landing-feature-item">
                  <CheckIcon size={16} className="ui-landing-feature-check" />
                  <span>1 Class (Up to 30 Students)</span>
                </li>
                <li className="ui-landing-feature-item">
                  <CheckIcon size={16} className="ui-landing-feature-check" />
                  <span>Your own question bank, checked on save</span>
                </li>
                <li className="ui-landing-feature-item">
                  <CheckIcon size={16} className="ui-landing-feature-check" />
                  <span>5 AI Question Drafts / mo</span>
                </li>
                <li className="ui-landing-feature-item">
                  <CheckIcon size={16} className="ui-landing-feature-check" />
                  <span>Basic Class Analytics</span>
                </li>
              </ul>
              <Link
                href="/signup"
                className="ui-button"
                data-variant="secondary"
                data-size="md"
              >
                <span>Sign up free</span>
              </Link>
            </div>

            <div className="ui-landing-price-card" data-featured="true">
              <span className="ui-landing-featured-tag">Most Popular</span>
              <h3 className="ui-landing-plan-name">Teacher Pro</h3>
              <p className="ui-landing-plan-desc">
                For active teachers & tutors managing multiple classes and cohorts.
              </p>
              <div className="ui-landing-price-num">
                <span>₹499</span>
                <span className="ui-landing-price-period">/ month</span>
              </div>
              <ul className="ui-landing-features-list">
                <li className="ui-landing-feature-item">
                  <CheckIcon size={16} className="ui-landing-feature-check" />
                  <span>Up to 5 Classes (200 Students)</span>
                </li>
                <li className="ui-landing-feature-item">
                  <CheckIcon size={16} className="ui-landing-feature-check" />
                  <span>100 AI Question Drafts / mo</span>
                </li>
                <li className="ui-landing-feature-item">
                  <CheckIcon size={16} className="ui-landing-feature-check" />
                  <span>1-Click Remedial Gap Intervention</span>
                </li>
                <li className="ui-landing-feature-item">
                  <CheckIcon size={16} className="ui-landing-feature-check" />
                  <span>Student Mistake Bank & Practice</span>
                </li>
                <li className="ui-landing-feature-item">
                  <CheckIcon size={16} className="ui-landing-feature-check" />
                  <span>Printable Term Parent Reports</span>
                </li>
              </ul>
              <Link
                href="/signup"
                className="ui-button"
                data-variant="primary"
                data-size="md"
              >
                <span>Get Started with Pro</span>
              </Link>
            </div>

            <div className="ui-landing-price-card">
              <h3 className="ui-landing-plan-name">Coaching & Institute</h3>
              <p className="ui-landing-plan-desc">
                For tuition centres and schools managing multiple staff members.
              </p>
              <div className="ui-landing-price-num">
                <span>₹99</span>
                <span className="ui-landing-price-period">/ student / mo</span>
              </div>
              <ul className="ui-landing-features-list">
                <li className="ui-landing-feature-item">
                  <CheckIcon size={16} className="ui-landing-feature-check" />
                  <span>Unlimited Teachers & Classes</span>
                </li>
                <li className="ui-landing-feature-item">
                  <CheckIcon size={16} className="ui-landing-feature-check" />
                  <span>Institute Admin Console</span>
                </li>
                <li className="ui-landing-feature-item">
                  <CheckIcon size={16} className="ui-landing-feature-check" />
                  <span>Cross-Batch Comparative Analytics</span>
                </li>
                <li className="ui-landing-feature-item">
                  <CheckIcon size={16} className="ui-landing-feature-check" />
                  <span>Webhook & SMS Integration</span>
                </li>
                <li className="ui-landing-feature-item">
                  <CheckIcon size={16} className="ui-landing-feature-check" />
                  <span>Dedicated Support</span>
                </li>
              </ul>
              <Link
                href="/signup"
                className="ui-button"
                data-variant="secondary"
                data-size="md"
              >
                <span>Contact Institute Sales</span>
              </Link>
            </div>
          </div>
        </section>
      </main>

      {/* ---------------- Footer ---------------- */}
      <footer className="ui-landing-footer">
        <div className="ui-landing-footer-inner">
          <div className="ui-landing-footer-grid">
            <div className="ui-landing-footer-col">
              <div className="ui-landing-brand" style={{ marginBottom: 4 }}>
                <div className="ui-landing-logo-badge" aria-hidden="true" style={{ width: 28, height: 28, fontSize: 14 }}>
                  S
                </div>
                <span className="ui-landing-brand-title">Sahayak</span>
              </div>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, maxWidth: 320 }}>
                AI assessment & personalised learning platform built for CBSE Class 9 & 10
                Mathematics and Science. Grounded in evidence and curriculum pedagogy.
              </p>
            </div>

            <div className="ui-landing-footer-col">
              <div className="ui-landing-footer-heading">Platform</div>
              <a href="#how-it-works" className="ui-landing-footer-link">How it Works</a>
              <a href="#curriculum" className="ui-landing-footer-link">CBSE Curriculum</a>
              <a href="#demo" className="ui-landing-footer-link">Interactive Demo</a>
              <a href="#pricing" className="ui-landing-footer-link">Pricing Plans</a>
            </div>

            <div className="ui-landing-footer-col">
              <div className="ui-landing-footer-heading">Portals</div>
              <Link href="/signin" className="ui-landing-footer-link">Teacher Portal</Link>
              <Link href="/signin/student" className="ui-landing-footer-link">Student Portal</Link>
              <Link href="/signin/student" className="ui-landing-footer-link">Parent Portal</Link>
              <Link href="/institute" className="ui-landing-footer-link">Institute Console</Link>
            </div>

            <div className="ui-landing-footer-col">
              <div className="ui-landing-footer-heading">Standards</div>
              <span className="ui-landing-footer-link">WCAG 2.2 AA Accessible</span>
              <span className="ui-landing-footer-link">Zero Student PII to AI</span>
              <span className="ui-landing-footer-link">Data Resident in India</span>
            </div>
          </div>

          <div className="ui-landing-footer-bottom">
            <span>© {new Date().getFullYear()} Sahayak. Built for CBSE educators and students.</span>
            <span>Designed for Mid-Tier Android & Desktop Browsers</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

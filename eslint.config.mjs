import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/**
 * The Anthropic SDK may only be reached through the AI provider layer, so model
 * routing, budget checks and PII scrubbing cannot be bypassed. The AI layer
 * arrives in slice 11; the rule lands before it does.
 */
const NO_DIRECT_SDK = {
  name: "@anthropic-ai/sdk",
  message:
    "Reach the model through src/ai, never directly. A direct call bypasses model routing, budgets and PII scrubbing at once.",
};

/**
 * The Claude Agent SDK drives a developer's own Claude Code login, which may
 * power local testing and nothing else (src/ai/claude-code.ts). It gets the
 * same fence as the API SDK, for the same reasons plus that one.
 */
const NO_AGENT_SDK = {
  name: "@anthropic-ai/claude-agent-sdk",
  message:
    "Only src/ai/claude-code.ts may use the Agent SDK. It is a local-testing provider behind the gateway, never a way around it.",
};

/**
 * The SMS layer is the same shape of problem as the AI layer: a paid external
 * provider, on a path that must not fail, sending something a regulator has
 * approved the exact wording of.
 *
 * So it gets the same fence. `sendSms()` is the only door: it applies the daily
 * ceiling, writes the ledger row that a support call reads, and never throws.
 * A call around it skips all three, and the third is the one that turns a
 * provider outage into a 500 on the sign-in form.
 */
const NO_DIRECT_SMS = {
  name: "@/sms/provider",
  message:
    "Send through sendSms() in @/sms/gateway. Reaching a provider directly skips the daily ceiling, the ledger, and the guarantee that delivery never throws on the sign-in path.",
};

/**
 * Flat config merges rules last-wins per file, so a later block that sets
 * `no-restricted-imports` REPLACES an earlier one rather than adding to it.
 * Each block below therefore restates the paths it needs — the layering rules
 * and the SDK rule cannot be split across blocks that match the same file.
 */
const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  {
    files: ["src/**/*.{ts,tsx}", "scripts/**/*.ts"],
    ignores: ["src/sms/**"],
    rules: {
      "no-restricted-imports": ["error", { paths: [NO_DIRECT_SDK, NO_AGENT_SDK, NO_DIRECT_SMS] }],
    },
  },
  {
    // ARCHITECTURE.md section 5: a component receives data; it does not fetch it.
    files: ["src/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [NO_DIRECT_SDK, NO_AGENT_SDK, NO_DIRECT_SMS],
          patterns: [
            {
              group: ["@/core/*", "@/core", "@/db/*", "@/db"],
              message:
                "src/ui must not import business logic or the database. A component receives data; it does not fetch it.",
            },
          ],
        },
      ],
    },
  },
  {
    // Business logic does not know about React or routing.
    files: ["src/core/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [NO_DIRECT_SDK, NO_AGENT_SDK, NO_DIRECT_SMS],
          patterns: [
            {
              group: ["@/app/*", "@/app", "@/ui/*", "@/ui"],
              message:
                "src/core must not import routes or components. Business logic does not know about React.",
            },
          ],
        },
      ],
    },
  },
  {
    // src/db/unscoped.ts is the only sanctioned pre-tenant read path; every
    // other module reaches tenant data through withTenant().
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/db/**",
      "src/core/identity/**",
      "src/core/roster/**",
      // The curriculum plane is global and has no tenant to scope by.
      "src/core/curriculum/**",
      // Plans and entitlements are on that same global plane: no
      // organization_id, readable by all, writable only by the platform role.
      "src/core/billing/plans.ts",
      // The platform console holds the same connection for the opposite
      // reason: it needs a READ across every tenant. Its policies are select
      // only, and it reaches three tables that carry no student work.
      "src/core/platform/**",
      // The sweep must visit every tenant, so it is the one module allowed to
      // ask which tenants exist. It still does the work inside withTenant().
      "src/core/attempts/sweep.ts",
      // Same for the mastery refresh: the estimate decays with the clock, so
      // the job has to reach tenants nobody has touched today.
      "src/core/mastery/sync.ts",
      // A parent invitation is opened by somebody with no session, so resolving
      // its token is a pre-tenant read — the same seam as sign-in, answered by
      // the same kind of narrow SECURITY DEFINER function.
      "src/core/parent/link.ts",
      // And the nightly mistake typing, for the same reason: it has to find
      // the tenants holding unclassified rows before it can classify any.
      "src/core/mistakes/sync.ts",
      // The fourth scheduled job: webhook delivery has to find the tenants
      // holding queued events before it can deliver any. Listed here rather
      // than left as an eslint-disable comment, because a disable is invisible
      // to anybody reading this list to find out who may enumerate tenants —
      // which is the only reason the list exists.
      "src/core/jobs/tenants.ts",
      // The question-library sweep: it has to find the CBSE schools still
      // waiting for the library before it can copy anything into one.
      "src/core/library/sync.ts",
      // The weekly WhatsApp digest: it has to find the schools with a parent
      // who asked for one before it can build any.
      "src/core/digest/jobs.ts",
      // A school's branded sign-in page is shown to somebody with no session,
      // so its name, colours and logo are a pre-tenant read — exact slug in,
      // the columns the page draws out, nothing about the school's work.
      "src/core/branding/public.ts",
      // Cross-school concept benchmarks. The answer IS an aggregate over every
      // tenant, which tenant-by-tenant work cannot produce for a page load, so
      // this module holds the third cross-tenant seam — @/db/benchmarks, whose
      // one read returns a median and two counts and has no column that could
      // name a school. It still writes each school's own contribution inside
      // withTenant().
      "src/core/benchmarks/**",
      // The SMS ledger. A student asking for a sign-in code has no tenant yet —
      // the code is what will eventually tell us which one — so its row belongs
      // to nobody and the tenant policy rightly refuses to let the app role
      // write it. Sign-in's ordering problem, answered by the same seam.
      "src/sms/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            NO_DIRECT_SMS,
            NO_DIRECT_SDK,
            NO_AGENT_SDK,
            {
              name: "@/db/unscoped",
              message:
                "Unscoped reads bypass row-level security. Only src/core/identity and src/core/roster may use them; everything else goes through withTenant().",
            },
            {
              name: "@/db/client",
              message:
                "Use withTenant() from @/db/tenant so the query runs inside a tenant-scoped transaction.",
            },
            {
              name: "@/db/platform",
              message:
                "The platform connection can write the shared curriculum and read across every tenant. Only src/core/curriculum/admin.ts and src/core/platform may hold it.",
            },
            {
              name: "@/db/maintenance",
              message:
                "Cross-tenant enumeration is for scheduled jobs only. Only the scheduled jobs may hold it — see the files list above; everything else goes through withTenant().",
            },
            {
              name: "@/db/benchmarks",
              message:
                "The cross-school read crosses every tenant. Only src/core/benchmarks may hold it; everything else goes through withTenant().",
            },
          ],
        },
      ],
    },
  },
  {
    // src/ai/anthropic.ts IS the provider — the one file allowed to hold the
    // SDK. Everything else, including the rest of src/ai, reaches the model
    // through the gateway.
    //
    // Last, and it restates the database paths: flat config merges last-wins
    // per rule, so this block REPLACES the earlier no-restricted-imports rather
    // than subtracting from it. Dropping the paths here would quietly let the
    // provider reach the database.
    files: ["src/ai/anthropic.ts", "src/ai/claude-code.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            NO_DIRECT_SMS,
            {
              name: "@/db/client",
              message:
                "The provider talks to a model, never to the database. Ledger writes belong in the gateway.",
            },
            {
              name: "@/db/unscoped",
              message: "Unscoped reads bypass row-level security.",
            },
            {
              name: "@/db/platform",
              message: "The platform connection writes the shared curriculum.",
            },
            {
              name: "@/db/benchmarks",
              message: "The cross-school read crosses every tenant.",
            },
          ],
        },
      ],
    },
  },
  {
    // ------------------------------------------------------------------
    // The parent scope boundary, made structural
    // ------------------------------------------------------------------
    // DOMAIN_MODEL.md: a parent's scope is "read-only, restricted to
    // performance data. Tutor conversations, mistake-bank contents and
    // free-text answers are outside it."
    //
    // Left as a sentence in a document, that rule survives about two features.
    // So the parent surface reaches student data through ONE module —
    // src/core/parent/read.ts, which returns no free text and has no argument
    // that could make it — and importing any other reader here fails the build.
    //
    // The reason is not compliance theatre: a child who believes a parent reads
    // every question they ask stops asking questions, which costs the child the
    // help and the product the feature in one move.
    //
    // This block RESTATES the database paths. Flat config merges last-wins per
    // rule, so it replaces the earlier no-restricted-imports for these files
    // rather than adding to it — dropping them here would quietly hand the
    // parent routes a direct client.
    files: ["src/app/parent/**/*.{ts,tsx}", "src/app/api/parent/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            NO_DIRECT_SMS,
            NO_DIRECT_SDK,
            NO_AGENT_SDK,
            {
              name: "@/db/client",
              message:
                "Parent routes read through core/parent/read.ts, never directly.",
            },
            {
              name: "@/db/unscoped",
              message: "Unscoped reads bypass row-level security.",
            },
            {
              name: "@/db/platform",
              message: "The platform connection reads across every tenant.",
            },
            {
              name: "@/db/maintenance",
              message: "Cross-tenant enumeration is for scheduled jobs only.",
            },
            {
              name: "@/db/benchmarks",
              message:
                "The cross-school read crosses every tenant. A parent surface has no business holding it.",
            },
            {
              name: "@/db/tenant",
              message:
                "A parent route does not open its own transaction. Everything it may read is in core/parent/read.ts, and a query written here is a query outside the scope boundary.",
            },
          ],
          patterns: [
            {
              group: [
                "@/core/mistakes",
                "@/core/mistakes/*",
                "@/core/practice",
                "@/core/practice/*",
                "@/core/tutor",
                "@/core/tutor/*",
                // A student's saved questions are their own, and
                // `announcementsForStudent` takes a student id and checks no
                // consent — neither belongs on a parent surface.
                "@/core/saved",
                "@/core/saved/*",
                "@/core/announcements",
                "@/core/announcements/*",
              ],
              message:
                "The mistake bank, practice, the tutor and saved questions are outside the parent scope. A child who believes a parent reads every question they ask, and every time they asked for help, stops asking.",
            },
            {
              group: [
                "@/core/attempts",
                "@/core/attempts/*",
                "@/core/results",
                "@/core/results/*",
              ],
              message:
                "These carry free-text answers and per-question detail, which are outside the parent scope. Performance data comes from core/parent/read.ts.",
            },
            {
              group: ["@/core/reports", "@/core/reports/*"],
              message:
                "A parent reads reports through core/parent/read.ts, which checks consent on the child the report is about. core/reports takes a studentUserId and checks none — a reportId is not a capability.",
            },
            {
              group: [
                "@/core/analytics",
                "@/core/analytics/*",
                "@/core/gaps",
                "@/core/gaps/*",
              ],
              message:
                "Class-level analytics and other students' gaps are not a parent's to read. core/parent/read.ts returns one child's own figures.",
            },
          ],
        },
      ],
    },
  },
];

export default config;

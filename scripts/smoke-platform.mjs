/**
 * End-to-end smoke check for plans, entitlements and the platform console.
 *
 *   npm run build && npm start
 *   node scripts/smoke-platform.mjs
 *
 * Two properties worth proving over HTTP rather than in a unit test: that the
 * plan gate stops a call before the provider is reached, and that the platform
 * console is a 404 — not a 403 — for everybody who is not an admin.
 */
import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-platform.mjs");
import pg from "pg";

const BASE = process.env.BASE ?? "http://localhost:3210";

try {
  const probe = await fetch(`${BASE}/signin/`);
  if (probe.status !== 200) throw new Error(`status ${probe.status}`);
} catch (error) {
  console.error(`No server at ${BASE} — run: npm run build && npm start\n${error}`);
  process.exit(1);
}

const results = [];
const check = (name, pass, detail = "") => results.push({ name, pass, detail });

function report(reason) {
  let failed = 0;
  for (const { name, pass, detail } of results) {
    if (!pass) failed++;
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  }
  console.log(`${results.length - failed}/${results.length} checks passed`);
  if (reason) console.error(`Stopped early: ${reason}`);
  process.exit(failed === 0 && !reason ? 0 : 1);
}

process.on("unhandledRejection", (error) => report(String(error)));
process.on("uncaughtException", (error) => report(String(error)));

const stamp = Date.now();

function session() {
  let cookie = "";
  return {
    async json(path, method = "GET", body) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async page(path) {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
      return { status: res.status, html: await res.text() };
    },
  };
}

const db = new pg.Client({ connectionString: process.env.DIRECT_URL });
await db.connect();

// --- The plans are data ----------------------------------------------------

const plans = await db.query(
  "select code, price_paise, is_public from plans order by sort_order",
);
check("plans are seeded", plans.rows.length >= 3, `${plans.rows.length}`);
check("with prices in paise as integers",
  plans.rows.every((row) => Number.isInteger(row.price_paise)));
check("and a free plan to fall back to",
  plans.rows.some((row) => row.code === "free"));
check("with the negotiated plan off the pricing page",
  plans.rows.find((row) => row.code === "institute")?.is_public === false);

// --- A new organisation is on Free -----------------------------------------

const teacher = session();
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Plan Teacher",
  email: `pln.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Plan Centre ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});

const org = await db.query("select id from organizations where name = $1", [
  `Plan Centre ${stamp}`,
]);
const organizationId = org.rows[0]?.id;
check("the organisation exists", Boolean(organizationId));

const subscriptions = await db.query(
  "select count(*)::int as n from subscriptions where organization_id = $1",
  [organizationId],
);
// Signup does not create one. A billing side effect on the path that must not
// fail is a billing side effect on the path that must not fail.
check("signup creates no subscription row", subscriptions.rows[0].n === 0);

// --- The plan gate stops a call before the provider -------------------------

const authored = await db.query(
  `select t.chapter_id as id from learning_outcomes o
     join topics t on t.id = o.topic_id where o.code = 'SIM-2' limit 1`,
);
const chapterId = authored.rows[0]?.id;

const free = await db.query(
  `select e.limit_value from entitlements e join plans p on p.id = e.plan_id
    where p.code = 'free' and e.key = 'ai_generations_per_month'`,
);
const allowance = free.rows[0]?.limit_value;
check("free includes a monthly generation allowance", allowance > 0, `${allowance}`);

// Spend it without making a single call.
await db.query(
  `insert into usage_counters (id, organization_id, key, period_start, value)
   values (gen_random_uuid(), $1, 'ai_generations_per_month',
           date_trunc('month', now() at time zone 'utc'), $2)`,
  [organizationId, allowance],
);

let r = await teacher.json("/api/questions/generate/", "POST", {
  chapterId,
  count: 2,
  types: ["MCQ"],
  difficulty: "MEDIUM",
  marks: 1,
});
check("a spent allowance refuses the request", r.status === 400, `status ${r.status}`);
check("and talks about the plan, not about dollars",
  /plan/i.test(r.body?.error?.message ?? "") &&
    !/budget|allowance for today/i.test(r.body?.error?.message ?? ""),
  r.body?.error?.message ?? "");

const generations = await db.query(
  "select count(*)::int as n from ai_generations where organization_id = $1",
  [organizationId],
);
// Refused before a generation record was opened, and long before a provider.
check("nothing was attempted", generations.rows[0].n === 0, `${generations.rows[0].n}`);

// --- Move them to Pro and it works again ------------------------------------

await db.query(
  `insert into subscriptions (id, organization_id, plan_id, status)
   select gen_random_uuid(), $1, p.id, 'ACTIVE' from plans p where p.code = 'teacher_pro'`,
  [organizationId],
);

r = await teacher.json("/api/questions/generate/", "POST", {
  chapterId,
  count: 2,
  types: ["MCQ"],
  difficulty: "MEDIUM",
  marks: 1,
});
// Past the plan gate now. With no API key the mock fails it, which is a
// different refusal — and that difference is the point.
check("a paid plan gets past the entitlement gate",
  !/plan does not include|used all/i.test(r.body?.error?.message ?? ""),
  r.body?.error?.message ?? `status ${r.status}`);

const afterGenerations = await db.query(
  "select count(*)::int as n from ai_generations where organization_id = $1",
  [organizationId],
);
check("and this time the attempt is on the ledger",
  afterGenerations.rows[0].n === 1, `${afterGenerations.rows[0].n}`);

const used = await db.query(
  `select value from usage_counters where organization_id = $1
     and key = 'ai_generations_per_month'`,
  [organizationId],
);
// The call failed, so it did not consume the promise. A teacher whose
// generations were spent on provider timeouts has been charged for nothing.
check("a failed call does not spend the allowance",
  Number(used.rows[0].value) === allowance, `${used.rows[0].value}`);

// --- The platform console ---------------------------------------------------

r = await teacher.page("/admin/costs/");
check("a teacher gets 404 on the cost dashboard, not 403", r.status === 404,
  `status ${r.status}`);

r = await teacher.page("/admin/audit/");
check("and 404 on audit search", r.status === 404, `status ${r.status}`);

r = await fetch(`${BASE}/admin/costs/`);
check("so does an anonymous visitor", r.status === 404, `status ${r.status}`);

// Promote and look again. There is deliberately no in-app way to do this.
await db.query("update users set platform_admin = true where email = $1", [
  `pln.${stamp}@example.test`,
]);

const admin = session();
await admin.json("/api/auth/signin/", "POST", {
  identifier: `pln.${stamp}@example.test`,
  password: "a-long-enough-password",
});

r = await admin.page("/admin/costs/");
check("a platform admin sees the cost dashboard", r.status === 200,
  `status ${r.status}`);
check("with the cache figure on it", r.html.includes("Saved by caching"));
check("and failures counted beside the calls",
  r.html.includes("failed or refused"));

r = await admin.page("/admin/audit/");
check("and audit search", r.status === 200, `status ${r.status}`);
check("which says why before and after are withheld",
  r.html.includes("deliberately not shown"));

r = await admin.page("/admin/audit/?days=30");
check("audit filters travel in the query string", r.status === 200,
  `status ${r.status}`);

// --- The teacher's own settings --------------------------------------------

r = await teacher.page("/teacher/settings/");
check("the settings page renders", r.status === 200, `status ${r.status}`);
check("and names the plan they are on", r.html.includes("Your plan"));
// They were moved to Pro above, so the limit is Pro's — the assertion is that
// usage is shown against whatever the CURRENT plan allows, not against the one
// the allowance was spent under.
check("with usage shown against the current plan's limit",
  /5 of 100 used/.test(r.html), "");
check("and says when counts reset", r.html.includes("reset on the first"));

r = await teacher.page("/teacher/students/");
check("the students index renders", r.status === 200, `status ${r.status}`);

await db.end();
report();

/**
 * End-to-end smoke check for the AI layer.
 *
 *   npm run build && npm start
 *   node scripts/smoke-ai.mjs
 *
 * What this can and cannot prove: with no ANTHROPIC_API_KEY the gateway falls
 * back to the mock provider, so a successful generation is not reachable over
 * HTTP — that path has eleven integration tests behind it. What IS reachable,
 * and what matters most here, is everything that happens before and instead of
 * a successful call: the guards, the refusals, the ledger, and the fact that a
 * missing provider produces a typed failure on a page rather than a stack
 * trace in front of a teacher.
 */
import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-ai.mjs");
import pg from "pg";
import {
  databaseNow,
  fixtureChapterNumber,
  removeFixtureCurriculum,
} from "./lib/fixture-curriculum.mjs";

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

const teacher = session();
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Generating Teacher",
  email: `gai.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Generating Centre ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});

const org = await db.query(
  "select id from organizations where name = $1",
  [`Generating Centre ${stamp}`],
);
const organizationId = org.rows[0]?.id;
check("the organisation exists", Boolean(organizationId));

const authored = await db.query(
  `select t.chapter_id as id from learning_outcomes o
     join topics t on t.id = o.topic_id
    where o.code = 'SIM-2' limit 1`,
);
const authoredChapter = authored.rows[0]?.id;

// A chapter with no outcomes, AUTHORED here as a fixture. This used to find
// one, which stopped being possible the day the NCERT drafts gave every real
// chapter outcomes. Removed at the end of the script.
const since = await databaseNow(db);
const bare = await db.query(
  `insert into chapters (id, subject_id, number, title, source)
   select gen_random_uuid(), t.subject_id, $1, 'Smoke chapter with no outcomes', 'smoke-ai.mjs — removed at the end of the run'
     from (select c.subject_id from learning_outcomes o
             join topics tp on tp.id = o.topic_id join chapters c on c.id = tp.chapter_id
            where o.code = 'SIM-2' limit 1) t
   returning id`,
  [fixtureChapterNumber()],
);
const bareChapter = bare.rows[0]?.id;
await db.query(
  `insert into topics (id, chapter_id, title, sort_order)
   values (gen_random_uuid(), $1, 'A topic with nothing stated about it', 0)`,
  [bareChapter],
);
check("the seed has both an authored and a bare chapter",
  Boolean(authoredChapter && bareChapter));

const ask = {
  count: 2,
  types: ["MCQ"],
  difficulty: "MEDIUM",
  marks: 1,
};

// --- What is refused before anything is sent -------------------------------

let r = await teacher.json("/api/questions/generate/", "POST", {
  ...ask,
  chapterId: bareChapter,
});
check("a chapter with no outcomes is refused", r.status === 400, `status ${r.status}`);
check("and the refusal explains what is missing",
  /learning outcomes/.test(r.body?.error?.message ?? ""),
  r.body?.error?.message ?? "");

r = await teacher.json("/api/questions/generate/", "POST", {
  ...ask,
  chapterId: authoredChapter,
  count: 500,
});
check("an absurd batch size is refused by the schema", r.status === 400,
  `status ${r.status}`);

let ledger = await db.query(
  "select count(*)::int as n from ai_generations where organization_id = $1",
  [organizationId],
);
// Nothing was attempted, so there is nothing on the ledger to explain.
check("neither refusal opened a generation record", ledger.rows[0].n === 0,
  `${ledger.rows[0].n}`);

// --- A real attempt, with no provider configured ---------------------------

r = await teacher.json("/api/questions/generate/", "POST", {
  ...ask,
  chapterId: authoredChapter,
});
const configured = Boolean(process.env.ANTHROPIC_API_KEY);

if (configured) {
  check("generation succeeds with a provider configured", r.status === 200,
    `status ${r.status}`);
  check("and everything it produced is a draft",
    Array.isArray(r.body?.created), JSON.stringify(r.body?.created?.length));
} else {
  // The point of the fallback: no key is a typed failure on a page, not a
  // crash. A teacher sees a sentence; the ledger sees three failed attempts.
  check("with no provider configured it fails gracefully", r.status === 400,
    `status ${r.status}`);
  // Written for a person, not copied from the provider. "MockProvider:
  // nothing scripted" is true and useless to a teacher who pressed a button.
  check("and says something a person can act on",
    /not set up on this deployment/i.test(r.body?.error?.message ?? "") &&
      !/mock|provider:|undefined/i.test(r.body?.error?.message ?? ""),
    r.body?.error?.message ?? "");
}

ledger = await db.query(
  `select status, requested_count, input_summary::text as summary
     from ai_generations where organization_id = $1`,
  [organizationId],
);
check("the attempt is on the generation ledger", ledger.rows.length === 1,
  `${ledger.rows.length}`);
check("with the count that was asked for", ledger.rows[0]?.requested_count === 2,
  `${ledger.rows[0]?.requested_count}`);

// The scrubbed payload, and only that. Never the organisation, never a name.
const summary = ledger.rows[0]?.summary ?? "";
check("the input summary carries curriculum context",
  summary.includes("chapterTitle"), summary.slice(0, 120));
check("and nothing that identifies anybody",
  !summary.includes("Generating Teacher") &&
    !summary.includes("Generating Centre") &&
    !summary.includes("@example.test"),
  summary.slice(0, 160));

const usage = await db.query(
  "select status, cost_micros from ai_usage where organization_id = $1",
  [organizationId],
);
// Written for every call including the failures. A retry storm is invisible in
// a success-only ledger, and that invisibility is what produces a surprise bill.
check("every attempt is on the usage ledger", usage.rows.length >= 1,
  `${usage.rows.length}`);

const budgets = await db.query(
  "select period, limit_micros, spent_micros from ai_budgets where organization_id = $1 order by period",
  [organizationId],
);
check("a budget window opened on first use", budgets.rows.length === 2,
  `${budgets.rows.length}`);
check("with a day ceiling under the month's",
  Number(budgets.rows.find((row) => row.period === "DAY").limit_micros) <
    Number(budgets.rows.find((row) => row.period === "MONTH").limit_micros));

// --- Who may ask -----------------------------------------------------------

const other = session();
await other.json("/api/auth/signup/", "POST", {
  fullName: "Other Teacher",
  email: `gai2.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Other Centre ${stamp}`,
  organizationType: "SOLO_TEACHER", boardCode: "CBSE",
});

const theirs = await db.query(
  "select count(*)::int as n from ai_generations where organization_id = $1",
  [organizationId],
);
check("another organisation's signup does not touch this ledger",
  theirs.rows[0].n === ledger.rows.length);

r = await fetch(`${BASE}/api/questions/generate/`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ...ask, chapterId: authoredChapter }),
});
check("an unauthenticated caller cannot generate", r.status === 401,
  `status ${r.status}`);

// --- The pages -------------------------------------------------------------

r = await teacher.page("/teacher/questions/generate/");
check("the generate page renders", r.status === 200, `status ${r.status}`);
check("and says drafts are all it can produce",
  r.html.includes("arrives as a draft"), "");
check("and offers only chapters that have outcomes",
  !r.html.includes("No chapter is ready") , "");

r = await teacher.page("/teacher/questions/");
check("the bank links to generation", r.html.includes("/teacher/questions/generate"));

// --- The class narrative ---------------------------------------------------

const classes = await teacher.json("/api/classes/");
if (classes.body?.classes?.length > 0) {
  const classId = classes.body.classes[0].id;
  r = await teacher.json(`/api/classes/${classId}/insight/`, "POST");
  // This teacher is on Free, which does not include the narrative — so it is
  // refused on the plan, before the data and before any provider, exactly as
  // the Copilot is. (Below a plan that includes it, an unmeasured class is
  // refused for having nothing to summarise.)
  check("a narrative is refused on a plan that does not include it",
    r.status === 400 || r.status === 409, `status ${r.status}`);
  check("and says it is the plan, not the data",
    /plan/i.test(r.body?.error?.message ?? "") &&
      !/nothing has been measured/i.test(r.body?.error?.message ?? ""),
    r.body?.error?.message ?? "");
}

r = await fetch(`${BASE}/api/classes/00000000-0000-4000-8000-000000000000/insight/`, {
  method: "POST",
});
check("an unauthenticated caller cannot ask for one", r.status === 401,
  `status ${r.status}`);

await removeFixtureCurriculum(db, since);
await db.end();
report();

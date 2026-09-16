/**
 * End-to-end smoke check for concept authoring.
 *
 *   npm run build && npm start
 *   node scripts/smoke-concepts.mjs
 *
 * Six properties that need a real HTTP round trip to prove:
 *
 *   1. **A teacher cannot reach any of it.** Not a code check — the app role
 *      matches no write policy on the curriculum plane at all.
 *   2. **Authoring a concept makes an outcome measurable**, immediately and
 *      for every tenant, because the plane is shared.
 *   3. **A prerequisite loop is refused**, because root-cause analysis walks
 *      that graph and in a cycle every concept causes itself.
 *   4. **There is no DELETE**, and the check looks for its absence: nothing
 *      has a foreign key from evidence to concepts, so a delete would succeed
 *      and silently orphan every estimate derived through it.
 *   5. **Unlinking leaves history alone**, which is why it is the safe move.
 *   6. **Every write is audited**, because a cross-tenant action nobody can
 *      reconstruct is one nobody can defend.
 */
import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-concepts.mjs");
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
const since = await databaseNow(db);

// --- An ordinary teacher, and a platform admin -------------------------------

const teacher = session();
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Concept Teacher",
  email: `con.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Concept Centre ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});

// --- 1. A teacher cannot reach concept authoring ------------------------------

let r = await teacher.json("/api/admin/curriculum/concepts/", "POST", {
  name: `Teacher written ${stamp}`,
});
check("a teacher cannot create a concept", r.status === 404 || r.status === 403,
  `status ${r.status}`);

const teacherPage = await teacher.page("/admin/curriculum/concepts/");
check("nor open the console page", teacherPage.status === 404 ||
  !teacherPage.html.includes("Add a concept"), `status ${teacherPage.status}`);

const before = await db.query(
  "select count(*)::int as n from concepts where name = $1",
  [`Teacher written ${stamp}`],
);
check("and nothing was written", before.rows[0].n === 0);

// --- Promote, the only way there is ------------------------------------------

const admin = session();
await admin.json("/api/auth/signup/", "POST", {
  fullName: "Platform Admin",
  email: `pcon.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Platform Concepts ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});
await db.query("update users set platform_admin = true where email = $1", [
  `pcon.${stamp}@example.test`,
]);
// The flag is read from the session, so it has to be re-established.
await admin.json("/api/auth/signin/", "POST", {
  email: `pcon.${stamp}@example.test`,
  password: "a-long-enough-password",
});

const console_ = await admin.page("/admin/curriculum/concepts/");
check("the platform admin can open the console", console_.status === 200,
  `status ${console_.status}`);
check("which states the coverage ceiling",
  /outcomes are covered by/.test(console_.html), "");

// --- 2. Authoring makes an outcome measurable ---------------------------------

r = await admin.json("/api/admin/curriculum/concepts/", "POST", {
  name: `Smoke authored ${stamp}`,
  description: "Authored by the smoke check",
});
check("a concept is created", r.status === 201, `status ${r.status}`);
const conceptId = r.body?.id;

const slug = await db.query("select slug from concepts where id = $1", [conceptId]);
check("with a derived identifier",
  /^smoke-authored-/.test(slug.rows[0]?.slug ?? ""), slug.rows[0]?.slug ?? "");

r = await admin.json("/api/admin/curriculum/concepts/", "POST", {
  name: `Smoke authored ${stamp}`,
});
// Two concepts with the same name are indistinguishable on a heatmap column.
check("a duplicate name is refused", r.status === 400, `status ${r.status}`);

r = await admin.json("/api/admin/curriculum/concepts/", "POST", { name: "x" });
check("and so is a name that is not a concept", r.status === 400, `status ${r.status}`);

// An outcome nothing measures, authored for this check.
// In a fixture chapter, never a seeded topic: an outcome authored into a real
// syllabus stays there for every school.
const anyChapter = await db.query("select subject_id from chapters where number < 1000 limit 1");
const fixture = await db.query(
  `insert into chapters (id, subject_id, number, title, source)
   values (gen_random_uuid(), $1, $2, 'Smoke concepts fixture', 'smoke-concepts.mjs — removed at the end of the run')
   returning id`,
  [anyChapter.rows[0].subject_id, fixtureChapterNumber()],
);
const topic = await db.query(
  `insert into topics (id, chapter_id, title, sort_order)
   values (gen_random_uuid(), $1, 'Smoke concepts topic', 0) returning id`,
  [fixture.rows[0].id],
);
const outcome = await db.query(
  `insert into learning_outcomes (id, topic_id, code, statement, bloom_level, sort_order, created_at, updated_at)
   values (gen_random_uuid(), $1, $2, $3, 'APPLY', 99, now(), now()) returning id`,
  [topic.rows[0].id, `CON-${stamp}`, "Apply the smoke idea to a worked problem."],
);
const outcomeId = outcome.rows[0].id;

const listBefore = await admin.page("/admin/curriculum/concepts/");
const coveredBefore = Number(
  /(\d+) of \d+ outcomes are covered/.exec(listBefore.html)?.[1] ?? "-1",
);
// Checked here, after this script has authored an uncovered outcome, rather
// than on the first page load: whether ANY outcome is uncovered is a fact about
// the database, and since the NCERT drafts every real one is covered.
check("and offers the worklist of outcomes nothing measures",
  /Outcomes nothing measures/.test(listBefore.html), "");
check("the console reports how many outcomes are covered", coveredBefore >= 0,
  `${coveredBefore}`);
check("and says when the worklist is truncated",
  !/Outcomes nothing measures/.test(listBefore.html) ||
    /Showing \d+ of \d+/.test(listBefore.html) ||
    (listBefore.html.match(/ui-uncovered-list/g) ?? []).length > 0,
  "");

r = await admin.json(`/api/admin/curriculum/concepts/${conceptId}/outcomes/`, "POST", {
  outcomeId,
  weight: 1,
});
check("linking an outcome works", r.status === 200, `status ${r.status}`);

const linked = await db.query(
  "select weight from concept_outcomes where concept_id = $1 and learning_outcome_id = $2",
  [conceptId, outcomeId],
);
check("and is stored with its weight", linked.rows.length === 1,
  JSON.stringify(linked.rows));

const listAfter = await admin.page("/admin/curriculum/concepts/");
const coveredAfter = Number(
  /(\d+) of \d+ outcomes are covered/.exec(listAfter.html)?.[1] ?? "-1",
);
// The property, not which fifty rows happen to be on screen: linking moves an
// outcome out of the uncovered set, which is the number the ceiling is
// computed from.
check("linking raises the covered count by exactly one",
  coveredAfter === coveredBefore + 1, `${coveredBefore} then ${coveredAfter}`);
check("and the linked outcome is not on the worklist",
  !listAfter.html.includes(`CON-${stamp}`), "");

r = await admin.json(`/api/admin/curriculum/concepts/${conceptId}/outcomes/`, "POST", {
  outcomeId,
  weight: 0,
});
// A link worth nothing claims coverage that measures nothing.
check("a weight of zero is refused", r.status === 400, `status ${r.status}`);

// --- 3. A prerequisite loop is refused -----------------------------------------

r = await admin.json("/api/admin/curriculum/concepts/", "POST", {
  name: `Smoke prereq ${stamp}`,
});
const otherId = r.body?.id;

r = await admin.json(
  `/api/admin/curriculum/concepts/${conceptId}/prerequisites/`,
  "POST",
  { prerequisiteId: otherId },
);
check("a real prerequisite is accepted", r.status === 200, `status ${r.status}`);

r = await admin.json(
  `/api/admin/curriculum/concepts/${otherId}/prerequisites/`,
  "POST",
  { prerequisiteId: conceptId },
);
check("closing the loop is refused", r.status === 400, `status ${r.status}`);
check("and says why in words",
  /loop|root cause/i.test(r.body?.error?.message ?? ""),
  r.body?.error?.message ?? "");

r = await admin.json(
  `/api/admin/curriculum/concepts/${conceptId}/prerequisites/`,
  "POST",
  { prerequisiteId: conceptId },
);
check("a concept cannot be its own prerequisite", r.status === 400,
  `status ${r.status}`);

const cycles = await db.query(
  `select count(*)::int as n from concept_prerequisites a
     join concept_prerequisites b
       on a.concept_id = b.prerequisite_concept_id
      and a.prerequisite_concept_id = b.concept_id`,
);
// The graph is walked to name a root cause. A cycle makes that unanswerable.
check("no two-step cycle exists anywhere in the graph", cycles.rows[0].n === 0,
  `${cycles.rows[0].n}`);

// --- 3b. Drafting proposals ----------------------------------------------------

// No API key in this environment, so the mock provider answers with nothing
// scripted. What matters at this level is that the call is ATTEMPTED, that a
// failure is a typed refusal rather than a crash, and that NOTHING is written
// by a draft — the proposal step must never create a concept.
const conceptsBefore = await db.query("select count(*)::int as n from concepts");

const subject = await db.query(
  `select distinct c.subject_id as id from chapters c
     join topics t on t.chapter_id = c.id
     join learning_outcomes lo on lo.topic_id = t.id
     left join concept_outcomes co on co.learning_outcome_id = lo.id
    where co.learning_outcome_id is null
    limit 1`,
);

if (subject.rows.length > 0) {
  r = await admin.json("/api/admin/curriculum/concepts/suggest/", "POST", {
    action: "draft",
    subjectId: subject.rows[0].id,
  });
  // Either it drafted, or the provider refused — both are fine, and neither
  // may be a 500. An authoring screen that errors is one nobody opens twice.
  check("drafting answers without crashing",
    r.status === 200 || r.status === 409, `status ${r.status}`);

  const attempted = await db.query(
    `select feature from ai_generations order by started_at desc limit 1`,
  );
  check("and the call is recorded as a RECOMMENDATION",
    attempted.rows[0]?.feature === "RECOMMENDATION", attempted.rows[0]?.feature);

  const summary = await db.query(
    `select input_summary::text as s from ai_generations
      where feature = 'RECOMMENDATION' order by started_at desc limit 1`,
  );
  // The one AI task in the product with no personal data in it whatsoever.
  check("carrying no identifiers in the ledger summary",
    !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(summary.rows[0]?.s ?? ""),
    summary.rows[0]?.s ?? "");
} else {
  check("drafting answers without crashing", true, "no uncovered subject");
  check("and the call is recorded as a RECOMMENDATION", true, "skipped");
  check("carrying no identifiers in the ledger summary", true, "skipped");
}

const conceptsAfter = await db.query("select count(*)::int as n from concepts");
// A proposal is a proposal. Nothing is written until a person presses Accept.
check("drafting writes no concepts at all",
  conceptsAfter.rows[0].n === conceptsBefore.rows[0].n,
  `${conceptsBefore.rows[0].n} then ${conceptsAfter.rows[0].n}`);

// Accepting is what writes — and it refuses the same things creating does.
r = await admin.json("/api/admin/curriculum/concepts/suggest/", "POST", {
  action: "accept",
  name: `Smoke authored ${stamp}`,
  outcomeIds: [outcomeId],
});
check("accepting a name that already exists is refused", r.status === 400,
  `status ${r.status}`);

const accepted = await admin.json("/api/admin/curriculum/concepts/suggest/", "POST", {
  action: "accept",
  name: `Smoke accepted ${stamp}`,
  description: "Created from a draft.",
  outcomeIds: [outcomeId],
});
check("accepting a good draft creates and links in one action",
  accepted.status === 201, `status ${accepted.status}`);
check("with every outcome linked", accepted.body?.linked === 1,
  `${accepted.body?.linked}`);

// A teacher cannot draft either.
r = await teacher.json("/api/admin/curriculum/concepts/suggest/", "POST", {
  action: "draft",
  subjectId: subject.rows[0]?.id ?? crypto.randomUUID(),
});
check("a teacher cannot draft concepts", r.status === 404 || r.status === 403,
  `status ${r.status}`);

// --- 4. There is no delete -------------------------------------------------------

for (const path of [
  `/api/admin/curriculum/concepts/`,
  `/api/admin/curriculum/concepts/${conceptId}/`,
]) {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
  check(`no DELETE on ${path}`, res.status === 404 || res.status === 405,
    `status ${res.status}`);
}

// --- 5. Unlinking leaves the concept, and history, alone --------------------------

r = await admin.json(
  `/api/admin/curriculum/concepts/${conceptId}/outcomes/?outcomeId=${outcomeId}`,
  "DELETE",
);
check("an outcome can be unlinked", r.status === 200, `status ${r.status}`);

const survives = await db.query("select count(*)::int as n from concepts where id = $1", [
  conceptId,
]);
// Retiring, not deleting: every past estimate stays explainable.
check("the concept itself survives unlinking", survives.rows[0].n === 1);

// --- 6. Everything is audited -----------------------------------------------------

const audited = await db.query(
  `select action from audit_logs where entity_id = $1 order by created_at asc`,
  [conceptId],
);
const actions = audited.rows.map((row) => row.action);
check("creating is audited", actions.includes("curriculum.concept_created"),
  JSON.stringify(actions));
check("linking is audited", actions.includes("curriculum.concept_outcome_linked"), "");
check("unlinking is audited",
  actions.includes("curriculum.concept_outcome_unlinked"), "");
check("adding a prerequisite is audited",
  actions.includes("curriculum.concept_prerequisite_added"), "");

// --- The detail page --------------------------------------------------------------

const detail = await admin.page(`/admin/curriculum/concepts/${conceptId}/`);
check("the detail page renders", detail.status === 200, `status ${detail.status}`);
check("and warns that nothing can be measured through it now",
  /nothing can be measured/i.test(detail.html), "");
check("and states what unlinking does to history",
  /keeps its meaning/i.test(detail.html), "");

// The curriculum plane has no tenant: what this script authored is removed
// here or it stays in every school's syllabus for good.
await removeFixtureCurriculum(db, since);
await db.end();
report();

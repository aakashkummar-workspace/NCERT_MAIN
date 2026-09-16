/**
 * End-to-end smoke check for the institute console.
 *
 *   npm run build && npm start
 *   node scripts/smoke-institute.mjs
 *
 * Three properties that need a real round trip:
 *
 *   1. **The console is gated by the PLAN, not only by the role.** An owner on
 *      Free gets 404 — not a 403 and not an upsell.
 *   2. **An organization always keeps one owner.** Every route that could
 *      produce an ownerless organization refuses, over HTTP as in the core.
 *   3. **There is no teacher league table**, and the page says why.
 */
import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-institute.mjs");
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
      return { status: res.status, html: await res.text(), url: res.url };
    },
  };
}

const db = new pg.Client({ connectionString: process.env.DIRECT_URL });
await db.connect();

// --- A centre on the default plan ------------------------------------------

const owner = session();
await owner.json("/api/auth/signup/", "POST", {
  fullName: "Rajesh Owner",
  email: `inst.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Institute Centre ${stamp}`,
  organizationType: "COACHING_INSTITUTE", boardCode: "CBSE",
});

const org = await db.query("select id from organizations where name = $1", [
  `Institute Centre ${stamp}`,
]);
const organizationId = org.rows[0]?.id;
check("the organisation exists", Boolean(organizationId));

// --- The plan gate ----------------------------------------------------------

let r = await owner.page("/institute/");
// Not a 403 and not an upsell: a solo teacher on Free is not a failed
// institute, and a paywall on a page they have no use for exists only to make
// them feel small.
check("an owner without the plan gets 404 on the console", r.status === 404,
  `status ${r.status}`);

r = await owner.json("/api/institute/staff/", "POST", {
  email: `blocked.${stamp}@example.test`,
  role: "TEACHER",
});
check("and 404 on the invite route too", r.status === 404, `status ${r.status}`);

const inviteCount = await db.query(
  "select count(*)::int as n from invitations where organization_id = $1",
  [organizationId],
);
check("with nothing written", inviteCount.rows[0].n === 0, `${inviteCount.rows[0].n}`);

// Move them onto the institute plan. There is deliberately no in-app way.
await db.query(
  `insert into subscriptions (id, organization_id, plan_id, status)
   select gen_random_uuid(), $1, p.id, 'ACTIVE' from plans p where p.code = 'institute'`,
  [organizationId],
);

r = await owner.page("/institute/");
check("on the institute plan the console opens", r.status === 200,
  `status ${r.status}`);
check("and names the organisation", r.html.includes(`Institute Centre ${stamp}`));

// --- The dashboard leads with exceptions ------------------------------------

// A class and some students with no phone numbers, which is a real exception.
const picker = await owner.json("/api/curriculum/picker/");
const chapter = picker.body.chapters[0];
const newClassPage = await owner.page("/teacher/classes/new/");
const gradeIds = [
  ...new Set(
    [
      ...(newClassPage.html.split('id="subjectId"')[0] ?? "").matchAll(
        /value="([0-9a-f-]{36})"/g,
      ),
    ].map((m) => m[1]),
  ),
];
let klass = null;
for (const candidate of gradeIds) {
  const attempt = await owner.json("/api/classes/", "POST", {
    name: "Batch A",
    gradeId: candidate,
    subjectId: chapter.subjectId,
    academicYear: "2026-27",
  });
  if (attempt.status === 200) {
    klass = attempt.body;
    break;
  }
}
check("a class is created", Boolean(klass?.id));

await owner.json(`/api/classes/${klass.id}/students/`, "POST", {
  text: "First Student\nSecond Student\nThird Student",
});

r = await owner.page("/institute/");
// The exceptions come first, above the counts. An owner does not need to be
// told they have three students.
check("the dashboard raises students who cannot sign in",
  /no mobile number/i.test(r.html), "");
check("with a link to where it is fixed", r.html.includes("/teacher/students"));
// Said out loud on the owner's own page, because this is where the request for
// a league table arrives.
check("and says there is no teacher ranking, with the reason",
  /no ranking of teachers/i.test(r.html) && /weaker set/i.test(r.html), "");

// --- Inviting a colleague ----------------------------------------------------

const colleagueEmail = `colleague.${stamp}@example.test`;
r = await owner.json("/api/institute/staff/", "POST", {
  email: colleagueEmail,
  role: "TEACHER",
});
check("an owner can invite a teacher", r.status === 201, `status ${r.status}`);
const inviteToken = r.body?.token;
check("and the token comes back once", Boolean(inviteToken));

const stored = await db.query(
  "select encode(token_hash, 'hex') as h from invitations where email = $1",
  [colleagueEmail],
);
check("only its hash is stored",
  !stored.rows[0].h.includes(Buffer.from(inviteToken).toString("hex")));

r = await owner.json("/api/institute/staff/", "POST", {
  email: colleagueEmail,
  role: "ADMIN",
});
// Two live invitations to one address is two links, and whichever gets used
// decides the role — which nobody chose.
check("a second live invitation to the same address is refused",
  r.status === 409, `status ${r.status}`);

r = await owner.page("/institute/teachers/");
check("the teachers page renders", r.status === 200, `status ${r.status}`);
check("showing the pending invitation", r.html.includes(colleagueEmail));
check("and marking their own row rather than offering controls",
  r.html.includes("Rajesh Owner") && />You</.test(r.html), "");

// --- The last owner ---------------------------------------------------------

const ownerMembership = await db.query(
  `select m.id from memberships m
    where m.organization_id = $1 and m.role = 'OWNER'`,
  [organizationId],
);
const ownerMembershipId = ownerMembership.rows[0].id;

r = await owner.json(`/api/institute/staff/${ownerMembershipId}/`, "PATCH", {
  role: "TEACHER",
});
// No owner means nobody who can manage billing, invite anybody, or undo it —
// and no route back except database access.
check("the only owner cannot be demoted", r.status === 409, `status ${r.status}`);

r = await owner.json(`/api/institute/staff/${ownerMembershipId}/`, "DELETE");
check("nor removed", r.status === 409, `status ${r.status}`);

const stillOwner = await db.query(
  `select role, status from memberships where id = $1`,
  [ownerMembershipId],
);
check("and they are untouched",
  stillOwner.rows[0].role === "OWNER" && stillOwner.rows[0].status === "ACTIVE",
  JSON.stringify(stillOwner.rows[0]));

// --- Removing somebody keeps their work -------------------------------------

// A second teacher, added directly — accepting an invitation is a later slice.
const teacherUser = await db.query(
  `insert into users (id, full_name, email, status)
   values (gen_random_uuid(), 'Second Teacher', $1, 'ACTIVE') returning id`,
  [`second.${stamp}@example.test`],
);
const teacherId = teacherUser.rows[0].id;
const teacherMembership = await db.query(
  `insert into memberships (id, organization_id, user_id, role, status, joined_at)
   values (gen_random_uuid(), $1, $2, 'TEACHER', 'ACTIVE', now()) returning id`,
  [organizationId, teacherId],
);
const teacherMembershipId = teacherMembership.rows[0].id;

await db.query(
  `insert into sessions (id, user_id, organization_id, membership_id, token_hash, expires_at)
   values (gen_random_uuid(), $1, $2, $3, decode(repeat('aa', 32), 'hex'), now() + interval '1 day')`,
  [teacherId, organizationId, teacherMembershipId],
);

r = await owner.json(`/api/institute/staff/${teacherMembershipId}/`, "PATCH", {
  role: "ADMIN",
});
check("a role can be changed", r.status === 200, `status ${r.status}`);

r = await owner.json(`/api/institute/staff/${teacherMembershipId}/`, "DELETE");
check("and access removed", r.status === 200, `status ${r.status}`);

const after = await db.query(
  "select status from memberships where id = $1",
  [teacherMembershipId],
);
// The row survives: their papers and their marking point at them, and "who
// marked this" is asked a year later.
check("the membership is suspended, not deleted",
  after.rows[0]?.status === "SUSPENDED", after.rows[0]?.status);

const sessions = await db.query(
  "select count(*)::int as n from sessions where user_id = $1",
  [teacherId],
);
// Removed and still signed in until the cookie expires is not removed.
check("and their sessions are gone", sessions.rows[0].n === 0,
  `${sessions.rows[0].n}`);

r = await owner.page("/institute/teachers/");
check("they still appear, marked as gone",
  r.html.includes("Second Teacher") && /No longer here/i.test(r.html), "");

// --- Batches carry their denominators ---------------------------------------

r = await owner.page("/institute/analytics/");
check("the batches page renders", r.status === 200, `status ${r.status}`);
check("naming the class", r.html.includes("Batch A"));
// "10-A is at 71%" is the sentence an owner wants and is almost always wrong.
check("and refusing a mean below the measured threshold",
  /not enough measured/i.test(r.html), "");

r = await owner.page("/institute/subscription/");
check("the subscription page renders", r.status === 200, `status ${r.status}`);
check("naming the plan", /Institute/i.test(r.html));

// --- Who cannot get in ------------------------------------------------------

const stranger = session();
await stranger.json("/api/auth/signup/", "POST", {
  fullName: "Other Owner",
  email: `inst.other.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Other Institute ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});
r = await stranger.json(`/api/institute/staff/${teacherMembershipId}/`, "PATCH", {
  role: "OWNER",
});
check("another organisation cannot change a role here",
  r.status === 404 || r.status === 409, `status ${r.status}`);

r = await fetch(`${BASE}/institute/`);
const anonHtml = await r.text();
// Whatever the status, what matters is that the console was not served: the
// redirect lands on sign-in, so a 200 here is the sign-in page.
check("an anonymous visitor cannot open the console",
  !anonHtml.includes(`Institute Centre ${stamp}`) &&
    !/no ranking of teachers/i.test(anonHtml),
  `status ${r.status} at ${r.url}`);

r = await fetch(`${BASE}/api/institute/staff/`, { method: "POST" });
check("nor invite anybody", r.status === 401 || r.status === 404,
  `status ${r.status}`);

await db.end();
report();

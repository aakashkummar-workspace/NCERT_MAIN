/**
 * End-to-end smoke check for white labelling.
 *
 *   npm run build && npm start
 *   node scripts/smoke-branding.mjs
 *
 * What needs a real round trip:
 *
 *   1. **Branding is a plan capability.** Off the plan, the editor and its routes
 *      are 404, and nothing renders — not an upsell.
 *   2. **An unreadable theme is refused over HTTP**, with nothing written.
 *   3. **The theme and the name reach the pages** through the layout, without
 *      any page having been told about branding.
 *   4. **A logo is served as what its bytes are**, with headers that stop it
 *      being anything else, and only inside its own school.
 *   5. **The public sign-in page draws only public things**, and an unknown or
 *      lapsed school is the same 404.
 */
import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-branding.mjs");
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
        headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async upload(path, bytes, filename, type) {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type }), filename);
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: cookie ? { cookie } : {},
        body: form,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async raw(path) {
      return fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
    },
    async page(path) {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
      return { status: res.status, html: await res.text() };
    },
  };
}

const db = new pg.Client({ connectionString: process.env.DIRECT_URL });
await db.connect();

// A real 1×1 PNG, so a browser opening the URL would draw it.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const owner = session();
const orgName = `Branding Centre ${stamp}`;
await owner.json("/api/auth/signup/", "POST", {
  fullName: "Anita Owner",
  email: `brand.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: orgName,
  organizationType: "SCHOOL",
  boardCode: "CBSE",
});
const org = await db.query("select id, slug from organizations where name = $1", [orgName]);
const organizationId = org.rows[0]?.id;
const slug = org.rows[0]?.slug;
check("the organisation exists", Boolean(organizationId));

// --- 1. The plan gate --------------------------------------------------------

let r = await owner.page("/institute/branding/");
check("off the plan, the editor is 404", r.status === 404, `status ${r.status}`);

r = await owner.json("/api/institute/branding/", "PUT", { details: { displayName: "Nope" }, theme: {} });
check("and the save route is 404", r.status === 404, `status ${r.status}`);

const written = await db.query(
  "select count(*)::int as n from organization_branding where organization_id = $1",
  [organizationId],
);
check("with nothing written", written.rows[0].n === 0, `${written.rows[0].n}`);

await db.query(
  `insert into subscriptions (id, organization_id, plan_id, status)
   select gen_random_uuid(), $1, p.id, 'ACTIVE' from plans p where p.code = 'institute'`,
  [organizationId],
);

r = await owner.page("/institute/branding/");
check("on the institute plan the editor opens", r.status === 200, `status ${r.status}`);
check("and the console offers a Branding tab", r.html.includes('href="/institute/branding/"'));

// --- 2. Refused, not clamped -------------------------------------------------

r = await owner.json("/api/institute/branding/", "PUT", {
  details: { displayName: "Gold School" },
  theme: { brand: "#f5c400" },
});
check("an unreadable brand colour is refused", r.status === 400, `status ${r.status}`);
check(
  "and the refusal names the pair that fails",
  JSON.stringify(r.body).includes("White button text"),
);

r = await owner.json("/api/institute/branding/", "PUT", {
  details: { website: "javascript:alert(1)" },
  theme: {},
});
check("a javascript: website is refused", r.status === 400, `status ${r.status}`);

// --- 3. It reaches the pages -------------------------------------------------

const displayName = `St. Smoke's ${stamp}`;
r = await owner.json("/api/institute/branding/", "PUT", {
  details: {
    displayName,
    tagline: "Learning together",
    principalName: "Mrs. Private Principal",
    affiliationNumber: "2130999",
  },
  theme: { brand: "#1f4e9c" },
});
check("a readable theme saves", r.status === 200, `status ${r.status}`);

r = await owner.page("/teacher/");
check("the teacher dashboard carries the theme", r.html.includes("--primary-600:#1f4e9c;"));
check("and the school's name", r.html.includes(displayName.replace("'", "&#x27;")) || r.html.includes(displayName));
check("and the name in the tab title", /<title>[^<]*St\. Smoke/.test(r.html));

const audit = await db.query(
  "select count(*)::int as n from audit_logs where organization_id = $1 and action = 'branding.updated'",
  [organizationId],
);
check("saving is audited", audit.rows[0].n >= 1, `${audit.rows[0].n}`);

// --- 4. Logos ---------------------------------------------------------------

r = await owner.upload(
  "/api/institute/branding/logo/",
  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
  "logo.png",
  "image/png",
);
check("an SVG named logo.png is refused", r.status === 400, `status ${r.status}`);

r = await owner.upload("/api/institute/branding/logo/", PNG, "logo.bin", "application/octet-stream");
check("a PNG is accepted whatever it was called", r.status === 200, `status ${r.status}`);
const logoPath = r.body?.url;
const logoId = r.body?.logoId;

let res = await owner.raw(logoPath);
check("the logo is served", res.status === 200, `status ${res.status}`);
check("as the type its bytes are", res.headers.get("content-type") === "image/png", res.headers.get("content-type") ?? "");
check("with nosniff", res.headers.get("x-content-type-options") === "nosniff");
check("and a sandboxing CSP", (res.headers.get("content-security-policy") ?? "").includes("sandbox"));

res = await fetch(`${BASE}${logoPath}`);
check("not to somebody signed out", res.status === 401, `status ${res.status}`);

const stranger = session();
await stranger.json("/api/auth/signup/", "POST", {
  fullName: "Other Owner",
  email: `brand.other.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Other Centre ${stamp}`,
  organizationType: "SCHOOL",
  boardCode: "CBSE",
});
res = await stranger.raw(logoPath);
check("and not to another school", res.status === 404, `status ${res.status}`);

r = await owner.page("/institute/branding/");
check("the editor shows the logo", r.html.includes(logoPath));

// --- 5. The public page ------------------------------------------------------

const visitor = session();
r = await visitor.page(`/school/${slug}/`);
check("the school's sign-in page opens signed out", r.status === 200, `status ${r.status}`);
check("with its theme", r.html.includes("--primary-600:#1f4e9c;"));
check("and the attribution", r.html.includes("Powered by Sahayak"));
check("and without the principal's name", !r.html.includes("Mrs. Private Principal"));
check("or the affiliation number", !r.html.includes("2130999"));
check("or an offer to found a new organisation", !r.html.includes('href="/signup/"'));

r = await visitor.page(`/school/${slug}/student/`);
check("the student sign-in page opens too", r.status === 200, `status ${r.status}`);

res = await fetch(`${BASE}/api/public/schools/${slug}/logo/${logoId}/`);
check("the current logo is public for that page", res.status === 200, `status ${res.status}`);

r = await visitor.page(`/school/no-such-school-${stamp}/`);
check("an unknown school is 404", r.status === 404, `status ${r.status}`);

r = await owner.json("/api/institute/branding/", "PUT", {
  details: { displayName, hidePoweredBy: true },
  theme: { brand: "#1f4e9c" },
});
r = await visitor.page(`/school/${slug}/`);
check("switching the attribution off removes it", !r.html.includes("Powered by Sahayak"));

// The plan lapses.
await db.query("update subscriptions set status = 'CANCELLED' where organization_id = $1", [
  organizationId,
]);

r = await visitor.page(`/school/${slug}/`);
check("a lapsed school's page is the same 404", r.status === 404, `status ${r.status}`);

res = await fetch(`${BASE}/api/public/schools/${slug}/logo/${logoId}/`);
check("and so is its public logo", res.status === 404, `status ${res.status}`);

r = await owner.page("/teacher/");
check("and the app returns to Sahayak's look", !r.html.includes("data-brand-theme"));

const kept = await db.query(
  "select display_name from organization_branding where organization_id = $1",
  [organizationId],
);
check("while keeping what was typed", kept.rows[0]?.display_name === displayName);

await db.end();
report();

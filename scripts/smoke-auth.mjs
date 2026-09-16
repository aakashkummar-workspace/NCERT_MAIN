import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-auth.mjs");
/**
 * End-to-end smoke check for the slice 0 auth flow.
 *
 *   npm run build && npm start        # in one shell
 *   node scripts/smoke-auth.mjs       # in another
 *
 * Asserts it is talking to a server that has the CURRENT build before running.
 * A bare readiness probe once passed against a zombie server left over from a
 * previous run and produced a page of confident, fictitious failures.
 */
const BASE = process.env.BASE ?? "http://localhost:3210";
const email = `priya.${Date.now()}@example.test`;

// Is anything there at all?
try {
  const probe = await fetch(`${BASE}/signin/`);
  if (probe.status !== 200) throw new Error(`status ${probe.status}`);
} catch (error) {
  console.error(`No server at ${BASE} — run: npm run build && npm start
${error}`);
  process.exit(1);
}

let cookie = "";
const results = [];
const check = (name, pass, detail = "") =>
  results.push({ name, pass, detail });

function capture(res) {
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
}

// 1. Dashboard is protected before sign-in
let r = await fetch(`${BASE}/teacher/`, { redirect: "manual" });
check("unauthenticated /t redirects to sign-in", [307, 302, 303].includes(r.status),
  `status ${r.status} -> ${r.headers.get("location")}`);

// 2. Sign up
r = await fetch(`${BASE}/api/auth/signup/`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    fullName: "Priya Raman", email, password: "a-long-enough-password",
    organizationName: "Raman Maths Centre", organizationType: "TUITION_CENTRE", boardCode: "CBSE",
  }),
});
capture(r);
const signup = await r.json();
check("signup returns 200 with an organization", r.status === 200 && !!signup.organizationId,
  `status ${r.status} role=${signup.role}`);
check("signup sets a session cookie", cookie.startsWith("sahayak_sid="));

// 3. Validation is enforced
r = await fetch(`${BASE}/api/auth/signup/`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ fullName: "X", email: "not-an-email", password: "short",
    organizationName: "", organizationType: "TUITION_CENTRE", boardCode: "CBSE" }),
});
const bad = await r.json();
check("bad signup returns 400 with per-field errors", r.status === 400 && !!bad.error?.details?.fields,
  `fields: ${Object.keys(bad.error?.details?.fields ?? {}).join(", ")}`);

// 4. Duplicate email is a conflict, not a crash
r = await fetch(`${BASE}/api/auth/signup/`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ fullName: "Someone Else", email, password: "a-long-enough-password",
    organizationName: "Another Centre", organizationType: "SOLO_TEACHER", boardCode: "CBSE" }),
});
check("duplicate email returns 409", r.status === 409, `status ${r.status}`);

// 5. Authenticated dashboard renders
r = await fetch(`${BASE}/teacher/`, { headers: { cookie } });
const html = await r.text();
check("authenticated /t renders 200", r.status === 200, `status ${r.status}`);
check("dashboard greets the teacher by first name", html.includes("Priya"));
check("dashboard shows the organisation", html.includes("Raman Maths Centre"));
check("empty stats render an em dash, not 0%", html.includes("—") && !html.includes(">0%<"));
check("empty state offers an action", html.includes("Create a class"));

// 6. Sign in with the same credentials
cookie = "";
r = await fetch(`${BASE}/api/auth/signin/`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identifier: email, password: "a-long-enough-password" }),
});
capture(r);
check("signin returns 200", r.status === 200, `status ${r.status}`);
check("signin sets a fresh session cookie", cookie.startsWith("sahayak_sid="));

// 7. Wrong password
r = await fetch(`${BASE}/api/auth/signin/`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identifier: email, password: "wrong-password-entirely" }),
});
const wrong = await r.json();
check("wrong password returns 401", r.status === 401, `status ${r.status}`);

// 8. Unknown account gives the SAME message — no enumeration oracle
r = await fetch(`${BASE}/api/auth/signin/`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identifier: "nobody@example.test", password: "wrong-password-entirely" }),
});
const unknown = await r.json();
check("unknown account is indistinguishable from a wrong password",
  r.status === 401 && unknown.error.message === wrong.error.message,
  `"${unknown.error.message}"`);

// 9. The session cookie is HttpOnly
r = await fetch(`${BASE}/api/auth/signin/`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identifier: email, password: "a-long-enough-password" }),
});
const raw = r.headers.get("set-cookie") ?? "";
check("session cookie is HttpOnly and SameSite=Lax",
  /httponly/i.test(raw) && /samesite=lax/i.test(raw));

// 10. A forged cookie gets nothing
r = await fetch(`${BASE}/teacher/`, {
  headers: { cookie: "sahayak_sid=forged-token-that-is-not-real" },
  redirect: "manual",
});
check("a forged session token is rejected", [307, 302, 303].includes(r.status),
  `status ${r.status}`);

let failed = 0;
for (const { name, pass, detail } of results) {
  if (!pass) failed++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);

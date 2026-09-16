import "server-only";
import { createHash, randomInt } from "node:crypto";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { identifierTaken, listMembershipsForAuth } from "@/db/unscoped";
import { normalisePhone } from "@/core/roster/parse";
import { sendSms } from "@/sms/gateway";
import { createSessionToken, sessionExpiry } from "./session";
import type { Role } from "./authorize";

/**
 * Student sign-in, by phone and a one-time code.
 *
 * Students are 13 to 16 and mostly do not have their own email. They do have a
 * phone number, or their guardian does, which is why the roster stores one and
 * why a student without one is flagged everywhere as unable to sit a test.
 *
 * ---------------------------------------------------------------------------
 * What is deliberately not here
 * ---------------------------------------------------------------------------
 * No password. A password a fifteen-year-old chooses for a test they sit twice
 * a term is a password they will have forgotten by the test, and the recovery
 * flow would then be the actual sign-in flow.
 *
 * The code itself is six digits, five minutes, single use, five guesses. The
 * rate limit and the guess limit both live in `prisma/rls.sql`, not here,
 * because they protect an SMS bill and must hold even if a route forgets.
 */

export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 5 * 60_000;

export function hashCode(phone: string, code: string): Buffer {
  // Salted with the phone, so an identical code for two students does not
  // produce an identical hash.
  return createHash("sha256").update(`${phone}:${code}`, "utf8").digest();
}

function generateCode(): string {
  // randomInt, not Math.random: this is a credential.
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");
}

export type RequestCodeResult =
  | {
      ok: true;
      /**
       * The code itself, in development only, so somebody working on sign-in
       * does not need a handset.
       *
       * Prefer `SMS_PROVIDER=log`, which prints it to the terminal instead:
       * a code in an HTTP response is a code in a browser's network tab, in a
       * proxy log and in whatever a test framework decides to print.
       */
      devCode?: string;
      /**
       * Development only: whether any account has this number.
       *
       * Production deliberately never says — "no account has that number" would
       * turn the form into a way of testing which numbers are students. But in
       * development the screen printed a code for a number nobody was registered
       * with, and then refused that same code, which reads as sign-in being
       * broken. A developer is told the truth instead.
       */
      devRegistered?: boolean;
      /**
       * False when the code was issued but could not be delivered.
       *
       * The distinction matters and used to be invisible. Issuing and sending
       * are different acts: the row exists, the clock is running, and the
       * student has nothing. A caller that cannot tell them apart will tell a
       * student to check their phone for a message nobody sent.
       */
      delivered: boolean;
    }
  | { ok: false; message: string };

/**
 * Issue a code.
 *
 * Always reports success for a well-formed number, whether or not an account
 * exists. Saying "no account with that number" turns the sign-in form into a
 * way of asking whether a given child is a student here.
 */
export async function requestLoginCode(
  rawPhone: string,
): Promise<RequestCodeResult> {
  const phone = normalisePhone(rawPhone);
  if (!phone) {
    return {
      ok: false,
      message: "That is not a mobile number we can send a code to.",
    };
  }

  const code = generateCode();
  const rows = await prisma.$queryRaw<{ app_auth_issue_code: boolean }[]>`
    select app_auth_issue_code(
      ${phone},
      ${hashCode(phone, code)},
      ${new Date(Date.now() + CODE_TTL_MS)}
    )
  `;

  if (rows[0]?.app_auth_issue_code !== true) {
    return {
      ok: false,
      message:
        "Too many codes requested for that number. Wait an hour and try again.",
    };
  }

  // Handed to the SMS layer, which never throws: a provider that is down must
  // not turn the sign-in form into a 500. The code has already been issued and
  // its clock has already started, so a failed send is reported rather than
  // rolled back — the student can ask for another one, and the ledger row says
  // what happened to the first.
  const sent = await sendSms({
    phone,
    template: "LOGIN_CODE",
    variables: [code],
    // No organization: a student signing in has no tenant yet — the code is
    // what will eventually tell us which one. The same pre-tenant seam the
    // auth reads sit behind.
    organizationId: null,
  });

  if (process.env.NODE_ENV !== "production") {
    const devRegistered = await identifierTaken(null, phone);
    return { ok: true, devCode: code, devRegistered, delivered: sent.ok };
  }
  return { ok: true, delivered: sent.ok };
}

export type VerifyResult =
  | {
      ok: true;
      token: string;
      expiresAt: Date;
      organizationId: string;
      role: Role;
    }
  | { ok: false; message: string };

export async function verifyLoginCode(
  rawPhone: string,
  code: string,
  meta: { userAgent?: string; ip?: string } = {},
): Promise<VerifyResult> {
  const phone = normalisePhone(rawPhone);
  if (!phone) {
    return { ok: false, message: "That code did not work. Ask for a new one." };
  }

  const rows = await prisma.$queryRaw<{ user_id: string; full_name: string }[]>`
    select * from app_auth_consume_code(${phone}, ${hashCode(phone, code)})
  `;
  const found = rows[0];

  // One message for a wrong code, an expired code, a used code and an unknown
  // number. Distinguishing them tells an attacker which of those it was.
  if (!found) {
    return { ok: false, message: "That code did not work. Ask for a new one." };
  }

  const memberships = await listMembershipsForAuth(found.user_id);
  const membership = memberships[0];
  if (!membership) {
    return {
      ok: false,
      message:
        "Your account is not attached to a class yet. Ask your teacher to add you.",
    };
  }

  const token = createSessionToken();
  const role = membership.role as Role;
  const expiresAt = sessionExpiry(role);

  await withTenant(membership.organization_id, (tx) =>
    tx.session.create({
      data: {
        userId: found.user_id,
        organizationId: membership.organization_id,
        membershipId: membership.membership_id,
        tokenHash: new Uint8Array(token.hash),
        userAgent: meta.userAgent ?? null,
        ip: meta.ip ?? null,
        expiresAt,
      },
    }),
  );

  return {
    ok: true,
    token: token.raw,
    expiresAt,
    organizationId: membership.organization_id,
    role,
  };
}

import { describe, expect, it } from "vitest";
import {
  ALL_ACTIONS,
  ALL_ROLES,
  type Action,
  type Actor,
  type Role,
  can,
  assertCan,
  ForbiddenError,
} from "@/core/identity/authorize";

const actor = (role: Role, organizationId = ORG_A): Actor => ({
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId,
  membershipId: "22222222-2222-4222-8222-222222222222",
  role,
});

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/**
 * The explicitly-allowed set. Anything not listed here must be denied — that
 * assertion is the point of this file, and it is what makes a new resource type
 * start locked instead of open.
 */
const ALLOWED: Record<Role, Action[]> = {
  OWNER: [
    "organization:read",
    "organization:update",
    "organization:delete",
    "member:read",
    "member:invite",
    "member:update_role",
    "member:remove",
    "billing:read",
    "billing:manage",
    "audit:read",
    "profile:read_own",
    "profile:update_own",
  ],
  ADMIN: [
    "organization:read",
    "organization:update",
    "member:read",
    "member:invite",
    "member:update_role",
    "member:remove",
    "billing:read",
    "audit:read",
    "profile:read_own",
    "profile:update_own",
  ],
  TEACHER: [
    "organization:read",
    "member:read",
    "profile:read_own",
    "profile:update_own",
  ],
  STUDENT: ["profile:read_own", "profile:update_own"],
  PARENT: ["profile:read_own", "profile:update_own"],
};

describe("authorize", () => {
  describe("the full matrix", () => {
    for (const role of ALL_ROLES) {
      for (const action of ALL_ACTIONS) {
        const shouldAllow = ALLOWED[role].includes(action);
        it(`${role} ${shouldAllow ? "may" : "may NOT"} ${action}`, () => {
          expect(can(actor(role), action)).toBe(shouldAllow);
        });
      }
    }
  });

  it("denies by default — every action is either listed or denied for every role", () => {
    // If someone adds an Action to the union and forgets the matrix, `can`
    // returns false and this stays green. If they add it to the matrix without
    // adding it to ALLOWED here, this goes red. Either way the omission is
    // visible rather than silently permissive.
    for (const role of ALL_ROLES) {
      for (const action of ALL_ACTIONS) {
        const permitted = can(actor(role), action);
        if (permitted) {
          expect(
            ALLOWED[role],
            `${role} was granted ${action} but the test matrix does not list it`,
          ).toContain(action);
        }
      }
    }
  });

  it("denies an unknown action for every role", () => {
    for (const role of ALL_ROLES) {
      expect(can(actor(role), "resource:invented" as Action)).toBe(false);
    }
  });

  describe("cross-organization", () => {
    it("refuses an action on a resource in another organization, whatever the role", () => {
      for (const role of ALL_ROLES) {
        expect(
          can(actor(role, ORG_A), "organization:read", {
            organizationId: ORG_B,
          }),
          `${role} must not reach org B from a session bound to org A`,
        ).toBe(false);
      }
    });

    it("allows an action on a resource in the actor's own organization", () => {
      expect(
        can(actor("OWNER", ORG_A), "organization:read", {
          organizationId: ORG_A,
        }),
      ).toBe(true);
    });

    it("an OWNER of one org is not an owner of another", () => {
      expect(
        can(actor("OWNER", ORG_A), "organization:delete", {
          organizationId: ORG_B,
        }),
      ).toBe(false);
    });
  });

  describe("assertCan", () => {
    it("returns quietly when permitted", () => {
      expect(() => assertCan(actor("OWNER"), "billing:manage")).not.toThrow();
    });

    it("throws ForbiddenError naming the action when not", () => {
      expect(() => assertCan(actor("STUDENT"), "billing:manage")).toThrow(
        ForbiddenError,
      );
      try {
        assertCan(actor("STUDENT"), "billing:manage");
      } catch (error) {
        expect((error as ForbiddenError).action).toBe("billing:manage");
      }
    });
  });

  describe("role separation that matters", () => {
    it("a TEACHER cannot read the audit log", () => {
      expect(can(actor("TEACHER"), "audit:read")).toBe(false);
    });

    it("a TEACHER cannot invite members", () => {
      expect(can(actor("TEACHER"), "member:invite")).toBe(false);
    });

    it("an ADMIN cannot delete the organization or manage billing", () => {
      expect(can(actor("ADMIN"), "organization:delete")).toBe(false);
      expect(can(actor("ADMIN"), "billing:manage")).toBe(false);
    });

    it("a STUDENT cannot read the member list", () => {
      expect(can(actor("STUDENT"), "member:read")).toBe(false);
    });

    it("a PARENT cannot read the member list or the organization", () => {
      expect(can(actor("PARENT"), "member:read")).toBe(false);
      expect(can(actor("PARENT"), "organization:read")).toBe(false);
    });
  });
});

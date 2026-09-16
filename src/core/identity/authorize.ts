/**
 * Authorization — layer 2 of three.
 *
 * Layer 1 is the session: who is asking, and for which organization.
 * Layer 2 is this file: may this role do this to this resource.
 * Layer 3 is RLS: Postgres refuses rows outside the tenant regardless.
 *
 * Layer 3 exists because layer 2 will be forgotten in some route, once, on a
 * Friday. Layer 2 exists because RLS answers "which organization" and cannot
 * answer "which student".
 *
 * ---------------------------------------------------------------------------
 * Deny by default
 * ---------------------------------------------------------------------------
 * `can()` returns false for any (role, action) pair not explicitly listed. A
 * new resource type therefore starts locked, and adding one without a policy
 * fails the test suite rather than shipping open.
 */

export type Role = "OWNER" | "ADMIN" | "TEACHER" | "STUDENT" | "PARENT";

/**
 * Actions are `resource:verb`. Adding one here without adding it to the matrix
 * below makes it denied for everybody — which is the correct default and is
 * asserted by a test.
 */
export type Action =
  // Organization
  | "organization:read"
  | "organization:update"
  | "organization:delete"
  // Members
  | "member:read"
  | "member:invite"
  | "member:update_role"
  | "member:remove"
  // Billing
  | "billing:read"
  | "billing:manage"
  // Audit
  | "audit:read"
  // Own profile
  | "profile:read_own"
  | "profile:update_own";

export type Actor = {
  userId: string;
  organizationId: string;
  membershipId: string;
  role: Role;
};

/**
 * The matrix. Read it as: this role may do these things, and nothing else.
 *
 * Deliberately explicit rather than hierarchical — an OWNER is not "an ADMIN
 * plus more" by inheritance, because inheritance is how a permission gets
 * granted to a role nobody meant to grant it to.
 */
const MATRIX: Record<Role, ReadonlySet<Action>> = {
  OWNER: new Set<Action>([
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
  ]),
  ADMIN: new Set<Action>([
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
  ]),
  TEACHER: new Set<Action>([
    "organization:read",
    "member:read",
    "profile:read_own",
    "profile:update_own",
  ]),
  STUDENT: new Set<Action>([
    "profile:read_own",
    "profile:update_own",
  ]),
  PARENT: new Set<Action>([
    "profile:read_own",
    "profile:update_own",
  ]),
};

/** Every action the system knows about. Used by the deny-by-default test. */
export const ALL_ACTIONS: readonly Action[] = [
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
];

export const ALL_ROLES: readonly Role[] = [
  "OWNER",
  "ADMIN",
  "TEACHER",
  "STUDENT",
  "PARENT",
];

/**
 * May this actor perform this action?
 *
 * `resource` is accepted for actions that need row-level reasoning later
 * (an attempt's owner, a class's teacher). Slice 0 has no such action yet;
 * the parameter exists so that adding one does not change every call site.
 */
export function can(
  actor: Actor,
  action: Action,
  resource?: { organizationId?: string },
): boolean {
  // An actor may never act outside the organization their session is bound to,
  // whatever the matrix says.
  if (
    resource?.organizationId !== undefined &&
    resource.organizationId !== actor.organizationId
  ) {
    return false;
  }

  return MATRIX[actor.role]?.has(action) ?? false;
}

/**
 * Throws unless permitted. Use in route handlers, where the alternative is an
 * `if` somebody forgets to write.
 */
export function assertCan(
  actor: Actor,
  action: Action,
  resource?: { organizationId?: string },
): void {
  if (!can(actor, action, resource)) {
    throw new ForbiddenError(action);
  }
}

export class ForbiddenError extends Error {
  readonly action: string;
  constructor(action: string) {
    super(`Not permitted: ${action}`);
    this.name = "ForbiddenError";
    this.action = action;
  }
}

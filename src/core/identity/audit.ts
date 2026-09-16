import "server-only";
import { withTenant } from "@/db/tenant";

/**
 * Audit logging.
 *
 * Append-only in the database: an UPDATE or DELETE raises from a trigger. When
 * a parent disputes a mark, the answer must be a reconstructable history rather
 * than a recollection.
 *
 * Written for the state changes that matter — publishing, grading, overriding a
 * grade, changing a role, exporting data, granting parent access — whether or
 * not anyone has asked for them yet.
 */
export async function writeAudit(entry: {
  organizationId: string;
  actorUserId?: string;
  actorRole?: string;
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}) {
  await withTenant(entry.organizationId, (tx) =>
    tx.auditLog.create({
      data: {
        organizationId: entry.organizationId,
        actorUserId: entry.actorUserId ?? null,
        actorRole: entry.actorRole ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: (entry.before ?? null) as never,
        after: (entry.after ?? null) as never,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
        requestId: entry.requestId ?? null,
      },
    }),
  );
}

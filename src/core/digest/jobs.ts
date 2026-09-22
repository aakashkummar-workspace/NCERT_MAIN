import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant } from "@/db/tenant";
import { organizationsWithDigestLinks } from "@/db/maintenance";
import { childView } from "@/core/parent/read";
import { sendWhatsapp } from "@/whatsapp/gateway";
import { buildDigest, weekOf } from "./build";

/**
 * The weekly send. The one part of the digest that must ask which schools
 * have work, so it is the part listed in eslint.config.mjs as allowed to hold
 * @/db/maintenance — ids only, the work done inside each school's tenant.
 */

export type DigestRunReport = { organizations: number; sent: number; skipped: number; failed: number };

export async function sendWeeklyDigests(now = new Date()): Promise<DigestRunReport> {
  const report: DigestRunReport = { organizations: 0, sent: 0, skipped: 0, failed: 0 };
  const week = weekOf(now);
  const since = new Date(now.getTime() - 7 * 24 * 3600_000);
  const portalUrl = `${(process.env.APP_URL ?? "").replace(/\/$/, "")}/parent`;

  for (const organizationId of await organizationsWithDigestLinks()) {
    report.organizations++;
    const links = await withTenant(organizationId, async (tx) => {
      const rows = await tx.parentStudentLink.findMany({
        where: { whatsappDigestAt: { not: null }, revokedAt: null, consentGrantedAt: { not: null } },
        select: { parentUserId: true, studentUserId: true },
      });
      const parents = await tx.user.findMany({
        where: { id: { in: rows.map((row) => row.parentUserId) } },
        select: { id: true, phone: true },
      });
      const phoneOf = new Map(parents.map((parent) => [parent.id, parent.phone]));
      return rows.map((row) => ({ ...row, phone: phoneOf.get(row.parentUserId) ?? null }));
    });

    for (const link of links) {
      const parent = { organizationId, userId: link.parentUserId };
      const view = await childView(parent, link.studentUserId);
      if (!view || !link.phone) {
        report.skipped++;
        continue;
      }
      const message = buildDigest(view, since, portalUrl);
      if (!message.send) {
        report.skipped++;
        continue;
      }

      // The row first, keyed by the week: a second run this week inserts
      // nothing and therefore sends nothing.
      const id = randomUUID();
      const inserted = await withTenant(organizationId, (tx) =>
        tx.whatsappMessage.createMany({
          data: [
            {
              id,
              organizationId,
              parentUserId: link.parentUserId,
              studentUserId: link.studentUserId,
              template: "WEEKLY_DIGEST",
              weekOf: week,
              status: "PENDING",
            },
          ],
          skipDuplicates: true,
        }),
      );
      if (inserted.count === 0) {
        report.skipped++;
        continue;
      }

      const outcome = await sendWhatsapp({ phone: link.phone, template: "WEEKLY_DIGEST", values: message.values });
      await withTenant(organizationId, (tx) =>
        tx.whatsappMessage.update({
          where: { id },
          data: outcome.ok
            ? { status: "SENT", provider: outcome.provider, providerMessageId: outcome.providerMessageId, sentAt: new Date() }
            : {
                status: outcome.reason === "not-configured" ? "SKIPPED" : "FAILED",
                provider: outcome.provider,
                error: outcome.detail.slice(0, 500),
              },
        }),
      );
      if (outcome.ok) report.sent++;
      else if (outcome.reason === "not-configured") report.skipped++;
      else report.failed++;
    }
  }
  return report;
}

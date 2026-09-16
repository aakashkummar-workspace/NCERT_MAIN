import { prisma } from "./client";

/**
 * The cross-tenant seam for scheduled jobs — and, like `unscoped.ts`, the only
 * one.
 *
 * A nightly job has the mirror image of sign-in's problem. Sign-in cannot scope
 * a lookup because it does not yet know the tenant; a sweep cannot scope one
 * because it has to visit *every* tenant, and RLS will show it exactly one.
 *
 * Rather than give cron a role that bypasses RLS — which would put a
 * BYPASSRLS connection string in an environment variable, one leaked secret
 * away from every customer's data — the job asks a SECURITY DEFINER function
 * for the *list of tenants with work to do* and nothing else. The work itself
 * then happens tenant by tenant inside withTenant(), under the same policies as
 * a request from a browser.
 *
 * The functions here return ids, never rows. That is the property to preserve:
 * the worst a bug in a caller can do with an organization id is open a
 * correctly scoped transaction.
 */

/**
 * Organizations holding at least one attempt whose clock has run out while
 * nobody was watching. Usually empty; usually one or two rows when it is not.
 */
export async function organizationsWithExpiredAttempts(
  now: Date,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ organization_id: string }[]>`
    select * from app_maint_orgs_with_expired_attempts(${now})
  `;
  return rows.map((row) => row.organization_id);
}

/**
 * Organizations whose mastery estimates have not been recomputed since a
 * cutoff. Ids only, like everything else here.
 */
export async function organizationsWithStaleMastery(
  before: Date,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ organization_id: string }[]>`
    select * from app_maint_orgs_with_stale_mastery(${before})
  `;
  return rows.map((row) => row.organization_id);
}

/**
 * Organizations holding mistakes nothing has typed yet.
 *
 * The nightly classification pass is the highest-volume AI operation in the
 * product, so it must not wake for tenants with nothing to do. Ids only, as
 * always.
 */
export async function organizationsWithUnclassifiedMistakes(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ organization_id: string }[]>`
    select * from app_maint_orgs_with_unclassified_mistakes()
  `;
  return rows.map((row) => row.organization_id);
}

/**
 * Organizations with webhook work waiting.
 *
 * Three kinds, and the third is the one that is easy to forget: unpublished
 * outbox rows, delivery jobs whose backoff has elapsed, and jobs left RUNNING
 * by a runner that died — whose lock has since expired and which would
 * otherwise sit there looking busy forever.
 *
 * Ids only, like everything else here. The fan-out and the delivery both happen
 * one tenant at a time inside withTenant(), under the same policies a browser
 * request gets.
 */
export async function organizationsWithWebhookWork(
  now: Date,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ organization_id: string }[]>`
    select * from app_maint_orgs_with_webhook_work(${now})
  `;
  return rows.map((row) => row.organization_id);
}

/**
 * The organization the shared question library is copied FROM, by slug.
 * One exact identifier in, one id out — or null.
 */
export async function librarySourceOrganization(slug: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string | null }[]>`
    select app_maint_library_source(${slug}) as id
  `;
  return rows[0]?.id ?? null;
}

/**
 * CBSE organizations waiting for the question library, oldest request first.
 * Ids only, and a bounded number per call: a copy is thousands of rows.
 */
export async function organizationsNeedingLibrary(
  sourceOrganizationId: string,
  includeExemplar: boolean,
  limit: number,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ organization_id: string }[]>`
    select * from app_maint_orgs_needing_library(
      ${sourceOrganizationId}::uuid, ${includeExemplar}, ${limit}::int
    )
  `;
  return rows.map((row) => row.organization_id);
}

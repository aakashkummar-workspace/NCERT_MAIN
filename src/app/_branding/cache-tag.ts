import { revalidateTag } from "next/cache";

/**
 * The cache tag for everything a signed-in shell reads about a school's look.
 *
 * Branding is read on every signed-in page and changes a few times a year, and
 * reading it is an entitlement check plus the branding row — two tenant
 * transactions to a database a network hop away, over a second per click. So
 * `brandFor` caches it across requests, and every route that can change the
 * answer (branding, logo, plan) expires it here, immediately rather than
 * stale-while-revalidate: a school that pressed Save must see its colours on
 * the next page, not the one after.
 */
export const brandTag = (organizationId: string) => `brand:${organizationId}`;

export function expireBrand(organizationId: string) {
  revalidateTag(brandTag(organizationId), { expire: 0 });
}

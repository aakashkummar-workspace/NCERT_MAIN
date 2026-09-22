import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";

/**
 * Beyond marks: the holistic section of a term report.
 *
 * NEP 2020 asks for a progress card that describes the whole child, not only
 * their marks. This is that section in its plainest honest form: a teacher's
 * observation, per area, as a word and a sentence — recorded by a person who
 * has seen the child, never inferred from test data, and never averaged.
 *
 * It does not claim to be PARAKH's official Holistic Progress Card template;
 * a school that must file that form still does. What it gives a parent is the
 * same thing that template is for: what the teacher sees beyond the marks.
 *
 * Four levels, all of them words. A number here would be a score for
 * curiosity, which is exactly the thing this section exists NOT to be.
 */

export const DOMAINS = [
  { key: "CURIOSITY", label: "Curiosity and questioning" },
  { key: "COMMUNICATION", label: "Expressing ideas" },
  { key: "COLLABORATION", label: "Working with others" },
  { key: "SELF_MANAGEMENT", label: "Organisation and effort" },
  { key: "CREATIVITY", label: "Creativity" },
  { key: "WELLBEING", label: "Participation and well-being" },
] as const;

export const LEVELS = ["Beginning", "Growing", "Confident", "Leading"] as const;

export type DomainKey = (typeof DOMAINS)[number]["key"];
export type Level = (typeof LEVELS)[number];

export type HolisticEntry = { domain: DomainKey; level: Level; note: string | null };
export type HolisticLine = { domain: string; label: string; level: Level; note: string | null };

type Actor = { organizationId: string; userId: string; role: string };

const STAFF = new Set(["OWNER", "ADMIN", "TEACHER"]);

/** Record one observation round. Every domain is optional; none is invented. */
export async function recordObservations(
  actor: Actor,
  studentUserId: string,
  entries: HolisticEntry[],
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!STAFF.has(actor.role)) return { ok: false, message: "Only staff record observations." };
  const valid = entries.filter(
    (entry) =>
      DOMAINS.some((domain) => domain.key === entry.domain) && (LEVELS as readonly string[]).includes(entry.level),
  );
  if (valid.length === 0) return { ok: false, message: "Choose a level for at least one area." };

  const saved = await withTenant(actor.organizationId, async (tx) => {
    const member = await tx.membership.findFirst({
      where: { userId: studentUserId, role: "STUDENT", status: "ACTIVE" },
      select: { id: true },
    });
    if (!member) return false;
    const now = new Date();
    await tx.holisticObservation.createMany({
      data: valid.map((entry) => ({
        id: randomUUID(),
        organizationId: actor.organizationId,
        studentUserId,
        domain: entry.domain,
        level: entry.level,
        note: entry.note?.trim() ? entry.note.trim().slice(0, 400) : null,
        observedById: actor.userId,
        observedAt: now,
      })),
    });
    return true;
  });
  if (!saved) return { ok: false, message: "We could not find that student." };
  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "student.holistic_observed",
    entityType: "user",
    entityId: studentUserId,
    after: { domains: valid.map((entry) => entry.domain) },
  });
  return { ok: true };
}

/**
 * The latest observation per domain, up to `until` and from `since` — the
 * rows a report stamps. Pure over the rows, in DOMAINS order.
 */
export function latestPerDomain(
  rows: { domain: string; level: string; note: string | null; observedAt: Date }[],
  since: Date,
  until: Date,
): HolisticLine[] {
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (row.observedAt < since || row.observedAt > until) continue;
    const current = latest.get(row.domain);
    if (!current || row.observedAt > current.observedAt) latest.set(row.domain, row);
  }
  return DOMAINS.flatMap((domain) => {
    const row = latest.get(domain.key);
    if (!row || !(LEVELS as readonly string[]).includes(row.level)) return [];
    return [{ domain: domain.key, label: domain.label, level: row.level as Level, note: row.note }];
  });
}

/** The latest observation per area over the last year — to start the form from. */
export async function recentHolistic(organizationId: string, studentUserId: string): Promise<HolisticLine[]> {
  const now = new Date();
  return holisticFor(organizationId, studentUserId, new Date(now.getTime() - 365 * 24 * 3600_000), now);
}

export async function holisticFor(
  organizationId: string,
  studentUserId: string,
  since: Date,
  until: Date,
): Promise<HolisticLine[]> {
  const rows = await withTenant(organizationId, (tx) =>
    tx.holisticObservation.findMany({
      where: { studentUserId, observedAt: { gte: since, lte: until } },
      select: { domain: true, level: true, note: true, observedAt: true },
    }),
  );
  return latestPerDomain(rows, since, until);
}

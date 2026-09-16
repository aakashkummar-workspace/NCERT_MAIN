import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUp } from "@/core/identity/accounts";
import { copyLibraryInto, loadLibrary } from "@/core/library";
import { prisma } from "@/db/client";
import { organizationsNeedingLibrary } from "@/db/maintenance";
import { platformPrisma } from "@/db/platform";
import { withTenant } from "@/db/tenant";
import { makeWorld, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
  await platformPrisma.$disconnect();
});

/**
 * The library is decided by copyright. These tests build a source of their own
 * — never the real Sirah Digital bank — with one question of each kind, and
 * copy it into a fresh school.
 */
let source: World;
let originalId: string;
let exemplarId: string;
let unstampedId: string;

async function school(boardCode = "CBSE") {
  const result = await signUp({
    fullName: "Library Owner",
    email: `library-${randomUUID()}@example.test`,
    password: "a-long-enough-password",
    organizationName: `Library School ${randomUUID().slice(0, 6)}`,
    organizationType: "TUITION_CENTRE",
    boardCode,
  });
  if (!result.ok) throw new Error("signUp failed");
  return result.organizationId;
}

beforeAll(async () => {
  source = await makeWorld();
  [originalId, exemplarId] = source.questionIds as [string, string];
  await withTenant(source.organizationId, async (tx) => {
    await tx.question.update({ where: { id: originalId }, data: { provenance: "ORIGINAL" } });
    await tx.question.update({ where: { id: exemplarId }, data: { provenance: "NCERT_EXEMPLAR" } });
  });
  const third = await makeWorld();
  unstampedId = third.questionIds[0]!;
});

describe("what the library holds", () => {
  it("is the ORIGINAL questions only, until Exemplar is switched on", async () => {
    const library = await loadLibrary(source.organizationId, false);
    expect(library.map((q) => q.id)).toEqual([originalId]);
  });

  it("adds the Exemplar questions when they are allowed", async () => {
    const library = await loadLibrary(source.organizationId, true);
    expect(library.map((q) => q.id).sort()).toEqual([originalId, exemplarId].sort());
  });

  it("never holds an unstamped question, whoever wrote it", async () => {
    const library = await loadLibrary(source.organizationId, true);
    expect(library.map((q) => q.id)).not.toContain(unstampedId);
  });
});

describe("copying into a school", () => {
  it("gives the school its own approved rows, with the wording and the outcomes", async () => {
    const target = await school();
    const library = await loadLibrary(source.organizationId, false);

    const result = await copyLibraryInto(target, library, false);
    expect(result.copied).toBe(1);

    const copy = await withTenant(target, (tx) =>
      tx.question.findFirstOrThrow({
        where: { libraryOriginId: originalId },
        include: { versions: true, outcomes: true },
      }),
    );
    expect(copy.organizationId).toBe(target);
    expect(copy.status).toBe("APPROVED");
    expect(copy.provenance).toBe("ORIGINAL");
    // The approval happened in the library; nobody in this school made it.
    expect(copy.approvedById).toBeNull();
    expect(copy.versions[0]!.stem).toBe(library[0]!.version.stem);
    expect(copy.outcomes.map((o) => o.learningOutcomeId)).toEqual(
      library[0]!.outcomes.map((o) => o.learningOutcomeId),
    );

    // And the source cannot see it: it is the school's row, behind its policy.
    const seenBySource = await withTenant(source.organizationId, (tx) =>
      tx.question.count({ where: { id: copy.id } }),
    );
    expect(seenBySource).toBe(0);
  });

  it("copies nothing twice, and adds only the Exemplar questions when they are switched on", async () => {
    const target = await school();
    await copyLibraryInto(target, await loadLibrary(source.organizationId, false), false);

    const again = await copyLibraryInto(target, await loadLibrary(source.organizationId, false), false);
    expect(again).toMatchObject({ copied: 0, alreadyHeld: 1 });

    const withExemplar = await copyLibraryInto(target, await loadLibrary(source.organizationId, true), true);
    expect(withExemplar).toMatchObject({ copied: 1, alreadyHeld: 1 });

    const org = await withTenant(target, (tx) =>
      tx.organization.findUniqueOrThrow({ where: { id: target } }),
    );
    expect(org.librarySyncedAt).not.toBeNull();
    expect(org.libraryIncludesExemplar).toBe(true);
  });
});

describe("who is waiting", () => {
  // Generous, because this database holds thousands of test schools and the
  // list is oldest-first: the property is membership, not position.
  const ALL = 1_000_000;

  it("a new CBSE school is waiting until it is synced, and then it is not", async () => {
    const target = await school();
    expect(await organizationsNeedingLibrary(source.organizationId, false, ALL)).toContain(target);

    await copyLibraryInto(target, await loadLibrary(source.organizationId, false), false);
    expect(await organizationsNeedingLibrary(source.organizationId, false, ALL)).not.toContain(target);
    // Switching Exemplar on puts it back in the queue.
    expect(await organizationsNeedingLibrary(source.organizationId, true, ALL)).toContain(target);
  });

  it("never offers the library to a school on another board, or to its own source", async () => {
    const icse = await school("ICSE");
    const waiting = await organizationsNeedingLibrary(source.organizationId, true, ALL);
    expect(waiting).not.toContain(icse);
    expect(waiting).not.toContain(source.organizationId);
  });
});

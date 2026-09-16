import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withTenant } from "@/db/tenant";

/**
 * The shared question library: approved questions from one source organization,
 * COPIED into every CBSE school.
 *
 * ---------------------------------------------------------------------------
 * Copied, not shared
 * ---------------------------------------------------------------------------
 * A school gets its own rows. It can edit, archive or put a library question
 * in a paper exactly as if a teacher had typed it, everything downstream
 * (papers, attempts, evidence) is tenant data behind the policies it always
 * was, and nothing a school does to its copy reaches any other school. The
 * cost is rows — about 3,000 a school — and that a correction to the source
 * does not flow out on its own.
 *
 * ---------------------------------------------------------------------------
 * What may be copied is decided by COPYRIGHT, not by quality
 * ---------------------------------------------------------------------------
 * Only questions stamped with a provenance are candidates:
 *
 *   - ORIGINAL — written for this bank; always copied.
 *   - NCERT_EXEMPLAR — verbatim NCERT Exemplar, © NCERT. Copied only when
 *     QUESTION_LIBRARY_INCLUDE_EXEMPLAR is "true", which must not be set until
 *     NCERT has granted permission in writing. Sahayak is commercial.
 *   - unstamped — including the CBSE sample-paper drafts, whose wording is
 *     CBSE's — never.
 *
 * And only APPROVED, never deleted. An archived question is out of the
 * syllabus, and a school should not inherit a removed topic.
 *
 * ---------------------------------------------------------------------------
 * Idempotent
 * ---------------------------------------------------------------------------
 * A question is skipped when the school already holds a row copied from it
 * (`library_origin_id`) or one with the same content hash — the per-tenant
 * duplicate rule a teacher's own save already follows. Re-running, or turning
 * Exemplar on later, copies only what is missing.
 */

export type LibraryConfig =
  | { enabled: false; reason: string }
  | { enabled: true; sourceSlug: string; includeExemplar: boolean };

export function libraryConfig(env: NodeJS.ProcessEnv = process.env): LibraryConfig {
  const sourceSlug = env.QUESTION_LIBRARY_SOURCE?.trim();
  if (!sourceSlug) {
    return { enabled: false, reason: "QUESTION_LIBRARY_SOURCE is not set" };
  }
  return {
    enabled: true,
    sourceSlug,
    includeExemplar: env.QUESTION_LIBRARY_INCLUDE_EXEMPLAR?.trim() === "true",
  };
}

export type LibraryQuestion = {
  id: string;
  subjectId: string;
  chapterId: string | null;
  primaryOutcomeId: string | null;
  type: Prisma.QuestionCreateManyInput["type"];
  difficulty: Prisma.QuestionCreateManyInput["difficulty"];
  marks: number;
  expectedTimeSeconds: number | null;
  provenance: "ORIGINAL" | "NCERT_EXEMPLAR";
  contentHash: Uint8Array<ArrayBuffer> | null;
  version: {
    stem: string;
    options: Prisma.JsonValue;
    answerKey: Prisma.JsonValue;
    rubric: Prisma.JsonValue;
    explanation: string | null;
    hint: string | null;
  };
  outcomes: { learningOutcomeId: string; weight: Prisma.Decimal; isPrimary: boolean }[];
};

/** Everything the library holds, read inside the SOURCE organization's own tenant. */
export async function loadLibrary(
  sourceOrganizationId: string,
  includeExemplar: boolean,
): Promise<LibraryQuestion[]> {
  return withTenant(sourceOrganizationId, async (tx) => {
    const rows = await tx.question.findMany({
      where: {
        deletedAt: null,
        status: "APPROVED",
        // A copy is never re-exported: the library is what the source wrote.
        libraryOriginId: null,
        provenance: { in: includeExemplar ? ["ORIGINAL", "NCERT_EXEMPLAR"] : ["ORIGINAL"] },
      },
      include: {
        versions: { orderBy: { version: "desc" }, take: 1 },
        outcomes: true,
      },
      orderBy: { createdAt: "asc" },
    });
    return rows.flatMap((row) => {
      const current = row.versions[0];
      if (!current || !row.provenance) return [];
      return [
        {
          id: row.id,
          subjectId: row.subjectId,
          chapterId: row.chapterId,
          primaryOutcomeId: row.primaryOutcomeId,
          type: row.type,
          difficulty: row.difficulty,
          marks: row.marks,
          expectedTimeSeconds: row.expectedTimeSeconds,
          provenance: row.provenance,
          contentHash: row.contentHash ? new Uint8Array(row.contentHash) : null,
          version: {
            stem: current.stem,
            options: current.options,
            answerKey: current.answerKey,
            rubric: current.rubric,
            explanation: current.explanation,
            hint: current.hint,
          },
          outcomes: row.outcomes.map((o) => ({
            learningOutcomeId: o.learningOutcomeId,
            weight: o.weight,
            isPrimary: o.isPrimary,
          })),
        },
      ];
    });
  });
}

export type CopyResult = {
  organizationId: string;
  copied: number;
  alreadyHeld: number;
};

/** Rows per transaction: small enough to stay far inside withTenant's timeout. */
const BATCH = 400;

const hex = (bytes: Uint8Array | null) => (bytes ? Buffer.from(bytes).toString("hex") : null);

/**
 * Copy what a school does not already hold, then stamp it synced.
 *
 * The rows are written as the school's OWNER, because `created_by_id` must name
 * somebody the school's own screens can resolve — a user from the source
 * organization is invisible to them. `approved_by_id` is left empty and
 * `approved_at` stamped: the approval happened in the library, not in this
 * school, and naming the owner as the approver would put a decision in their
 * name they never made. The audit row says where the questions came from.
 */
export async function copyLibraryInto(
  targetOrganizationId: string,
  library: LibraryQuestion[],
  includeExemplar: boolean,
): Promise<CopyResult> {
  const { ownerId, heldOrigins, heldHashes } = await withTenant(targetOrganizationId, async (tx) => {
    const owner = await tx.membership.findFirst({
      where: { role: "OWNER", status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: { userId: true },
    });
    const held = await tx.question.findMany({
      where: { deletedAt: null },
      select: { libraryOriginId: true, contentHash: true },
    });
    return {
      ownerId: owner?.userId ?? null,
      heldOrigins: new Set(held.map((q) => q.libraryOriginId).filter((id): id is string => Boolean(id))),
      heldHashes: new Set(held.map((q) => hex(q.contentHash ? new Uint8Array(q.contentHash) : null)).filter(Boolean)),
    };
  });

  if (!ownerId) {
    throw new Error("The organization has no active owner to hold the copied questions.");
  }

  const missing = library.filter(
    (q) => !heldOrigins.has(q.id) && !(q.contentHash && heldHashes.has(hex(q.contentHash))),
  );
  const now = new Date();

  for (let start = 0; start < missing.length; start += BATCH) {
    const batch = missing.slice(start, start + BATCH);
    const questions: Prisma.QuestionCreateManyInput[] = [];
    const versions: Prisma.QuestionVersionCreateManyInput[] = [];
    const outcomes: Prisma.QuestionOutcomeCreateManyInput[] = [];

    for (const q of batch) {
      const questionId = randomUUID();
      const versionId = randomUUID();
      questions.push({
        id: questionId,
        organizationId: targetOrganizationId,
        visibility: "ORGANIZATION",
        createdById: ownerId,
        subjectId: q.subjectId,
        chapterId: q.chapterId,
        primaryOutcomeId: q.primaryOutcomeId,
        type: q.type,
        difficulty: q.difficulty,
        marks: q.marks,
        expectedTimeSeconds: q.expectedTimeSeconds,
        status: "APPROVED",
        source: "IMPORTED",
        provenance: q.provenance,
        libraryOriginId: q.id,
        currentVersionId: versionId,
        approvedAt: now,
        contentHash: q.contentHash ? new Uint8Array(q.contentHash) : null,
      });
      versions.push({
        id: versionId,
        questionId,
        version: 1,
        stem: q.version.stem,
        options: (q.version.options ?? undefined) as Prisma.InputJsonValue | undefined,
        answerKey: (q.version.answerKey ?? undefined) as Prisma.InputJsonValue | undefined,
        rubric: (q.version.rubric ?? undefined) as Prisma.InputJsonValue | undefined,
        explanation: q.version.explanation,
        hint: q.version.hint,
        createdById: ownerId,
      });
      for (const o of q.outcomes) {
        outcomes.push({
          questionId,
          learningOutcomeId: o.learningOutcomeId,
          weight: o.weight,
          isPrimary: o.isPrimary,
        });
      }
    }

    // Postgres applies the SELECT policy to INSERT ... RETURNING, so these are
    // createMany with ids made here — the roster's rule, for the same reason.
    await withTenant(targetOrganizationId, async (tx) => {
      await tx.question.createMany({ data: questions });
      await tx.questionVersion.createMany({ data: versions });
      if (outcomes.length > 0) await tx.questionOutcome.createMany({ data: outcomes });
    });
  }

  await withTenant(targetOrganizationId, async (tx) => {
    await tx.organization.update({
      where: { id: targetOrganizationId },
      data: {
        librarySyncedAt: now,
        libraryIncludesExemplar: includeExemplar,
      },
    });
    await tx.auditLog.create({
      data: {
        organizationId: targetOrganizationId,
        actorRole: "SYSTEM",
        action: "question_library.copied",
        entityType: "organization",
        entityId: targetOrganizationId,
        after: {
          copied: missing.length,
          alreadyHeld: library.length - missing.length,
          includesExemplar: includeExemplar,
        },
      },
    });
  });

  return {
    organizationId: targetOrganizationId,
    copied: missing.length,
    alreadyHeld: library.length - missing.length,
  };
}

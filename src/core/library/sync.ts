import "server-only";
import { librarySourceOrganization, organizationsNeedingLibrary } from "@/db/maintenance";
import { copyLibraryInto, libraryConfig, loadLibrary, type CopyResult } from "./index";

/**
 * The library sweep: find the CBSE schools still waiting for the question
 * library and copy it into a few of them.
 *
 * A few per run, not all: one copy is thousands of rows, and a scheduler that
 * calls this every few minutes drains a backlog steadily without any single
 * run holding connections for long. A brand-new school is requested by its own
 * insert and gets the library on the next run — signup itself does nothing
 * extra, because it is a path that must not fail.
 *
 * Like every scheduled job: it asks which tenants have work (ids only), then
 * does the work one tenant at a time inside withTenant(). One school that
 * throws is reported and does not stop the others.
 */
export type LibrarySyncReport =
  | { enabled: false; reason: string }
  | {
      enabled: true;
      includesExemplar: boolean;
      libraryQuestions: number;
      organizations: CopyResult[];
      failures: { organizationId: string; message: string }[];
    };

export const ORGANIZATIONS_PER_RUN = 5;

export async function syncLibrary(
  options: { limit?: number } = {},
): Promise<LibrarySyncReport> {
  const config = libraryConfig();
  if (!config.enabled) return { enabled: false, reason: config.reason };

  const sourceId = await librarySourceOrganization(config.sourceSlug);
  if (!sourceId) {
    return {
      enabled: false,
      reason: `No organization has the slug "${config.sourceSlug}" (QUESTION_LIBRARY_SOURCE)`,
    };
  }

  const waiting = await organizationsNeedingLibrary(
    sourceId,
    config.includeExemplar,
    options.limit ?? ORGANIZATIONS_PER_RUN,
  );
  if (waiting.length === 0) {
    return {
      enabled: true,
      includesExemplar: config.includeExemplar,
      libraryQuestions: 0,
      organizations: [],
      failures: [],
    };
  }

  // Read once per run, not once per school.
  const library = await loadLibrary(sourceId, config.includeExemplar);
  const organizations: CopyResult[] = [];
  const failures: { organizationId: string; message: string }[] = [];

  for (const organizationId of waiting) {
    try {
      organizations.push(await copyLibraryInto(organizationId, library, config.includeExemplar));
    } catch (error) {
      failures.push({
        organizationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    enabled: true,
    includesExemplar: config.includeExemplar,
    libraryQuestions: library.length,
    organizations,
    failures,
  };
}

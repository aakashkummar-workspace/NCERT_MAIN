/**
 * Give existing schools the shared question library, or run the sweep by hand.
 *
 *     npx tsx --conditions=react-server scripts/share-question-library.ts --list
 *     npx tsx --conditions=react-server scripts/share-question-library.ts --org <slug> [--commit]
 *     npx tsx --conditions=react-server scripts/share-question-library.ts --sweep [--limit 5]
 *
 * New schools are requested automatically when they are created, and the
 * scheduled sweep (POST /api/cron/share-library/) fills them in. Schools that
 * existed before the library were deliberately NOT requested by the migration —
 * in a development database most organizations are test tenants — so a real
 * one is given the library here, by name.
 *
 * `--org` is a dry run unless `--commit`: it says how many questions the school
 * would receive and how many it already holds.
 */
import { PrismaClient } from "@prisma/client";
import { copyLibraryInto, libraryConfig, loadLibrary } from "../src/core/library";
import { syncLibrary } from "../src/core/library/sync";

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

async function main() {
  const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
  const config = libraryConfig();
  try {
    if (!config.enabled) throw new Error(config.reason);
    const source = await db.organization.findUnique({ where: { slug: config.sourceSlug } });
    if (!source) throw new Error(`No organization has the slug "${config.sourceSlug}".`);

    if (process.argv.includes("--list")) {
      const orgs = await db.organization.findMany({
        where: { deletedAt: null, board: { code: "CBSE" }, id: { not: source.id } },
        select: { slug: true, name: true, createdAt: true, libraryRequestedAt: true, librarySyncedAt: true },
        orderBy: { createdAt: "asc" },
      });
      console.log(`${orgs.length} CBSE organizations (source: ${source.name})`);
      for (const o of orgs) {
        const state = o.librarySyncedAt ? "synced" : o.libraryRequestedAt ? "waiting" : "not requested";
        console.log(`  ${state.padEnd(14)} ${o.slug.padEnd(40)} ${o.name}`);
      }
      return;
    }

    if (process.argv.includes("--sweep")) {
      const limit = Number(arg("--limit") ?? 5);
      console.log(JSON.stringify(await syncLibrary({ limit }), null, 2));
      return;
    }

    const slug = arg("--org");
    if (!slug) throw new Error("Pass --list, --sweep, or --org <slug>.");
    const target = await db.organization.findUnique({ where: { slug }, include: { board: true } });
    if (!target) throw new Error(`No organization has the slug "${slug}".`);
    if (target.id === source.id) throw new Error("That is the library's own source organization.");
    if (target.board.code !== "CBSE") throw new Error(`${target.name} teaches ${target.board.code}; the library is CBSE.`);

    const library = await loadLibrary(source.id, config.includeExemplar);
    const commit = process.argv.includes("--commit");
    console.log(`\nQuestion library → ${target.name} — ${commit ? "COMMIT" : "dry run"}`);
    console.log(`  library questions   ${library.length} (${config.includeExemplar ? "including" : "excluding"} NCERT Exemplar)`);
    if (!commit) {
      const held = await db.question.count({
        where: { organizationId: target.id, deletedAt: null, libraryOriginId: { in: library.map((q) => q.id) } },
      });
      console.log(`  already held        ${held}`);
      console.log("\nNothing written. Re-run with --commit to apply.");
      return;
    }
    await db.organization.update({
      where: { id: target.id },
      data: { libraryRequestedAt: target.libraryRequestedAt ?? new Date() },
    });
    const result = await copyLibraryInto(target.id, library, config.includeExemplar);
    console.log(`  copied              ${result.copied}`);
    console.log(`  already held        ${result.alreadyHeld}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

/**
 * Fails on stray control bytes in source.
 *
 * A `\b` pushed through two layers of shell and Python escaping once landed in
 * a .tsx file as a literal backspace (0x08). It was invisible in every editor
 * and every diff, and broke the build with a message that named nothing useful.
 * Cheap to check, expensive to find by hand.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOTS = ["src", "prisma", "scripts", "tests"];
const EXTENSIONS = new Set([".ts", ".tsx", ".css", ".sql", ".mjs", ".js", ".json", ".md"]);
const ALLOWED = new Set([9, 10, 13]); // tab, newline, carriage return

const problems = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      walk(path);
      continue;
    }
    if (!EXTENSIONS.has(extname(entry))) continue;

    const bytes = readFileSync(path);
    let found = false;
    for (const [index, byte] of bytes.entries()) {
      if (byte < 32 && !ALLOWED.has(byte)) {
        problems.push(`${path}: control byte 0x${byte.toString(16).padStart(2, "0")} at offset ${index}`);
        found = true;
        break;
      }
    }
    if (found) continue;

    // C1 controls (U+0080–U+009F) and invalid UTF-8. The byte check above
    // cannot see them: an escape pushed through Python once turned "\203A" into
    // U+0083, which is two ordinary-looking bytes, and a CSS caret became a
    // rotated letter "a" beside every score a student was shown.
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 0xfffd) {
        problems.push(`${path}: invalid UTF-8 near character ${index}`);
        break;
      }
      if (code >= 0x80 && code <= 0x9f) {
        const line = text.slice(0, index).split("\n").length;
        problems.push(`${path}: C1 control character U+00${code.toString(16).toUpperCase()} on line ${line}`);
        break;
      }
    }
  }
}

for (const root of ROOTS) {
  try {
    walk(root);
  } catch {
    // A root that does not exist yet is not a problem.
  }
}

if (problems.length > 0) {
  console.error(`\nStray control bytes in ${problems.length} file(s):\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("\nThese are invisible in an editor and in a diff. Rewrite the file.\n");
  process.exit(1);
}

console.log("Encoding clean — no stray control bytes.");

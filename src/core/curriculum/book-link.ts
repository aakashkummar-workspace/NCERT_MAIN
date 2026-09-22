import type { ChapterContents } from "./chapter-contents";

/**
 * "Revisit §6.4 in your book" — which section of the NCERT chapter an idea
 * lives in, read from the chapter's own printed contents.
 *
 * Pure and deterministic: no model. The book's sections, their titles and the
 * points under them were read from the PDFs (prisma/chapter-contents), and
 * matching a concept's words against them is counting, not judgement.
 *
 * ---------------------------------------------------------------------------
 * It names a section only when the match is clear
 * ---------------------------------------------------------------------------
 * A pointer to the wrong section is worse than no pointer: a student sent to
 * reread §6.2 for a question about §6.4 reads a page that does not help and
 * concludes the book does not either. So a section is named only when it
 * shares enough of the idea's own words AND beats the runner-up; otherwise
 * the link is the chapter, which is never wrong. "Introduction" and
 * "Summary" sections are never named — they mention everything.
 */

export type BookLink = {
  bookTitle: string;
  chapterNumber: number;
  chapterTitle: string;
  /** Null when no single section is a clear match; the chapter is then the link. */
  section: { number: string | null; title: string } | null;
};

const STOP = new Set(
  (
    "about above after again against also among another answer answers any are because been before being " +
    "below between both but can cannot could does doing down during each find from given have having here " +
    "into its itself just many more most much must need only other over same should show shown some such " +
    "than that their them then there these they this those through under using very what when where which " +
    "while will with within without would your write student students question questions using identify " +
    "explain state describe calculate solve apply determine chapter section example examples " +
    "and the for are has how its not all one two was who why use get let her him his our out you may"
  ).split(" "),
);

/** Words worth matching on, crudely stemmed so "triangles" meets "triangle". */
export function keywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .normalize("NFKD")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOP.has(word));
  return new Set(words.map(stem));
}

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

const SKIP_TITLES = /^(introduction|summary|let us recap|exercise|points to remember)\b/i;

/**
 * Enough shared evidence to say "this section", and a clear lead over the
 * runner-up. In units of rarity-weighted words: a word every section of the
 * chapter uses ("progression", in the chapter on progressions) counts for
 * almost nothing, and the word only one section uses counts for most.
 */
export const MIN_SCORE = 2;
export const MIN_LEAD = 0.5;
/**
 * And it must beat the runner-up by half as much again. Measured, not chosen:
 * over the 197 concepts in the CBSE drafts, every link checked by hand as
 * RIGHT led by 1.6× or more, and every one checked as WRONG ("tangent ⟂
 * radius" → §10.3, "reactions of carbon compounds" → soaps) led by under
 * 1.5×. The bar costs a few correct links — they fall back to the chapter,
 * which is never wrong — and removes the confidently misleading ones.
 */
export const MIN_RATIO = 1.5;

/**
 * And the winning heading must carry at least half the NAME's own words.
 * The statements under a concept are long and match long sections by volume;
 * the name is what the idea is called, and a heading that shares none of it
 * ("Tree diagrams" for "Experimental and theoretical probability") is not
 * where it is taught, however many body words it shares.
 */
export const MIN_NAME_COVERAGE = 0.5;

export function bookLinkFor(
  contents: ChapterContents,
  chapterTitle: string,
  name: string,
  statements: string[] = [],
): BookLink {
  const about = [name, ...statements];
  // Words in the chapter's own title name the CHAPTER, not a section: every
  // idea in "Arithmetic Progressions" mentions progressions, and letting that
  // word vote sent "the nth term of an AP" to the section titled with it.
  const chapterWords = keywords(chapterTitle);
  const query = new Set([...keywords(about.join(" "))].filter((word) => !chapterWords.has(word)));
  const pool = contents.sections
    .flatMap((section) => [
      { number: section.number, title: section.title, body: section.points.join(" ") },
      ...section.subsections.map((sub) => ({
        number: sub.number,
        title: sub.title,
        body: sub.points.join(" "),
      })),
    ])
    .filter((section) => !SKIP_TITLES.test(section.title))
    .map((section) => ({ ...section, inTitle: keywords(section.title), inBody: keywords(section.body) }));

  // How many sections use each word: the rarer, the more it says.
  const spread = new Map<string, number>();
  for (const section of pool) {
    for (const word of new Set([...section.inTitle, ...section.inBody])) {
      spread.set(word, (spread.get(word) ?? 0) + 1);
    }
  }
  // Smoothed, so a chapter with only two sections still has something to
  // weigh: a word in both counts log 2, a word in one counts log 3.
  const rarity = (word: string) => Math.log(1 + pool.length / Math.max(1, spread.get(word) ?? 0));

  const candidates = pool
    .map((section) => {
      let total = 0;
      let titled = false;
      for (const word of query) {
        // A word in the title counts double: a heading is what a section is FOR.
        if (section.inTitle.has(word)) {
          total += 2 * rarity(word);
          titled = true;
        } else if (section.inBody.has(word)) total += rarity(word);
      }
      return { number: section.number, title: section.title, score: total, titled, inTitle: section.inTitle };
    })
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  const runnerUp = candidates[1]?.score ?? 0;
  // And the winner's own heading must share a word with the idea: a section
  // that only mentions it in passing is not where it is taught.
  const nameWords = [...keywords(name)].filter((word) => !chapterWords.has(word));
  const covered = best ? nameWords.filter((word) => best.inTitle.has(word)).length : 0;
  const clear =
    best !== undefined &&
    nameWords.length > 0 &&
    covered / nameWords.length >= MIN_NAME_COVERAGE &&
    best.titled &&
    best.score >= MIN_SCORE &&
    best.score - runnerUp >= MIN_LEAD &&
    best.score >= MIN_RATIO * runnerUp;

  return {
    bookTitle: contents.bookTitle,
    chapterNumber: contents.bookChapter,
    chapterTitle,
    section: clear ? { number: best.number, title: best.title } : null,
  };
}

/** One line a student reads: "Mathematics, chapter 6 (Triangles), §6.4 Criteria for Similarity". */
export function describeBookLink(link: BookLink): string {
  const chapter = `${link.bookTitle}, chapter ${link.chapterNumber} (${link.chapterTitle})`;
  if (!link.section) return chapter;
  return `${chapter}, ${link.section.number ? `§${link.section.number} ` : ""}${link.section.title}`;
}

/** The anchor the syllabus page gives a section, so a link can open at it. */
export function sectionAnchor(chapterId: string, number: string | null): string {
  return number ? `ch-${chapterId}-s-${number.replace(/[^0-9a-z]+/gi, "-")}` : `ch-${chapterId}`;
}

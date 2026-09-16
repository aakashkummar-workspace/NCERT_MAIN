/**
 * `chapters.contents`: what a chapter contains, read from the NCERT book
 * (prisma/chapter-contents, imported by scripts/import-chapter-contents.ts).
 *
 * Pure, and it parses rather than casts. The column is jsonb written by a
 * script, and a renderer that trusted its shape would draw half a chapter the
 * day someone writes a row by hand. An unknown version, or anything malformed,
 * is `null` — the page then shows the chapter without contents, which is a
 * true statement, rather than a partial block that looks complete.
 */

export type ContentsSection = {
  number: string | null;
  title: string;
  points: string[];
  subsections: { number: string | null; title: string; points: string[] }[];
};

export type ChapterContents = {
  book: string;
  bookTitle: string;
  bookChapter: number;
  pages: number | null;
  author: string | null;
  form: string | null;
  overview: string;
  sections: ContentsSection[];
  keyTerms: { term: string; meaning: string }[];
  keyResults: { label: string; statement: string }[];
  activities: string[];
  exercises: { name: string; questions: number | null }[];
  bookSummary: string[];
  notes: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const texts = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(text).filter((item): item is string => item !== null) : [];

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

export function parseChapterContents(raw: unknown): ChapterContents | null {
  if (!isRecord(raw) || raw.version !== 1) return null;
  const source = isRecord(raw.source) ? raw.source : null;
  const overview = text(raw.overview);
  if (!source || !overview || !Array.isArray(raw.sections)) return null;

  const sections: ContentsSection[] = [];
  for (const item of raw.sections) {
    if (!isRecord(item)) continue;
    const title = text(item.title);
    if (!title) continue;
    sections.push({
      number: text(item.number),
      title,
      points: texts(item.points),
      subsections: (Array.isArray(item.subsections) ? item.subsections : [])
        .filter(isRecord)
        .map((sub) => ({ number: text(sub.number), title: text(sub.title) ?? "", points: texts(sub.points) }))
        .filter((sub) => sub.title !== ""),
    });
  }

  const pairs = <K extends string, V extends string>(value: unknown, k: K, v: V) =>
    (Array.isArray(value) ? value : [])
      .filter(isRecord)
      .map((item) => ({ [k]: text(item[k]), [v]: text(item[v]) }))
      .filter((item) => item[k] !== null && item[v] !== null) as Record<K | V, string>[];

  return {
    book: text(source.book) ?? "",
    bookTitle: text(source.bookTitle) ?? "",
    bookChapter: count(source.chapter) ?? 0,
    pages: count(raw.pages),
    author: text(raw.author),
    form: text(raw.form),
    overview,
    sections,
    keyTerms: pairs(raw.keyTerms, "term", "meaning"),
    keyResults: pairs(raw.keyResults, "label", "statement"),
    activities: texts(raw.activities),
    exercises: (Array.isArray(raw.exercises) ? raw.exercises : [])
      .filter(isRecord)
      .map((item) => ({ name: text(item.name) ?? "", questions: count(item.questions) }))
      .filter((item) => item.name !== ""),
    bookSummary: texts(raw.bookSummary),
    notes: text(raw.notes),
  };
}

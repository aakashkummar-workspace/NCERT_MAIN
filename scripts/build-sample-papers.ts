/**
 * Sample papers in the CBSE board pattern, built as DRAFT assessments.
 *
 *     npx tsx --conditions=react-server scripts/build-sample-papers.ts --org <slug>                       # dry run
 *     npx tsx --conditions=react-server scripts/build-sample-papers.ts --org <slug> --commit
 *     npx tsx --conditions=react-server scripts/build-sample-papers.ts --org <slug> --commit --rebuild     # re-lay untouched drafts
 *
 * Every paper goes through the builder's own functions — createAssessment,
 * updateDraft with the pattern, setQuestions with sections and "OR" pairs — so
 * checkLayout judges it exactly as it judges a paper a teacher made by hand.
 *
 * They are DRAFTS, and cannot be anything else yet: the written questions they
 * need (VSA, SA, LA, case, assertion–reason, extracts, writing tasks) are
 * drafts, and publishCheck refuses a paper holding one. So a sample paper is
 * also a review list — a teacher opens it, approves what it holds (or swaps
 * what they would not set), and publishes. Nothing here approves a question;
 * an approval nobody read is a claim that is untrue.
 *
 * Choices it makes:
 *  - Section A of Maths, Science and Social Science is 18 APPROVED
 *    multiple-choice questions and 2 assertion–reason, the board's split.
 *  - Questions are dealt chapter by chapter in turn, so a paper covers the
 *    syllabus instead of the first four chapters, and two papers for a subject
 *    share no question.
 *  - An "OR" alternative comes from the same chapter as the question it pairs
 *    with where the bank allows — the board's alternatives test the same idea.
 *    Internal choices sit on the last questions of a section, as on the board.
 *  - Social Science Section F is the map question, and only a map question
 *    goes there (scripts/import-map-questions.ts). Class 10 Geography and
 *    History have map work; Economics, Political Science and Class 9 do not —
 *    the Class 9 map list follows the old books, which the new Class 9 book
 *    does not teach — so those papers drop Section F and carry one more long
 *    answer in Section D, keeping 80 marks. The pattern's label says so.
 *  - Class 10 Social Science is four subjects here, and a paper holds one
 *    subject, so each discipline gets its own paper in the pattern.
 *  - English has no pattern in core (patternForSubject leaves it out, rightly:
 *    it is not a section of types). Here the board's English paper is split
 *    along the subjects it spans: Reading, Grammar and Writing (40 marks) and
 *    the literature — First Flight (28) and Footprints (12) in Class 10, Kaveri
 *    (40) in Class 9. Each keeps the board's question shapes and choices. The
 *    two reading passages are one discursive and one factual, as on the board.
 *
 * Idempotent: an existing title is skipped. With --rebuild, an existing DRAFT
 * whose questions were set exactly once — by this script, and never touched
 * since — is re-laid in place; anything a person has edited is left alone.
 */
import { PrismaClient } from "@prisma/client";
import {
  createAssessment,
  setQuestions,
  updateDraft,
  DEFAULT_BLUEPRINT,
  type Blueprint,
  type LayoutInput,
} from "../src/core/assessments";
import {
  CBSE_PATTERNS,
  checkLayout,
  patternMarks,
  patternQuestionCount,
  type LayoutItem,
  type PaperPattern,
  type SectionPlan,
} from "../src/core/assessments/pattern";
import type { QuestionType } from "../src/core/questions/validate";

/** The outcomes the map questions are filed against. Only these fill Section F. */
const MAP_OUTCOMES = ["G10-03-5", "G10-05-5", "G10-05-6", "G10-06-5", "G10-07-4", "H10-02-6", "H10-02-7"];

/** Social Science where there is no map work: Section F folded into Section D. */
const SST_NO_MAP: PaperPattern = {
  key: "cbse-sst-no-map",
  label: "CBSE board pattern — Social Science (no map work: one more long answer in place of the map question)",
  durationMinutes: 180,
  sections: CBSE_PATTERNS.SST.sections
    .filter((section) => section.name !== "F")
    .map((section) => (section.name === "D" ? { ...section, count: section.count + 1 } : section)),
};

const ENGLISH_RGW: PaperPattern = {
  key: "cbse-english-rgw",
  label: "CBSE board pattern — English: Reading, Grammar and Writing (Sections A and B of the board paper)",
  durationMinutes: 90,
  sections: [
    { name: "A", title: "Reading — one discursive and one factual passage", types: ["CASE_STUDY"], count: 2, marksEach: 10, internalChoices: 0 },
    { name: "B", title: "Grammar", types: ["MCQ"], count: 10, marksEach: 1, internalChoices: 0 },
    { name: "C", title: "Writing", types: ["LA"], count: 2, marksEach: 5, internalChoices: 2 },
  ],
};

const ENGLISH_FIRST_FLIGHT: PaperPattern = {
  key: "cbse-english-first-flight",
  label: "CBSE board pattern — English literature: First Flight (Section C of the board paper)",
  durationMinutes: 60,
  sections: [
    { name: "A", title: "Reference to the context — prose and poetry extracts", types: ["CASE_STUDY"], count: 2, marksEach: 5, internalChoices: 2 },
    { name: "B", title: "Short answer", types: ["SA"], count: 4, marksEach: 3, internalChoices: 1 },
    { name: "C", title: "Long answer", types: ["LA"], count: 1, marksEach: 6, internalChoices: 1 },
  ],
};

const ENGLISH_FOOTPRINTS: PaperPattern = {
  key: "cbse-english-footprints",
  label: "CBSE board pattern — English literature: Footprints without Feet (Section C of the board paper)",
  durationMinutes: 30,
  sections: [
    { name: "A", title: "Short answer", types: ["SA"], count: 2, marksEach: 3, internalChoices: 1 },
    { name: "B", title: "Long answer", types: ["LA"], count: 1, marksEach: 6, internalChoices: 1 },
  ],
};

const ENGLISH_KAVERI: PaperPattern = {
  key: "cbse-english-kaveri",
  label: "CBSE board pattern — English literature: Kaveri (Class 9)",
  durationMinutes: 90,
  sections: [
    { name: "A", title: "Reference to the context — prose and poetry extracts", types: ["CASE_STUDY"], count: 2, marksEach: 5, internalChoices: 2 },
    { name: "B", title: "Short answer", types: ["SA"], count: 6, marksEach: 3, internalChoices: 1 },
    { name: "C", title: "Long answer", types: ["LA"], count: 2, marksEach: 6, internalChoices: 2 },
  ],
};

type Target = {
  grade: number;
  code: string;
  papers: number;
  pattern: PaperPattern;
  name?: string;
  /** Chapters a section may draw from, where the subject mixes kinds of chapter. */
  chapters?: Record<string, number[]>;
};

const GRAMMAR = [1, 2, 3, 4, 5];

const TARGETS: Target[] = [
  { grade: 10, code: "MATH", papers: 2, pattern: CBSE_PATTERNS.MATH },
  { grade: 10, code: "SCI", papers: 2, pattern: CBSE_PATTERNS.SCI },
  { grade: 10, code: "SST", papers: 1, pattern: CBSE_PATTERNS.SST, name: "Social Science (Geography)" },
  { grade: 10, code: "SSTEC", papers: 1, pattern: SST_NO_MAP, name: "Social Science (Economics)" },
  { grade: 10, code: "SSTHI", papers: 1, pattern: CBSE_PATTERNS.SST, name: "Social Science (History)" },
  { grade: 10, code: "SSTPS", papers: 1, pattern: SST_NO_MAP, name: "Social Science (Political Science)" },
  { grade: 10, code: "ENGGW", papers: 2, pattern: ENGLISH_RGW, name: "English: Reading, Grammar and Writing", chapters: { A: [8], B: GRAMMAR, C: [6, 7] } },
  { grade: 10, code: "ENG", papers: 2, pattern: ENGLISH_FIRST_FLIGHT, name: "English Literature: First Flight" },
  { grade: 10, code: "ENGFP", papers: 2, pattern: ENGLISH_FOOTPRINTS, name: "English Literature: Footprints without Feet" },
  { grade: 9, code: "MATH", papers: 2, pattern: CBSE_PATTERNS.MATH },
  { grade: 9, code: "SCI", papers: 2, pattern: CBSE_PATTERNS.SCI },
  { grade: 9, code: "SST", papers: 2, pattern: SST_NO_MAP },
  { grade: 9, code: "ENGGW", papers: 2, pattern: ENGLISH_RGW, name: "English: Reading, Grammar and Writing", chapters: { A: [8], B: GRAMMAR, C: [6, 7] } },
  { grade: 9, code: "ENG", papers: 2, pattern: ENGLISH_KAVERI, name: "English Literature: Kaveri" },
];

/** Section A of the Maths, Science and Social Science patterns: how many assertion–reason. */
const SECTION_A_AR = 2;

type Candidate = {
  id: string;
  type: string;
  marks: number;
  chapter: number;
  status: string;
  map: boolean;
  stemLength: number;
};

/** Chapter 1's first, chapter 2's first, … then everybody's second. */
function interleave(candidates: Candidate[]): Candidate[] {
  const byChapter = new Map<number, Candidate[]>();
  for (const candidate of candidates) {
    byChapter.set(candidate.chapter, [...(byChapter.get(candidate.chapter) ?? []), candidate]);
  }
  const lists = [...byChapter.keys()].sort((a, b) => a - b).map((key) => byChapter.get(key)!);
  const out: Candidate[] = [];
  for (let round = 0; out.length < candidates.length; round++) {
    for (const list of lists) if (list[round]) out.push(list[round]!);
  }
  return out;
}

/**
 * The reading passages alternate discursive and factual. CBSE sets one of each,
 * and the bank tells them apart only by length: a discursive passage is 380–470
 * words, a factual one 180–270 (scripts/check-english-questions.mjs).
 */
function alternateByLength(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates].sort((a, b) => b.stemLength - a.stemLength);
  const half = Math.ceil(sorted.length / 2);
  const long = sorted.slice(0, half);
  const short = sorted.slice(half);
  const out: Candidate[] = [];
  for (let i = 0; i < Math.max(long.length, short.length); i++) {
    if (long[i]) out.push(long[i]!);
    if (short[i]) out.push(short[i]!);
  }
  return out;
}

class Pool {
  private used = new Set<string>();
  constructor(private readonly items: Candidate[]) {}
  take(): Candidate | null {
    const next = this.items.find((item) => !this.used.has(item.id)) ?? null;
    if (next) this.used.add(next.id);
    return next;
  }
  /** An alternative for `partner`: its own chapter first, then anything. */
  takeLike(partner: Candidate): Candidate | null {
    const same = this.items.find((item) => !this.used.has(item.id) && item.chapter === partner.chapter);
    const next = same ?? this.items.find((item) => !this.used.has(item.id)) ?? null;
    if (next) this.used.add(next.id);
    return next;
  }
}

/** One pool per section, drawn up once per subject so two papers share nothing. */
function poolsFor(target: Target, candidates: Candidate[]): Map<string, Pool | { mcq: Pool; ar: Pool }> {
  const pools = new Map<string, Pool | { mcq: Pool; ar: Pool }>();
  for (const section of target.pattern.sections) {
    const allowed = target.chapters?.[section.name];
    const fits = (c: Candidate, type: string) =>
      c.type === type && c.marks === section.marksEach && (!allowed || allowed.includes(c.chapter));

    const objective = section.types.includes("MCQ") && section.types.includes("ASSERTION_REASON");
    if (objective) {
      pools.set(section.name, {
        mcq: new Pool(interleave(candidates.filter((c) => fits(c, "MCQ") && c.status === "APPROVED"))),
        ar: new Pool(interleave(candidates.filter((c) => fits(c, "ASSERTION_REASON")))),
      });
      continue;
    }
    const type = section.types[0]!;
    const isMap = target.pattern === CBSE_PATTERNS.SST && section.name === "F";
    const list = candidates.filter((c) => fits(c, type) && c.map === isMap);
    const reading = target.pattern === ENGLISH_RGW && section.name === "A";
    pools.set(section.name, new Pool(reading ? alternateByLength(list) : interleave(list)));
  }
  return pools;
}

/** One paper's layout, and what it could not fill. */
function layOut(
  sections: SectionPlan[],
  pools: Map<string, Pool | { mcq: Pool; ar: Pool }>,
): { items: LayoutInput[]; shortfalls: string[] } {
  const items: LayoutInput[] = [];
  const shortfalls: string[] = [];
  let group = 0;

  for (const section of sections) {
    const pool = pools.get(section.name)!;

    if ("mcq" in pool) {
      const ar: LayoutInput[] = [];
      for (let i = 0; i < SECTION_A_AR; i++) {
        const next = pool.ar.take();
        if (next) ar.push({ questionId: next.id, section: section.name, choiceGroup: null });
      }
      for (let i = 0; i < section.count - ar.length; i++) {
        const next = pool.mcq.take();
        if (!next) {
          shortfalls.push(`Section ${section.name}: the bank ran out of approved multiple-choice questions.`);
          break;
        }
        items.push({ questionId: next.id, section: section.name, choiceGroup: null });
      }
      // Multiple choice first, assertion–reason last, as the board prints them.
      items.push(...ar);
      continue;
    }

    const firstChoice = section.count - section.internalChoices;
    for (let i = 0; i < section.count; i++) {
      const main = pool.take();
      if (!main) {
        shortfalls.push(
          `Section ${section.name}: needs ${section.count + section.internalChoices} ${section.types.join("/")} questions of ${section.marksEach} marks.`,
        );
        break;
      }
      if (i >= firstChoice) {
        const alternative = pool.takeLike(main);
        if (!alternative) {
          shortfalls.push(`Section ${section.name}: no alternative left for an internal choice.`);
          items.push({ questionId: main.id, section: section.name, choiceGroup: null });
          break;
        }
        group++;
        items.push({ questionId: main.id, section: section.name, choiceGroup: group });
        items.push({ questionId: alternative.id, section: section.name, choiceGroup: group });
      } else {
        items.push({ questionId: main.id, section: section.name, choiceGroup: null });
      }
    }
  }
  return { items, shortfalls };
}

async function main() {
  const commit = process.argv.includes("--commit");
  const rebuild = process.argv.includes("--rebuild");
  const at = process.argv.indexOf("--org");
  const slug = at !== -1 ? process.argv[at + 1] : undefined;
  if (!slug) throw new Error("Pass --org <slug>. A name is not enough: two schools here share one.");

  const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
  const organization = await db.organization.findUniqueOrThrow({ where: { slug }, select: { id: true, name: true } });
  const membership = await db.membership.findFirstOrThrow({
    where: { organizationId: organization.id, status: "ACTIVE", role: "OWNER" },
    select: { userId: true, role: true },
    orderBy: { createdAt: "asc" },
  });
  const actor = { organizationId: organization.id, userId: membership.userId, role: membership.role };
  console.log(`Sample papers — ${commit ? "COMMIT" : "dry run"}${rebuild ? " (rebuild)" : ""} into ${organization.name} (${slug})\n`);

  // Outcomes live on the curriculum plane, so a question row carries only their ids.
  const mapOutcomeIds = new Set(
    (await db.learningOutcome.findMany({ where: { code: { in: MAP_OUTCOMES } }, select: { id: true } })).map((o) => o.id),
  );

  const counts = { created: 0, rebuilt: 0, skipped: 0, refused: 0 };
  for (const target of TARGETS) {
    const subject = await db.subject.findFirstOrThrow({
      where: { code: target.code, grade: { number: target.grade, board: { code: "CBSE" } } },
      select: { id: true, name: true, gradeId: true },
    });
    const pattern = target.pattern;
    const types = [...new Set(pattern.sections.flatMap((section) => section.types))] as QuestionType[];

    const rows = await db.question.findMany({
      where: {
        organizationId: organization.id,
        subjectId: subject.id,
        deletedAt: null,
        type: { in: types },
        status: { in: ["APPROVED", "DRAFT"] },
      },
      select: {
        id: true,
        type: true,
        marks: true,
        status: true,
        chapter: { select: { number: true } },
        outcomes: { select: { learningOutcomeId: true } },
        versions: { select: { stem: true }, orderBy: { version: "desc" }, take: 1 },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    // Approved first inside each chapter, so a paper needs as little review as the bank allows.
    const candidates: Candidate[] = rows
      .filter((row) => row.chapter && row.chapter.number < 1000)
      .map((row) => ({
        id: row.id,
        type: row.type,
        marks: row.marks,
        chapter: row.chapter!.number,
        status: row.status,
        map: row.outcomes.some((o) => mapOutcomeIds.has(o.learningOutcomeId)),
        stemLength: row.versions[0]?.stem.length ?? 0,
      }))
      .sort((a, b) => a.chapter - b.chapter || (a.status === "APPROVED" ? 0 : 1) - (b.status === "APPROVED" ? 0 : 1));

    const pools = poolsFor(target, candidates);
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const subjectName = target.name ?? subject.name;
    const fullMarks = patternMarks(pattern.sections);

    for (let n = 1; n <= target.papers; n++) {
      const title = `Sample Paper ${n} — Class ${target.grade} ${subjectName} (CBSE pattern)`;
      const { items, shortfalls } = layOut(pattern.sections, pools);
      const drafts = items.filter((item) => byId.get(item.questionId)!.status !== "APPROVED").length;
      const layoutItems: LayoutItem[] = items.map((item) => ({
        questionId: item.questionId,
        marks: byId.get(item.questionId)!.marks,
        section: item.section ?? null,
        choiceGroup: item.choiceGroup ?? null,
      }));
      const { errors, warnings } = checkLayout(pattern.sections, layoutItems);
      const pairs = new Set(layoutItems.flatMap((i) => (i.choiceGroup ? [i.choiceGroup] : []))).size;
      const marks = layoutItems.reduce((sum, item) => sum + item.marks, 0) -
        layoutItems
          .filter((item, index) => item.choiceGroup !== null && layoutItems[index - 1]?.choiceGroup === item.choiceGroup)
          .reduce((sum, item) => sum + item.marks, 0);

      console.log(title);
      console.log(`  ${layoutItems.length} printed, ${layoutItems.length - pairs} to answer, ${marks} of ${fullMarks} marks — ${drafts} still drafts`);
      for (const line of [...shortfalls, ...errors, ...warnings]) console.log(`  ! ${line}`);
      if (errors.length > 0 || items.length === 0 || marks !== fullMarks) {
        console.log("  refused: the layout is incomplete\n");
        counts.refused++;
        continue;
      }

      const existing = await db.assessment.findFirst({
        where: { organizationId: organization.id, title, deletedAt: null },
        select: { id: true, status: true },
      });
      let id: string;
      if (existing) {
        const sets = await db.auditLog.count({
          where: { organizationId: organization.id, entityId: existing.id, action: "assessment.questions_set" },
        });
        const current = await db.assessmentQuestion.findMany({
          where: { assessmentId: existing.id },
          orderBy: { position: "asc" },
          select: { questionId: true, section: true, choiceGroup: true },
        });
        const same =
          current.length === items.length &&
          current.every(
            (row, index) =>
              row.questionId === items[index]!.questionId &&
              row.section === (items[index]!.section ?? null) &&
              row.choiceGroup === (items[index]!.choiceGroup ?? null),
          );
        if (same) {
          console.log("  already there, unchanged\n");
          counts.skipped++;
          continue;
        }
        if (!rebuild || existing.status !== "DRAFT" || sets !== 1) {
          console.log(
            rebuild && (existing.status !== "DRAFT" || sets !== 1)
              ? "  already there and edited since — left alone\n"
              : "  already there — skipped\n",
          );
          counts.skipped++;
          continue;
        }
        if (!commit) {
          console.log("  would be re-laid\n");
          continue;
        }
        id = existing.id;
      } else {
        if (!commit) {
          console.log("");
          continue;
        }
        const created = await createAssessment(actor, {
          title,
          subjectId: subject.id,
          gradeId: subject.gradeId,
          durationMinutes: pattern.durationMinutes,
          totalMarks: fullMarks,
        });
        if ("error" in created) throw new Error(`${title}: ${created.error}`);
        id = created.id;
      }

      const blueprint: Blueprint = {
        ...DEFAULT_BLUEPRINT,
        totalMarks: fullMarks,
        totalQuestions: patternQuestionCount(pattern.sections),
        pattern: { key: pattern.key, label: pattern.label, sections: pattern.sections },
      };
      const updated = await updateDraft(actor, id, {
        blueprint,
        totalMarks: fullMarks,
        durationMinutes: pattern.durationMinutes,
      });
      if (!updated.ok) throw new Error(`${title}: ${updated.error}`);

      const set = await setQuestions(actor, id, items);
      if (!set.ok) throw new Error(`${title}: ${set.error}`);
      if (existing) counts.rebuilt++;
      else counts.created++;
      console.log(`  ${existing ? "re-laid" : "created"} ${id}\n`);
    }
  }

  console.log(
    commit
      ? `Done. ${counts.created} created, ${counts.rebuilt} re-laid, ${counts.skipped} left alone, ${counts.refused} refused.`
      : "Nothing written. Re-run with --commit to apply.",
  );
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

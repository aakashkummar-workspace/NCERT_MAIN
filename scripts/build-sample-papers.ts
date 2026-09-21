/**
 * Sample papers in the CBSE board pattern, built as DRAFT assessments.
 *
 *     npx tsx --conditions=react-server scripts/build-sample-papers.ts --org <slug>            # dry run
 *     npx tsx --conditions=react-server scripts/build-sample-papers.ts --org <slug> --commit
 *
 * Every paper goes through the builder's own functions — createAssessment,
 * updateDraft with the pattern, setQuestions with sections and "OR" pairs — so
 * checkLayout judges it exactly as it judges a paper a teacher made by hand.
 *
 * They are DRAFTS, and cannot be anything else yet: the written questions they
 * need (VSA, SA, LA, case, assertion–reason) are drafts, and publishCheck
 * refuses a paper holding one. So a sample paper is also a review list — a
 * teacher opens it, approves what it holds (or swaps what they would not set),
 * and publishes. Nothing here approves a question; an approval nobody read is a
 * claim that is untrue.
 *
 * Choices it makes:
 *  - Section A is 18 APPROVED multiple-choice questions and 2 assertion–reason,
 *    the board sample papers' own split.
 *  - Questions are dealt chapter by chapter in turn, so a paper covers the
 *    syllabus instead of the first four chapters, and the two papers for a
 *    subject share no question.
 *  - An "OR" alternative comes from the same chapter as the question it pairs
 *    with where the bank allows — the board's alternatives test the same idea.
 *  - Internal choices sit on the last questions of a section, as they do on
 *    the board paper.
 *  - Social Science Section F (the map question) is left EMPTY. The bank holds
 *    no map questions, and filing an ordinary long answer there would print
 *    "Map skill" above something that is not one. The paper therefore shows
 *    75 of 80 marks until a teacher adds one, and publishCheck says so.
 *  - Class 10 Social Science is four subjects here (Geography, Economics,
 *    History, Political Science) and a paper holds one subject, so each gets
 *    its own paper in the pattern — practice in the shape, not the board's
 *    mixed paper.
 *
 * Idempotent: a paper whose title already exists in the organization is
 * skipped.
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
  checkLayout,
  patternForSubject,
  patternMarks,
  patternQuestionCount,
  type LayoutItem,
  type SectionPlan,
} from "../src/core/assessments/pattern";

type Target = { grade: number; code: string; papers: number; label?: string };

const TARGETS: Target[] = [
  { grade: 10, code: "MATH", papers: 2 },
  { grade: 10, code: "SCI", papers: 2 },
  { grade: 10, code: "SST", papers: 1, label: "Geography" },
  { grade: 10, code: "SSTEC", papers: 1, label: "Economics" },
  { grade: 10, code: "SSTHI", papers: 1, label: "History" },
  { grade: 10, code: "SSTPS", papers: 1, label: "Political Science" },
  { grade: 9, code: "MATH", papers: 2 },
  { grade: 9, code: "SCI", papers: 2 },
  { grade: 9, code: "SST", papers: 2 },
];

/** Section A: how many assertion–reason questions, the rest multiple choice. */
const SECTION_A_AR = 2;
/** The map question: left empty, see the header. */
const EMPTY_SECTIONS = new Set(["F"]);

type Candidate = { id: string; type: string; marks: number; chapter: number; status: string };

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

class Pool {
  private used = new Set<string>();
  constructor(private readonly items: Candidate[]) {}
  get remaining() {
    return this.items.filter((item) => !this.used.has(item.id)).length;
  }
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

function poolKey(type: string, marks: number) {
  return `${type}:${marks}`;
}

/** One paper's layout, or the reason it cannot be made. */
function layOut(
  sections: SectionPlan[],
  pools: Map<string, Pool>,
): { items: LayoutInput[]; shortfalls: string[] } {
  const items: LayoutInput[] = [];
  const shortfalls: string[] = [];
  let group = 0;

  for (const section of sections) {
    if (EMPTY_SECTIONS.has(section.name)) continue;

    if (section.name === "A") {
      const ar = pools.get(poolKey("ASSERTION_REASON", section.marksEach));
      const mcq = pools.get(poolKey("MCQ", section.marksEach));
      let arTaken = 0;
      for (let i = 0; i < SECTION_A_AR; i++) {
        const next = ar?.take();
        if (!next) break;
        arTaken++;
        items.push({ questionId: next.id, section: "A", choiceGroup: null });
      }
      const mcqs: LayoutInput[] = [];
      for (let i = 0; i < section.count - arTaken; i++) {
        const next = mcq?.take();
        if (!next) {
          shortfalls.push(`Section A: the bank ran out of approved multiple-choice questions.`);
          break;
        }
        mcqs.push({ questionId: next.id, section: "A", choiceGroup: null });
      }
      // Multiple choice first, assertion–reason last, as the board prints them.
      items.splice(items.length - arTaken, 0, ...mcqs);
      continue;
    }

    const type = section.types[0]!;
    const pool = pools.get(poolKey(type, section.marksEach));
    const firstChoice = section.count - section.internalChoices;
    for (let i = 0; i < section.count; i++) {
      const main = pool?.take();
      if (!main) {
        shortfalls.push(`Section ${section.name}: needs ${section.count + section.internalChoices} ${type} questions of ${section.marksEach} marks.`);
        break;
      }
      if (i >= firstChoice) {
        const alternative = pool!.takeLike(main);
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
  console.log(`Sample papers — ${commit ? "COMMIT" : "dry run"} into ${organization.name} (${slug})\n`);

  let made = 0;
  for (const target of TARGETS) {
    const subject = await db.subject.findFirstOrThrow({
      where: { code: target.code, grade: { number: target.grade, board: { code: "CBSE" } } },
      select: { id: true, name: true, gradeId: true },
    });
    const pattern = patternForSubject("CBSE", target.code);
    if (!pattern) throw new Error(`${target.code}: no board pattern`);

    const rows = await db.question.findMany({
      where: {
        organizationId: organization.id,
        subjectId: subject.id,
        deletedAt: null,
        // Multiple choice only when approved — there are hundreds. The written
        // types are all drafts today; a paper of them is the review list.
        OR: [
          { type: "MCQ", status: "APPROVED" },
          { type: { in: ["ASSERTION_REASON", "VSA", "SA", "LA", "CASE_STUDY"] }, status: { in: ["APPROVED", "DRAFT"] } },
        ],
      },
      select: { id: true, type: true, marks: true, status: true, createdAt: true, chapter: { select: { number: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    // Approved first inside each chapter, so a paper needs as little review as the bank allows.
    const candidates: Candidate[] = rows
      .filter((row) => row.chapter && row.chapter.number < 1000)
      .map((row) => ({ id: row.id, type: row.type, marks: row.marks, chapter: row.chapter!.number, status: row.status }))
      .sort((a, b) => a.chapter - b.chapter || (a.status === "APPROVED" ? 0 : 1) - (b.status === "APPROVED" ? 0 : 1));

    const byKey = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
      const key = poolKey(candidate.type, candidate.marks);
      byKey.set(key, [...(byKey.get(key) ?? []), candidate]);
    }
    const pools = new Map([...byKey].map(([key, list]) => [key, new Pool(interleave(list))]));

    const subjectName = target.label ? `Social Science (${target.label})` : subject.name;
    for (let n = 1; n <= target.papers; n++) {
      const title = `Sample Paper ${n} — Class ${target.grade} ${subjectName} (CBSE pattern)`;
      const { items, shortfalls } = layOut(pattern.sections, pools);
      const status = new Map(candidates.map((c) => [c.id, c]));
      const drafts = items.filter((item) => status.get(item.questionId)!.status !== "APPROVED").length;
      const layoutItems: LayoutItem[] = items.map((item) => ({
        questionId: item.questionId,
        marks: status.get(item.questionId)!.marks,
        section: item.section ?? null,
        choiceGroup: item.choiceGroup ?? null,
      }));
      const { errors, warnings } = checkLayout(pattern.sections, layoutItems);
      const answerable = layoutItems.length - new Set(layoutItems.flatMap((i) => (i.choiceGroup ? [i.choiceGroup] : []))).size;
      const marks = layoutItems.reduce((sum, item) => sum + item.marks, 0) -
        layoutItems.filter((item, index) => item.choiceGroup !== null && layoutItems[index - 1]?.choiceGroup === item.choiceGroup).reduce((sum, item) => sum + item.marks, 0);

      console.log(`${title}`);
      console.log(`  ${layoutItems.length} printed, ${answerable} to answer, ${marks} of ${patternMarks(pattern.sections)} marks — ${drafts} still drafts`);
      for (const line of [...shortfalls, ...errors, ...warnings]) console.log(`  ! ${line}`);
      if (errors.length > 0 || items.length === 0) {
        console.log("  skipped: the layout would be refused\n");
        continue;
      }

      const existing = await db.assessment.findFirst({
        where: { organizationId: organization.id, title, deletedAt: null },
        select: { id: true },
      });
      if (existing) {
        console.log("  already there — skipped\n");
        continue;
      }
      if (!commit) {
        console.log("");
        continue;
      }

      const created = await createAssessment(actor, {
        title,
        subjectId: subject.id,
        gradeId: subject.gradeId,
        durationMinutes: pattern.durationMinutes,
        totalMarks: patternMarks(pattern.sections),
      });
      if ("error" in created) throw new Error(`${title}: ${created.error}`);

      const blueprint: Blueprint = {
        ...DEFAULT_BLUEPRINT,
        totalMarks: patternMarks(pattern.sections),
        totalQuestions: patternQuestionCount(pattern.sections),
        pattern: { key: pattern.key, label: pattern.label, sections: pattern.sections },
      };
      const updated = await updateDraft(actor, created.id, { blueprint });
      if (!updated.ok) throw new Error(`${title}: ${updated.error}`);

      const set = await setQuestions(actor, created.id, items);
      if (!set.ok) throw new Error(`${title}: ${set.error}`);
      made++;
      console.log(`  created ${created.id}\n`);
    }
  }

  console.log(commit ? `Done. ${made} draft papers created.` : "Nothing written. Re-run with --commit to apply.");
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

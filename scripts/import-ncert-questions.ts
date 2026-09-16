import fs from "fs";
import path from "path";
import { createHash, randomUUID } from "crypto";
import {
  PrismaClient,
  type Prisma,
  Difficulty,
  QuestionStatus,
  QuestionSource,
  QuestionVisibility,
} from "@prisma/client";

type RawSourceQuestion = {
  id?: string;
  class?: number;
  grade?: number;
  subject?: string;
  bookCode?: string;
  chapter?: number | string;
  type?: string;
  question?: string;
  stem?: string;
  options?: string[];
  answer?: number | string;
  marks?: number;
  difficulty?: string;
  explanation?: string;
};

const SOURCE_DIR = "C:\\dev\\sirah_project\\NCERT\\data";

const QUESTION_FILES = [
  "questions.mathematics9.json",
  "questions.mathematics10.json",
  "questions.science9.json",
  "questions.science10.json",
  "questions.english9.json",
  "questions.english10.json",
  "questions.socialscience9.json",
  "questions.socialscience10.json",
  "questions.exemplar.json",
  "questions.exemplar-recovered.json",
  "questions.generated-maths.json",
  "questions.json",
];

/**
 * Class 10 books that are their own subject. English and Social Science are one
 * examination each but several books, and every book numbers from 1 — so the
 * first version of this script, which resolved a chapter from (class, subject
 * name, chapter number), filed Footprints under First Flight and History,
 * Economics and Political Science under Geography: 740 questions under the
 * wrong chapter. The book code decides the subject; the number means something
 * only inside a book.
 *
 * Chapters are NOT created here any more. `prisma/curriculum.ts` owns them and
 * `npm run db:seed` writes them; a second list in this file drifted from it
 * the first time the syllabus changed. Run the seed before this script.
 */
const BOOK_SUBJECT_CODE: Record<string, string> = {
  jefp1: "ENGFP",
  jess2: "SSTEC",
  jess3: "SSTHI",
  jess4: "SSTPS",
};

const SUBJECT_CODE_MAP: Record<string, string> = {
  mathematics: "MATH",
  math: "MATH",
  maths: "MATH",
  science: "SCI",
  english: "ENG",
  "social science": "SST",
  socialscience: "SST",
  sst: "SST",
};

const KEY_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

function computeContentHash(
  type: string,
  stem: string,
  options?: { text: string }[] | null,
): Buffer {
  const normalise = (value: string) =>
    value.trim().toLowerCase().replace(/\s+/g, " ");

  const parts = [type, normalise(stem)];
  if (options && options.length > 0) {
    parts.push(
      ...options
        .map((opt) => normalise(opt.text))
        .sort()
        .map((text, index) => `${index}:${text}`),
    );
  }
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest();
}

function loadQuestions(filePath: string): RawSourceQuestion[] {
  if (!fs.existsSync(filePath)) return [];
  const content = JSON.parse(fs.readFileSync(filePath, "utf-8")) as
    | RawSourceQuestion[]
    | { questions?: RawSourceQuestion[] };
  if (Array.isArray(content)) return content;
  if (content && typeof content === "object" && Array.isArray(content.questions)) {
    return content.questions;
  }
  return [];
}

async function main() {
  console.log("=================================================");
  console.log("   Sahayak NCERT CBSE Question Bank Importer    ");
  console.log("=================================================\n");

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: process.env.DIRECT_URL || process.env.DATABASE_URL,
      },
    },
  });

  // 1. Locate primary teacher & organization (prioritize Sirah Digital / Aakash kummar)
  let user = await prisma.user.findFirst({
    where: {
      OR: [
        { email: "aakash.kummar@sirahdigital.in" },
        { memberships: { some: { organization: { name: { contains: "Sirah", mode: "insensitive" } } } } },
      ],
    },
    include: { memberships: { include: { organization: true } } },
  });

  if (!user || user.memberships.length === 0) {
    user = await prisma.user.findFirst({
      where: { email: "teacher@ncert.test" },
      include: { memberships: { include: { organization: true } } },
    });
  }

  if (!user || user.memberships.length === 0) {
    console.log("Locating fallback owner...");
    user = await prisma.user.findFirst({
      where: { memberships: { some: { role: "OWNER" } } },
      include: { memberships: { include: { organization: true } } },
    });
  }

  if (!user || user.memberships.length === 0) {
    throw new Error("No eligible teacher / organization found in database.");
  }

  const primaryMembership = user.memberships[0];
  if (!primaryMembership) {
    throw new Error("User has no memberships.");
  }
  const targetOrg = primaryMembership.organization;
  const targetUserId = user.id;
  const targetOrgId = targetOrg.id;

  console.log(`Target Organization: ${targetOrg.name} (${targetOrgId})`);
  console.log(`Target Author/Approver: ${user.fullName} <${user.email}> (${targetUserId})\n`);

  // 2. Resolve CBSE Board and Grades 9 & 10
  const cbse = await prisma.board.findFirst({
    where: { code: "CBSE" },
    include: {
      grades: {
        include: {
          subjects: {
            include: { chapters: true },
          },
        },
      },
    },
  });

  if (!cbse) {
    throw new Error("CBSE board not found in database.");
  }

  const grade9 = cbse.grades.find((g) => g.number === 9 || g.label.includes("9"));
  const grade10 = cbse.grades.find((g) => g.number === 10 || g.label.includes("10"));

  if (!grade9 || !grade10) {
    throw new Error("Grade 9 or Grade 10 not found under CBSE board.");
  }

  console.log(`CBSE Board found: ${cbse.name}`);
  console.log(`Grade 9 ID: ${grade9.id} (${grade9.subjects.length} subjects)`);
  console.log(`Grade 10 ID: ${grade10.id} (${grade10.subjects.length} subjects)\n`);

  // Reload grades with refreshed chapters
  const refreshedGrades = await prisma.grade.findMany({
    where: { id: { in: [grade9.id, grade10.id] } },
    include: {
      subjects: {
        include: { chapters: true },
      },
    },
  });

  const subjectMap = new Map<string, { id: string; name: string; chapters: Map<number, string> }>();
  for (const g of refreshedGrades) {
    const gradeNum = g.number;
    for (const s of g.subjects) {
      const key = `${gradeNum}:${s.code}`;
      const chMap = new Map<number, string>();
      for (const ch of s.chapters) {
        chMap.set(ch.number, ch.id);
      }
      subjectMap.set(key, { id: s.id, name: s.name, chapters: chMap });
    }
  }

  // 4. Load existing content hashes to skip duplicate imports
  console.log("\nLoading existing question content hashes from database...");
  const existingQuestions = await prisma.question.findMany({
    where: { organizationId: targetOrgId, deletedAt: null },
    select: { contentHash: true },
  });

  const existingHashes = new Set<string>();
  for (const eq of existingQuestions) {
    if (eq.contentHash) {
      existingHashes.add(Buffer.from(eq.contentHash).toString("hex"));
    }
  }
  console.log(`Found ${existingHashes.size} existing questions in ${targetOrg.name}.\n`);

  // 5. Read all questions from files and batch insert
  let totalRead = 0;
  let totalImported = 0;
  let totalDuplicatesSkipped = 0;
  let totalMisfiles = 0;

  const statsBySubject: Record<string, { count: number; chapters: Set<number> }> = {};
  const seenInRun = new Set<string>();

  const BATCH_SIZE = 100;
  let pendingQuestions: Prisma.QuestionCreateManyInput[] = [];
  let pendingVersions: Prisma.QuestionVersionCreateManyInput[] = [];

  async function flushBatch() {
    if (pendingQuestions.length === 0) return;
    const qBatch = [...pendingQuestions];
    const vBatch = [...pendingVersions];
    pendingQuestions = [];
    pendingVersions = [];

    await prisma.$transaction(async (tx) => {
      await tx.question.createMany({
        data: qBatch,
      });
      await tx.questionVersion.createMany({
        data: vBatch,
      });
    });
  }

  const now = new Date();

  for (const fileName of QUESTION_FILES) {
    const filePath = path.join(SOURCE_DIR, fileName);
    const questions = loadQuestions(filePath);
    console.log(`Processing ${fileName} (${questions.length} items)...`);

    let fileImported = 0;
    let fileDups = 0;

    for (const q of questions) {
      totalRead++;
      const gradeNum = q.class ?? q.grade;
      if (gradeNum === undefined) {
        totalMisfiles++;
        continue;
      }
      const rawSubject: string = String(q.subject ?? "").trim().toLowerCase();
      const subjCode = (q.bookCode && BOOK_SUBJECT_CODE[q.bookCode]) ?? SUBJECT_CODE_MAP[rawSubject];

      if (!subjCode) {
        console.warn(`Unknown subject '${q.subject}' for item ${q.id}`);
        totalMisfiles++;
        continue;
      }

      const subjInfo = subjectMap.get(`${gradeNum}:${subjCode}`);
      if (!subjInfo) {
        console.warn(`No subject mapping for Grade ${gradeNum} ${subjCode}`);
        totalMisfiles++;
        continue;
      }

      const chapterNum = typeof q.chapter === "number" ? q.chapter : parseInt(String(q.chapter ?? ""), 10);
      const chapterId = !isNaN(chapterNum) ? subjInfo.chapters.get(chapterNum) ?? null : null;

      const stem = (q.question ?? q.stem ?? "").trim();
      if (stem.length < 5) {
        totalMisfiles++;
        continue;
      }

      const rawOptions: string[] = Array.isArray(q.options) ? q.options : [];
      if (rawOptions.length < 2) {
        totalMisfiles++;
        continue;
      }

      let ansIndex = -1;
      if (typeof q.answer === "number") {
        ansIndex = q.answer;
      } else if (typeof q.answer === "string") {
        const parsed = parseInt(q.answer, 10);
        if (!isNaN(parsed)) ansIndex = parsed;
        else {
          const lIdx = KEY_LETTERS.indexOf(q.answer.trim().toUpperCase());
          if (lIdx !== -1) ansIndex = lIdx;
        }
      }

      if (ansIndex < 0 || ansIndex >= rawOptions.length) {
        totalMisfiles++;
        continue;
      }

      const options = rawOptions.map((text, idx) => ({
        key: KEY_LETTERS[idx] ?? `O${idx + 1}`,
        text: String(text).trim(),
        isCorrect: idx === ansIndex,
      }));

      const hashBuffer = computeContentHash("MCQ", stem, options);
      const hashHex = hashBuffer.toString("hex");

      if (existingHashes.has(hashHex) || seenInRun.has(hashHex)) {
        totalDuplicatesSkipped++;
        fileDups++;
        continue;
      }

      seenInRun.add(hashHex);
      existingHashes.add(hashHex);

      const correctKey = KEY_LETTERS[ansIndex] ?? `O${ansIndex + 1}`;
      const answerKey = {
        kind: "choice",
        correctKeys: [correctKey],
      };

      let difficulty: Difficulty = Difficulty.MEDIUM;
      const rawDiff = String(q.difficulty ?? "").toLowerCase();
      if (rawDiff === "easy") difficulty = Difficulty.EASY;
      else if (rawDiff === "hard") difficulty = Difficulty.HARD;

      const marks = typeof q.marks === "number" && q.marks > 0 ? q.marks : 1;
      const explanation = q.explanation ? String(q.explanation).trim() : null;

      const questionId = randomUUID();
      const versionId = randomUUID();

      pendingQuestions.push({
        id: questionId,
        organizationId: targetOrgId,
        visibility: QuestionVisibility.ORGANIZATION,
        createdById: targetUserId,
        subjectId: subjInfo.id,
        chapterId: chapterId,
        type: "MCQ",
        difficulty,
        marks,
        status: QuestionStatus.APPROVED,
        source: QuestionSource.IMPORTED,
        currentVersionId: versionId,
        approvedById: targetUserId,
        approvedAt: now,
        contentHash: new Uint8Array(hashBuffer),
      });

      pendingVersions.push({
        id: versionId,
        questionId,
        version: 1,
        stem,
        options,
        answerKey,
        explanation,
        createdById: targetUserId,
      });

      fileImported++;
      totalImported++;

      const statKey = `Class ${gradeNum} - ${subjInfo.name}`;
      if (!statsBySubject[statKey]) {
        statsBySubject[statKey] = { count: 0, chapters: new Set() };
      }
      statsBySubject[statKey].count++;
      if (chapterNum) statsBySubject[statKey].chapters.add(chapterNum);

      if (pendingQuestions.length >= BATCH_SIZE) {
        await flushBatch();
      }
    }

    // Flush any leftovers for this file
    await flushBatch();
    console.log(`  -> Imported: ${fileImported}, Duplicates skipped: ${fileDups}`);
  }

  // Final flush just in case
  await flushBatch();

  console.log("\n=================================================");
  console.log("               IMPORT COMPLETE                   ");
  console.log("=================================================");
  console.log(`Total questions read:       ${totalRead}`);
  console.log(`Successfully imported:      ${totalImported}`);
  console.log(`Duplicates skipped:         ${totalDuplicatesSkipped}`);
  console.log(`Misfiles/invalid dropped:   ${totalMisfiles}\n`);

  console.log("Breakdown by Grade and Subject:");
  for (const [k, v] of Object.entries(statsBySubject)) {
    const chList = Array.from(v.chapters).sort((a, b) => a - b);
    console.log(`  • ${k.padEnd(26)} : ${v.count.toString().padStart(4)} questions across ${chList.length} chapters (${chList.join(", ")})`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Import failed with error:", err);
  process.exit(1);
});

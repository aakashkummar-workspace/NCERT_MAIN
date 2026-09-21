/**
 * The CBSE chapter list for Class 9 and 10.
 *
 * ---------------------------------------------------------------------------
 * What is here, and what deliberately is not
 * ---------------------------------------------------------------------------
 * Chapters are here because they are a matter of public record: they are the
 * NCERT textbook contents, checkable against the book in about a minute.
 *
 * Topics and learning outcomes are NOT here. An outcome statement is not a
 * label — with no seeded question bank to few-shot from, it is the only
 * grounding an AI generator will have, so it has to describe what a student can
 * do precisely enough that a question could be written from it alone. Inventing
 * 400 of those and calling them curriculum would be exactly the guess this
 * product exists to refuse. They are authored through /x/curriculum by someone
 * who teaches the subject.
 *
 * So a chapter with no outcomes is a normal, visible state — see the "needs
 * outcomes" count in the curriculum editor — and not an error.
 *
 * `source` records where each row came from. A curriculum row with no
 * provenance is a claim nobody can check.
 */

export type ChapterSeed = { number: number; title: string };

export const CHAPTERS: Record<string, Record<string, ChapterSeed[]>> = {
  // ---- Class 10 -----------------------------------------------------------
  "10": {
    MATH: [
      { number: 1, title: "Real Numbers" },
      { number: 2, title: "Polynomials" },
      { number: 3, title: "Pair of Linear Equations in Two Variables" },
      { number: 4, title: "Quadratic Equations" },
      { number: 5, title: "Arithmetic Progressions" },
      { number: 6, title: "Triangles" },
      { number: 7, title: "Coordinate Geometry" },
      { number: 8, title: "Introduction to Trigonometry" },
      { number: 9, title: "Some Applications of Trigonometry" },
      { number: 10, title: "Circles" },
      { number: 11, title: "Areas Related to Circles" },
      { number: 12, title: "Surface Areas and Volumes" },
      { number: 13, title: "Statistics" },
      { number: 14, title: "Probability" },
    ],
    SCI: [
      { number: 1, title: "Chemical Reactions and Equations" },
      { number: 2, title: "Acids, Bases and Salts" },
      { number: 3, title: "Metals and Non-metals" },
      { number: 4, title: "Carbon and its Compounds" },
      { number: 5, title: "Life Processes" },
      { number: 6, title: "Control and Coordination" },
      { number: 7, title: "How do Organisms Reproduce?" },
      { number: 8, title: "Heredity" },
      { number: 9, title: "Light — Reflection and Refraction" },
      { number: 10, title: "The Human Eye and the Colourful World" },
      { number: 11, title: "Electricity" },
      { number: 12, title: "Magnetic Effects of Electric Current" },
      { number: 13, title: "Our Environment" },
    ],
    // English and Social Science are one EXAMINATION each but several BOOKS,
    // and every book numbers its chapters from 1. Filed by number into one
    // subject, "Footprints ch1" and "First Flight ch1" were the same chapter,
    // and History, Economics and Political Science all landed inside the
    // Geography chapters. So each book is its own subject (see seed.ts), and
    // a chapter number means one thing again.
    ENG: [
      { number: 1, title: "A Letter to God" },
      { number: 2, title: "Nelson Mandela: Long Walk to Freedom" },
      { number: 3, title: "Two Stories about Flying" },
      { number: 4, title: "From the Diary of Anne Frank" },
      { number: 5, title: "Glimpses of India" },
      { number: 6, title: "Mijbil the Otter" },
      { number: 7, title: "Madam Rides the Bus" },
      { number: 8, title: "The Sermon at Benares" },
      { number: 9, title: "The Proposal" },
    ],
    // CBSE English (184) 2025-26, Section B: the grammar items and the two
    // writing tasks the Class X paper sets. Not a book — the syllabus itself.
    ENGGW: [
      { number: 1, title: "Determiners" },
      { number: 2, title: "Tenses" },
      { number: 3, title: "Modals" },
      { number: 4, title: "Subject–Verb Concord" },
      { number: 5, title: "Reported Speech" },
      { number: 6, title: "Formal Letter" },
      { number: 7, title: "Analytical Paragraph" },
      { number: 8, title: "Reading Comprehension" },
    ],
    ENGFP: [
      { number: 1, title: "A Triumph of Surgery" },
      { number: 2, title: "The Thief’s Story" },
      { number: 3, title: "The Midnight Visitor" },
      { number: 4, title: "A Question of Trust" },
      { number: 5, title: "Footprints without Feet" },
      { number: 6, title: "The Making of a Scientist" },
      { number: 7, title: "The Necklace" },
      { number: 8, title: "Bholi" },
      { number: 9, title: "The Book That Saved the Earth" },
    ],
    // Hindi. The supplementary readers' titles came from the NCERT project's
    // data/title-overrides.json. The main books' titles there were the AUTHOR'S
    // name ("प्रेमचंद", "कबीर"), and Kshitij 1 was a song from the section's
    // opening page; in September 2026 every chapter was read against the book
    // (prisma/chapter-contents) and these are now the printed lesson titles.
    // "पद" alone would name three different chapters, so it carries its poet.
    // A course is two books and a chapter number must be unique within a
    // subject, so the supplementary reader continues the main book's numbering
    // and names itself in the title.
    // Hindi A (Course A, 002): Kshitij-2 (jhks1) 1–12, then Kritika (jhkr1).
    HIN: [
      { number: 1, title: "पद (सूरदास)" },
      { number: 2, title: "राम-लक्ष्मण-परशुराम संवाद" },
      { number: 3, title: "आत्मकथ्य" },
      { number: 4, title: "उत्साह / अट नहीं रही है" },
      { number: 5, title: "यह दंतुरित मुसकान / फसल" },
      { number: 6, title: "संगतकार" },
      { number: 7, title: "नेताजी का चश्मा" },
      { number: 8, title: "बालगोबिन भगत" },
      { number: 9, title: "लखनवी अंदाज़" },
      { number: 10, title: "एक कहानी यह भी" },
      { number: 11, title: "नौबतखाने में इबादत" },
      { number: 12, title: "संस्कृति" },
      { number: 13, title: "कृतिका – माता का अँचल" },
      { number: 14, title: "कृतिका – साना-साना हाथ जोड़ि…" },
      { number: 15, title: "कृतिका – मैं क्यों लिखता हूँ?" },
    ],
    // Hindi B (Course B, 085): Sparsh (jhsp1) 1–14, then Sanchayan Bhag-2 (jhsy1).
    HINB: [
      { number: 1, title: "साखी" },
      { number: 2, title: "पद (मीरा)" },
      { number: 3, title: "मनुष्यता" },
      { number: 4, title: "पर्वत प्रदेश में पावस" },
      { number: 5, title: "तोप" },
      { number: 6, title: "कर चले हम फ़िदा" },
      { number: 7, title: "आत्मत्राण" },
      { number: 8, title: "बड़े भाई साहब" },
      { number: 9, title: "डायरी का एक पन्ना" },
      { number: 10, title: "तताँरा-वामीरो कथा" },
      { number: 11, title: "तीसरी कसम के शिल्पकार शैलेंद्र" },
      { number: 12, title: "अब कहाँ दूसरे के दुख से दुखी होने वाले" },
      { number: 13, title: "पतझर में टूटी पत्तियाँ" },
      { number: 14, title: "कारतूस" },
      { number: 15, title: "संचयन – हरिहर काका" },
      { number: 16, title: "संचयन – सपनों के-से दिन" },
      { number: 17, title: "संचयन – टोपी शुक्ला" },
    ],
    SST: [
      { number: 1, title: "Resources and Development" },
      { number: 2, title: "Forest and Wildlife Resources" },
      { number: 3, title: "Water Resources" },
      { number: 4, title: "Agriculture" },
      { number: 5, title: "Minerals and Energy Resources" },
      { number: 6, title: "Manufacturing Industries" },
      { number: 7, title: "Lifelines of National Economy" },
    ],
    SSTEC: [
      { number: 1, title: "Development" },
      { number: 2, title: "Sectors of the Indian Economy" },
      { number: 3, title: "Money and Credit" },
      { number: 4, title: "Globalisation and the Indian Economy" },
      { number: 5, title: "Consumer Rights" },
    ],
    SSTHI: [
      { number: 1, title: "The Rise of Nationalism in Europe" },
      { number: 2, title: "Nationalism in India" },
      { number: 3, title: "The Making of a Global World" },
      { number: 4, title: "The Age of Industrialisation" },
      { number: 5, title: "Print Culture and the Modern World" },
    ],
    SSTPS: [
      { number: 1, title: "Power-sharing" },
      { number: 2, title: "Federalism" },
      { number: 3, title: "Gender, Religion and Caste" },
      { number: 4, title: "Political Parties" },
      { number: 5, title: "Outcomes of Democracy" },
    ],
  },

  // ---- Class 9 ------------------------------------------------------------
  //
  // The NEW NCERT books, not the old syllabus. Class 9 moved to Ganita Manjari
  // (Mathematics, iemh1) and Exploration (Science, iesc1), and the question
  // bank imported from the NCERT project is written against those books. This
  // list used to be the old syllabus — Number Systems, Matter in Our
  // Surroundings — and the importer matched questions to chapters by NUMBER,
  // so a question about coordinates sat under "Number Systems" with nothing
  // looking wrong. Titles are copied from the books' own contents pages; a
  // PDF line-break inside "Algebraic" is corrected.
  //
  // These are Part 1 of each book. Part 2 chapters are added when the part
  // is published — not guessed at now.
  "9": {
    MATH: [
      { number: 1, title: "Orienting Yourself: The Use of Coordinates" },
      { number: 2, title: "Introduction to Linear Polynomials" },
      { number: 3, title: "The World of Numbers" },
      { number: 4, title: "Exploring Algebraic Identities" },
      { number: 5, title: "I’m Up and Down, and Round and Round" },
      { number: 6, title: "Measuring Space: Perimeter and Area" },
      { number: 7, title: "The Mathematics of Maybe: Introduction to Probability" },
      { number: 8, title: "Predicting What Comes Next: Exploring Sequences and Progressions" },
    ],
    SCI: [
      { number: 1, title: "Exploration: Entering the World of Secondary Science" },
      { number: 2, title: "Cell: The Building Block of Life" },
      { number: 3, title: "Tissues in Action" },
      { number: 4, title: "Describing Motion Around Us" },
      { number: 5, title: "Exploring Mixtures and their Separation" },
      { number: 6, title: "How Forces Affect Motion" },
      { number: 7, title: "Work, Energy, and Simple Machines" },
      { number: 8, title: "Journey Inside the Atom" },
      { number: 9, title: "Atomic Foundations of Matter" },
      { number: 10, title: "Sound Waves: Characteristics and Applications" },
      { number: 11, title: "Reproduction: How Life Continues" },
      { number: 12, title: "Patterns in Life: Diversity and Classification" },
      { number: 13, title: "Earth as a System: Energy, Matter, and Life" },
    ],
    // CBSE English (184) 2025-26, Section B for Class IX: the same grammar
    // items, and the Class IX writing tasks.
    ENGGW: [
      { number: 1, title: "Determiners" },
      { number: 2, title: "Tenses" },
      { number: 3, title: "Modals" },
      { number: 4, title: "Subject–Verb Concord" },
      { number: 5, title: "Reported Speech" },
      { number: 6, title: "Descriptive Paragraph" },
      { number: 7, title: "Story and Diary Entry" },
      { number: 8, title: "Reading Comprehension" },
    ],
    ENG: [
      { number: 1, title: "How I Taught My Grandmother to Read" },
      { number: 2, title: "The Pot Maker" },
      { number: 3, title: "Winds of Change" },
      { number: 4, title: "Vitamin" },
      { number: 5, title: "The World of Limitless Possibilities" },
      { number: 6, title: "Twin Melodies" },
      { number: 7, title: "Carrier of Words" },
      { number: 8, title: "Follow That Dream" },
    ],
    // Hindi (Class 9): Ganga (ihga1), the new NCERT book. No Class 9 Course B
    // book has been published in the new series.
    HIN: [
      { number: 1, title: "दो बैलों की कथा" },
      { number: 2, title: "क्या लिखूँ?" },
      { number: 3, title: "संवादहीन" },
      { number: 4, title: "ऐसी भी बातें होती हैं" },
      { number: 5, title: "आखिरी चट्टान तक" },
      { number: 6, title: "रीढ़ की हड्डी" },
      { number: 7, title: "मैं और मेरा देश" },
      { number: 8, title: "पद (रैदास)" },
      { number: 9, title: "राम-लक्ष्मण-परशुराम संवाद" },
      { number: 10, title: "भारति, जय, विजयकरे!" },
      { number: 11, title: "झाँसी की रानी" },
      { number: 12, title: "घर की याद" },
    ],
    SST: [
      { number: 1, title: "Understanding Social Science" },
      { number: 2, title: "Shaping of the Earth’s Surface" },
      { number: 3, title: "Atmosphere and Climate" },
      { number: 4, title: "Early Humans and Beginning of Civilisation" },
      { number: 5, title: "State and Society up to 1000 CE" },
      { number: 6, title: "Democracy" },
      { number: 7, title: "Elections" },
      { number: 8, title: "Building Blocks in Economics: The Problem of Choice" },
      { number: 9, title: "The Price Puzzle: What Drives the Market" },
    ],
  },
};

export const CHAPTER_SOURCE =
  "NCERT textbook contents, 2025-26 rationalised syllabus. Entered by hand; verify against the printed book before relying on chapter numbers.";

/**
 * One fully authored chapter, as the worked example the editor is measured
 * against. Written against Class 10 Mathematics chapter 6, Triangles, because
 * similar triangles is the prerequisite that Trigonometry and Circles both
 * lean on — which makes it the first place a real learning gap shows up.
 *
 * These statements are the shape every other outcome should take: a verb a
 * student performs, a specific object, and enough detail that a question could
 * be written from the sentence alone.
 */
type ConceptSeed = {
  slug: string;
  name: string;
  description: string;
  outcomeCodes: string[];
  prerequisiteSlugs?: string[];
};

export const WORKED_EXAMPLE: {
  gradeNumber: number;
  subjectCode: string;
  chapterNumber: number;
  topics: {
    title: string;
    outcomes: {
      code: string;
      statement: string;
      bloomLevel: string;
      competency: string;
      typicalMarks: number;
    }[];
  }[];
  concepts: ConceptSeed[];
} = {
  gradeNumber: 10,
  subjectCode: "MATH",
  chapterNumber: 6,
  topics: [
    {
      title: "Similar figures and the criteria for similarity",
      outcomes: [
        {
          code: "SIM-1",
          statement:
            "States that two triangles are similar when their corresponding angles are equal and their corresponding sides are in the same ratio, and identifies which pairs of sides correspond in a given pair of triangles.",
          bloomLevel: "UNDERSTAND",
          competency: "UNDERSTANDING",
          typicalMarks: 1,
        },
        {
          code: "SIM-2",
          statement:
            "Applies the AA, SSS and SAS similarity criteria to decide whether two given triangles are similar, and names which criterion was used.",
          bloomLevel: "APPLY",
          competency: "APPLICATION",
          typicalMarks: 2,
        },
        {
          code: "SIM-3",
          statement:
            "Uses the Basic Proportionality Theorem (a line drawn parallel to one side of a triangle divides the other two sides in the same ratio) to find an unknown length in a triangle.",
          bloomLevel: "APPLY",
          competency: "PROBLEM_SOLVING",
          typicalMarks: 3,
        },
      ],
    },
    {
      title: "Consequences of similarity",
      outcomes: [
        {
          code: "SIM-4",
          statement:
            "Deduces that the ratio of the areas of two similar triangles equals the square of the ratio of any pair of corresponding sides, and uses it to find an unknown area.",
          bloomLevel: "APPLY",
          competency: "PROBLEM_SOLVING",
          typicalMarks: 3,
        },
        {
          code: "SIM-5",
          statement:
            "Proves or applies the converse of the Basic Proportionality Theorem to establish that a line is parallel to a side of a triangle.",
          bloomLevel: "ANALYSE",
          competency: "ANALYSIS",
          typicalMarks: 3,
        },
      ],
    },
  ],
  concepts: [
    {
      slug: "similarity-of-triangles",
      name: "Similarity of triangles",
      description:
        "Recognising similar triangles and using the correspondence between their sides and angles.",
      outcomeCodes: ["SIM-1", "SIM-2"],
    },
    {
      slug: "proportionality-in-triangles",
      name: "Proportionality in triangles",
      description:
        "The Basic Proportionality Theorem, its converse, and the area ratio that follows from similarity.",
      outcomeCodes: ["SIM-3", "SIM-4", "SIM-5"],
      // Reading the graph: you cannot use the proportionality results until
      // you can recognise similarity in the first place. This edge is what
      // later turns "weak in Trigonometry" into a root cause a teacher can act
      // on.
      prerequisiteSlugs: ["similarity-of-triangles"],
    },
  ],
};

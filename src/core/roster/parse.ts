/**
 * Roster parsing.
 *
 * One parser serves both roster paths, because they are the same problem: a
 * teacher has a list of students somewhere and wants it in the product without
 * retyping it. Pasting from WhatsApp and uploading a CSV differ only in
 * delimiter and whether there is a header row.
 *
 * Pure — no database, no I/O — so the dry-run preview a teacher sees is
 * produced by exactly the same code that later does the import. A preview that
 * runs different logic from the commit is a preview that lies.
 */

export type ParsedStudent = {
  /** 1-based, as the teacher sees it in their own file. */
  line: number;
  fullName: string;
  rollNumber?: string;
  phone?: string;
  raw: string;
};

export type RosterProblem = {
  line: number;
  raw: string;
  message: string;
};

export type RosterParse = {
  students: ParsedStudent[];
  problems: RosterProblem[];
  /** Duplicates within the pasted list itself, not against the database. */
  duplicateNames: string[];
  detected: { delimiter: string; hadHeader: boolean; columns: string[] };
};

const MAX_ROWS = 500;

/**
 * Indian mobile numbers. Accepts the shapes people actually paste — +91, 0091,
 * a leading 0, and spaces or hyphens anywhere — and normalises to ten digits.
 * Rejects anything that is not a real mobile prefix rather than storing a
 * number no OTP will ever reach.
 */
export function normalisePhone(input: string): string | null {
  const digits = input.replace(/[^\d]/g, "");
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  if (ten.length !== 10) return null;
  if (!/^[6-9]/.test(ten)) return null;
  // A prefix stripped from a longer string must have been a real country or
  // trunk code, not arbitrary leading digits.
  if (digits.length > 10) {
    const prefix = digits.slice(0, digits.length - 10);
    if (!/^(0|91|091|0091)$/.test(prefix)) return null;
  }
  return ten;
}

export function parseRoster(input: string): RosterParse {
  const students: ParsedStudent[] = [];
  const problems: RosterProblem[] = [];

  const rawLines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (rawLines.length === 0) {
    return {
      students,
      problems,
      duplicateNames: [],
      detected: { delimiter: "none", hadHeader: false, columns: [] },
    };
  }

  const delimiter = detectDelimiter(rawLines);
  const firstCells = splitLine(rawLines[0]!, delimiter);
  const hadHeader = looksLikeHeader(firstCells);
  const columns = hadHeader ? firstCells.map(normaliseHeader) : [];

  const body = hadHeader ? rawLines.slice(1) : rawLines;
  const bodyCells = body.map((raw) => splitLine(raw, delimiter));

  // Where each field lives. With a header we trust it; without one we read the
  // columns themselves.
  const index = hadHeader ? headerColumns(columns) : inferColumns(bodyCells);

  // A header with no column we recognise as a phone, over a column that is
  // plainly full of phone numbers, would otherwise import every student with
  // no way to sign in and nothing on screen saying so. The header is wrong,
  // not the data: read the numbers from where they are, and say which column
  // they came from so the teacher can check.
  if (hadHeader && index.phone === -1) {
    const found = phoneColumnByContent(bodyCells, [index.name]);
    if (found !== -1) {
      index.phone = found;
      if (index.roll === found) index.roll = -1;
      problems.push({
        line: 1,
        raw: rawLines[0]!,
        message: `No column is headed "Mobile" or "Phone", so the numbers in "${firstCells[found] ?? ""}" were read as mobile numbers. Check they are right.`,
      });
    }
  }

  const seen = new Map<string, number>();
  const duplicateNames: string[] = [];

  for (const [offset, raw] of body.entries()) {
    const line = offset + 1 + (hadHeader ? 1 : 0);

    if (students.length >= MAX_ROWS) {
      problems.push({
        line,
        raw,
        message: `More than ${MAX_ROWS} rows. Split the list and import it in parts.`,
      });
      break;
    }

    const cells = bodyCells[offset]!;
    const fullName = cleanName(pick(cells, index.name));

    if (!fullName) {
      problems.push({ line, raw, message: "No name on this row." });
      continue;
    }
    if (fullName.length > 120) {
      problems.push({ line, raw, message: "That name is too long to be a name." });
      continue;
    }

    // A header the detector missed shows up as a row literally called "Name".
    if (/^(name|student|student name|full name)$/i.test(fullName)) {
      problems.push({ line, raw, message: "This looks like a header row, not a student." });
      continue;
    }

    const rollRaw = pick(cells, index.roll);
    const phoneRaw = pick(cells, index.phone);

    let phone: string | undefined;
    if (phoneRaw) {
      const normalised = normalisePhone(phoneRaw);
      if (normalised) {
        phone = normalised;
      } else {
        // The student is still imported — a bad phone is not a reason to lose
        // a name. It is reported so the teacher can fix it, and that student
        // simply cannot sign in until they do.
        problems.push({
          line,
          raw,
          message: `"${phoneRaw}" is not a mobile number we can send a code to. The student was still added.`,
        });
      }
    }

    // A roll column that is really a phone number (columns swapped) should not
    // become a roll number.
    const rollNumber =
      rollRaw && rollRaw.length <= 24 && !isProbablyPhone(rollRaw)
        ? rollRaw
        : undefined;

    const key = fullName.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) {
      if (!duplicateNames.includes(fullName)) duplicateNames.push(fullName);
    } else {
      seen.set(key, line);
    }

    students.push({ line, fullName, rollNumber, phone, raw });
  }

  return {
    students,
    problems,
    duplicateNames,
    detected: { delimiter, hadHeader, columns },
  };
}

// ---------------------------------------------------------------------------

function detectDelimiter(lines: string[]): string {
  const sample = lines.slice(0, 10);
  for (const candidate of [",", "\t", ";", "|"]) {
    const counts = sample.map((line) => line.split(candidate).length - 1);
    // Consistent across rows, not merely present in one — a comma inside a
    // single name should not turn the whole list into CSV.
    if (counts.every((count) => count > 0) && new Set(counts).size <= 2) {
      return candidate;
    }
  }
  return "none";
}

function splitLine(line: string, delimiter: string): string[] {
  if (delimiter === "none") return splitUndelimited(line);
  return splitCsvLine(line, delimiter);
}

/**
 * A list where only SOME lines carry a comma is genuinely ambiguous, so the
 * delimiter detector refuses it — a single "Nair, Meera" must not turn a whole
 * list into two columns.
 *
 * But a trailing run of DIGITS after a comma is not ambiguous: no name is a
 * number. So `Meera Nair, 12` and `Meera Nair, 9876543210` split, while
 * `Nair, Meera` stays one name. This is the shape teachers actually paste when
 * only some of their students have roll numbers.
 */
function splitUndelimited(line: string): string[] {
  // Peel numeric cells off the END only, so `Zoë D'Souza, 9379778877, 7` gives
  // up both its phone and its roll, while a comma inside the name is never
  // reached: the first non-numeric cell from the right stops the peeling.
  let rest = line;
  let roll = "";
  let phone = "";
  for (;;) {
    const match = /[,;|	]([^,;|	]*)$/.exec(rest);
    if (!match) break;
    const cell = (match[1] ?? "").trim();
    if (!/^\+?[\d][\d\s()-]*$/.test(cell)) break;
    const digits = cell.replace(/[^\d]/g, "");
    // Ten or more digits is a phone; anything shorter is a roll number. A
    // second cell of the same kind is not something we can place, so stop.
    if (digits.length >= 10) {
      if (phone) break;
      phone = cell;
    } else {
      if (roll) break;
      roll = cell;
    }
    rest = rest.slice(0, match.index);
  }
  if (!roll && !phone) return [line];
  return [rest.trim(), roll, phone];
}

/** Handles quoted cells, so `"Kumar, Arun",12` is two cells and not three. */
function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

/**
 * Which column is what, for a list with no header row.
 *
 * Position alone is not enough. `Arun Kumar, 9876543210` is the single most
 * common thing a teacher pastes, and reading its second column as a roll
 * number — which is what a fixed name/roll/phone order does — silently throws
 * away the student's only way of signing in. Nothing is reported, because
 * nothing looked wrong: the name imported fine.
 *
 * So the phone column is found by what is IN it. Ten or more digits is a phone
 * number and nothing else; a roll number that long is not a roll number. The
 * first remaining column after the name is the roll, which is where it sits in
 * every list that has both.
 */
function inferColumns(rows: string[][]): {
  name: number;
  roll: number;
  phone: number;
} {
  const width = Math.max(1, ...rows.map((cells) => cells.length));
  const phone = phoneColumnByContent(rows, [0]);

  let roll = -1;
  for (let column = 1; column < width; column++) {
    if (column !== phone) {
      roll = column;
      break;
    }
  }

  return { name: 0, roll, phone };
}

/**
 * The first column (other than `skip`) whose non-empty values are mostly phone
 * numbers. A majority, not all of them: one student whose number is missing or
 * mistyped must not move the whole column.
 */
function phoneColumnByContent(rows: string[][], skip: number[]): number {
  const width = Math.max(1, ...rows.map((cells) => cells.length));
  for (let column = 0; column < width; column++) {
    if (skip.includes(column)) continue;
    const values = rows
      .map((cells) => (cells[column] ?? "").trim())
      .filter((value) => value.length > 0);
    if (values.length === 0) continue;
    const phones = values.filter(isProbablyPhone).length;
    if (phones * 2 > values.length) return column;
  }
  return -1;
}

type HeaderRole = "name" | "roll" | "phone" | null;

/**
 * What a header cell names, matched by the words in it rather than exactly.
 * Our own sample template says "Mobile Number", and exact matching on
 * "mobile" dropped every phone in a file we handed the teacher ourselves.
 *
 * Phone is tested first because "Mobile Number" also contains "number", and
 * roll before name so "Roll Number" is never read as a name column.
 */
function headerRole(cell: string): HeaderRole {
  const h = normaliseHeader(cell);
  if (!h) return null;
  // Anchored whole-cell patterns, not substrings: a names-only list whose
  // first student is "Cellina" or "Nameeta" must not be read as a header.
  if (
    /^((student|parent|guardian|father|mother)s?)?(mobile|phone|contact|whatsapp|cell)(phone)?(no|num|number)?$/.test(h)
  ) {
    return "phone";
  }
  if (/^(roll|admission|enrol|enrolment|enrollment)(no|num|number)?$|^(srno|sno|no|id|studentid)$/.test(h)) {
    return "roll";
  }
  if (/^((full|student|students|candidate|pupil)?name|nameof(the)?student|student)$/.test(h)) {
    return "name";
  }
  return null;
}

function headerColumns(columns: string[]): { name: number; roll: number; phone: number } {
  const roles = columns.map(headerRole);
  return {
    name: roles.indexOf("name"),
    roll: roles.indexOf("roll"),
    phone: roles.indexOf("phone"),
  };
}

function looksLikeHeader(cells: string[]): boolean {
  const roles = cells.map(headerRole);
  // A name-shaped cell alone is not enough — "Arun Kumar" is not a header, but
  // nor does it match; a lone "Name" does.
  return roles.some((role) => role !== null) && !cells.some(isProbablyPhone);
}

function normaliseHeader(cell: string): string {
  return cell.toLowerCase().replace(/[^a-z]/g, "");
}

function pick(cells: string[], at: number): string {
  if (at < 0) return "";
  return (cells[at] ?? "").trim();
}

function cleanName(value: string): string {
  return value
    // Numbering a teacher pasted with the list: "1. Arun" or "12) Meera".
    .replace(/^\s*\d{1,3}\s*[.)\]-]\s*/, "")
    // Trailing separators left by an empty last column: "No Name Row,,".
    .replace(/[,;|	]+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isProbablyPhone(value: string): boolean {
  const digits = value.replace(/[^\d]/g, "");
  return digits.length >= 10;
}

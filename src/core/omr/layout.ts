/**
 * The printed answer sheet, as geometry.
 *
 * ONE layout, used twice: `OmrSheet` draws it for the printer, and `readSheet`
 * reads a photograph of it back. Both call `omrLayout` with the same
 * questions, so a bubble cannot be printed in one place and looked for in
 * another — the failure that would make every scanned sheet quietly wrong.
 *
 * Units are millimetres on an A4 page (210 × 297). The reader never needs the
 * printed size: it finds the four corner squares and maps millimetres to
 * pixels through them, so a sheet printed at 90% or photographed at an angle
 * reads the same.
 *
 * Pure, and safe in the browser: the scanner runs on the teacher's phone, and
 * a photo of thirty children's answer sheets has no business leaving it.
 */

export const PAGE = { width: 210, height: 297 } as const;

/** Solid corner squares the reader finds first. */
export const FIDUCIAL_SIZE = 8;
export const FIDUCIALS = [
  { x: 14, y: 14 },
  { x: 196, y: 14 },
  { x: 14, y: 283 },
  { x: 196, y: 283 },
] as const;

/** The sheet's identity, as a strip of filled and empty squares. */
export const ID_BITS = 20;
export const CHECK_BITS = 4;
export const ID_CELL = 5;
const ID_PITCH = 6.5;
const ID_Y = 70;
const ID_X0 = 32.5;

export const BUBBLE_RADIUS = 2.4;
const BUBBLE_PITCH = 7;
const ROW_HEIGHT = 7.2;
const GRID_TOP = 90;
const GRID_BOTTOM = 270;
const COLUMN_X = [16, 78, 140] as const;
const NUMBER_WIDTH = 11;
export const MAX_CHOICES = 5;

export const ROWS_PER_COLUMN = Math.floor((GRID_BOTTOM - GRID_TOP) / ROW_HEIGHT);
export const MAX_QUESTIONS = ROWS_PER_COLUMN * COLUMN_X.length;

export type OmrQuestion = {
  /** What is printed beside the row: "12", or "21a" for half of a choice. */
  label: string;
  /** The keys a student can fill: option keys, or T and F. */
  choices: string[];
};

export type OmrBubble = { key: string; cx: number; cy: number };
export type OmrRow = { label: string; labelX: number; labelY: number; bubbles: OmrBubble[] };

export type OmrLayout = {
  idCells: { cx: number; cy: number }[];
  rows: OmrRow[];
};

export function omrLayout(questions: OmrQuestion[]): OmrLayout {
  if (questions.length > MAX_QUESTIONS) {
    throw new Error(`An answer sheet holds at most ${MAX_QUESTIONS} questions.`);
  }
  const idCells = Array.from({ length: ID_BITS + CHECK_BITS }, (_, index) => ({
    cx: ID_X0 + index * ID_PITCH,
    cy: ID_Y,
  }));

  const rows = questions.map((question, index) => {
    const column = Math.floor(index / ROWS_PER_COLUMN);
    const row = index % ROWS_PER_COLUMN;
    const x0 = COLUMN_X[column]!;
    const cy = GRID_TOP + row * ROW_HEIGHT + ROW_HEIGHT / 2;
    return {
      label: question.label,
      labelX: x0 + NUMBER_WIDTH - 2,
      labelY: cy,
      bubbles: question.choices.slice(0, MAX_CHOICES).map((key, choice) => ({
        key,
        cx: x0 + NUMBER_WIDTH + BUBBLE_RADIUS + choice * BUBBLE_PITCH,
        cy,
      })),
    };
  });

  return { idCells, rows };
}

/**
 * Spots on the page nothing is ever printed on, which the reader samples to
 * learn what "white" looks like under this light.
 */
export const BLANK_SPOTS = [
  { x: 105, y: 8 },
  { x: 60, y: 8 },
  { x: 150, y: 8 },
  { x: 5, y: 150 },
  { x: 205, y: 150 },
  { x: 105, y: 292 },
] as const;

// ---------------------------------------------------------------------------
// The identity strip
// ---------------------------------------------------------------------------

/**
 * Four check bits over the twenty id bits: the sum of the five nibbles, mod
 * 16, folded with a constant so an all-empty strip is never valid. A reader
 * that finds the corners in the wrong order reads a scrambled strip, and this
 * is how it knows.
 */
export function checksum(id: number): number {
  let sum = 0;
  for (let shift = 0; shift < ID_BITS; shift += 4) sum += (id >> shift) & 0xf;
  return (sum % 16) ^ 0b1010;
}

export function encodeSheetId(id: number): boolean[] {
  if (!Number.isInteger(id) || id < 0 || id >= 2 ** ID_BITS) {
    throw new Error("A sheet id must fit in twenty bits.");
  }
  const bits: boolean[] = [];
  for (let index = ID_BITS - 1; index >= 0; index--) bits.push(((id >> index) & 1) === 1);
  const check = checksum(id);
  for (let index = CHECK_BITS - 1; index >= 0; index--) bits.push(((check >> index) & 1) === 1);
  return bits;
}

export function decodeSheetId(bits: boolean[]): { id: number; valid: boolean } {
  let id = 0;
  for (let index = 0; index < ID_BITS; index++) id = id * 2 + (bits[index] ? 1 : 0);
  let check = 0;
  for (let index = 0; index < CHECK_BITS; index++) check = check * 2 + (bits[ID_BITS + index] ? 1 : 0);
  return { id, valid: check === checksum(id) };
}

import {
  BLANK_SPOTS,
  BUBBLE_RADIUS,
  FIDUCIALS,
  FIDUCIAL_SIZE,
  ID_CELL,
  decodeSheetId,
  type OmrLayout,
} from "./layout";

/**
 * Reading a photograph of a printed answer sheet.
 *
 * Pure: pixels in, a verdict per question out. It runs in the teacher's
 * browser, on their phone's photo, and nothing about it needs a server — or a
 * model. A filled bubble is a dark disc at a known place, and deciding that is
 * arithmetic.
 *
 * ---------------------------------------------------------------------------
 * The rule it will not break
 * ---------------------------------------------------------------------------
 * **It never guesses.** Two filled bubbles, or one filled only faintly, comes
 * back as `multiple` or `unclear` and the screen asks the teacher, who is
 * holding the sheet. A scanner that picked the darker of two bubbles would be
 * right most of the time and silently wrong on exactly the children who
 * changed their minds — and a wrong answer recorded as theirs becomes a
 * mistake in their bank and evidence against a concept.
 *
 * ---------------------------------------------------------------------------
 * How
 * ---------------------------------------------------------------------------
 * 1. Threshold the image (Otsu) and find dark, solid, square blobs — the four
 *    corner marks are the only such things on the page.
 * 2. Take the blob nearest each corner of the photo, and fit the homography
 *    that maps the sheet's millimetres onto those four points. A tilted or
 *    angled photo is the ordinary case, not the exception.
 * 3. Try all four rotations of the corners, and keep the one whose identity
 *    strip passes its checksum — so a sheet photographed upside down reads.
 * 4. Learn black from the corner marks and white from spots nothing is
 *    printed on, and score each bubble as "how far from white towards black".
 *    Measured per photo, so a dim classroom and a bright window both work.
 */

export type RawImage = { width: number; height: number; data: Uint8ClampedArray | Uint8Array };

export type QuestionReading = {
  keys: string[];
  status: "ok" | "blank" | "multiple" | "unclear";
  /** Darkness per bubble, 0 (paper) to 1 (corner-mark black). */
  darkness: number[];
};

export type SheetReading =
  | {
      ok: true;
      sheetId: number;
      /** False when the identity strip did not pass its checksum. */
      sheetIdValid: boolean;
      questions: QuestionReading[];
    }
  | { ok: false; message: string };

/** Filled means at least this dark. Pencil on a phone photo sits well above. */
export const FILLED = 0.42;
/** Between this and FILLED is a mark somebody should look at. */
export const FAINT = 0.24;

export function readSheet(image: RawImage, layout: OmrLayout): SheetReading {
  const gray = toGray(image);
  const threshold = otsu(gray);
  const blobs = findSquares(gray, image.width, image.height, threshold);
  if (blobs.length < 4) {
    return {
      ok: false,
      message:
        "Could not find the four black corner squares. Photograph the whole sheet, flat, with all four corners in the picture.",
    };
  }

  const corners = pickCorners(blobs, image.width, image.height);
  if (!corners) {
    return {
      ok: false,
      message:
        "Could not tell which corner square is which. Hold the phone square to the sheet and try again.",
    };
  }

  // corners: [top-left, top-right, bottom-right, bottom-left] of the PHOTO.
  // The sheet's own order is TL, TR, BL, BR (see FIDUCIALS). Each rotation
  // maps the sheet's corners onto the photo's corners one step further round.
  const sheetCycle = [FIDUCIALS[0], FIDUCIALS[1], FIDUCIALS[3], FIDUCIALS[2]];
  let best: { reading: SheetReading & { ok: true }; valid: boolean } | null = null;

  for (let rotation = 0; rotation < 4; rotation++) {
    const source = sheetCycle.map((_, index) => sheetCycle[(index + rotation) % 4]!);
    const matrix = homography(
      source.map((point) => [point.x, point.y] as [number, number]),
      corners.map((point) => [point.x, point.y] as [number, number]),
    );
    if (!matrix) continue;
    const reading = readWith(gray, image.width, image.height, matrix, layout);
    if (reading.sheetIdValid) return reading;
    if (!best) best = { reading, valid: false };
  }

  if (best) return best.reading;
  return { ok: false, message: "The sheet could not be read. Try a clearer photo." };
}

function readWith(
  gray: Float32Array,
  width: number,
  height: number,
  matrix: number[],
  layout: OmrLayout,
): SheetReading & { ok: true } {
  const sampleDisc = (cx: number, cy: number, radius: number) => {
    let total = 0;
    let count = 0;
    const steps = 4;
    for (let i = -steps; i <= steps; i++) {
      for (let j = -steps; j <= steps; j++) {
        const dx = (i / steps) * radius;
        const dy = (j / steps) * radius;
        if (dx * dx + dy * dy > radius * radius) continue;
        const [px, py] = project(matrix, cx + dx, cy + dy);
        const value = pixel(gray, width, height, px, py);
        if (value === null) continue;
        total += value;
        count++;
      }
    }
    return count === 0 ? 255 : total / count;
  };

  const black = median(
    FIDUCIALS.map((point) => sampleDisc(point.x, point.y, FIDUCIAL_SIZE * 0.3)),
  );
  const white = median(BLANK_SPOTS.map((point) => sampleDisc(point.x, point.y, 1.5)));
  const span = Math.max(1, white - black);
  const darkness = (value: number) => clamp((white - value) / span, 0, 1);

  const bits = layout.idCells.map(
    (cell) => darkness(sampleDisc(cell.cx, cell.cy, ID_CELL * 0.3)) > 0.5,
  );
  const identity = decodeSheetId(bits);

  const questions = layout.rows.map((row) => {
    // The inside of the circle only: the printed ring would otherwise make
    // every empty bubble look a little filled.
    const values = row.bubbles.map((bubble) =>
      darkness(sampleDisc(bubble.cx, bubble.cy, BUBBLE_RADIUS * 0.55)),
    );
    return judge(
      row.bubbles.map((bubble) => bubble.key),
      values,
    );
  });

  return { ok: true, sheetId: identity.id, sheetIdValid: identity.valid, questions };
}

/** One row's verdict. Pure, and the only place the thresholds are applied. */
export function judge(keys: string[], values: number[]): QuestionReading {
  const filled = keys.filter((_, index) => values[index]! >= FILLED);
  const faint = keys.filter((_, index) => values[index]! >= FAINT && values[index]! < FILLED);
  const darkness = values.map((value) => Math.round(value * 100) / 100);
  if (filled.length === 0 && faint.length === 0) return { keys: [], status: "blank", darkness };
  if (filled.length === 1 && faint.length === 0) return { keys: filled, status: "ok", darkness };
  if (filled.length > 1) return { keys: filled, status: "multiple", darkness };
  return { keys: [...filled, ...faint], status: "unclear", darkness };
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

function toGray(image: RawImage): Float32Array {
  const gray = new Float32Array(image.width * image.height);
  for (let index = 0; index < gray.length; index++) {
    const offset = index * 4;
    gray[index] =
      0.299 * image.data[offset]! + 0.587 * image.data[offset + 1]! + 0.114 * image.data[offset + 2]!;
  }
  return gray;
}

function otsu(gray: Float32Array): number {
  const histogram = new Array<number>(256).fill(0);
  for (const value of gray) histogram[Math.max(0, Math.min(255, Math.round(value)))]!++;
  const total = gray.length;
  let sum = 0;
  for (let level = 0; level < 256; level++) sum += level * histogram[level]!;
  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let threshold = 127;
  for (let level = 0; level < 256; level++) {
    weightBackground += histogram[level]!;
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += level * histogram[level]!;
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const between =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (between > best) {
      best = between;
      threshold = level;
    }
  }
  return threshold;
}

type Blob = { x: number; y: number; area: number };

/** Dark, solid, roughly square components of a plausible size. */
function findSquares(
  gray: Float32Array,
  width: number,
  height: number,
  threshold: number,
): Blob[] {
  const seen = new Uint8Array(width * height);
  const shortSide = Math.min(width, height);
  const minSide = shortSide * 0.012;
  const maxSide = shortSide * 0.09;
  const blobs: Blob[] = [];
  const stack: number[] = [];

  for (let start = 0; start < gray.length; start++) {
    if (seen[start] || gray[start]! > threshold) continue;
    seen[start] = 1;
    stack.push(start);
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % width;
      const y = (index - x) / width;
      area++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbours = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y < height - 1 ? index + width : -1,
      ];
      for (const next of neighbours) {
        if (next < 0 || seen[next] || gray[next]! > threshold) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const aspect = w / h;
    const fill = area / (w * h);
    // A square photographed at an angle is a quadrilateral whose bounding box
    // it only partly fills, hence the generous fill bound.
    if (w < minSide || h < minSide || w > maxSide || h > maxSide) continue;
    if (aspect < 0.6 || aspect > 1.6 || fill < 0.6) continue;
    blobs.push({ x: sumX / area, y: sumY / area, area });
  }
  return blobs;
}

/** The candidate nearest each corner of the photo, each used once. */
function pickCorners(blobs: Blob[], width: number, height: number): Blob[] | null {
  const targets = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  const chosen: Blob[] = [];
  for (const target of targets) {
    let best: Blob | null = null;
    let bestDistance = Infinity;
    for (const blob of blobs) {
      if (chosen.includes(blob)) continue;
      const distance = (blob.x - target.x) ** 2 + (blob.y - target.y) ** 2;
      if (distance < bestDistance) {
        best = blob;
        bestDistance = distance;
      }
    }
    if (!best) return null;
    chosen.push(best);
  }
  // The four must span the photo, not cluster in one part of it.
  const xs = chosen.map((blob) => blob.x);
  const ys = chosen.map((blob) => blob.y);
  if (Math.max(...xs) - Math.min(...xs) < width * 0.3) return null;
  if (Math.max(...ys) - Math.min(...ys) < height * 0.3) return null;
  return chosen;
}

/**
 * The 3×3 projective map taking four source points to four destination
 * points, as its first eight entries (the ninth is 1). Null when the points
 * are degenerate.
 */
export function homography(
  source: [number, number][],
  destination: [number, number][],
): number[] | null {
  const rows: number[][] = [];
  for (let index = 0; index < 4; index++) {
    const [x, y] = source[index]!;
    const [u, v] = destination[index]!;
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  return solve(rows);
}

export function project(matrix: number[], x: number, y: number): [number, number] {
  const [a, b, c, d, e, f, g, h] = matrix as [number, number, number, number, number, number, number, number];
  const w = g * x + h * y + 1;
  return [(a * x + b * y + c) / w, (d * x + e * y + f) / w];
}

/** Gaussian elimination with partial pivoting on an 8×9 augmented matrix. */
function solve(rows: number[][]): number[] | null {
  const n = 8;
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) {
      if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(rows[pivot]![column]!) < 1e-12) return null;
    [rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!];
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = rows[row]![column]! / rows[column]![column]!;
      for (let k = column; k <= n; k++) rows[row]![k]! -= factor * rows[column]![k]!;
    }
  }
  return rows.map((row, index) => row[n]! / row[index]!);
}

function pixel(gray: Float32Array, width: number, height: number, x: number, y: number) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= width || py >= height) return null;
  return gray[py * width + px]!;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value));
}

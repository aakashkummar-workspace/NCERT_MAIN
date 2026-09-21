import { describe, expect, it } from "vitest";
import {
  BUBBLE_RADIUS,
  FIDUCIALS,
  FIDUCIAL_SIZE,
  ID_CELL,
  MAX_QUESTIONS,
  PAGE,
  decodeSheetId,
  encodeSheetId,
  omrLayout,
  type OmrLayout,
} from "@/core/omr/layout";
import { homography, judge, project, readSheet } from "@/core/omr/read";

/**
 * A photograph, synthesised: the printed sheet drawn in millimetres and then
 * projected onto a camera image through a chosen homography — perspective,
 * rotation, a dark table round the page and noise included. The reader has to
 * find its way back through all of that, which is the whole of its job.
 */
function photograph(
  layout: OmrLayout,
  options: {
    sheetId: number;
    marks: Record<number, { key: string; shade: number }[]>;
    /** Where the sheet's four corners (TL, TR, BR, BL) land in the photo. */
    corners: [number, number][];
    width?: number;
    height?: number;
    seed?: number;
  },
) {
  const width = options.width ?? 600;
  const height = options.height ?? 800;
  const sheetCorners: [number, number][] = [
    [0, 0],
    [PAGE.width, 0],
    [PAGE.width, PAGE.height],
    [0, PAGE.height],
  ];
  const toSheet = homography(options.corners, sheetCorners)!;
  const bits = encodeSheetId(options.sheetId);
  let seed = options.seed ?? 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return (seed / 2 ** 31 - 0.5) * 16;
  };

  const ink = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x > PAGE.width || y > PAGE.height) return 70; // the table
    for (const point of FIDUCIALS) {
      if (Math.abs(x - point.x) <= FIDUCIAL_SIZE / 2 && Math.abs(y - point.y) <= FIDUCIAL_SIZE / 2) {
        return 15;
      }
    }
    for (const [index, cell] of layout.idCells.entries()) {
      const dx = Math.abs(x - cell.cx);
      const dy = Math.abs(y - cell.cy);
      if (dx <= ID_CELL / 2 && dy <= ID_CELL / 2) {
        if (bits[index]) return 20;
        if (dx >= ID_CELL / 2 - 0.3 || dy >= ID_CELL / 2 - 0.3) return 60;
      }
    }
    for (const [rowIndex, row] of layout.rows.entries()) {
      for (const bubble of row.bubbles) {
        const distance = Math.hypot(x - bubble.cx, y - bubble.cy);
        if (distance > BUBBLE_RADIUS) continue;
        const mark = options.marks[rowIndex]?.find((m) => m.key === bubble.key);
        if (mark && distance <= BUBBLE_RADIUS * 0.92) return mark.shade;
        if (distance >= BUBBLE_RADIUS - 0.3) return 90;
      }
    }
    // Header text, as blocks of ink the reader must ignore.
    if (y > 26 && y < 60 && Math.floor(x / 3) % 3 === 0 && Math.floor(y / 2) % 2 === 0) return 40;
    return 238;
  };

  const data = new Uint8ClampedArray(width * height * 4);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const [x, y] = project(toSheet, px, py);
      const value = Math.max(0, Math.min(255, ink(x, y) + noise()));
      const offset = (py * width + px) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

const questions = [
  { label: "1", choices: ["A", "B", "C", "D"] },
  { label: "2", choices: ["A", "B", "C", "D"] },
  { label: "3", choices: ["T", "F"] },
  { label: "4", choices: ["A", "B", "C", "D"] },
  { label: "5", choices: ["A", "B", "C", "D"] },
  { label: "6", choices: ["A", "B", "C", "D"] },
];
const layout = omrLayout(questions);

// A sheet photographed slightly skewed, with a trapezoid of perspective.
const TILTED: [number, number][] = [
  [46, 40],
  [560, 63],
  [573, 767],
  [27, 747],
];

describe("the identity strip", () => {
  it("round-trips every id and catches a flipped bit", () => {
    for (const id of [0, 1, 12345, 2 ** 20 - 1]) {
      const bits = encodeSheetId(id);
      expect(decodeSheetId(bits)).toEqual({ id, valid: true });
      const flipped = [...bits];
      flipped[3] = !flipped[3];
      expect(decodeSheetId(flipped).valid).toBe(false);
    }
  });

  it("never reads an empty strip as a valid sheet", () => {
    expect(decodeSheetId(new Array(24).fill(false)).valid).toBe(false);
  });
});

describe("the layout", () => {
  it("refuses more questions than a sheet holds", () => {
    const many = Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => ({
      label: String(i + 1),
      choices: ["A", "B"],
    }));
    expect(() => omrLayout(many)).toThrow();
  });

  it("keeps every bubble inside the corner marks", () => {
    const full = omrLayout(
      Array.from({ length: MAX_QUESTIONS }, (_, i) => ({
        label: String(i + 1),
        choices: ["A", "B", "C", "D", "E"],
      })),
    );
    for (const row of full.rows) {
      for (const bubble of row.bubbles) {
        expect(bubble.cx).toBeGreaterThan(FIDUCIALS[0].x + FIDUCIAL_SIZE);
        expect(bubble.cx).toBeLessThan(FIDUCIALS[1].x - FIDUCIAL_SIZE);
        expect(bubble.cy).toBeLessThan(FIDUCIALS[2].y - FIDUCIAL_SIZE);
      }
    }
  });
});

describe("reading a photographed sheet", () => {
  it("reads the sheet id and every answer from a tilted photo", () => {
    const image = photograph(layout, {
      sheetId: 604211,
      corners: TILTED,
      marks: {
        0: [{ key: "B", shade: 55 }],
        1: [{ key: "D", shade: 60 }],
        2: [{ key: "F", shade: 50 }],
        4: [{ key: "A", shade: 65 }],
      },
    });
    const reading = readSheet(image, layout);
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.sheetIdValid).toBe(true);
    expect(reading.sheetId).toBe(604211);
    expect(reading.questions.map((q) => [q.status, q.keys.join("")])).toEqual([
      ["ok", "B"],
      ["ok", "D"],
      ["ok", "F"],
      ["blank", ""],
      ["ok", "A"],
      ["blank", ""],
    ]);
  });

  it("reads a sheet photographed upside down", () => {
    const upsideDown: [number, number][] = [TILTED[2]!, TILTED[3]!, TILTED[0]!, TILTED[1]!];
    const image = photograph(layout, {
      sheetId: 77,
      corners: upsideDown,
      marks: { 0: [{ key: "C", shade: 55 }] },
    });
    const reading = readSheet(image, layout);
    expect(reading.ok && reading.sheetIdValid && reading.sheetId).toBe(77);
    if (reading.ok) expect(reading.questions[0]!.keys).toEqual(["C"]);
  });

  it("asks rather than guesses when two bubbles are filled", () => {
    const image = photograph(layout, {
      sheetId: 5,
      corners: TILTED,
      marks: { 3: [{ key: "A", shade: 55 }, { key: "C", shade: 70 }] },
    });
    const reading = readSheet(image, layout);
    if (!reading.ok) throw new Error(reading.message);
    expect(reading.questions[3]!.status).toBe("multiple");
  });

  it("flags a faint mark instead of deciding it", () => {
    const image = photograph(layout, {
      sheetId: 5,
      corners: TILTED,
      marks: { 5: [{ key: "B", shade: 175 }] },
    });
    const reading = readSheet(image, layout);
    if (!reading.ok) throw new Error(reading.message);
    expect(reading.questions[5]!.status).toBe("unclear");
  });

  it("says what to do when the corners are not in the picture", () => {
    const blank = new Uint8ClampedArray(400 * 300 * 4).fill(235);
    const reading = readSheet({ width: 400, height: 300, data: blank }, layout);
    expect(reading.ok).toBe(false);
    if (!reading.ok) expect(reading.message).toMatch(/corner/);
  });
});

describe("judging one row", () => {
  it("separates filled, faint and blank", () => {
    expect(judge(["A", "B"], [0.8, 0.05]).status).toBe("ok");
    expect(judge(["A", "B"], [0.05, 0.05]).status).toBe("blank");
    expect(judge(["A", "B"], [0.8, 0.3]).status).toBe("unclear");
    expect(judge(["A", "B"], [0.8, 0.7]).status).toBe("multiple");
  });
});

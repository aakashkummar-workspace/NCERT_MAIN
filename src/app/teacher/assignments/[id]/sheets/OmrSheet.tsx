import {
  BUBBLE_RADIUS,
  FIDUCIALS,
  FIDUCIAL_SIZE,
  ID_CELL,
  PAGE,
  encodeSheetId,
  type OmrLayout,
} from "@/core/omr/layout";

/**
 * One student's answer sheet, drawn from the same `omrLayout` the scanner
 * reads — see core/omr/layout.ts.
 *
 * An SVG in millimetres rather than HTML boxes, because the scanner needs
 * the corner squares, the identity strip and every bubble exactly where the
 * layout says, and HTML would let a font or a browser's print margin move
 * them. It prints slightly under A4 so every printer's margin fits; the
 * reader maps through the corner squares, so the scale does not matter.
 */
export function OmrSheet({
  layout,
  sheetCode,
  studentName,
  rollNumber,
  title,
  className,
  schoolName,
  offSheet,
}: {
  layout: OmrLayout;
  sheetCode: number;
  studentName: string;
  rollNumber: string | null;
  title: string;
  className: string;
  schoolName: string;
  /** Question numbers answered on the question paper instead. */
  offSheet: string[];
}) {
  const bits = encodeSheetId(sheetCode);
  const half = FIDUCIAL_SIZE / 2;

  return (
    <section className="ui-omr-page" aria-label={`Answer sheet for ${studentName}`}>
      <svg
        className="ui-omr-sheet"
        viewBox={`0 0 ${PAGE.width} ${PAGE.height}`}
        role="img"
        aria-label={`Answer sheet for ${studentName}`}
      >
        <rect width={PAGE.width} height={PAGE.height} fill="#ffffff" />
        {FIDUCIALS.map((point, index) => (
          <rect
            key={index}
            x={point.x - half}
            y={point.y - half}
            width={FIDUCIAL_SIZE}
            height={FIDUCIAL_SIZE}
            fill="#000000"
          />
        ))}

        <text x={105} y={26} textAnchor="middle" fontSize={5} fontWeight={700}>
          {schoolName}
        </text>
        <text x={105} y={33} textAnchor="middle" fontSize={4.2}>
          {title} · {className}
        </text>
        <text x={18} y={45} fontSize={5.2} fontWeight={700}>
          {studentName}
        </text>
        <text x={18} y={52} fontSize={4}>
          {rollNumber ? `Roll ${rollNumber}` : "Roll —"}
        </text>
        <text x={192} y={45} textAnchor="end" fontSize={3.2}>
          Fill ONE circle per question, fully, in dark pencil or pen.
        </text>
        <text x={192} y={50} textAnchor="end" fontSize={3.2}>
          To change an answer, rub it out completely.
        </text>
        <text x={192} y={55} textAnchor="end" fontSize={3.2}>
          Do not write on the black squares or the strip below.
        </text>

        <text x={16} y={71.2} fontSize={2.8}>
          Sheet
        </text>
        {layout.idCells.map((cell, index) => (
          <rect
            key={index}
            x={cell.cx - ID_CELL / 2}
            y={cell.cy - ID_CELL / 2}
            width={ID_CELL}
            height={ID_CELL}
            fill={bits[index] ? "#000000" : "#ffffff"}
            stroke="#000000"
            strokeWidth={0.25}
          />
        ))}
        <line x1={14} x2={196} y1={80} y2={80} stroke="#000000" strokeWidth={0.3} />

        {layout.rows.map((row) => (
          <g key={row.label}>
            <text
              x={row.labelX}
              y={row.labelY + 1.3}
              textAnchor="end"
              fontSize={3.6}
              fontWeight={700}
            >
              {row.label}
            </text>
            {row.bubbles.map((bubble) => (
              <g key={bubble.key}>
                <circle
                  cx={bubble.cx}
                  cy={bubble.cy}
                  r={BUBBLE_RADIUS}
                  fill="#ffffff"
                  stroke="#555555"
                  strokeWidth={0.3}
                />
                <text
                  x={bubble.cx}
                  y={bubble.cy + 1.1}
                  textAnchor="middle"
                  fontSize={2.6}
                  fill="#9a9a9a"
                >
                  {bubble.key}
                </text>
              </g>
            ))}
          </g>
        ))}

        {offSheet.length > 0 && (
          <text x={105} y={276} textAnchor="middle" fontSize={3}>
            Answer {offSheet.length === 1 ? "question" : "questions"} {offSheet.join(", ")} on the
            question paper, not here.
          </text>
        )}
      </svg>
    </section>
  );
}

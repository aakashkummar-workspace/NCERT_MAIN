import qrcode from "qrcode-generator";

/**
 * A QR code as an SVG path, for a printed page.
 *
 * Drawn as ONE path of unit squares rather than an <img> of a data URL, so it
 * prints as vectors at whatever resolution the printer has — a smudged QR
 * code on a photocopied card is one a phone camera will not read — and so no
 * HTML string is ever injected into the page.
 *
 * Error correction M: a card lives in a pocket for a term, and M recovers
 * about 15% of a damaged code without making the symbol much denser.
 */
export function QrCode({
  value,
  size = 96,
  label,
}: {
  value: string;
  size?: number;
  /** What the code is for, read out by a screen reader. */
  label: string;
}) {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  const count = qr.getModuleCount();
  // The quiet zone: four modules of white around the symbol, which the
  // standard requires and a scanner genuinely needs on a busy card.
  const quiet = 4;
  const total = count + quiet * 2;

  let path = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="ui-qr"
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}

/**
 * Shrink a phone photo before it is sent.
 *
 * A phone camera produces a 4 MB, 4000-pixel image; a written answer is
 * readable at 1600 pixels and a JPEG of that is a few hundred KB — the
 * difference between an upload that finishes on school wifi and one that
 * does not. Re-encoding also turns a HEIC or an oddly rotated file into a
 * plain upright JPEG, which is the only kind the server has to accept.
 */
export async function shrinkPhoto(file: File, maxSide = 1600, quality = 0.82): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no canvas");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("could not encode"))),
      "image/jpeg",
      quality,
    ),
  );
}

/**
 * Does a class name contradict the class year it is filed under?
 *
 * A teacher can call a class anything, and usually should. But a group named
 * "Class 10-A" that is filed against the Class 9 curriculum is a quiet filing
 * error: every mastery number would later be measured against the wrong
 * syllabus, and nothing downstream would look wrong. So this warns; it never
 * blocks. The name belongs to the teacher, the curriculum does not.
 *
 * Pure, so it is testable and cannot drift from the form that uses it.
 */
export function claimedClassNumber(name: string): number | null {
  // The boundary is a character class rather than \b so it survives every
  // layer of tooling between the editor and the file. 10 is tried before 9 so
  // "Class 10" is never read as a bare digit.
  // The optional ordinal suffix matters: teachers write "9th standard" at
  // least as often as "Class 9", and without it that name claims nothing.
  const match =
    /(?:^|[^A-Za-z0-9])(10|9|IX|X)(?:st|nd|rd|th)?(?:[^A-Za-z0-9]|$)/i.exec(
      name.replace(/[-_]/g, " "),
    );
  if (!match) return null;

  const token = match[1]?.toUpperCase();
  if (token === "IX") return 9;
  if (token === "X") return 10;

  const asNumber = Number(token);
  return Number.isFinite(asNumber) ? asNumber : null;
}

export function classNameContradictsGrade(
  name: string,
  gradeNumber: number,
): boolean {
  const claimed = claimedClassNumber(name);
  return claimed !== null && claimed !== gradeNumber;
}

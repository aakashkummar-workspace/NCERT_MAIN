/**
 * The three numbers every paper starts with, checked the same way in the
 * browser and on the server.
 *
 * Pure, and the bounds are the ones the API enforces, so a teacher is told
 * beside the box while typing rather than meeting "Check the highlighted
 * fields" with nothing highlighted — which is what a 0-minute paper used to get.
 */

export const DURATION_MIN = 5;
export const DURATION_MAX = 360;
export const MARKS_MIN = 1;
export const MARKS_MAX = 200;

export const BASICS_MESSAGE = {
  title: "Give the assessment a name of at least two characters.",
  durationMinutes: `Between ${DURATION_MIN} and ${DURATION_MAX} minutes, as a whole number.`,
  totalMarks: `Between ${MARKS_MIN} and ${MARKS_MAX} marks, as a whole number.`,
} as const;

export type BasicsErrors = Partial<Record<keyof typeof BASICS_MESSAGE, string>>;

export function checkBasics(input: {
  title?: string;
  durationMinutes?: number;
  totalMarks?: number;
}): BasicsErrors {
  const errors: BasicsErrors = {};
  if (input.title !== undefined && input.title.trim().length < 2) {
    errors.title = BASICS_MESSAGE.title;
  }
  if (
    input.durationMinutes !== undefined &&
    (!Number.isInteger(input.durationMinutes) ||
      input.durationMinutes < DURATION_MIN ||
      input.durationMinutes > DURATION_MAX)
  ) {
    errors.durationMinutes = BASICS_MESSAGE.durationMinutes;
  }
  if (
    input.totalMarks !== undefined &&
    (!Number.isInteger(input.totalMarks) ||
      input.totalMarks < MARKS_MIN ||
      input.totalMarks > MARKS_MAX)
  ) {
    errors.totalMarks = BASICS_MESSAGE.totalMarks;
  }
  return errors;
}

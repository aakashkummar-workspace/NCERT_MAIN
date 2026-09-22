/**
 * The period a meeting brief covers: from `?from=YYYY-MM-DD` if given, else
 * the Indian academic year so far (1 April, IST), to now.
 */
export function meetingPeriod(from: string | undefined, now = new Date()): { start: Date; end: Date } {
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
    const start = new Date(`${from}T00:00:00+05:30`);
    if (!Number.isNaN(start.getTime()) && start < now) return { start, end: now };
  }
  const year = now.getUTCMonth() + 1 >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return { start: new Date(`${year}-04-01T00:00:00+05:30`), end: now };
}

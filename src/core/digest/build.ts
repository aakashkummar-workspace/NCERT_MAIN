/**
 * What a weekly WhatsApp digest says about one child. Pure.
 *
 * Built from the parent's OWN view (`core/parent/read.ts#childView`), so it
 * can say nothing the parent could not already see on their page: released
 * marks, the concepts named on it, and nothing a child wrote, practised or
 * asked a tutor. A message on a phone is read by whoever holds the phone.
 *
 * It sends only when there is something NEW — a result released for a paper
 * sat this week. "Nothing to report" every Sunday teaches a parent to mute
 * the chat, and then the week something matters is not read either.
 */

export type DigestView = {
  fullName: string;
  sittings: {
    title: string;
    satAt: Date;
    percentage: number | null;
    marks: { awarded: number | null; total: number; awaitingMarking: number } | null;
    fullyMarked: boolean;
  }[];
  attention: { conceptName: string; estimate: number | null }[];
};

export type DigestMessage = { send: false; reason: string } | { send: true; values: string[] };

export function buildDigest(view: DigestView, since: Date, portalUrl: string): DigestMessage {
  const fresh = view.sittings.filter(
    (sitting) => sitting.satAt >= since && sitting.percentage !== null && sitting.marks !== null,
  );
  if (fresh.length === 0) return { send: false, reason: "no new released results this week" };

  const results = fresh
    .slice(0, 3)
    .map((sitting) => {
      const marks = sitting.marks!;
      const awarded = marks.awarded === null ? "not marked yet" : `${marks.awarded} of ${marks.total}`;
      return `${sitting.title} ${awarded}${sitting.fullyMarked ? "" : " (still being marked)"}`;
    })
    .join("; ");
  const more = fresh.length > 3 ? ` and ${fresh.length - 3} more` : "";

  // One idea, named — never a score. Only one the estimator stood behind.
  const focus = view.attention.find((concept) => concept.estimate !== null);

  return {
    send: true,
    values: [
      firstName(view.fullName),
      `${results}${more}`,
      focus ? focus.conceptName : "nothing flagged this week",
      portalUrl,
    ],
  };
}

/** Monday 00:00 IST of the week containing `now`, as a date. */
export function weekOf(now: Date): Date {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  const day = (ist.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - day));
}

function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}
